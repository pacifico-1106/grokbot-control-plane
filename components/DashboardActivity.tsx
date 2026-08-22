"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getActivityDemo,
  type ActivityPoint,
  type ActivityRange,
  type EmployeeActivitySummary,
} from "@/lib/activity-demo";
import {
  formatYen,
  getCostDemo,
  type CostPoint,
  type EmployeeCostRow,
} from "@/lib/cost-demo";

const RANGES: { id: ActivityRange; label: string }[] = [
  { id: "day", label: "日次" },
  { id: "week", label: "週次" },
  { id: "month", label: "月次" },
];

type BoardTab = "activity" | "cost";

type EmployeeInput = {
  id: string;
  displayName: string;
  roleLabel: string;
};

function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Max that never returns -Infinity / NaN (empty spread / bad values). */
function safeMax(floor: number, values: number[]): number {
  let m = floor;
  for (const v of values) {
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

function finiteOr(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

function AreaLineChart({ series }: { series: ActivityPoint[] }) {
  const width = 640;
  const height = 180;
  const padX = 12;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const maxY = safeMax(
    1,
    series.map((p) => Math.max(finiteOr(p.actions), finiteOr(p.approvals) + finiteOr(p.denies)))
  );

  const xAt = (i: number) =>
    padX + (series.length <= 1 ? innerW / 2 : (i / Math.max(1, series.length - 1)) * innerW);
  const yAt = (v: number) => padY + innerH - (finiteOr(v) / maxY) * innerH;

  const actionsPath = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.actions).toFixed(1)}`)
    .join(" ");

  const areaPath =
    series.length === 0
      ? ""
      : `${actionsPath} L ${xAt(series.length - 1).toFixed(1)} ${(padY + innerH).toFixed(1)} L ${xAt(0).toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;

  const approvalsPath = series
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.approvals).toFixed(1)}`
    )
    .join(" ");

  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const tickLabels = series
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % labelEvery === 0 || i === series.length - 1);

  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label="組織アクティビティ推移"
      >
        <defs>
          <linearGradient id="actionsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75, 1].map((t) => {
          const y = padY + innerH * (1 - t);
          return (
            <line
              key={t}
              x1={padX}
              x2={width - padX}
              y1={y}
              y2={y}
              stroke="var(--border-soft)"
              strokeWidth="1"
            />
          );
        })}

        {areaPath ? (
          <path d={areaPath} fill="url(#actionsFill)" stroke="none" />
        ) : null}
        {actionsPath ? (
          <path
            d={actionsPath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {approvalsPath ? (
          <path
            d={approvalsPath}
            fill="none"
            stroke="var(--ok)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.9"
          />
        ) : null}

        {tickLabels.map(({ p, i }) => (
          <text
            key={`${p.label}-${i}`}
            x={Number(xAt(i).toFixed(1))}
            y={height - 2}
            textAnchor="middle"
            fill="var(--text-faint)"
            fontSize="9"
          >
            {p.label}
          </text>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: "var(--accent)" }}
          />
          アクション
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: "var(--ok)", opacity: 0.9 }}
          />
          承認
        </span>
      </div>
    </div>
  );
}

function CostTrendChart({ series }: { series: CostPoint[] }) {
  const width = 640;
  const height = 160;
  const padX = 12;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const maxY = safeMax(1, series.map((p) => finiteOr(p.units)));

  const xAt = (i: number) =>
    padX + (series.length <= 1 ? innerW / 2 : (i / Math.max(1, series.length - 1)) * innerW);
  const yAt = (v: number) => padY + innerH - (finiteOr(v) / maxY) * innerH;

  const path = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.units).toFixed(1)}`)
    .join(" ");
  const area =
    series.length === 0
      ? ""
      : `${path} L ${xAt(series.length - 1).toFixed(1)} ${(padY + innerH).toFixed(1)} L ${xAt(0).toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;

  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const tickLabels = series
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % labelEvery === 0 || i === series.length - 1);

  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label="使用量推移"
      >
        <defs>
          <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--warn)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--warn)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((t) => {
          const y = padY + innerH * (1 - t);
          return (
            <line
              key={t}
              x1={padX}
              x2={width - padX}
              y1={y}
              y2={y}
              stroke="var(--border-soft)"
              strokeWidth="1"
            />
          );
        })}
        {area ? <path d={area} fill="url(#costFill)" /> : null}
        {path ? (
          <path
            d={path}
            fill="none"
            stroke="var(--warn)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {tickLabels.map(({ p, i }) => (
          <text
            key={`${p.label}-${i}`}
            x={Number(xAt(i).toFixed(1))}
            y={height - 2}
            textAnchor="middle"
            fill="var(--text-faint)"
            fontSize="9"
          >
            {p.label}
          </text>
        ))}
      </svg>
      <div className="mt-2 text-[11px] muted">使用量（ユニット）推移 · 超過後は従量</div>
    </div>
  );
}

function EmployeeBars({ rows }: { rows: EmployeeActivitySummary[] }) {
  const maxActions = safeMax(1, rows.map((r) => finiteOr(r.actions)));

  return (
    <ul className="space-y-3">
      {rows.length === 0 ? (
        <li className="text-xs faint">表示できる活動がありません</li>
      ) : null}
      {rows.map((row) => {
        const widthPct = Math.min(
          100,
          Math.max(0, Math.round((finiteOr(row.actions) / maxActions) * 100))
        );
        return (
          <li key={row.employeeId}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm truncate">{row.displayName}</div>
                <div className="text-[11px] faint truncate">{row.roleLabel}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm tabular-nums">{row.actions}</div>
                <div className="text-[11px] muted">
                  承認率 {formatPct(row.approvalRate)}
                </div>
              </div>
            </div>
            <div
              className="mt-2 h-1.5 rounded-full overflow-hidden"
              style={{ background: "var(--bg-soft)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${widthPct}%`,
                  background:
                    "linear-gradient(90deg, color-mix(in oklab, var(--accent) 70%, transparent), var(--accent))",
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EmployeeCostTable({ rows }: { rows: EmployeeCostRow[] }) {
  const maxUnits = safeMax(1, rows.map((r) => finiteOr(r.units)));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] muted border-b border-[var(--border-soft)]">
            <th className="pb-2 font-normal">AI社員</th>
            <th className="pb-2 font-normal text-right">使用量</th>
            <th className="pb-2 font-normal text-right">超過推計</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-3 text-xs faint">
                表示できるコスト内訳がありません
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const widthPct = Math.min(
              100,
              Math.max(0, Math.round((finiteOr(row.units) / maxUnits) * 100))
            );
            return (
              <tr
                key={row.employeeId}
                className="border-b border-[var(--border-soft)] last:border-0"
              >
                <td className="py-2.5 pr-3">
                  <div className="truncate">{row.displayName}</div>
                  <div className="text-[11px] faint truncate">{row.roleLabel}</div>
                  <div
                    className="mt-1.5 h-1 rounded-full overflow-hidden max-w-[140px]"
                    style={{ background: "var(--bg-soft)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${widthPct}%`,
                        background: "var(--warn)",
                        opacity: 0.85,
                      }}
                    />
                  </div>
                </td>
                <td className="py-2.5 text-right tabular-nums align-top">
                  {row.units.toLocaleString("ja-JP")}
                  <div className="text-[11px] faint">
                    {Math.round(finiteOr(row.share) * 100)}%
                  </div>
                </td>
                <td className="py-2.5 text-right tabular-nums align-top">
                  {formatYen(row.yen)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="inline-flex rounded-full border border-[var(--border)] p-0.5 self-start"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((r) => {
        const active = value === r.id;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onChange(r.id)}
            className="px-3 py-1.5 text-xs rounded-full transition-colors"
            style={
              active
                ? {
                    background: "var(--accent)",
                    color: "var(--accent-fg)",
                  }
                : { color: "var(--text-muted)" }
            }
            aria-pressed={active}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

const EMPTY_EMPLOYEES: EmployeeInput[] = [];

export function DashboardActivity({
  employees = EMPTY_EMPLOYEES,
}: {
  employees?: EmployeeInput[];
}) {
  const [range, setRange] = useState<ActivityRange>("week");
  const [tab, setTab] = useState<BoardTab>("activity");
  // Avoid SSR/client chart attribute drift (floats / locale); paint charts after mount.
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => {
    setChartsReady(true);
  }, []);

  const list = Array.isArray(employees) ? employees : EMPTY_EMPLOYEES;
  const usingSample = list.length === 0;

  const activity = useMemo(
    () => getActivityDemo(range, usingSample ? undefined : list),
    [range, list, usingSample]
  );

  const cost = useMemo(
    () => getCostDemo(range, usingSample ? undefined : list),
    [range, list, usingSample]
  );

  const quotaPct = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (finiteOr(cost.usedUnits) / Math.max(1, finiteOr(cost.plan.includedUnits, 1))) *
          100
      )
    )
  );

  return (
    <section className="surface p-5 mt-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">エージェント活動 · コスト</h2>
          <p className="mt-1 text-xs muted">
            活動量と枠・従量の推計を社長向けに一覧
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Segmented
            ariaLabel="表示切替"
            options={[
              { id: "activity" as const, label: "活動" },
              { id: "cost" as const, label: "コスト" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <Segmented
            ariaLabel="集計期間"
            options={RANGES}
            value={range}
            onChange={setRange}
          />
        </div>
      </div>

      {tab === "activity" ? (
        <>
          <div className="mt-4 grid sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">アクション</div>
              <div className="text-lg font-medium tabular-nums mt-0.5">
                {activity.totals.actions.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">承認</div>
              <div className="text-lg font-medium tabular-nums mt-0.5 text-[var(--ok)]">
                {activity.totals.approvals.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">却下</div>
              <div className="text-lg font-medium tabular-nums mt-0.5 text-[var(--danger)]">
                {activity.totals.denies.toLocaleString("ja-JP")}
              </div>
            </div>
          </div>

          <div className="mt-5 grid lg:grid-cols-5 gap-6">
            <div className="lg:col-span-3">
              <div className="text-xs muted mb-2">組織合計の推移</div>
              {chartsReady ? (
                <AreaLineChart series={activity.series} />
              ) : (
                <div className="h-[180px] rounded-lg bg-[var(--bg-soft)]" aria-hidden />
              )}
            </div>
            <div className="lg:col-span-2">
              <div className="text-xs muted mb-2">AI社員別</div>
              {usingSample ? (
                <p className="mb-3 text-[11px] faint">
                  まだ AI社員がいません。下はサンプル表示です。雇うと実データに切り替わります。
                </p>
              ) : null}
              <EmployeeBars rows={activity.employees} />
            </div>
          </div>

          <p className="mt-4 text-[11px] faint">
            デモデータ（本番は監査イベント集計）
          </p>
        </>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs muted">{cost.plan.planLabel}</span>
            {cost.metered ? (
              <span className="chip chip-warn">枠超過 · 従量課金中</span>
            ) : (
              <span className="chip chip-ok">枠内</span>
            )}
          </div>

          <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">期間の枠</div>
              <div className="text-lg font-medium tabular-nums mt-0.5">
                {cost.plan.includedUnits.toLocaleString("ja-JP")}
              </div>
              <div className="text-[11px] faint mt-1">含まれるユニット</div>
            </div>
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">使用量</div>
              <div className="text-lg font-medium tabular-nums mt-0.5">
                {cost.usedUnits.toLocaleString("ja-JP")}
              </div>
              <div
                className="mt-2 h-1.5 rounded-full overflow-hidden"
                style={{ background: "var(--bg-soft)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${quotaPct}%`,
                    background: cost.metered ? "var(--warn)" : "var(--ok)",
                  }}
                />
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">
                {cost.metered ? "超過分" : "残枠"}
              </div>
              <div
                className="text-lg font-medium tabular-nums mt-0.5"
                style={{
                  color: cost.metered ? "var(--warn)" : "var(--ok)",
                }}
              >
                {(cost.metered
                  ? cost.overageUnits
                  : cost.remainingUnits
                ).toLocaleString("ja-JP")}
              </div>
              <div className="text-[11px] faint mt-1">
                {cost.metered
                  ? `単価 ${formatYen(cost.plan.overageYenPerUnit)}/単位`
                  : "まだ従量なし"}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5">
              <div className="text-[11px] muted">概算料金（超過）</div>
              <div className="text-lg font-medium tabular-nums mt-0.5">
                {formatYen(cost.estimatedOverageYen)}
              </div>
              <div className="text-[11px] faint mt-1">デモ推計 · 税抜イメージ</div>
            </div>
          </div>

          {cost.metered ? (
            <p className="mt-3 text-xs text-[var(--warn)]">
              プラン枠を超えた分は従量課金になります。社長向けに超過ユニットと概算¥を表示しています。
            </p>
          ) : (
            <p className="mt-3 text-xs muted">
              いまは枠内です。超過すると自動で従量表示に切り替わります。
            </p>
          )}

          <div className="mt-5 grid lg:grid-cols-5 gap-6">
            <div className="lg:col-span-3">
              <div className="text-xs muted mb-2">使用量トレンド</div>
              {chartsReady ? (
                <CostTrendChart series={cost.series} />
              ) : (
                <div className="h-[160px] rounded-lg bg-[var(--bg-soft)]" aria-hidden />
              )}
            </div>
            <div className="lg:col-span-2">
              <div className="text-xs muted mb-2">社員別内訳（デモ推計）</div>
              {usingSample ? (
                <p className="mb-3 text-[11px] faint">
                  サンプル社員での推計です。雇うと実AI社員に按分されます。
                </p>
              ) : null}
              <EmployeeCostTable rows={cost.employees} />
            </div>
          </div>

          <p className="mt-4 text-[11px] faint">
            実コストは Grok Bot / Cursor 課金と突合予定；いまは制御面の推計表示。
          </p>
        </>
      )}
    </section>
  );
}
