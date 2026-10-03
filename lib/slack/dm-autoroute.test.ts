/**
 * SLACK_DM_AUTOROUTE_ENABLED (Plan A) — demo mode, network mocked.
 * Covers: flag OFF inert, create + wake works, idempotency, external/stranger/
 * other-team/guest/bot skip, missing im:write, existing external classification
 * not overwritten, route conflict, party → external removal, revoke removal,
 * manual routes untouched, org_id tenant isolation, and no token leakage.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyChannelClassification } from "@/lib/admin-mcp/channel-classify";
import { getOrgChannel, upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import {
  getSlackImEmployeeRoute,
  resolveSlackUserTokenImWakeTarget,
  upsertSlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";
import { getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import {
  DM_AUTOROUTE_MAX_COUNTERPARTS,
  evaluateSlackCounterpart,
  onSlackUserPartyUpserted,
  removeAutoDmRoutesForEmployee,
  syncAutoDmRoutesForEmployee,
} from "@/lib/slack/dm-autoroute";
import { SLACK_USER_SCOPES, slackAuthorizeUrl, slackUserScopesForAuthorize } from "@/lib/slack/oauth";
import type { AuditEvent, Employee } from "@/lib/types";

const TEAM = "TAUTOTEAM1";
const OTHER_TEAM = "TEVILTEAM9";
const TOKEN = "xoxp-autoroute-SECRET-token-777";
const FLAGS = ["SLACK_DM_AUTOROUTE_ENABLED", "SLACK_USER_SCOPE_IM_WRITE"] as const;

type SlackUser = Record<string, unknown>;
type Call = { method: string; body: Record<string, unknown>; auth: string };

let saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let seq = 0;
let calls: Call[] = [];
let users: Map<string, SlackUser>;
let scopes: string | null;
let dmFlags: Record<string, boolean>;
let whoami: { user_id: string; team_id: string } | null;
let usersInfoError: string | null;

function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`.replace(/[^A-Z0-9]/gi, "").slice(0, 30);
}

function dmFor(counterpart: string, employeeUser: string): string {
  return `D${(employeeUser + counterpart).replace(/[^A-Z0-9]/gi, "").slice(-20)}`.toUpperCase();
}

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "").split("?")[0];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    calls.push({ method, body, auth });
    const json = (data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "auth.test") {
      if (!whoami) return json({ ok: false, error: "invalid_auth" });
      return json({ ok: true, ...whoami }, scopes === null ? {} : { "x-oauth-scopes": scopes });
    }
    if (method === "users.info") {
      if (usersInfoError) return json({ ok: false, error: usersInfoError });
      const user = users.get(String(body.user));
      return user ? json({ ok: true, user }) : json({ ok: false, error: "user_not_found" });
    }
    if (method === "conversations.open") {
      const employeeUser = whoami?.user_id || "";
      return json({ ok: true, channel: { id: dmFor(String(body.users), employeeUser), is_im: true, ...dmFlags } });
    }
    if (method === "conversations.info") return json({ ok: false, error: "channel_not_found" });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

function member(id: string, extra: SlackUser = {}): SlackUser {
  return { id, team_id: TEAM, deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false, ...extra };
}

type Tenant = { orgId: string; employee: Employee; slackUserId: string; cleanup: () => Promise<void> };

async function tenant(opts?: { team?: string; link?: boolean }): Promise<Tenant> {
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm");
  if (!base) throw new Error("missing emp_comm");
  const orgId = `org_ar_${uid("o").toLowerCase()}`;
  const slackUserId = uid("UEMP");
  const employee: Employee = {
    ...base,
    id: `emp_ar_${uid("e").toLowerCase()}`,
    orgId,
    status: "active",
    allowedAccounts: [{ service: "slack", accountId: slackUserId }],
  };
  getRuntimeEmployees().push(employee);
  if (opts?.link !== false) {
    await bindEmployeeSlackIdentity({
      employeeId: employee.id,
      orgId,
      slackUserId,
      slackTeamId: opts?.team ?? TEAM,
      displayName: "自動ルート検証",
      userToken: TOKEN,
    });
  }
  whoami = { user_id: slackUserId, team_id: opts?.team ?? TEAM };
  return {
    orgId,
    employee,
    slackUserId,
    cleanup: async () => {
      await revokeEmployeeSlackIdentity({ employeeId: employee.id, orgId });
      const list = getRuntimeEmployees();
      const idx = list.findIndex((item) => item.id === employee.id);
      if (idx >= 0) list.splice(idx, 1);
    },
  };
}

async function internalParty(orgId: string, user: SlackUser | string, audience: "internal" | "external" = "internal") {
  const id = typeof user === "string" ? user : String(user.id);
  if (typeof user !== "string") users.set(id, user);
  await upsertOrgParty({ orgId, kind: "slack_user", identifier: id, audience });
  return id;
}

function auditsFor(orgId: string): AuditEvent[] {
  return getRuntimeAudit().filter(
    (event) => event.orgId === orgId && String(event.metadata?.event || "").startsWith("slack_dm_autoroute.")
  );
}

function methods(): string[] {
  return calls.map((call) => call.method);
}

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
  process.env.SLACK_DM_AUTOROUTE_ENABLED = "1";
  delete process.env.SLACK_USER_SCOPE_IM_WRITE;
  savedFetch = globalThis.fetch;
  users = new Map();
  scopes = "chat:write,users:read,im:history,im:write";
  dmFlags = {};
  usersInfoError = null;
  installFetch();
});

afterEach(() => {
  for (const flag of FLAGS) {
    if (saved[flag] === undefined) delete process.env[flag];
    else process.env[flag] = saved[flag];
  }
  globalThis.fetch = savedFetch;
});

describe("flags default OFF", () => {
  test("SLACK_DM_AUTOROUTE_ENABLED off → no Slack call, no audit, no route", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.status).toBe("flag_off");
    expect(await onSlackUserPartyUpserted({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "internal" })).toEqual([]);
    expect((await removeAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id })).status).toBe("flag_off");
    expect(calls.length).toBe(0);
    expect(auditsFor(t.orgId).length).toBe(0);
    expect(await getSlackImEmployeeRoute(t.orgId, dmFor(counterpart, t.slackUserId))).toBeNull();
    await t.cleanup();
  });

  test("SLACK_USER_SCOPE_IM_WRITE off → authorize URL unchanged; on → im:write appended once", () => {
    expect(slackUserScopesForAuthorize()).toBe(SLACK_USER_SCOPES);
    expect(slackAuthorizeUrl("s")).toContain(`user_scope=${encodeURIComponent(SLACK_USER_SCOPES)}`);
    process.env.SLACK_USER_SCOPE_IM_WRITE = "1";
    const scoped = slackUserScopesForAuthorize();
    expect(scoped).toBe(`${SLACK_USER_SCOPES},im:write`);
    expect(scoped.split(",").filter((s) => s === "im:write").length).toBe(1);
    expect(slackAuthorizeUrl("s")).toContain(encodeURIComponent("im:write"));
    expect(SLACK_USER_SCOPES).not.toContain("im:write");
  });
});

describe("Plan A create", () => {
  test("internal party → DM opened with the employee token, route + internal class installed, wake resolves", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    const dm = dmFor(counterpart, t.slackUserId);
    expect(result.status).toBe("done");
    expect(result.items).toEqual([{ counterpartSlackUserId: counterpart, outcome: "created", reason: "internal_party", channelId: dm }]);
    expect(methods().filter((m) => m !== "conversations.info")).toEqual(["auth.test", "users.info", "conversations.open"]);
    expect(calls.filter((c) => c.method !== "conversations.info").every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const route = await getSlackImEmployeeRoute(t.orgId, dm);
    expect(route?.employeeId).toBe(t.employee.id);
    expect(route?.source).toBe("auto_party");
    expect(route?.counterpartSlackUserId).toBe(counterpart);
    const channel = await getOrgChannel(t.orgId, "slack", dm);
    expect(channel?.classification).toBe("internal");
    expect(channel?.mixed).toBe(false);
    const target = await resolveSlackUserTokenImWakeTarget({ slackChannelId: dm, slackTeamId: TEAM, authorizedSlackUserId: t.slackUserId });
    expect(target?.employeeId).toBe(t.employee.id);
    const audits = auditsFor(t.orgId);
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe("admin.channel");
    expect(audits[0].metadata?.auditClass).toBe("admin");
    expect(audits[0].metadata?.event).toBe("slack_dm_autoroute.created");
    expect(audits[0].metadata?.trigger).toBe("identity_linked");
    await t.cleanup();
  });

  test("idempotent: second run is a no-op (no new audit, same single route)", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    const again = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "party_upserted" });
    expect(again.items.map((i) => i.outcome)).toEqual(["already_routed"]);
    expect(auditsFor(t.orgId).length).toBe(1);
    expect((await getSlackImEmployeeRoute(t.orgId, dmFor(counterpart, t.slackUserId)))?.source).toBe("auto_party");
    await t.cleanup();
  });

  test("external party and self are never opened", async () => {
    const t = await tenant();
    const ext = await internalParty(t.orgId, member(uid("UEXT")), "external");
    await internalParty(t.orgId, t.slackUserId);
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.items).toEqual([]);
    expect(calls.some((c) => c.method === "users.info" || c.method === "conversations.open")).toBe(false);
    expect(await getSlackImEmployeeRoute(t.orgId, dmFor(ext, t.slackUserId))).toBeNull();
    await t.cleanup();
  });
});

describe("Slack Connect / external / undeterminable → skip (fail-closed)", () => {
  const cases: Array<[string, SlackUser, string]> = [
    ["stranger", { is_stranger: true }, "slack_connect_stranger"],
    ["other team", { team_id: OTHER_TEAM }, "other_workspace"],
    ["no team", { team_id: "" }, "team_undeterminable"],
    ["guest", { is_restricted: true }, "guest_user"],
    ["single-channel guest", { is_ultra_restricted: true }, "guest_user"],
    ["bot", { is_bot: true }, "bot_user"],
    ["deleted", { deleted: true }, "user_deleted"],
    ["grid other workspace", { enterprise_user: { enterprise_id: "E1", teams: [OTHER_TEAM] } }, "other_workspace"],
  ];
  for (const [label, extra, reason] of cases) {
    test(`${label} → skipped (${reason}), no DM opened, audited`, async () => {
      const t = await tenant();
      const counterpart = await internalParty(t.orgId, member(uid("UCP"), extra));
      const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
      expect(result.items.map((i) => [i.outcome, i.reason])).toEqual([["skipped", reason]]);
      expect(methods()).not.toContain("conversations.open");
      expect(await getSlackImEmployeeRoute(t.orgId, dmFor(counterpart, t.slackUserId))).toBeNull();
      expect(auditsFor(t.orgId).map((a) => a.metadata?.event)).toEqual(["slack_dm_autoroute.skipped"]);
      await t.cleanup();
    });
  }

  test("users.info error → skipped, no DM", async () => {
    const t = await tenant();
    await internalParty(t.orgId, member(uid("UCP")));
    usersInfoError = "missing_scope";
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.items[0]).toMatchObject({ outcome: "skipped", reason: "users_info_missing_scope" });
    expect(methods()).not.toContain("conversations.open");
    await t.cleanup();
  });

  test("evaluateSlackCounterpart: null / id mismatch are undeterminable", () => {
    expect(evaluateSlackCounterpart(null, { counterpartSlackUserId: "U1", employeeTeamId: TEAM })).toEqual({ ok: false, reason: "user_undeterminable" });
    expect(evaluateSlackCounterpart(member("U2"), { counterpartSlackUserId: "U1", employeeTeamId: TEAM })).toEqual({ ok: false, reason: "user_undeterminable" });
    expect(evaluateSlackCounterpart(member("U1"), { counterpartSlackUserId: "U1", employeeTeamId: TEAM })).toEqual({ ok: true });
  });

  for (const flag of ["is_ext_shared", "is_shared", "is_org_shared", "is_pending_ext_shared"]) {
    test(`DM ${flag}=true → skipped, nothing written`, async () => {
      const t = await tenant();
      const counterpart = await internalParty(t.orgId, member(uid("UCP")));
      dmFlags = { [flag]: true };
      const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
      expect(result.items[0]).toMatchObject({ outcome: "skipped", reason: "dm_externally_shared" });
      const dm = dmFor(counterpart, t.slackUserId);
      expect(await getSlackImEmployeeRoute(t.orgId, dm)).toBeNull();
      expect(await getOrgChannel(t.orgId, "slack", dm)).toBeNull();
      await t.cleanup();
    });
  }

  test("existing shared_external / mixed classification is not overwritten", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    const dm = dmFor(counterpart, t.slackUserId);
    await upsertOrgChannel({ orgId: t.orgId, surface: "slack", externalId: dm, classification: "shared_external", mixed: true, skipInspect: true });
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.items[0]).toMatchObject({ outcome: "skipped", reason: "channel_classified_external" });
    expect((await getOrgChannel(t.orgId, "slack", dm))?.classification).toBe("shared_external");
    expect(await getSlackImEmployeeRoute(t.orgId, dm)).toBeNull();
    await t.cleanup();
  });
});

describe("token / scope checks", () => {
  test("token without im:write → whole run skipped before any users.info / open", async () => {
    const t = await tenant();
    await internalParty(t.orgId, member(uid("UCP")));
    scopes = "chat:write,users:read,im:history";
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result).toMatchObject({ status: "skipped", reason: "missing_scope_im_write" });
    expect(methods()).toEqual(["auth.test"]);
    expect(auditsFor(t.orgId)[0]?.metadata?.reason).toBe("missing_scope_im_write");
    await t.cleanup();
  });

  test("scopes header missing → fail-closed", async () => {
    const t = await tenant();
    await internalParty(t.orgId, member(uid("UCP")));
    scopes = null;
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.reason).toBe("token_scopes_unknown");
    expect(methods()).toEqual(["auth.test"]);
    await t.cleanup();
  });

  test("token belongs to a different user/team → skipped", async () => {
    const t = await tenant();
    await internalParty(t.orgId, member(uid("UCP")));
    whoami = { user_id: "UOTHERPERSON", team_id: TEAM };
    expect((await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" })).reason).toBe("token_identity_mismatch");
    whoami = { user_id: t.slackUserId, team_id: OTHER_TEAM };
    expect((await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" })).reason).toBe("token_identity_mismatch");
    expect(methods().filter((m) => m !== "auth.test")).toEqual([]);
    await t.cleanup();
  });

  test("unlinked identity → skipped without any Slack call", async () => {
    const t = await tenant({ link: false });
    await internalParty(t.orgId, member(uid("UCP")));
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.reason).toBe("identity_not_linked");
    expect(calls.length).toBe(0);
    await t.cleanup();
  });

  test("counterparts beyond the per-run cap are skipped (limit_exceeded)", async () => {
    const t = await tenant();
    for (let i = 0; i < DM_AUTOROUTE_MAX_COUNTERPARTS + 2; i += 1) await internalParty(t.orgId, member(uid("UCAP")));
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.items.filter((i) => i.outcome === "created").length).toBe(DM_AUTOROUTE_MAX_COUNTERPARTS);
    expect(result.items.filter((i) => i.reason === "limit_exceeded").length).toBe(2);
    expect(calls.filter((c) => c.method === "conversations.open").length).toBe(DM_AUTOROUTE_MAX_COUNTERPARTS);
    await t.cleanup();
  });
});

describe("conflicts and removal", () => {
  test("DM already routed to another employee → skipped, not overwritten", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    const other = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
    const otherEmp: Employee = { ...other, id: `emp_ar_other_${uid("x").toLowerCase()}`, orgId: t.orgId, status: "active" };
    getRuntimeEmployees().push(otherEmp);
    const dm = dmFor(counterpart, t.slackUserId);
    await upsertSlackImEmployeeRoute({ orgId: t.orgId, slackChannelId: dm, slackTeamId: TEAM, employeeId: otherEmp.id });
    const result = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    expect(result.items[0]).toMatchObject({ outcome: "skipped", reason: "route_conflict" });
    expect((await getSlackImEmployeeRoute(t.orgId, dm))?.employeeId).toBe(otherEmp.id);
    await t.cleanup();
  });

  test("parties.upsert hook: internal → created for every linked employee; external → removed + reset to unknown", async () => {
    const t = await tenant();
    const counterpartUser = member(uid("UCP"));
    users.set(String(counterpartUser.id), counterpartUser);
    const counterpart = String(counterpartUser.id);
    await upsertOrgParty({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "internal" });
    const created = await onSlackUserPartyUpserted({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "internal" });
    expect(created.flatMap((r) => r.items.map((i) => i.outcome))).toEqual(["created"]);
    const dm = dmFor(counterpart, t.slackUserId);
    expect(auditsFor(t.orgId).at(0)?.metadata?.trigger).toBe("party_upserted");

    await upsertOrgParty({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "external" });
    const removed = await onSlackUserPartyUpserted({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "external" });
    expect(removed.flatMap((r) => r.items.map((i) => i.outcome))).toEqual(["removed"]);
    expect(await getSlackImEmployeeRoute(t.orgId, dm)).toBeNull();
    expect((await getOrgChannel(t.orgId, "slack", dm))?.classification).toBe("unknown");
    expect(await resolveSlackUserTokenImWakeTarget({ slackChannelId: dm, slackTeamId: TEAM, authorizedSlackUserId: t.slackUserId })).toBeNull();
    expect(auditsFor(t.orgId).map((a) => a.metadata?.event)).toContain("slack_dm_autoroute.removed");
    await t.cleanup();
  });

  test("identity revoked → that employee's auto routes removed", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
    const dm = dmFor(counterpart, t.slackUserId);
    expect(await getSlackImEmployeeRoute(t.orgId, dm)).not.toBeNull();
    const result = await removeAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id });
    expect(result.items.map((i) => i.outcome)).toEqual(["removed"]);
    expect(await getSlackImEmployeeRoute(t.orgId, dm)).toBeNull();
    await t.cleanup();
  });

  test("manual (human channels.classify) route is never removed by the auto cleanup", async () => {
    const t = await tenant();
    const counterpart = await internalParty(t.orgId, member(uid("UCP")));
    const dm = dmFor(counterpart, t.slackUserId);
    await applyChannelClassification({ orgId: t.orgId, surface: "slack", externalId: dm, classification: "internal", mixed: false, employeeId: t.employee.id, slackTeamId: TEAM });
    expect((await getSlackImEmployeeRoute(t.orgId, dm))?.source).toBe("manual");
    await upsertOrgParty({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "external" });
    const removed = await onSlackUserPartyUpserted({ orgId: t.orgId, kind: "slack_user", identifier: counterpart, audience: "external" });
    expect(removed.flatMap((r) => r.items)).toEqual([]);
    expect((await getSlackImEmployeeRoute(t.orgId, dm))?.employeeId).toBe(t.employee.id);
    await t.cleanup();
  });
});

describe("tenant isolation (org_id)", () => {
  test("org B's internal party never produces a route for org A's employee, and vice versa", async () => {
    const a = await tenant();
    const b = await tenant();
    const bParty = member(uid("UBPARTY"));
    await internalParty(b.orgId, bParty);
    whoami = { user_id: a.slackUserId, team_id: TEAM };
    const resultA = await syncAutoDmRoutesForEmployee({ orgId: a.orgId, employeeId: a.employee.id, trigger: "identity_linked" });
    expect(resultA.items).toEqual([]);
    expect(methods().filter((m) => m !== "auth.test")).toEqual([]);
    expect(await getSlackImEmployeeRoute(a.orgId, dmFor(String(bParty.id), a.slackUserId))).toBeNull();

    // The party hook for org B only iterates org B's linked employees.
    calls = [];
    whoami = { user_id: b.slackUserId, team_id: TEAM };
    const hook = await onSlackUserPartyUpserted({ orgId: b.orgId, kind: "slack_user", identifier: String(bParty.id), audience: "internal" });
    expect(hook.length).toBe(1);
    expect(hook[0].items.map((i) => i.outcome)).toEqual(["created"]);
    expect(await getSlackImEmployeeRoute(b.orgId, dmFor(String(bParty.id), b.slackUserId))).not.toBeNull();
    expect(auditsFor(a.orgId).length).toBe(0);
    expect(auditsFor(b.orgId).every((ev) => ev.orgId === b.orgId)).toBe(true);
    await a.cleanup();
    await b.cleanup();
  });

  test("same Slack user internal in org A but external in org B → only org A gets a route", async () => {
    const a = await tenant();
    const shared = member(uid("USHARED"));
    await internalParty(a.orgId, shared);
    const b = await tenant();
    await internalParty(b.orgId, String(shared.id), "external");
    whoami = { user_id: b.slackUserId, team_id: TEAM };
    expect((await syncAutoDmRoutesForEmployee({ orgId: b.orgId, employeeId: b.employee.id, trigger: "identity_linked" })).items).toEqual([]);
    whoami = { user_id: a.slackUserId, team_id: TEAM };
    expect((await syncAutoDmRoutesForEmployee({ orgId: a.orgId, employeeId: a.employee.id, trigger: "identity_linked" })).items[0].outcome).toBe("created");
    await a.cleanup();
    await b.cleanup();
  });

  test("employee id from another org is rejected (employee_not_found), nothing called", async () => {
    const a = await tenant();
    const b = await tenant();
    await internalParty(a.orgId, member(uid("UCP")));
    calls = [];
    const result = await syncAutoDmRoutesForEmployee({ orgId: a.orgId, employeeId: b.employee.id, trigger: "identity_linked" });
    expect(result.reason).toBe("employee_not_found");
    expect(calls.length).toBe(0);
    await a.cleanup();
    await b.cleanup();
  });
});

describe("secrets", () => {
  test("token never appears in results, audits, or console output", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const key of ["log", "info", "warn", "error"] as const) {
      console[key] = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
    }
    try {
      const t = await tenant();
      await internalParty(t.orgId, member(uid("UCP")));
      await internalParty(t.orgId, member(uid("UCP"), { is_stranger: true }));
      const ok = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
      usersInfoError = "ratelimited";
      await internalParty(t.orgId, member(uid("UCP")));
      const failed = await syncAutoDmRoutesForEmployee({ orgId: t.orgId, employeeId: t.employee.id, trigger: "identity_linked" });
      const haystack = JSON.stringify({ ok, failed, audits: auditsFor(t.orgId), logs });
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain("SECRET-token");
      await t.cleanup();
    } finally {
      Object.assign(console, orig);
    }
  });
});

describe("trigger wiring: human-approved parties.upsert fulfillment", () => {
  test("fulfillApprovedAdmin(parties.upsert internal) installs the DM route; flag OFF installs nothing", async () => {
    const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
    const t = await tenant();
    const cp = member(uid("UFUL"));
    users.set(String(cp.id), cp);
    const approval = (id: string) => ({
      id,
      orgId: t.orgId,
      employeeId: t.employee.id,
      credentialId: null,
      title: "相手台帳の更新",
      summary: "parties.upsert",
      purpose: "admin.parties",
      risk: "medium",
      tool: "parties.upsert",
      status: "approved",
      createdAt: new Date().toISOString(),
      metadata: {
        approvalClass: "admin",
        adminTool: "parties.upsert",
        adminMutation: { kind: "slack_user", identifier: String(cp.id), audience: "internal" },
      },
    }) as unknown as import("@/lib/types").ApprovalRequest;
    delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
    const off = await fulfillApprovedAdmin(approval(`apr_ar_off_${uid("a")}`));
    expect(off?.ok).toBe(true);
    expect(calls.length).toBe(0);
    expect(await getSlackImEmployeeRoute(t.orgId, dmFor(String(cp.id), t.slackUserId))).toBeNull();

    process.env.SLACK_DM_AUTOROUTE_ENABLED = "1";
    const on = await fulfillApprovedAdmin(approval(`apr_ar_on_${uid("a")}`));
    expect(on?.ok).toBe(true);
    const route = await getSlackImEmployeeRoute(t.orgId, dmFor(String(cp.id), t.slackUserId));
    expect(route?.employeeId).toBe(t.employee.id);
    expect(route?.source).toBe("auto_party");
    await t.cleanup();
  });
});
