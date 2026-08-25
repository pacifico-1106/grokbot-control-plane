import { appendAuditEvent } from "@/lib/data/audit";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

type ActionCount = { countToday: number; countThisMonth: number };

const demoEvents: Array<{
  orgId: string;
  employeeId: string;
  tool: string;
  createdAt: string;
}> = [];

function tokyoParts(date = new Date()): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function tokyoActionPeriod(date = new Date()): string {
  const { year, month } = tokyoParts(date);
  return `${year}-${month}`;
}

export function startOfTokyoDayIso(date = new Date()): string {
  const { year, month, day } = tokyoParts(date);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)) - 9 * 60 * 60 * 1000).toISOString();
}

export async function getActionCounts(input: {
  orgId: string;
  employeeId: string;
  tool: string;
  now?: Date;
}): Promise<ActionCount> {
  const now = input.now ?? new Date();
  const period = tokyoActionPeriod(now);
  const dayStart = startOfTokyoDayIso(now);
  if (isDemoMode()) {
    const matches = demoEvents.filter(
      (event) => event.orgId === input.orgId && event.employeeId === input.employeeId && event.tool === input.tool
    );
    return {
      countToday: matches.filter((event) => event.createdAt >= dayStart).length,
      countThisMonth: matches.filter((event) => tokyoActionPeriod(new Date(event.createdAt)) === period).length,
    };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { countToday: 0, countThisMonth: 0 };
  const [{ data: counter }, { count: countToday }] = await Promise.all([
    admin
      .from("action_counters")
      .select("count")
      .eq("org_id", input.orgId)
      .eq("employee_id", input.employeeId)
      .eq("period", period)
      .eq("tool", input.tool)
      .maybeSingle(),
    admin
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", input.orgId)
      .eq("employee_id", input.employeeId)
      .gte("created_at", dayStart)
      .contains("metadata", { actionCounter: true, tool: input.tool }),
  ]);
  return {
    countToday: countToday ?? 0,
    countThisMonth: Number(counter?.count || 0),
  };
}

/** Called only at the same successful Gateway completion boundary as billing meter. */
export async function incrementActionCounter(input: {
  orgId: string;
  employeeId: string;
  credentialId?: string | null;
  tool: string;
  jobId: string;
  purpose?: string | null;
}): Promise<void> {
  const now = new Date();
  if (isDemoMode()) {
    demoEvents.push({
      orgId: input.orgId,
      employeeId: input.employeeId,
      tool: input.tool,
      createdAt: now.toISOString(),
    });
  } else {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new Error("supabase_not_configured");
    const { error } = await admin.rpc("increment_action_counter", {
      p_org_id: input.orgId,
      p_employee_id: input.employeeId,
      p_period: tokyoActionPeriod(now),
      p_tool: input.tool,
    });
    if (error) throw new Error(error.message || "action_counter_increment_failed");
  }
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: input.credentialId ?? null,
    action: "tool.invoke",
    purpose: input.purpose ?? null,
    summary: `行為カウント: ${input.tool}`,
    metadata: {
      actionCounter: true,
      tool: input.tool,
      jobId: input.jobId,
      period: tokyoActionPeriod(now),
    },
  });
}
