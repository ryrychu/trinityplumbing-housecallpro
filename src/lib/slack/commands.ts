// Parsing, resolving and rendering for the /trinity slash command.
//
// Deliberately a fixed vocabulary rather than natural language: an LLM in this
// path would bill per question (see the spec's "Why there is no chatbot in
// Slack"), and the whole point of this surface is that it is free and instant.
// The conversational version lives in Claude, not here.

import { weekRange, localParts } from "@/lib/dashboard/week";
import { dayLabelFromKey } from "./format";
import { localDateKey } from "@/lib/notifications/schedule";

export type Command =
  | { kind: "today" | "tomorrow" | "week" | "nextWeek" | "money" | "help" }
  | { kind: "weekday"; dow: number };

// 0 = Sunday, matching localParts().dow in src/lib/dashboard/week.ts.
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export function parseCommand(text: string): Command {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");

  if (t === "" || t === "help") return { kind: "help" };
  if (t === "today") return { kind: "today" };
  if (t === "tomorrow") return { kind: "tomorrow" };
  if (t === "week" || t === "this week") return { kind: "week" };
  if (t === "next week" || t === "nextweek") return { kind: "nextWeek" };
  if (t === "money") return { kind: "money" };

  const dow = WEEKDAYS[t];
  // typeof, not `!== undefined`: WEEKDAYS is an object literal and so inherits
  // from Object.prototype, where "constructor", "toString", "valueOf" and
  // "__proto__" all resolve to non-undefined values. Accepting those would
  // return a weekday whose dow is a function, and the caller's date arithmetic
  // would turn it into an Invalid Date.
  if (typeof dow === "number") return { kind: "weekday", dow };

  // Unrecognized input returns help rather than an error — see the module note.
  return { kind: "help" };
}

// A UTC instant at 16:00 on the given calendar date. That is noon-ish Eastern
// under either offset (-04:00 or -05:00) and never within hours of a DST
// boundary, so localParts() always resolves it back to the intended calendar
// day. Exactly the anchor trick getScheduleDays() uses internally
// (src/lib/dashboard/queries.ts) — reused rather than reinvented, because a
// second piece of DST arithmetic is how two surfaces start disagreeing about
// which day a job falls on.
function noonAnchor(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d, 16, 0, 0));
}

export function resolveWindow(
  cmd: Command,
  now: Date
): { anchor: Date; days: number; title: string } | null {
  const { y, m0, d, dow } = localParts(now);

  switch (cmd.kind) {
    case "help":
    case "money":
      return null;

    case "today":
      return { anchor: now, days: 1, title: `Today — ${dayLabelFromKey(localDateKey(now))}` };

    case "tomorrow": {
      const anchor = noonAnchor(y, m0, d + 1);
      return { anchor, days: 1, title: `Tomorrow — ${dayLabelFromKey(localDateKey(anchor))}` };
    }

    case "week":
      return {
        anchor: new Date(weekRange(now, "this").startIso),
        days: 7,
        title: "Week ahead",
      };

    case "nextWeek":
      return {
        anchor: new Date(weekRange(now, "next").startIso),
        days: 7,
        title: "Next week",
      };

    case "weekday": {
      // Today counts as the next occurrence: asking on a Thursday for
      // "thursday" means today, not a week out.
      const delta = (cmd.dow - dow + 7) % 7;
      const anchor = noonAnchor(y, m0, d + delta);
      return { anchor, days: 1, title: dayLabelFromKey(localDateKey(anchor)) };
    }
  }
}
