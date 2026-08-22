/** Deterministic demo cost / quota estimates for dashboard (day / week / month). */

import type { ActivityRange } from "./activity-demo";

export interface CostPlanQuota {
  /** Included units in the selected period (actions / tool calls proxy). */
  includedUnits: number;
  /** Yen per unit once over quota (従量). */
  overageYenPerUnit: number;
  planLabel: string;
}

export interface CostPoint {
  label: string;
  units: number;
  /** Estimated yen for this bucket (only overage portion, or full metered share). */
  yen: number;
}

export interface EmployeeCostRow {
  employeeId: string;
  displayName: string;
  roleLabel: string;
  units: number;
  /** Share of org usage 0–1. */
  share: number;
  /** Estimated yen attributed to this employee (overage allocated by share). */
  yen: number;
}

export interface CostDemoBundle {
  range: ActivityRange;
  plan: CostPlanQuota;
  usedUnits: number;
  remainingUnits: number;
  overageUnits: number;
  /** True when used > included (従量課金が発生). */
  metered: boolean;
  estimatedOverageYen: number;
  /** Soft estimate of period total (base plan portion is not billed here). */
  estimatedPeriodYen: number;
  series: CostPoint[];
  employees: EmployeeCostRow[];
}

type EmployeeSeed = {
  id: string;
  displayName: string;
  roleLabel: string;
  weight: number;
};

const FALLBACK: EmployeeSeed[] = [
  {
    id: "emp_sales",
    displayName: "営業AI社員",
    roleLabel: "営業アシスタント",
    weight: 1.2,
  },
  {
    id: "emp_ops",
    displayName: "事務AI社員",
    roleLabel: "バックオフィス",
    weight: 0.95,
  },
  {
    id: "emp_support",
    displayName: "サポートAI社員",
    roleLabel: "カスタマーサポート",
    weight: 0.7,
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

function unit(seed: string, i: number): number {
  const x = Math.sin(hashSeed(`${seed}:${i}`) * 0.0001 + i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function planFor(range: ActivityRange): CostPlanQuota {
  // SME-friendly included quota; overage is 従量
  if (range === "day") {
    return {
      includedUnits: 120,
      overageYenPerUnit: 8,
      planLabel: "Business 日次枠",
    };
  }
  if (range === "week") {
    return {
      includedUnits: 700,
      overageYenPerUnit: 8,
      planLabel: "Business 週次枠",
    };
  }
  return {
    includedUnits: 2800,
    overageYenPerUnit: 8,
    planLabel: "Business 月次枠",
  };
}

function rangeBuckets(range: ActivityRange): {
  buckets: number;
  labelFor: (i: number, buckets: number) => string;
  baseUnits: number;
} {
  if (range === "day") {
    return {
      buckets: 24,
      baseUnits: 8,
      labelFor: (i) => `${String(i).padStart(2, "0")}:00`,
    };
  }
  if (range === "week") {
    const days = ["月", "火", "水", "木", "金", "土", "日"];
    return {
      buckets: 7,
      baseUnits: 110,
      labelFor: (i) => days[i] ?? `D${i + 1}`,
    };
  }
  return {
    buckets: 30,
    baseUnits: 95,
    labelFor: (i, buckets) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (buckets - 1 - i));
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    },
  };
}

/**
 * Deterministic cost / quota bundle for the selected range.
 * Intentionally pushes some ranges slightly over quota so 従量状態が見える.
 */
export function getCostDemo(
  range: ActivityRange,
  employees?: Array<{ id: string; displayName: string; roleLabel: string }>
): CostDemoBundle {
  const seeds: EmployeeSeed[] =
    employees && employees.length > 0
      ? employees.map((e, i) => ({
          id: e.id,
          displayName: e.displayName,
          roleLabel: e.roleLabel,
          weight: 0.75 + unit(`cw-${e.id}`, i) * 0.6,
        }))
      : FALLBACK;

  const plan = planFor(range);
  const { buckets, labelFor, baseUnits } = rangeBuckets(range);
  const orgWeight = seeds.reduce((s, e) => s + e.weight, 0) || 1;

  const series: CostPoint[] = [];
  let usedUnits = 0;

  for (let i = 0; i < buckets; i++) {
    let shape = 1;
    if (range === "day") {
      const hour = i;
      if (hour < 7 || hour > 21) shape = 0.2;
      else if (hour >= 9 && hour <= 18) shape = 1.2;
      else shape = 0.6;
    } else if (range === "week") {
      shape = i >= 5 ? 0.3 : 1.05 + unit("c-week", i) * 0.25;
    } else {
      const dow = (i + 2) % 7;
      shape = dow === 5 || dow === 6 ? 0.4 : 1 + unit("c-month", i) * 0.3;
    }

    // Slight overshoot bias so metered state appears on week/month demos
    const overshoot = range === "day" ? 1.05 : range === "week" ? 1.18 : 1.22;
    const noise = 0.8 + unit(`c-org-${range}`, i) * 0.45;
    const units = Math.max(
      0,
      Math.round(baseUnits * orgWeight * shape * noise * overshoot * 0.45)
    );
    usedUnits += units;
    series.push({ label: labelFor(i, buckets), units, yen: 0 });
  }

  const remainingUnits = Math.max(0, plan.includedUnits - usedUnits);
  const overageUnits = Math.max(0, usedUnits - plan.includedUnits);
  const metered = overageUnits > 0;
  const estimatedOverageYen = overageUnits * plan.overageYenPerUnit;
  // Period estimate: only overage is shown as variable cost for SME clarity
  const estimatedPeriodYen = estimatedOverageYen;

  // Allocate cumulative overage across buckets proportionally for trend line
  let running = 0;
  for (const p of series) {
    running += p.units;
    const overAt = Math.max(0, running - plan.includedUnits);
    const prevOver = Math.max(0, running - p.units - plan.includedUnits);
    const bucketOverage = overAt - prevOver;
    p.yen = bucketOverage * plan.overageYenPerUnit;
  }

  const totalWeight = seeds.reduce((s, e) => s + e.weight, 0) || 1;
  const employeesRows: EmployeeCostRow[] = seeds.map((emp, idx) => {
    const share =
      (emp.weight / totalWeight) *
      (0.92 + unit(`c-share-${emp.id}-${range}`, idx) * 0.16);
    const normalized = share; // will re-normalize below
    return {
      employeeId: emp.id,
      displayName: emp.displayName,
      roleLabel: emp.roleLabel,
      units: 0,
      share: normalized,
      yen: 0,
    };
  });

  const shareSum = employeesRows.reduce((s, r) => s + r.share, 0) || 1;
  for (const row of employeesRows) {
    row.share = row.share / shareSum;
    row.units = Math.round(usedUnits * row.share);
    row.yen = Math.round(estimatedOverageYen * row.share);
  }
  // Fix rounding drift on last row
  if (employeesRows.length > 0) {
    const unitsSum = employeesRows.reduce((s, r) => s + r.units, 0);
    const yenSum = employeesRows.reduce((s, r) => s + r.yen, 0);
    employeesRows[employeesRows.length - 1].units += usedUnits - unitsSum;
    employeesRows[employeesRows.length - 1].yen += estimatedOverageYen - yenSum;
  }

  return {
    range,
    plan,
    usedUnits,
    remainingUnits,
    overageUnits,
    metered,
    estimatedOverageYen,
    estimatedPeriodYen,
    series,
    employees: employeesRows,
  };
}

export function formatYen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}
