/**
 * SLACK_DM_AUTOROUTE_ENABLED — Plan A: auto-install internal 1:1 DM routes.
 *
 * For a linked employee (employee_slack_identities, status=linked) and each
 * counterpart registered as internal slack_user in org_parties (human-approved
 * via parties.upsert), open the employee↔counterpart DM with the EMPLOYEE's
 * user token (conversations.open, needs user scope im:write) and install the
 * internal classification + IM route through the existing channel-ledger
 * mutation (applyChannelClassification).
 *
 * Trust boundary / invariants:
 * - Triggers: (1) Slack OAuth callback after a human linked the identity
 *   (HMAC state), (2) fulfillment of a human-approved parties.upsert,
 *   (3) identity revoke by an org admin, (4) admin MCP dmAutoroute.run
 *   (PR-4): fulfillment of a human-approved ticket, or — only when
 *   ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY is ON — directly with an audit row.
 *   dryRun (read-only preview: auth.test + users.info only) needs neither.
 *   Not on the employee MCP (/api/mcp).
 * - Counterparts come ONLY from org_parties(kind=slack_user, audience=internal)
 *   of the same org. internalAudienceRule (team auto-internal) is NOT a source.
 * - users.info (employee token): is_stranger, team_id ≠ employee's team,
 *   guest (restricted/ultra_restricted), bot/app user, deleted, or anything
 *   undeterminable → skip (fail-closed).
 * - DM flags is_ext_shared / is_shared / is_org_shared / is_pending_ext_shared
 *   → skip. Existing shared_external / mixed classification is never overwritten.
 *   A DM already routed to another employee (any org) is never overwritten.
 * - Tokens are local variables only: never returned, logged, or audited.
 *   Slack error strings are reduced to a short code.
 * - Every create / skip / failure / removal → audit admin.channel
 *   (auditClass=admin, metadata.event=slack_dm_autoroute.*) in the employee's org.
 * - Never throws to the caller (OAuth callback / approval fulfillment).
 */
import { applyChannelClassification } from "@/lib/admin-mcp/channel-classify";
import { appendAuditEvent } from "@/lib/data/audit";
import { getOrgChannel, listOrgParties, upsertOrgChannel } from "@/lib/data/directory";
import { getEmployee } from "@/lib/data/employees";
import {
  getEmployeeSlackIdentity,
  getLinkedSlackUserToken,
  listLinkedSlackIdentitiesForOrg,
} from "@/lib/data/slack-identities";
import {
  deleteSlackImEmployeeRoute,
  getSlackImEmployeeRoute,
  isSlackImChannelId,
  listAutoSlackImRoutes,
  listSlackImRoutesForChannel,
  type SlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";
import { isSlackDmAutorouteEnabled } from "@/lib/slack/dm-autoroute-flags";
import { slackRequestBody } from "@/lib/slack/web-api-request";
import type { AuditEvent } from "@/lib/types";

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;
/** conversations.open is Tier 3 (~50/min). Cap one run; the rest is audited as skipped. */
export const DM_AUTOROUTE_MAX_COUNTERPARTS = 50;
const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/i;
const ADMIN_AUDIT_CLASS = "admin";

export type DmAutorouteTrigger =
  | "identity_linked"
  | "party_upserted"
  | "party_external"
  | "identity_revoked"
  | "admin_mcp";

/** would_open: dryRun only — eligible; a real run would open the DM and install the route. */
export type DmAutorouteOutcome = "created" | "already_routed" | "skipped" | "failed" | "removed" | "would_open";

export type DmAutorouteItem = {
  counterpartSlackUserId: string;
  outcome: DmAutorouteOutcome;
  reason: string;
  channelId?: string;
};

export type DmAutorouteResult = {
  status: "flag_off" | "skipped" | "done" | "error";
  reason?: string;
  items: DmAutorouteItem[];
};

type AuditWriter = (event: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }) => Promise<void>;
let writerOverride: AuditWriter | null = null;
/** Test-only: replace the audit writer. */
export function setDmAutorouteAuditWriterForTests(writer: AuditWriter | null): void {
  writerOverride = writer;
}

function slackId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return SLACK_ID_RE.test(raw) ? raw : "";
}

/** Slack error → short code. Never echoes arbitrary strings (no token / body leak). */
function errorCode(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_]{1,64}$/.test(raw) ? raw : "slack_error";
}

async function slackCall(
  token: string,
  method: "auth.test" | "users.info" | "conversations.open",
  body: Record<string, unknown>
): Promise<{ ok: boolean; error: string; data: Record<string, unknown>; scopes: string[] | null }> {
  try {
    // users.info / auth.test → form (Slack ignores JSON args there); others stay JSON.
    const request = slackRequestBody(method, body);
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": request.contentType,
      },
      body: request.body,
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const data = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const header = response.headers?.get?.("x-oauth-scopes");
    const scopes = typeof header === "string" ? header.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (data.ok !== true) {
      return { ok: false, error: errorCode(data.error) || `http_${response.status}`, data: {}, scopes };
    }
    return { ok: true, error: "", data, scopes };
  } catch {
    return { ok: false, error: "network_error", data: {}, scopes: null };
  }
}

type CounterpartCheck = { ok: true } | { ok: false; reason: string; failed?: boolean };

/** users.info verdict. Anything not positively "same-team full member human" is a skip. */
export function evaluateSlackCounterpart(
  user: Record<string, unknown> | null | undefined,
  input: { counterpartSlackUserId: string; employeeTeamId: string }
): CounterpartCheck {
  if (!user || typeof user !== "object") return { ok: false, reason: "user_undeterminable" };
  if (String(user.id || "").toUpperCase() !== input.counterpartSlackUserId.toUpperCase()) {
    return { ok: false, reason: "user_undeterminable" };
  }
  if (user.is_stranger === true) return { ok: false, reason: "slack_connect_stranger" };
  const teamId = typeof user.team_id === "string" ? user.team_id.trim() : "";
  if (!teamId) return { ok: false, reason: "team_undeterminable" };
  if (teamId.toUpperCase() !== input.employeeTeamId.toUpperCase()) {
    return { ok: false, reason: "other_workspace" };
  }
  const enterprise = user.enterprise_user as Record<string, unknown> | undefined;
  if (enterprise && typeof enterprise === "object") {
    const teams = Array.isArray(enterprise.teams) ? enterprise.teams.map(String) : [];
    if (teams.length > 0 && !teams.map((t) => t.toUpperCase()).includes(input.employeeTeamId.toUpperCase())) {
      return { ok: false, reason: "other_workspace" };
    }
  }
  if (user.deleted === true) return { ok: false, reason: "user_deleted" };
  if (user.is_bot === true || user.is_app_user === true) return { ok: false, reason: "bot_user" };
  if (user.is_restricted === true || user.is_ultra_restricted === true) {
    return { ok: false, reason: "guest_user" };
  }
  return { ok: true };
}

function dmLooksExternal(channel: Record<string, unknown>): boolean {
  return (
    channel.is_ext_shared === true ||
    channel.is_shared === true ||
    channel.is_org_shared === true ||
    channel.is_pending_ext_shared === true
  );
}

async function audit(input: {
  orgId: string;
  employeeId: string | null;
  trigger: DmAutorouteTrigger;
  item: DmAutorouteItem;
}): Promise<void> {
  const write = writerOverride ?? appendAuditEvent;
  const { item } = input;
  const label =
    item.outcome === "created"
      ? "DM ルートを自動作成"
      : item.outcome === "removed"
        ? "自動作成した DM ルートを削除"
        : item.outcome === "failed"
          ? "DM ルートの自動作成に失敗"
          : "DM ルートの自動作成をスキップ";
  try {
    await write({
      orgId: input.orgId,
      employeeId: input.employeeId,
      credentialId: null,
      action: "admin.channel",
      purpose: "admin.channel",
      summary: `${label}（相手 ${item.counterpartSlackUserId || "-"}${item.channelId ? ` / ${item.channelId}` : ""}: ${item.reason}）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        event: `slack_dm_autoroute.${item.outcome}`,
        trigger: input.trigger,
        reason: item.reason,
        counterpartSlackUserId: item.counterpartSlackUserId || null,
        channelId: item.channelId ?? null,
        employeeId: input.employeeId,
      },
    });
  } catch (error) {
    console.error("slack_dm_autoroute_audit_failed", error instanceof Error ? error.message.slice(0, 120) : "unknown");
  }
}

async function finish(
  orgId: string,
  employeeId: string | null,
  trigger: DmAutorouteTrigger,
  items: DmAutorouteItem[]
): Promise<void> {
  for (const item of items) {
    if (item.outcome === "already_routed") continue; // idempotent no-op: not a change
    await audit({ orgId, employeeId, trigger, item });
  }
}

async function processCounterpart(input: {
  orgId: string;
  employeeId: string;
  employeeSlackUserId: string;
  employeeTeamId: string;
  token: string;
  counterpart: string;
}): Promise<DmAutorouteItem> {
  const base = { counterpartSlackUserId: input.counterpart };
  const info = await slackCall(input.token, "users.info", { user: input.counterpart });
  if (!info.ok) return { ...base, outcome: "skipped", reason: `users_info_${info.error}` };
  const verdict = evaluateSlackCounterpart(info.data.user as Record<string, unknown>, {
    counterpartSlackUserId: input.counterpart,
    employeeTeamId: input.employeeTeamId,
  });
  if (!verdict.ok) return { ...base, outcome: "skipped", reason: verdict.reason };

  const opened = await slackCall(input.token, "conversations.open", {
    users: input.counterpart,
    return_im: true,
  });
  if (!opened.ok) return { ...base, outcome: "failed", reason: `conversations_open_${opened.error}` };
  const channel = (opened.data.channel ?? {}) as Record<string, unknown>;
  const channelId = slackId(channel.id);
  if (!channelId || !isSlackImChannelId(channelId)) {
    return { ...base, outcome: "skipped", reason: "not_a_dm" };
  }
  if (dmLooksExternal(channel)) {
    return { ...base, channelId, outcome: "skipped", reason: "dm_externally_shared" };
  }

  const existingChannel = await getOrgChannel(input.orgId, "slack", channelId);
  if (existingChannel && (existingChannel.classification === "shared_external" || existingChannel.mixed)) {
    return { ...base, channelId, outcome: "skipped", reason: "channel_classified_external" };
  }
  const candidates = await listSlackImRoutesForChannel({
    slackChannelId: channelId,
    slackTeamId: input.employeeTeamId,
  });
  const foreign = candidates.filter(
    (route) => route.orgId !== input.orgId || route.employeeId !== input.employeeId
  );
  if (foreign.length > 0) {
    return { ...base, channelId, outcome: "skipped", reason: "route_conflict" };
  }
  const existingRoute = await getSlackImEmployeeRoute(input.orgId, channelId);
  if (
    existingRoute &&
    existingRoute.employeeId === input.employeeId &&
    existingChannel?.classification === "internal" &&
    !existingChannel.mixed
  ) {
    return { ...base, channelId, outcome: "already_routed", reason: "already_routed" };
  }

  try {
    const { channel: saved, routeEmployeeId } = await applyChannelClassification({
      orgId: input.orgId,
      surface: "slack",
      externalId: channelId,
      classification: "internal",
      mixed: false,
      employeeId: input.employeeId,
      slackTeamId: input.employeeTeamId,
      routeSource: existingRoute && existingRoute.source !== "auto_party" ? "manual" : "auto_party",
      counterpartSlackUserId: input.counterpart,
    });
    if (saved.classification !== "internal" || saved.mixed || routeEmployeeId !== input.employeeId) {
      return { ...base, channelId, outcome: "skipped", reason: "dm_externally_shared" };
    }
    return { ...base, channelId, outcome: "created", reason: "internal_party" };
  } catch (error) {
    const code = error instanceof Error ? errorCode(error.message) : "apply_failed";
    return {
      ...base,
      channelId,
      outcome: code === "connect_cannot_be_internal" ? "skipped" : "failed",
      reason: code === "slack_error" ? "apply_failed" : code,
    };
  }
}

/**
 * Install DM routes for one linked employee. Idempotent. Never throws.
 * `onlyCounterpart` narrows to one party (parties.upsert trigger).
 * `dryRun` (admin MCP preview): read-only — auth.test + users.info only, no
 * conversations.open, no ledger/route write, no audit, works with the flag OFF
 * and never reads the migration-added columns.
 */
export async function syncAutoDmRoutesForEmployee(input: {
  orgId: string;
  employeeId: string;
  trigger: DmAutorouteTrigger;
  onlyCounterpart?: string;
  dryRun?: boolean;
}): Promise<DmAutorouteResult> {
  const dryRun = input.dryRun === true;
  if (!dryRun && !isSlackDmAutorouteEnabled()) return { status: "flag_off", items: [] };
  const orgId = (input.orgId || "").trim();
  const employeeId = (input.employeeId || "").trim();
  try {
    if (!orgId || !employeeId) return { status: "skipped", reason: "invalid_input", items: [] };
    const employee = await getEmployee(employeeId, orgId);
    if (!employee || employee.orgId !== orgId) {
      return { status: "skipped", reason: "employee_not_found", items: [] };
    }
    const skipAll = async (reason: string): Promise<DmAutorouteResult> => {
      const item: DmAutorouteItem = {
        counterpartSlackUserId: input.onlyCounterpart ? slackId(input.onlyCounterpart) : "",
        outcome: "skipped",
        reason,
      };
      if (!dryRun) await finish(orgId, employeeId, input.trigger, [item]);
      return { status: "skipped", reason, items: [item] };
    };
    if (employee.status !== "active") return skipAll("employee_not_active");
    const identity = await getEmployeeSlackIdentity(employeeId);
    if (!identity || identity.orgId !== orgId || identity.status !== "linked") {
      return skipAll("identity_not_linked");
    }
    const employeeTeamId = slackId(identity.slackTeamId);
    const employeeSlackUserId = slackId(identity.slackUserId);
    if (!employeeTeamId || !employeeSlackUserId) return skipAll("identity_team_unknown");

    const only = input.onlyCounterpart ? slackId(input.onlyCounterpart) : "";
    if (input.onlyCounterpart && !only) return skipAll("invalid_counterpart");
    const parties = (await listOrgParties(orgId)).filter(
      (party) => party.orgId === orgId && party.kind === "slack_user" && party.audience === "internal"
    );
    const seen = new Set<string>();
    const counterparts: string[] = [];
    for (const party of parties) {
      const id = slackId(party.identifier);
      if (!id || seen.has(id.toUpperCase())) continue;
      if (id.toUpperCase() === employeeSlackUserId.toUpperCase()) continue;
      if (only && id.toUpperCase() !== only.toUpperCase()) continue;
      seen.add(id.toUpperCase());
      counterparts.push(id);
    }
    if (only && counterparts.length === 0) {
      return { status: "skipped", reason: "counterpart_not_internal_party", items: [] };
    }
    if (counterparts.length === 0) return { status: "done", items: [] };

    // Token is a local only. Never returned, logged, or audited.
    const token = await getLinkedSlackUserToken(employeeId);
    if (!token) return skipAll("user_token_unavailable");
    const whoami = await slackCall(token, "auth.test", {});
    if (!whoami.ok) return skipAll(`auth_test_${whoami.error}`);
    if (
      String(whoami.data.user_id || "").toUpperCase() !== employeeSlackUserId.toUpperCase() ||
      String(whoami.data.team_id || "").toUpperCase() !== employeeTeamId.toUpperCase()
    ) {
      return skipAll("token_identity_mismatch");
    }
    if (!whoami.scopes) return skipAll("token_scopes_unknown");
    if (!whoami.scopes.includes("im:write")) return skipAll("missing_scope_im_write");
    if (!whoami.scopes.includes("users:read")) return skipAll("missing_scope_users_read");

    const items: DmAutorouteItem[] = [];
    for (const [index, counterpart] of counterparts.entries()) {
      if (index >= DM_AUTOROUTE_MAX_COUNTERPARTS) {
        items.push({ counterpartSlackUserId: counterpart, outcome: "skipped", reason: "limit_exceeded" });
        continue;
      }
      if (dryRun) {
        items.push(await previewCounterpart({ token, counterpart, employeeTeamId }));
        continue;
      }
      items.push(
        await processCounterpart({
          orgId,
          employeeId,
          employeeSlackUserId,
          employeeTeamId,
          token,
          counterpart,
        })
      );
    }
    if (!dryRun) await finish(orgId, employeeId, input.trigger, items);
    return { status: "done", items };
  } catch (error) {
    console.error("slack_dm_autoroute_failed", error instanceof Error ? errorCode(error.message) : "unknown");
    return { status: "error", reason: "unexpected_error", items: [] };
  }
}

/** dryRun: the same users.info verdict, without conversations.open or any write. */
async function previewCounterpart(input: {
  token: string;
  counterpart: string;
  employeeTeamId: string;
}): Promise<DmAutorouteItem> {
  const base = { counterpartSlackUserId: input.counterpart };
  const info = await slackCall(input.token, "users.info", { user: input.counterpart });
  if (!info.ok) return { ...base, outcome: "skipped", reason: `users_info_${info.error}` };
  const verdict = evaluateSlackCounterpart(info.data.user as Record<string, unknown>, {
    counterpartSlackUserId: input.counterpart,
    employeeTeamId: input.employeeTeamId,
  });
  if (!verdict.ok) return { ...base, outcome: "skipped", reason: verdict.reason };
  return { ...base, outcome: "would_open", reason: "internal_party" };
}

async function removeRoutes(
  orgId: string,
  routes: SlackImEmployeeRoute[],
  trigger: DmAutorouteTrigger,
  reason: string
): Promise<DmAutorouteItem[]> {
  const items: DmAutorouteItem[] = [];
  for (const route of routes) {
    if (route.orgId !== orgId || route.source !== "auto_party") continue;
    const item: DmAutorouteItem = {
      counterpartSlackUserId: route.counterpartSlackUserId || "",
      channelId: route.slackChannelId,
      outcome: "removed",
      reason,
    };
    try {
      await deleteSlackImEmployeeRoute({ orgId, slackChannelId: route.slackChannelId });
      const channel = await getOrgChannel(orgId, "slack", route.slackChannelId);
      if (channel && channel.classification === "internal") {
        // Do not leave an internal classification behind (reply audience would stay internal).
        await upsertOrgChannel({
          orgId,
          surface: "slack",
          externalId: route.slackChannelId,
          classification: "unknown",
          mixed: false,
          skipInspect: true,
        });
      }
    } catch (error) {
      item.outcome = "failed";
      item.reason = `remove_${error instanceof Error ? errorCode(error.message) : "failed"}`;
    }
    items.push(item);
    await audit({ orgId, employeeId: route.employeeId || null, trigger, item });
  }
  return items;
}

/** Party downgraded to external (or no longer internal): remove its auto routes. Never throws. */
export async function removeAutoDmRoutesForCounterpart(input: {
  orgId: string;
  counterpartSlackUserId: string;
}): Promise<DmAutorouteResult> {
  if (!isSlackDmAutorouteEnabled()) return { status: "flag_off", items: [] };
  const orgId = (input.orgId || "").trim();
  const counterpart = slackId(input.counterpartSlackUserId);
  if (!orgId || !counterpart) return { status: "skipped", reason: "invalid_input", items: [] };
  try {
    const routes = await listAutoSlackImRoutes({ orgId, counterpartSlackUserId: counterpart });
    const items = await removeRoutes(orgId, routes, "party_external", "party_not_internal");
    return { status: "done", items };
  } catch (error) {
    console.error("slack_dm_autoroute_remove_failed", error instanceof Error ? errorCode(error.message) : "unknown");
    return { status: "error", reason: "unexpected_error", items: [] };
  }
}

/** Employee Slack identity revoked: remove that employee's auto routes. Never throws. */
export async function removeAutoDmRoutesForEmployee(input: {
  orgId: string;
  employeeId: string;
}): Promise<DmAutorouteResult> {
  if (!isSlackDmAutorouteEnabled()) return { status: "flag_off", items: [] };
  const orgId = (input.orgId || "").trim();
  const employeeId = (input.employeeId || "").trim();
  if (!orgId || !employeeId) return { status: "skipped", reason: "invalid_input", items: [] };
  try {
    const routes = await listAutoSlackImRoutes({ orgId, employeeId });
    const items = await removeRoutes(orgId, routes, "identity_revoked", "identity_revoked");
    return { status: "done", items };
  } catch (error) {
    console.error("slack_dm_autoroute_remove_failed", error instanceof Error ? errorCode(error.message) : "unknown");
    return { status: "error", reason: "unexpected_error", items: [] };
  }
}

/**
 * parties.upsert fulfillment hook (after the human-approved upsert succeeded).
 * internal slack_user → sync that counterpart for every linked employee of the org.
 * external slack_user → remove that counterpart's auto routes. Never throws.
 */
export async function onSlackUserPartyUpserted(input: {
  orgId: string;
  kind: string;
  identifier: string;
  audience: string;
}): Promise<DmAutorouteResult[]> {
  if (!isSlackDmAutorouteEnabled()) return [];
  if (input.kind !== "slack_user") return [];
  const orgId = (input.orgId || "").trim();
  const counterpart = slackId(input.identifier);
  if (!orgId || !counterpart) return [];
  try {
    if (input.audience !== "internal") {
      return [await removeAutoDmRoutesForCounterpart({ orgId, counterpartSlackUserId: counterpart })];
    }
    const identities = await listLinkedSlackIdentitiesForOrg(orgId);
    const results: DmAutorouteResult[] = [];
    for (const identity of identities) {
      if (identity.orgId !== orgId || identity.status !== "linked") continue;
      results.push(
        await syncAutoDmRoutesForEmployee({
          orgId,
          employeeId: identity.employeeId,
          trigger: "party_upserted",
          onlyCounterpart: counterpart,
        })
      );
    }
    return results;
  } catch (error) {
    console.error("slack_dm_autoroute_party_hook_failed", error instanceof Error ? errorCode(error.message) : "unknown");
    return [];
  }
}
