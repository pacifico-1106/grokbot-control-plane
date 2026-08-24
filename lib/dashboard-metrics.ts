/** Live dashboard activity/cost from audit (production). No demo seed. */

import type { ActivityPoint, ActivityRange, EmployeeActivitySummary } from "./activity-demo";
import type { CostPoint, CostDemoBundle, EmployeeCostRow } from "./cost-demo";
import {
  PLAN_CONFIRM_QUOTAS,
  PLAN_OVERAGE_YEN,
  type PlanCode,
} from "./billing/plans";

export type DashboardEmployee = {
  id: string;
  displayName: string;
  roleLabel: string;
};

export type DashboardAuditEvent = {
  employeeId: string | null;
  action: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

export type LiveActivityBundle = {
  range: ActivityRange;
  series: ActivityPoint[];
  employees: EmployeeActivitySummary[];
  totals: { actions: number; approvals: number; denies: number };
  empty: boolean;
};

/** Deterministic labels for SSR-safe empty placeholders. */
function staticBuckets(range: ActivityRange): {
  buckets: number;
  labelFor: (i: number) => string;
} {
  if (range === "day") {
    return {
      buckets: 24,
      labelFor: (i) => `${String(i).padStart(2, "0")}:00`,
    };
  }
  if (range === "week") {
    const days = ["月", "火", "水", "木", "金", "土", "日"];
    return { buckets: 7, labelFor: (i) => days[i] ?? `D${i + 1}` };
  }
  return { buckets: 30, labelFor: (i) => `${i + 1}日` };
}

/** Wall-clock window for live audit bucketing (client after mount). */
function rangeBuckets(range: ActivityRange): {
  buckets: number;
  labelFor: (i: number) => string;
  startMs: number;
  bucketMs: number;
} {
  if (range === "day") {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() - 23);
    return {
      buckets: 24,
      labelFor: (i) => {
        const d = new Date(start.getTime() + i * 3600_000);
        return `${String(d.getHours()).padStart(2, "0")}:00`;
      },
      startMs: start.getTime(),
      bucketMs: 3600_000,
    };
  }
  if (range === "week") {
    const days = ["日", "月", "火", "水", "木", "金", "土"];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return {
      buckets: 7,
      labelFor: (i) => {
        const d = new Date(start.getTime() + i * 86400_000);
        return days[d.getDay()] ?? `D${i + 1}`;
      },
      startMs: start.getTime(),
      bucketMs: 86400_000,
    };
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  return {
    buckets: 30,
    labelFor: (i) => `${i + 1}日`,
    startMs: start.getTime(),
    bucketMs: 86400_000,
  };
}

function classify(ev: DashboardAuditEvent): "action" | "approval" | "deny" | null {
  if (ev.action === "approval.resolved") {
    const decision = ev.metadata?.decision;
    if (decision === "rejected") return "deny";
    return "approval";
  }
  if (
    ev.action === "tool.invoke" ||
    ev.action === "approval.requested" ||
    ev.action === "credential.issued" ||
    ev.action === "employee.created" ||
    ev.action === "employee.updated" ||
    ev.action === "gateway.link_changed"
  ) {
    return "action";
  }
  return null;
}

/** Build activity from audit events. Empty when no events in range. */
export function buildLiveActivity(
  range: ActivityRange,
  employees: DashboardEmployee[],
  events: DashboardAuditEvent[]
): LiveActivityBundle {
  const { buckets, labelFor, startMs, bucketMs } = rangeBuckets(range);
  const series: ActivityPoint[] = Array.from({ length: buckets }, (_, i) => ({
    label: labelFor(i),
    actions: 0,
    approvals: 0,
    denies: 0,
  }));

  const byEmp = new Map<
    string,
    { actions: number; approvals: number; denies: number }
  >();
  for (const e of employees) {
    byEmp.set(e.id, { actions: 0, approvals: 0, denies: 0 });
  }

  let any = false;
  for (const ev of events) {
    const t = new Date(ev.createdAt).getTime();
    if (!Number.isFinite(t) || t < startMs) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((t - startMs) / bucketMs)));
    const kind = classify(ev);
    if (!kind) continue;
    any = true;
    const point = series[idx];
    if (kind === "action") point.actions += 1;
    else if (kind === "approval") point.approvals += 1;
    else point.denies += 1;

    const eid = ev.employeeId;
    if (eid && byEmp.has(eid)) {
      const row = byEmp.get(eid)!;
      if (kind === "action") row.actions += 1;
      else if (kind === "approval") row.approvals += 1;
      else row.denies += 1;
    }
  }

  const employeeSummaries: EmployeeActivitySummary[] = employees.map((e) => {
    const row = byEmp.get(e.id) ?? { actions: 0, approvals: 0, denies: 0 };
    const denom = row.approvals + row.denies;
    return {
      employeeId: e.id,
      displayName: e.displayName,
      roleLabel: e.roleLabel,
      actions: row.actions,
      approvals: row.approvals,
      denies: row.denies,
      approvalRate: denom === 0 ? 1 : row.approvals / denom,
    };
  });

  const totals = {
    actions: series.reduce((s, p) => s + p.actions, 0),
    approvals: series.reduce((s, p) => s + p.approvals, 0),
    denies: series.reduce((s, p) => s + p.denies, 0),
  };

  return {
    range,
    series,
    employees: employeeSummaries,
    totals,
    empty: !any,
  };
}

export type LiveCostInput = {
  plan: PlanCode | string;
  usedUnits: number;
  employees: DashboardEmployee[];
  events: DashboardAuditEvent[];
  range: ActivityRange;
};

/** Cost tab from real confirm meter + audit (no demo overshoot seed). */
export function buildLiveCost(input: LiveCostInput): CostDemoBundle & { empty: boolean } {
  const planKey = (input.plan || "business") as PlanCode;
  const included =
    PLAN_CONFIRM_QUOTAS[planKey] ?? PLAN_CONFIRM_QUOTAS.business;
  const overageYen =
    PLAN_OVERAGE_YEN[planKey] ?? PLAN_OVERAGE_YEN.business;
  const usedUnits = Math.max(0, Math.floor(input.usedUnits) || 0);
  const overageUnits = Math.max(0, usedUnits - included);
  const estimatedOverageYen = overageUnits * overageYen;

  const { buckets, labelFor, startMs, bucketMs } = rangeBuckets(input.range);
  const series: CostPoint[] = Array.from({ length: buckets }, (_, i) => ({
    label: labelFor(i),
    units: 0,
    yen: 0,
  }));

  const byEmp = new Map<string, number>();
  for (const e of input.employees) byEmp.set(e.id, 0);

  let meteredEvents = 0;
  for (const ev of input.events) {
    const meta = ev.metadata ?? {};
    if (meta.type !== "gated_confirm_action") continue;
    if (meta.billable === false) continue;
    meteredEvents += 1;
    const t = new Date(ev.createdAt).getTime();
    if (Number.isFinite(t) && t >= startMs) {
      const idx = Math.min(
        buckets - 1,
        Math.max(0, Math.floor((t - startMs) / bucketMs))
      );
      series[idx].units += 1;
    }
    if (ev.employeeId && byEmp.has(ev.employeeId)) {
      byEmp.set(ev.employeeId, (byEmp.get(ev.employeeId) ?? 0) + 1);
    }
  }

  // Prefer month meter total for headline; series may be sparse subset of audit window.
  const displayUsed = usedUnits > 0 ? usedUnits : meteredEvents;
  const shareBase = Math.max(1, [...byEmp.values()].reduce((a, b) => a + b, 0));

  const employeesRows: EmployeeCostRow[] = input.employees.map((e) => {
    const units = byEmp.get(e.id) ?? 0;
    const share = units / shareBase;
    return {
      employeeId: e.id,
      displayName: e.displayName,
      roleLabel: e.roleLabel,
      units,
      share: displayUsed === 0 ? 0 : share,
      yen: Math.round(estimatedOverageYen * share),
    };
  });

  const planLabel =
    planKey === "starter"
      ? "Starter 月次枠"
      : planKey === "managed"
        ? "Managed 月次枠"
        : "Business 月次枠";

  return {
    range: input.range,
    plan: {
      includedUnits: included,
      overageYenPerUnit: overageYen,
      planLabel,
    },
    usedUnits: displayUsed,
    remainingUnits: Math.max(0, included - displayUsed),
    overageUnits: Math.max(0, displayUsed - included),
    metered: displayUsed > included,
    estimatedOverageYen:
      Math.max(0, displayUsed - included) * overageYen,
    estimatedPeriodYen:
      Math.max(0, displayUsed - included) * overageYen,
    series,
    employees: employeesRows,
    empty: displayUsed === 0 && meteredEvents === 0,
  };
}

export function emptyActivity(
  range: ActivityRange,
  employees: DashboardEmployee[]
): LiveActivityBundle {
  const { buckets, labelFor } = staticBuckets(range);
  return {
    range,
    series: Array.from({ length: buckets }, (_, i) => ({
      label: labelFor(i),
      actions: 0,
      approvals: 0,
      denies: 0,
    })),
    employees: employees.map((e) => ({
      employeeId: e.id,
      displayName: e.displayName,
      roleLabel: e.roleLabel,
      actions: 0,
      approvals: 0,
      denies: 0,
      approvalRate: 1,
    })),
    totals: { actions: 0, approvals: 0, denies: 0 },
    empty: true,
  };
}
