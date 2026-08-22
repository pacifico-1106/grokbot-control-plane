/** Deterministic demo activity series for dashboard charts (day / week / month). */

export type ActivityRange = "day" | "week" | "month";

export interface ActivityPoint {
  label: string;
  actions: number;
  approvals: number;
  denies: number;
}

export interface EmployeeActivitySummary {
  employeeId: string;
  displayName: string;
  roleLabel: string;
  actions: number;
  approvals: number;
  denies: number;
  /** 0–1; approvals / (approvals + denies), or 1 if none. */
  approvalRate: number;
}

export interface ActivityDemoBundle {
  range: ActivityRange;
  series: ActivityPoint[];
  employees: EmployeeActivitySummary[];
  totals: { actions: number; approvals: number; denies: number };
}

type EmployeeSeed = {
  id: string;
  displayName: string;
  roleLabel: string;
  /** Relative volume weight (higher = busier). */
  weight: number;
  /** Bias toward approvals (0–1). */
  approvalBias: number;
};

const FALLBACK_EMPLOYEES: EmployeeSeed[] = [
  {
    id: "emp_sales",
    displayName: "営業AI社員",
    roleLabel: "営業アシスタント",
    weight: 1.15,
    approvalBias: 0.78,
  },
  {
    id: "emp_ops",
    displayName: "事務AI社員",
    roleLabel: "バックオフィス",
    weight: 0.92,
    approvalBias: 0.86,
  },
  {
    id: "emp_support",
    displayName: "サポートAI社員",
    roleLabel: "カスタマーサポート",
    weight: 0.7,
    approvalBias: 0.9,
  },
];

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 0..1 from seed + bucket index. */
function unit(seed: string, i: number): number {
  const x = Math.sin(hashSeed(`${seed}:${i}`) * 0.0001 + i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function rangeConfig(range: ActivityRange): {
  buckets: number;
  labelFor: (i: number, buckets: number) => string;
  baseActions: number;
} {
  if (range === "day") {
    return {
      buckets: 24,
      baseActions: 6,
      labelFor: (i) => `${String(i).padStart(2, "0")}:00`,
    };
  }
  if (range === "week") {
    const days = ["月", "火", "水", "木", "金", "土", "日"];
    return {
      buckets: 7,
      baseActions: 42,
      labelFor: (i) => days[i] ?? `D${i + 1}`,
    };
  }
  return {
    buckets: 30,
    baseActions: 28,
    // Deterministic labels (no wall-clock Date) to avoid SSR/client hydration drift.
    labelFor: (i) => `${i + 1}日`,
  };
}

function buildSeries(
  range: ActivityRange,
  employeeSeeds: EmployeeSeed[]
): ActivityPoint[] {
  const { buckets, labelFor, baseActions } = rangeConfig(range);
  const orgWeight = employeeSeeds.reduce((s, e) => s + e.weight, 0) || 1;
  const points: ActivityPoint[] = [];

  for (let i = 0; i < buckets; i++) {
    // Mild weekday / business-hours shape
    let shape = 1;
    if (range === "day") {
      const hour = i;
      if (hour < 7 || hour > 21) shape = 0.25;
      else if (hour >= 9 && hour <= 18) shape = 1.15;
      else shape = 0.65;
    } else if (range === "week") {
      shape = i >= 5 ? 0.35 : 1 + unit("week-shape", i) * 0.2;
    } else {
      const dow = (i + 3) % 7; // rough weekend dip
      shape = dow === 5 || dow === 6 ? 0.45 : 1 + unit("month-shape", i) * 0.25;
    }

    const noise = 0.75 + unit(`org-${range}`, i) * 0.5;
    const actions = Math.max(
      0,
      Math.round(baseActions * orgWeight * shape * noise)
    );
    const decisionShare = 0.22 + unit(`dec-${range}`, i) * 0.12;
    const decisions = Math.round(actions * decisionShare);
    const approveShare =
      0.72 + unit(`apr-${range}`, i) * 0.2; // ~72–92%
    const approvals = Math.round(decisions * approveShare);
    const denies = Math.max(0, decisions - approvals);

    points.push({
      label: labelFor(i, buckets),
      actions,
      approvals,
      denies,
    });
  }

  return points;
}

function buildEmployeeSummaries(
  range: ActivityRange,
  series: ActivityPoint[],
  employeeSeeds: EmployeeSeed[]
): EmployeeActivitySummary[] {
  const orgActions = series.reduce((s, p) => s + p.actions, 0);
  const orgApprovals = series.reduce((s, p) => s + p.approvals, 0);
  const orgDenies = series.reduce((s, p) => s + p.denies, 0);
  const totalWeight = employeeSeeds.reduce((s, e) => s + e.weight, 0) || 1;

  return employeeSeeds.map((emp, idx) => {
    const share = emp.weight / totalWeight;
    const jitter = 0.9 + unit(`emp-${emp.id}-${range}`, idx) * 0.2;
    const actions = Math.max(0, Math.round(orgActions * share * jitter));
    const decisionsShare = (orgApprovals + orgDenies) / Math.max(1, orgActions);
    const decisions = Math.round(actions * decisionsShare);
    const approvals = Math.round(decisions * emp.approvalBias);
    const denies = Math.max(0, decisions - approvals);
    const denom = approvals + denies;
    const approvalRate = denom === 0 ? 1 : approvals / denom;

    return {
      employeeId: emp.id,
      displayName: emp.displayName,
      roleLabel: emp.roleLabel,
      actions,
      approvals,
      denies,
      approvalRate,
    };
  });
}

/**
 * Build a deterministic activity bundle for the selected range.
 * Pass real employees when available; otherwise uses sample AI社員 for empty-state charts.
 */
export function getActivityDemo(
  range: ActivityRange,
  employees?: Array<{
    id: string;
    displayName: string;
    roleLabel: string;
  }>
): ActivityDemoBundle {
  const seeds: EmployeeSeed[] =
    employees && employees.length > 0
      ? employees.map((e, i) => ({
          id: e.id,
          displayName: e.displayName,
          roleLabel: e.roleLabel,
          weight: 0.75 + unit(`w-${e.id}`, i) * 0.55,
          approvalBias: 0.72 + unit(`b-${e.id}`, i) * 0.2,
        }))
      : FALLBACK_EMPLOYEES;

  const series = buildSeries(range, seeds);
  const employeeSummaries = buildEmployeeSummaries(range, series, seeds);
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
  };
}
