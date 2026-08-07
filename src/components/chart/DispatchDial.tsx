"use client";

import { useState } from "react";
import Link from "next/link";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { buildDial, type DialMark } from "@/lib/dial/geometry";
import { ChevronRightIcon } from "@/components/ui/icons";

// Geometry in viewBox units. The box is square and the plot is inset far
// enough for the compass letters to sit outside the outer ring.
const BOX = 240;
const C = BOX / 2;
const R = 88;

const CARD = "#1b1b1b"; // surface-card — the gap colour between overlapping marks
const MARK = "#b7b09b"; // ink-muted — 7.95:1 on the card, well past the 3:1 mark floor
const ACCENT = "#f2c400"; // brand gold — spent only on the farthest job
const ALERT = "#ff6b6b"; // danger — spent only on out-of-area work
const GRID = "#2d2d2d"; // surface-divider — hairline, one shade off the surface

const BUSINESS_TIME_ZONE = "America/New_York";

function clock(iso: string | null): string {
  if (!iso) return "Unscheduled";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
}

function markLabel(m: DialMark): string {
  return [
    clock(m.job.scheduledStart),
    m.job.customerName ?? "Unknown customer",
    `${m.miles} miles ${m.compass}`,
    m.job.zone,
  ].join(", ");
}

/**
 * Today's work plotted by where it actually is: angle is the job's true bearing
 * from the shop, radius is its distance. Trinity's whole product question is
 * "are we already going near there?", and this is the only view that answers it
 * in one glance — a tight gold cluster is a cheap day, a lone mark out on the
 * rim is an hour of driving nobody costed.
 *
 * Reading the marks: every job is the same recessive dot. Colour means exactly
 * two things — gold is the farthest job of the day, a hollow red ring is work
 * outside the service area. The hollow ring is a shape difference on purpose,
 * not decoration: red and the mark grey sit at CVD ΔE 6.4, inside the band that
 * is only legal with a second, non-colour channel carrying the same meaning.
 */
function ReadoutBody({ active, href }: { active: DialMark; href: string | null }) {
  const body = (
    <>
      <span className="font-mono text-ink-primary tnum">{clock(active.job.scheduledStart)}</span>{" "}
      <span className="font-semibold text-ink-primary">
        {active.job.customerName ?? "Unknown customer"}
      </span>
      <br />
      <span className="text-ink-faint">
        {active.job.zone} · {active.miles} mi {active.compass}
        {active.job.driveMinutes != null && ` · ${active.job.driveMinutes} min drive`}
      </span>
    </>
  );

  if (!href) return <span>{body}</span>;

  return (
    <Link
      href={href}
      className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-left transition-colors hover:bg-surface-raised"
    >
      <span>{body}</span>
      <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-brand" />
    </Link>
  );
}

export function DispatchDial({
  jobs,
  linkJobs = true,
}: {
  jobs: TodayScheduleRow[];
  /** Only the installable app has a job screen to open. */
  linkJobs?: boolean;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const dial = buildDial(jobs);
  const active = dial.marks.find((m) => m.id === activeId) ?? null;

  const px = (m: DialMark) => ({ cx: C + m.x * R, cy: C + m.y * R });

  // Sorted so the emphasised marks paint last and are never buried under a
  // neighbouring dot.
  const painted = [...dial.marks].sort(
    (a, b) => Number(a.farthest || a.outside) - Number(b.farthest || b.outside)
  );

  const summary = [
    `${dial.marks.length} ${dial.marks.length === 1 ? "job" : "jobs"} placed`,
    dial.zoneCount > 1 ? `${dial.zoneCount} zones` : null,
    dial.farthest ? `farthest ${dial.farthest.miles} mi ${dial.farthest.compass}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Rings with nothing in them are worse than no dial: the reader spends a
  // moment deciding whether the day is empty or the plot is broken. Say which.
  if (dial.marks.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-ink-faint">
        {dial.unplotted > 0
          ? `Nothing to place — none of today's ${dial.unplotted} jobs has address coordinates.`
          : "Nothing to place yet."}
      </p>
    );
  }

  return (
    <figure className="m-0">
      <div className="relative mx-auto w-full max-w-[340px]">
        <svg
          viewBox={`0 0 ${BOX} ${BOX}`}
          className="w-full"
          role="group"
          aria-label={`Today's jobs by direction and distance from Averill Park. ${summary}.`}
        >
          {/* Rings. Solid hairlines one shade off the surface — a dashed grid
              reads as a threshold when it is only a scale. */}
          {dial.rings.map((mi, i) => (
            <circle
              key={mi}
              cx={C}
              cy={C}
              r={(R * (i + 1)) / dial.rings.length}
              fill="none"
              stroke={GRID}
              strokeWidth={1}
            />
          ))}

          {/* Cardinal spokes. Four, not eight: the extra four would be noise. */}
          {[0, 90, 180, 270].map((deg) => {
            const t = (deg * Math.PI) / 180;
            return (
              <line
                key={deg}
                x1={C}
                y1={C}
                x2={C + Math.sin(t) * R}
                y2={C - Math.cos(t) * R}
                stroke={GRID}
                strokeWidth={1}
              />
            );
          })}

          {/* Ring scale, read downwards along the south spoke — the emptiest
              bearing in Trinity's town table. Each label sits in a punched-out
              gap so it stays legible over whatever it lands on. */}
          {dial.rings.map((mi, i) => {
            const y = C + (R * (i + 1)) / dial.rings.length;
            const text = i === dial.rings.length - 1 ? `${mi} mi` : `${mi}`;
            return (
              <g key={`tick-${mi}`}>
                <rect
                  x={C - (text.length * 2.6 + 4)}
                  y={y - 6}
                  width={text.length * 5.2 + 8}
                  height={12}
                  rx={2}
                  fill={CARD}
                />
                <text
                  x={C}
                  y={y + 3}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={8}
                  fill="#8f887a"
                >
                  {text}
                </text>
              </g>
            );
          })}

          {/* Compass letters, outside the outer ring. */}
          {[
            { d: "N", x: C, y: C - R - 8 },
            { d: "E", x: C + R + 10, y: C + 3 },
            { d: "S", x: C, y: C + R + 14 },
            { d: "W", x: C - R - 10, y: C + 3 },
          ].map((c) => (
            <text
              key={c.d}
              x={c.x}
              y={c.y}
              textAnchor="middle"
              className="font-display"
              fontSize={11}
              fontWeight={600}
              letterSpacing={0.5}
              fill="#8f887a"
            >
              {c.d}
            </text>
          ))}

          {/* The shop. An outline, not a disc, so a job in Averill Park itself
              sits at radius zero and stays visible instead of hiding under it. */}
          <circle cx={C} cy={C} r={4} fill="none" stroke={ACCENT} strokeWidth={1.5} />

          {painted.map((m) => {
            const { cx, cy } = px(m);
            const isActive = m.id === activeId;
            const i = dial.marks.indexOf(m);
            return (
              <g
                key={m.id}
                role="button"
                tabIndex={0}
                aria-label={markLabel(m)}
                className="cursor-pointer focus:outline-none"
                onMouseEnter={() => setActiveId(m.id)}
                onMouseLeave={() => setActiveId((cur) => (cur === m.id ? null : cur))}
                onFocus={() => setActiveId(m.id)}
                onBlur={() => setActiveId((cur) => (cur === m.id ? null : cur))}
                onClick={() => setActiveId((cur) => (cur === m.id ? null : m.id))}
              >
                {/* Hit area, ~35px across at the size this renders on a phone.
                    The visible mark is 9px; nobody should have to land on it. */}
                <circle cx={cx} cy={cy} r={14} fill="transparent" />

                {isActive && (
                  <circle cx={cx} cy={cy} r={10} fill="none" stroke={ACCENT} strokeWidth={1} />
                )}

                <g
                  className="animate-dial-mark-in"
                  style={{
                    animationDelay: `${Math.min(i * 45, 500)}ms`,
                    transformOrigin: `${cx}px ${cy}px`,
                  }}
                >
                  {m.outside ? (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill="none"
                      stroke={ALERT}
                      strokeWidth={2}
                      // The 2px surface ring that keeps overlapping marks apart.
                      paintOrder="stroke"
                    />
                  ) : (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={m.farthest ? 5.5 : 4.5}
                      fill={m.farthest ? ACCENT : MARK}
                      stroke={CARD}
                      strokeWidth={2}
                      paintOrder="stroke"
                    />
                  )}
                </g>
              </g>
            );
          })}

          {/* One direct label, on the one mark that carries the day's headline.
              A number beside every dot would be unreadable at this size — the
              rest are in the readout below and in the run sheet. */}
          {dial.farthest &&
            (() => {
              const { cx, cy } = px(dial.farthest);
              // Reads outward, away from the origin. Pointing it inward sends
              // the text back across the rings and straight through the ring
              // scale — which is exactly what it did on a two-job day.
              const outward = dial.farthest.x >= 0;
              return (
                <text
                  x={cx + (outward ? 11 : -11)}
                  y={cy + 3}
                  textAnchor={outward ? "start" : "end"}
                  className="font-mono"
                  fontSize={9}
                  // Matches its own mark. When the farthest job is also the
                  // out-of-area one, a gold label beside a red ring reads as
                  // two separate findings instead of one.
                  fill={dial.farthest.outside ? ALERT : ACCENT}
                >
                  {dial.farthest.miles} mi {dial.farthest.compass}
                </text>
              );
            })()}
        </svg>
      </div>

      {/* The readout replaces the summary while a mark is held, so the dial
          never needs a floating bubble that would fall off a 360px screen. */}
      <figcaption
        aria-live="polite"
        className="mt-2 min-h-[2.5rem] text-center text-xs leading-snug text-ink-muted"
      >
        {active ? (
          // Two steps on purpose. A phone has no hover, so one tap cannot both
          // reveal which job a mark is AND open it without guessing which the
          // reader meant. The first tap fills this readout; the readout is the
          // link. When the dial is read-only -- the desktop dashboard has no
          // job screen to open -- it stays plain text.
          <ReadoutBody active={active} href={linkJobs ? `/app/jobs/${active.job.id}` : null} />
        ) : (
          <span>
            {summary}
            {dial.unplotted > 0 && (
              <>
                <br />
                {/* Never silently dropped: a job whose address never geocoded
                    has no bearing and no distance, and a dial that shows five
                    marks for an eight-job day without saying so is a lie. */}
                <span className="text-warn">
                  {dial.unplotted} not placed — no address coordinates
                </span>
              </>
            )}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
