export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="surface p-4">
      <div className="text-xs muted">{label}</div>
      <div className="text-2xl font-medium mt-2 tracking-tight">{value}</div>
      {hint ? <div className="text-xs faint mt-2">{hint}</div> : null}
    </div>
  );
}
