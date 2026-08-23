/**
 * Ando pricing BM P0 — meter only Gateway confirm-class completions.
 * Event: gated_confirm_action. No Grok token resale; do not claim metering
 * of all bot actions outside Gateway.
 */

import { appendAuditEvent, listAuditEvents } from "../data/audit";
import {
  DEMO_ORG,
  getRuntimeMeterRecords,
  pushRuntimeMeterRecord,
} from "../demo-data";
import { isConfirmClassTool, type GatewayToolDef } from "../gateway/tools";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import type { PlanKey } from "./entitlements";
import {
  QUOTA_PROVISIONAL_NOTE_JA,
  confirmQuotaForPlan,
} from "./plans";

export {
  PLAN_CONFIRM_QUOTAS,
  QUOTA_PROVISIONAL_NOTE_JA,
  confirmQuotaForPlan,
} from "./plans";

/** Meter event type (fixed). */
export const METER_EVENT_GATED_CONFIRM = "gated_confirm_action" as const;

export type MeterEventType = typeof METER_EVENT_GATED_CONFIRM;

export interface GatedConfirmMeterRecord {
  type: typeof METER_EVENT_GATED_CONFIRM;
  orgId: string;
  employeeId: string;
  tool: string;
  jobId: string;
  billable: boolean;
  purpose?: string | null;
  createdAt: string;
  id?: string;
}

export function isBillableConfirmCompletion(def: GatewayToolDef): boolean {
  return isConfirmClassTool(def);
}

/**
 * Record a successful confirm-class Gateway completion.
 * Dual-mode: demo memory + audit_events metadata (Supabase when configured).
 */
export async function recordGatedConfirmAction(input: {
  orgId: string;
  employeeId: string;
  tool: string;
  jobId: string;
  purpose?: string | null;
  credentialId?: string | null;
  billable?: boolean;
}): Promise<GatedConfirmMeterRecord> {
  const billable = input.billable !== false;
  const createdAt = new Date().toISOString();
  const record: GatedConfirmMeterRecord = {
    type: METER_EVENT_GATED_CONFIRM,
    orgId: input.orgId,
    employeeId: input.employeeId,
    tool: input.tool,
    jobId: input.jobId,
    billable,
    purpose: input.purpose ?? null,
    createdAt,
  };

  if (isDemoMode()) {
    const stored = pushRuntimeMeterRecord(record);
    // Also mirror into audit for executives browsing 監査.
    const audit = (await import("../demo-data")).pushRuntimeAuditEvent;
    audit({
      orgId: input.orgId || DEMO_ORG.id,
      employeeId: input.employeeId,
      credentialId: input.credentialId ?? null,
      action: "tool.invoke",
      purpose: input.purpose ?? null,
      summary: billable
        ? `確定アクション計測: ${input.tool}（課金対象）`
        : `ゲートウェイ完了: ${input.tool}（非課金）`,
      metadata: {
        type: METER_EVENT_GATED_CONFIRM,
        tool: input.tool,
        jobId: input.jobId,
        billable,
        meter: true,
      },
    });
    return stored;
  }

  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: input.credentialId ?? null,
    action: "tool.invoke",
    purpose: input.purpose ?? null,
    summary: billable
      ? `確定アクション計測: ${input.tool}（課金対象）`
      : `ゲートウェイ完了: ${input.tool}（非課金）`,
    metadata: {
      type: METER_EVENT_GATED_CONFIRM,
      tool: input.tool,
      jobId: input.jobId,
      billable,
      meter: true,
    },
  });

  return record;
}

function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function isBillableGatedConfirmMeta(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  if (meta.type !== METER_EVENT_GATED_CONFIRM) return false;
  if (meta.billable === false) return false;
  return true;
}

/**
 * Count billable gated_confirm_action events for the current UTC month.
 * Demo: in-memory meter store. Prod: audit_events metadata.
 */
export async function countGatedConfirmsThisMonth(
  orgId?: string | null
): Promise<number> {
  const since = startOfMonthUtc().toISOString();
  const oid = orgId || (isDemoMode() ? DEMO_ORG.id : null);

  if (isDemoMode()) {
    return getRuntimeMeterRecords().filter(
      (r) =>
        r.billable &&
        r.type === METER_EVENT_GATED_CONFIRM &&
        (!oid || r.orgId === oid) &&
        r.createdAt >= since
    ).length;
  }

  if (!oid) return 0;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    // Fallback: list recent audit and filter (bounded).
    const events = await listAuditEvents(oid, 500);
    return events.filter(
      (e) =>
        e.createdAt >= since &&
        isBillableGatedConfirmMeta(e.metadata)
    ).length;
  }

  const { data, error } = await admin
    .from("audit_events")
    .select("id, metadata, created_at")
    .eq("org_id", oid)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error || !data) return 0;
  return data.filter((row) =>
    isBillableGatedConfirmMeta(
      (row as { metadata?: Record<string, unknown> }).metadata
    )
  ).length;
}

export type ConfirmUsageSummary = {
  used: number;
  quota: number;
  plan: PlanKey;
  provisionalNoteJa: string;
  /** used / quota, capped display helper */
  remaining: number;
};

export async function getConfirmUsageSummary(
  orgId: string | null | undefined,
  plan: PlanKey
): Promise<ConfirmUsageSummary> {
  const used = await countGatedConfirmsThisMonth(orgId);
  const quota = confirmQuotaForPlan(plan);
  return {
    used,
    quota,
    plan,
    provisionalNoteJa: QUOTA_PROVISIONAL_NOTE_JA,
    remaining: Math.max(0, quota - used),
  };
}
