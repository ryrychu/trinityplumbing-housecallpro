// Parsing, resolving and rendering for the /trinity slash command.
//
// Deliberately a fixed vocabulary rather than natural language: an LLM in this
// path would bill per question (see the spec's "Why there is no chatbot in
// Slack"), and the whole point of this surface is that it is free and instant.
// The conversational version lives in Claude, not here.

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
