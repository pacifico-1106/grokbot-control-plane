/**
 * Slack employee re-authorize links (SLACK_AUTHORIZE_LINK_ENABLED, default OFF).
 *
 * Only a sha256 hash of the link token is stored. Rows are always read/written
 * with an explicit org_id (tenant isolation); there is no lookup that returns a
 * row of another org. Requires migration 20261004100000_slack_authorize_links.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type SlackAuthorizeLinkStatus = "issued" | "consumed" | "completed" | "rejected" | "superseded" | "revoked";

export type SlackAuthorizeLink = {
  id: string;
  orgId: string;
  employeeId: string;
  expectedSlackUserId: string | null;
  expectedTeamId: string;
  status: SlackAuthorizeLinkStatus;
  resultReason: string | null;
  boundSlackUserId: string | null;
  deliveredInboxId: string | null;
  deliveredChannelId: string | null;
  deliveredUserId: string | null;
  approvalId: string | null;
  issuedVia: "ticket" | "audit_only";
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DemoRow = SlackAuthorizeLink & { tokenHash: string };
const demoLinks = new Map<string, DemoRow>();

const COLUMNS =
  "id,org_id,employee_id,expected_slack_user_id,expected_team_id,status,result_reason,bound_slack_user_id," +
  "delivered_inbox_id,delivered_channel_id,delivered_user_id,approval_id,issued_via,expires_at,consumed_at,created_at,updated_at";

const STATUSES: SlackAuthorizeLinkStatus[] = ["issued", "consumed", "completed", "rejected", "superseded", "revoked"];

function nowIso(): string {
  return new Date().toISOString();
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function mapRow(row: Record<string, unknown>): SlackAuthorizeLink {
  const status = String(row.status || "") as SlackAuthorizeLinkStatus;
  return {
    id: String(row.id ?? ""),
    orgId: String(row.org_id ?? ""),
    employeeId: String(row.employee_id ?? ""),
    expectedSlackUserId: strOrNull(row.expected_slack_user_id),
    expectedTeamId: String(row.expected_team_id ?? ""),
    status: STATUSES.includes(status) ? status : "revoked",
    resultReason: strOrNull(row.result_reason),
    boundSlackUserId: strOrNull(row.bound_slack_user_id),
    deliveredInboxId: strOrNull(row.delivered_inbox_id),
    deliveredChannelId: strOrNull(row.delivered_channel_id),
    deliveredUserId: strOrNull(row.delivered_user_id),
    approvalId: strOrNull(row.approval_id),
    issuedVia: row.issued_via === "audit_only" ? "audit_only" : "ticket",
    expiresAt: String(row.expires_at ?? ""),
    consumedAt: strOrNull(row.consumed_at),
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

function publicOf(row: DemoRow): SlackAuthorizeLink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tokenHash: _omit, ...rest } = row;
  return { ...rest };
}

function isLive(link: { status: string; expiresAt: string }, now = Date.now()): boolean {
  return link.status === "issued" && Date.parse(link.expiresAt) > now;
}

export type CreateSlackAuthorizeLinkInput = {
  orgId: string;
  employeeId: string;
  tokenHash: string;
  expectedSlackUserId: string | null;
  expectedTeamId: string;
  expiresAt: string;
  deliveredInboxId: string;
  deliveredChannelId: string;
  deliveredUserId: string;
  approvalId: string | null;
  issuedVia: "ticket" | "audit_only";
};

/**
 * Insert a new link and supersede every other live link of the same employee
 * (at most one usable link per employee).
 */
export async function createSlackAuthorizeLink(input: CreateSlackAuthorizeLinkInput): Promise<SlackAuthorizeLink> {
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) throw new Error("invalid_token_hash");
  const at = nowIso();
  if (isDemoMode()) {
    for (const row of demoLinks.values()) {
      if (row.orgId === input.orgId && row.employeeId === input.employeeId && row.status === "issued") {
        row.status = "superseded";
        row.updatedAt = at;
      }
    }
    const row: DemoRow = {
      id: `sal_${Math.random().toString(36).slice(2, 12)}${demoLinks.size}`,
      orgId: input.orgId,
      employeeId: input.employeeId,
      tokenHash: input.tokenHash,
      expectedSlackUserId: input.expectedSlackUserId,
      expectedTeamId: input.expectedTeamId,
      status: "issued",
      resultReason: null,
      boundSlackUserId: null,
      deliveredInboxId: input.deliveredInboxId,
      deliveredChannelId: input.deliveredChannelId,
      deliveredUserId: input.deliveredUserId,
      approvalId: input.approvalId,
      issuedVia: input.issuedVia,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    demoLinks.set(row.id, row);
    return publicOf(row);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { error: supersedeError } = await admin
    .from("slack_authorize_links")
    .update({ status: "superseded", updated_at: at })
    .eq("org_id", input.orgId)
    .eq("employee_id", input.employeeId)
    .eq("status", "issued");
  if (supersedeError) throw new Error("slack_authorize_link_supersede_failed");
  const { data, error } = await admin
    .from("slack_authorize_links")
    .insert({
      org_id: input.orgId,
      employee_id: input.employeeId,
      token_hash: input.tokenHash,
      expected_slack_user_id: input.expectedSlackUserId,
      expected_team_id: input.expectedTeamId,
      status: "issued",
      delivered_inbox_id: input.deliveredInboxId,
      delivered_channel_id: input.deliveredChannelId,
      delivered_user_id: input.deliveredUserId,
      approval_id: input.approvalId,
      issued_via: input.issuedVia,
      expires_at: input.expiresAt,
      created_at: at,
      updated_at: at,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error("slack_authorize_link_save_failed");
  return mapRow(data as unknown as Record<string, unknown>);
}

/** Live (issued + unexpired) link for a token hash, or null. */
export async function findLiveSlackAuthorizeLinkByHash(tokenHash: string): Promise<SlackAuthorizeLink | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  if (isDemoMode()) {
    for (const row of demoLinks.values()) {
      if (row.tokenHash === tokenHash) return isLive(row) ? publicOf(row) : null;
    }
    return null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("slack_authorize_links")
    .select(COLUMNS)
    .eq("token_hash", tokenHash)
    .eq("status", "issued")
    .gt("expires_at", nowIso())
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data as unknown as Record<string, unknown>);
}

export async function getSlackAuthorizeLink(id: string, orgId: string): Promise<SlackAuthorizeLink | null> {
  if (!id || !orgId) return null;
  if (isDemoMode()) {
    const row = demoLinks.get(id);
    return row && row.orgId === orgId ? publicOf(row) : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("slack_authorize_links")
    .select(COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data as unknown as Record<string, unknown>);
}

/**
 * Atomically consume a live link (issued → consumed). Returns the row only for
 * the single caller that won; expired / used / other-org / other-employee → null.
 */
export async function consumeSlackAuthorizeLink(input: {
  id: string;
  orgId: string;
  employeeId: string;
}): Promise<SlackAuthorizeLink | null> {
  const at = nowIso();
  if (isDemoMode()) {
    const row = demoLinks.get(input.id);
    if (!row || row.orgId !== input.orgId || row.employeeId !== input.employeeId || !isLive(row)) return null;
    row.status = "consumed";
    row.consumedAt = at;
    row.updatedAt = at;
    return publicOf(row);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("slack_authorize_links")
    .update({ status: "consumed", consumed_at: at, updated_at: at })
    .eq("id", input.id)
    .eq("org_id", input.orgId)
    .eq("employee_id", input.employeeId)
    .eq("status", "issued")
    .gt("expires_at", at)
    .select(COLUMNS)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data as unknown as Record<string, unknown>);
}

export async function finishSlackAuthorizeLink(input: {
  id: string;
  orgId: string;
  status: "completed" | "rejected" | "revoked";
  reason: string;
  boundSlackUserId?: string | null;
}): Promise<void> {
  const at = nowIso();
  const reason = /^[a-z0-9_]{1,64}$/.test(input.reason) ? input.reason : "unknown";
  const bound = input.boundSlackUserId && /^[UW][A-Z0-9]{2,30}$/.test(input.boundSlackUserId) ? input.boundSlackUserId : null;
  if (isDemoMode()) {
    const row = demoLinks.get(input.id);
    if (!row || row.orgId !== input.orgId) return;
    row.status = input.status;
    row.resultReason = reason;
    row.boundSlackUserId = bound;
    row.updatedAt = at;
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin
    .from("slack_authorize_links")
    .update({ status: input.status, result_reason: reason, bound_slack_user_id: bound, updated_at: at })
    .eq("id", input.id)
    .eq("org_id", input.orgId);
}

/** Test helper (demo store only). */
export function resetDemoSlackAuthorizeLinks(): void {
  demoLinks.clear();
}
