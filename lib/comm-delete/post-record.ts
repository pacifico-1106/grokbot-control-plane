/**
 * Records of posts Staffpass made, used as the ONLY authority for comm.delete.
 *
 * A post record is written into the audit event of a successful conversation
 * post (ids only, never the body):
 *   metadata.postRecord = { v: 1, surface: "slack", channel, messageId, postedVia }
 * - auto post: the `tool.invoke` audit (lib/gateway/invoke.ts)
 * - approved post: the `slack.posted` audit (lib/approvals/fulfill.ts)
 * `postedVia` is the token that actually made the post ("user" = the employee's
 * own Slack user token for posting_as=user, "bot" = the org conversation bot,
 * including the app-DM bot fallback). chat.delete uses the same token.
 *
 * Legacy approved posts (slack.posted written before post records) are accepted
 * only when the approval itself confirms them: same org + employee, its stored
 * fulfillment has the same channel + ts, and its snapshot says which identity
 * posted (posting_as).
 *
 * Every lookup is scoped by org AND employee AND a time window; audit_events
 * writes are server-only (20261004500000).
 */
import { getRuntimeAudit } from "@/lib/demo-data";
import { getApprovalById } from "@/lib/data/approvals";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { CommDeleteTarget } from "./target";

export type PostRecord = {
  v: 1;
  surface: "slack";
  channel: string;
  messageId: string;
  postedVia: "user" | "bot";
};

export type DeleteRecord = { v: 1; surface: string; channel: string; messageId: string };

/** Audit actions that may carry a post record (writers above). */
export const POST_RECORD_ACTIONS = ["tool.invoke", "slack.posted"] as const;
/** Audit actions that mean "this post is already gone" (idempotency). */
export const DELETE_DONE_ACTIONS = ["comm.delete.succeeded", "comm.delete.already_deleted"] as const;

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function s(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Build the record from a conversation delivery; null unless a real Slack post with ids + postedVia. */
export function buildSlackPostRecord(delivery: unknown): PostRecord | null {
  const d = rec(delivery);
  if (!d || d.ok !== true || d.delivery !== "slack") return null;
  const channel = s(d.channel);
  const messageId = s(d.ts);
  const postedVia = d.postedVia === "user" || d.postedVia === "bot" ? d.postedVia : null;
  if (!channel || !messageId || !postedVia) return null;
  return { v: 1, surface: "slack", channel, messageId, postedVia };
}

export function readPostRecord(metadata: unknown): PostRecord | null {
  const r = rec(rec(metadata)?.postRecord);
  if (!r || r.v !== 1 || r.surface !== "slack") return null;
  const postedVia = r.postedVia === "user" || r.postedVia === "bot" ? r.postedVia : null;
  const channel = s(r.channel);
  const messageId = s(r.messageId);
  if (!postedVia || !channel || !messageId) return null;
  return { v: 1, surface: "slack", channel, messageId, postedVia };
}

export function buildDeleteRecord(target: CommDeleteTarget): DeleteRecord {
  return { v: 1, surface: target.surface, channel: target.channel, messageId: target.messageId };
}

type Row = {
  id: string;
  orgId: string;
  employeeId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type FoundPostRecord = {
  postedVia: "user" | "bot";
  source: "post_record" | "legacy_approved_post";
  auditId: string;
  postedAt: string;
  approvalId?: string;
};

export type LookupResult<T> = { ok: true; found: T | null } | { ok: false; code: "comm_delete_unavailable" };

type Scope = { orgId: string; employeeId: string; target: CommDeleteTarget; sinceIso: string };

function inScope(row: Row, scope: Scope): boolean {
  return (
    row.orgId === scope.orgId &&
    row.employeeId === scope.employeeId &&
    new Date(row.createdAt).getTime() >= new Date(scope.sinceIso).getTime()
  );
}

function mapRow(raw: Record<string, unknown>): Row {
  return {
    id: String(raw.id ?? ""),
    orgId: String(raw.org_id ?? ""),
    employeeId: raw.employee_id == null ? null : String(raw.employee_id),
    action: String(raw.action ?? ""),
    metadata: rec(raw.metadata) ?? {},
    createdAt: String(raw.created_at ?? ""),
  };
}

const SELECT = "id, org_id, employee_id, action, metadata, created_at";

async function fetchRows(
  scope: Scope,
  actions: readonly string[],
  jsonEq: Record<string, string>
): Promise<Row[] | null> {
  if (isDemoMode()) {
    return getRuntimeAudit()
      .map((e) => ({ id: e.id, orgId: e.orgId, employeeId: e.employeeId, action: e.action, metadata: e.metadata ?? {}, createdAt: e.createdAt }))
      .filter((row) => actions.includes(row.action) && inScope(row, scope));
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  let query = admin
    .from("audit_events")
    .select(SELECT)
    .eq("org_id", scope.orgId)
    .eq("employee_id", scope.employeeId)
    .in("action", [...actions])
    .gte("created_at", scope.sinceIso);
  for (const [path, value] of Object.entries(jsonEq)) query = query.eq(path, value);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(10);
  if (error || !Array.isArray(data)) return null;
  return data.map((r) => mapRow(r as Record<string, unknown>)).filter((row) => inScope(row, scope));
}

/** The employee's own post record for exactly this target (or null). */
export async function findOwnPostRecord(scope: Scope): Promise<LookupResult<FoundPostRecord>> {
  const { target } = scope;
  if (target.surface !== "slack") return { ok: true, found: null };
  const rows = await fetchRows(scope, POST_RECORD_ACTIONS, {
    "metadata->postRecord->>surface": "slack",
    "metadata->postRecord->>channel": target.channel,
    "metadata->postRecord->>messageId": target.messageId,
  });
  if (!rows) return { ok: false, code: "comm_delete_unavailable" };
  for (const row of rows) {
    const record = readPostRecord(row.metadata);
    if (record && record.channel === target.channel && record.messageId === target.messageId) {
      return {
        ok: true,
        found: {
          postedVia: record.postedVia,
          source: "post_record",
          auditId: row.id,
          postedAt: row.createdAt,
          ...(s(row.metadata.approvalId) ? { approvalId: s(row.metadata.approvalId) } : {}),
        },
      };
    }
  }

  const legacy = await fetchRows(scope, ["slack.posted"], {
    "metadata->>channel": target.channel,
    "metadata->>ts": target.messageId,
    "metadata->>phase": "approval.fulfill",
  });
  if (!legacy) return { ok: false, code: "comm_delete_unavailable" };
  for (const row of legacy) {
    if (s(row.metadata.channel) !== target.channel || s(row.metadata.ts) !== target.messageId) continue;
    if (s(row.metadata.phase) !== "approval.fulfill") continue;
    const approvalId = s(row.metadata.approvalId);
    if (!approvalId) continue;
    let approval: Awaited<ReturnType<typeof getApprovalById>>;
    try {
      approval = await getApprovalById(approvalId, scope.orgId);
    } catch {
      return { ok: false, code: "comm_delete_unavailable" };
    }
    if (!approval || approval.orgId !== scope.orgId || approval.employeeId !== scope.employeeId) continue;
    const fulfillment = rec(approval.metadata?.fulfillment);
    if (!fulfillment || fulfillment.ok !== true || s(fulfillment.channel) !== target.channel || s(fulfillment.ts) !== target.messageId) {
      continue;
    }
    const snapshot = rec(approval.metadata?.invoke);
    if (!snapshot || typeof snapshot.postingAs !== "string") continue;
    return {
      ok: true,
      found: {
        postedVia: normalizePostingAs(snapshot.postingAs),
        source: "legacy_approved_post",
        auditId: row.id,
        postedAt: row.createdAt,
        approvalId,
      },
    };
  }
  return { ok: true, found: null };
}

/** A successful earlier delete of this target by this employee (idempotency). */
export async function findOwnDeleteDone(scope: Scope): Promise<LookupResult<{ auditId: string; at: string }>> {
  const { target } = scope;
  const rows = await fetchRows(scope, DELETE_DONE_ACTIONS, {
    "metadata->deleteRecord->>surface": target.surface,
    "metadata->deleteRecord->>channel": target.channel,
    "metadata->deleteRecord->>messageId": target.messageId,
  });
  if (!rows) return { ok: false, code: "comm_delete_unavailable" };
  for (const row of rows) {
    const d = rec(row.metadata.deleteRecord);
    if (d && d.surface === target.surface && d.channel === target.channel && d.messageId === target.messageId) {
      return { ok: true, found: { auditId: row.id, at: row.createdAt } };
    }
  }
  return { ok: true, found: null };
}
