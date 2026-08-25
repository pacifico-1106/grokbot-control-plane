export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className={`surface p-4 min-w-0 ${tone === "warn" ? "ring-1 ring-[color-mix(in_oklab,var(--warn)_55%,transparent)]" : ""}`}>
      <div className="text-xs muted break-words">{label}</div>
      <div className="text-xl sm:text-2xl font-medium mt-2 tracking-tight break-words tabular-nums">
        {value}
      </div>
      {hint ? (
        <div className="text-xs faint mt-2 break-words leading-snug">{hint}</div>
      ) : null}
    </div>
  );
}
