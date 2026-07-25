import { Card } from "./Card";

type Tone = "default" | "danger" | "warn" | "success";

// Literal per-tone value colors (Tailwind must see them verbatim).
const VALUE_TONE: Record<Tone, string> = {
  default: "text-ink-primary",
  danger: "text-danger",
  warn: "text-warn",
  success: "text-success",
};

export function StatCard({
  label,
  value,
  tone = "default",
  caption,
}: {
  label: string;
  value: number | string;
  tone?: Tone;
  caption?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-ink-muted">{label}</span>
        {tone === "danger" && (
          <svg
            role="img"
            aria-label="Attention"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0 text-danger"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.1c.765-1.36 2.72-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.492-1.646-1.743-2.98l5.58-9.92zM10 7a1 1 0 00-1 1v2a1 1 0 002 0V8a1 1 0 00-1-1zm0 6a1 1 0 100 2 1 1 0 000-2z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </div>
      <div
        className={`mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight ${VALUE_TONE[tone]}`}
      >
        {value}
      </div>
      {caption && <div className="mt-1 text-xs text-ink-faint">{caption}</div>}
    </Card>
  );
}
