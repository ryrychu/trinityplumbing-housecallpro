type Tone = "default" | "danger" | "warn" | "success" | "brand";

const TONE: Record<Tone, string> = {
  default: "text-ink-primary",
  danger: "text-danger",
  warn: "text-warn",
  success: "text-success",
  brand: "text-brand",
};

const SIZE = {
  hero: "text-[2.75rem] leading-[1.05]",
  stat: "text-3xl leading-none",
  compact: "text-xl leading-none",
} as const;

/**
 * A headline number and what it counts.
 *
 * Two deliberate departures from how this app used to set figures. It is in
 * Inter, not the mono — a display face on a hero number reads as decoration,
 * and the number is data. And it does NOT use tabular figures: equal-width
 * digits are for columns that align vertically, and on a lone 44px "121" they
 * just open a gap under the 1s. The run sheet's time rail still gets both,
 * because there the digits really do stack.
 */
export function Figure({
  value,
  label,
  tone = "default",
  size = "stat",
  caption,
}: {
  value: number | string;
  label: string;
  tone?: Tone;
  size?: keyof typeof SIZE;
  caption?: string;
}) {
  return (
    <div>
      <div className={`font-bold tracking-tight ${SIZE[size]} ${TONE[tone]}`}>{value}</div>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {caption && <div className="mt-0.5 text-xs text-ink-muted">{caption}</div>}
    </div>
  );
}
