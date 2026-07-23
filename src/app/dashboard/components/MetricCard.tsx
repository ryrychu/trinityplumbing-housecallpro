interface MetricCardProps {
  label: string;
  value: number | string;
  highlight?: boolean;
}

export function MetricCard({ label, value, highlight = false }: MetricCardProps) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, minWidth: 160 }}>
      <div style={{ fontSize: 13, color: "#666" }}>{label}</div>
      <div
        className={highlight ? "highlight" : undefined}
        style={{ fontSize: 28, fontWeight: 700, color: highlight ? "#c0392b" : "#111" }}
      >
        {value}
      </div>
    </div>
  );
}
