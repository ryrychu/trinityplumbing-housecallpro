# Slack `/trinity` Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/trinity` Slack slash command that answers schedule and money
questions instantly and for free, reusing the existing query and formatting
layers so a command and the 6am digest can never disagree.

**Architecture:** One Next.js route handler verifies Slack's HMAC signature,
acknowledges within Slack's 3-second budget, then finishes the work in
`waitUntil` and POSTs the answer to Slack's `response_url`. All rendering goes
through `src/lib/slack/format.ts`; all data comes from the existing
`getScheduleDays()` / `listOpenEstimates()` / `listUnpaidInvoices()`. No new
query logic, no new date arithmetic, no Anthropic API.

**Tech Stack:** Next.js 14 App Router, TypeScript, Vitest, `node:crypto`,
`@vercel/functions` (new dependency).

**Spec:** `docs/superpowers/specs/2026-08-08-slack-commands-mcp-design.md` —
**Part A only.** Part B (the MCP connector) is deferred; its implementation gate
did not pass. Do not build `/api/mcp`, do not add `MCP_AUTH_TOKEN` or
`MCP_ENABLED`, and do not touch the middleware matcher for it.

## Global Constraints

- **Read-only.** No writes to Housecall Pro or Supabase anywhere in this plan.
- **No new date arithmetic.** Reuse `weekRange()`, `dayRange()`, `localParts()`
  from `src/lib/dashboard/week.ts`. A second `Intl` implementation is how the
  dashboard and the digest start disagreeing about which day a job falls on.
- **No new query logic.** Reuse `getScheduleDays()`, `getWeekAheadSchedule()`,
  `getDashboardSnapshot()` from `src/lib/dashboard/queries.ts`, and
  `listOpenEstimates()` / `listUnpaidInvoices()` from `src/lib/mobile/money.ts`.
- **Kill switch defaults off.** `SLACK_COMMANDS_ENABLED` must equal the exact
  string `"true"`; `"1"`, `"yes"`, `"TRUE"` do not count. Same rule as
  `slackAlertsEnabled()` in `src/lib/slack/client.ts`.
- **Never log or echo a secret**, a presented signature, or a raw error from
  Supabase — errors can carry customer rows. Follow the logging discipline in
  `src/lib/slack/client.ts:38-45`.
- **Timezone is `America/New_York`** everywhere, via the existing helpers.
- **Slack replies are ephemeral** (`response_type: "ephemeral"`) — they carry
  customer names, addresses and phone numbers.
- **Do not modify** `src/lib/notifications/`, `src/app/api/cron/sync/`, or
  `src/app/api/admin/trigger/`. A bug here must not be able to reach the digest.
- Follow the codebase's comment style: explain **why**, not what. See
  `src/lib/dashboard/queries.ts` for the house standard.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/slack/verify.ts` | **Create.** Slack HMAC signature + replay window. Pure, no I/O. |
| `src/lib/slack/format.ts` | **Modify.** Add `formatScheduleDays()` and `formatMoneySummary()`; refactor `formatWeeklyLookahead()` to delegate. |
| `src/lib/slack/commands.ts` | **Create.** Parse command text → `Command`; resolve `Command` → date window; render → message string. |
| `src/lib/slack/respond.ts` | **Create.** POST a message to Slack's `response_url`. |
| `src/app/api/slack/command/route.ts` | **Create.** Verify → kill switch → dedupe → ack → `waitUntil`. |
| `src/__tests__/middleware.test.ts` | **Modify.** Regression test: matcher must not cover `/api/slack/*`. |
| `.env.example` | **Modify.** Document the two new variables. |
| `docs/SLACK-ROLLOUT.md` | **Modify.** Add the slash-command setup section. |
| `package.json` | **Modify.** Add `@vercel/functions`. |

---

### Task 1: Slack signature verification

**Files:**
- Create: `src/lib/slack/verify.ts`
- Test: `src/lib/slack/__tests__/verify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `verifySlackSignature(opts: { rawBody: string; timestamp: string | null; signature: string | null; signingSecret: string | undefined; nowMs: number }): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/verify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../verify";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = "command=%2Ftrinity&text=week&response_url=https%3A%2F%2Fhooks.slack.com%2Fx";
const NOW_MS = 1_754_640_000_000; // 2026-08-08T08:00:00Z
const TS = String(Math.floor(NOW_MS / 1000));

// Built here from Slack's documented base string rather than by calling the
// implementation, so a change to that format breaks this test instead of
// silently agreeing with itself.
function sign(body: string, ts: string, secret = SECRET): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}

const base = {
  rawBody: BODY,
  timestamp: TS,
  signature: sign(BODY, TS),
  signingSecret: SECRET,
  nowMs: NOW_MS,
};

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verifySlackSignature(base)).toBe(true);
  });

  // The signature covers the raw body. Any re-serialization changes the bytes.
  it("rejects a tampered body", () => {
    expect(verifySlackSignature({ ...base, rawBody: BODY + "&evil=1" })).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifySlackSignature({ ...base, signature: sign(BODY, TS, "wrong-secret") })).toBe(false);
  });

  // Replay guard: a captured request must not stay valid indefinitely.
  it("rejects a timestamp older than five minutes", () => {
    const oldTs = String(Math.floor(NOW_MS / 1000) - 301);
    expect(
      verifySlackSignature({ ...base, timestamp: oldTs, signature: sign(BODY, oldTs) })
    ).toBe(false);
  });

  it("rejects a timestamp more than five minutes in the future", () => {
    const futureTs = String(Math.floor(NOW_MS / 1000) + 301);
    expect(
      verifySlackSignature({ ...base, timestamp: futureTs, signature: sign(BODY, futureTs) })
    ).toBe(false);
  });

  it("accepts a timestamp just inside the window", () => {
    const ts = String(Math.floor(NOW_MS / 1000) - 299);
    expect(verifySlackSignature({ ...base, timestamp: ts, signature: sign(BODY, ts) })).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(verifySlackSignature({ ...base, signature: null })).toBe(false);
  });

  it("rejects a missing timestamp", () => {
    expect(verifySlackSignature({ ...base, timestamp: null })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifySlackSignature({ ...base, timestamp: "not-a-number" })).toBe(false);
  });

  // An unset secret must never mean "no verification required".
  it("rejects when the signing secret is unset", () => {
    expect(verifySlackSignature({ ...base, signingSecret: undefined })).toBe(false);
  });

  // Guards the hash-then-compare: timingSafeEqual throws on a length mismatch,
  // which would 500 instead of returning false and leak the expected length.
  it("rejects a short signature without throwing", () => {
    expect(verifySlackSignature({ ...base, signature: "v0=aa" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/__tests__/verify.test.ts`
Expected: FAIL — cannot resolve `../verify`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/slack/verify.ts`:

```ts
// Slack request signing. This is the ONLY thing standing between a stranger and
// the schedule: /api/slack/command sits outside the middleware's Supabase
// session gate (a slash command arrives from Slack's servers with no cookies),
// so there is no login behind this.
//
// https://api.slack.com/authentication/verifying-requests-from-slack
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Slack's own recommendation. Bounds how long a captured request stays
// replayable if one is ever intercepted.
const MAX_SKEW_MS = 5 * 60 * 1000;

export function verifySlackSignature(opts: {
  /**
   * The request body EXACTLY as received. Slack signs the bytes, so the caller
   * must read it once with `await req.text()` and parse it themselves.
   * Reading with req.json()/req.formData() and re-serializing changes the bytes
   * and makes every signature fail, with no useful error to explain why.
   */
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string | undefined;
  nowMs: number;
}): boolean {
  const { rawBody, timestamp, signature, signingSecret, nowMs } = opts;

  // An unset secret is a setup mistake, and it must fail closed. Returning true
  // here (or skipping the check) would publish the schedule to the internet.
  if (!signingSecret || !timestamp || !signature) return false;

  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(nowMs - tsSeconds * 1000) > MAX_SKEW_MS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  // sha256 both sides before comparing: timingSafeEqual throws when the two
  // buffers differ in length, and that throw would itself leak the expected
  // signature's length to anyone probing. Same technique as tokenMatches() in
  // src/app/api/admin/trigger/route.ts.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(signature).digest();
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slack/__tests__/verify.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/verify.ts src/lib/slack/__tests__/verify.test.ts
git commit -m "feat(slack): verify slash-command request signatures"
```

---

### Task 2: Message formatters

**Files:**
- Modify: `src/lib/slack/format.ts`
- Test: `src/lib/slack/__tests__/format.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `TodayScheduleRow` from `@/lib/dashboard/queries`; `EstimateHit`, `InvoiceHit` from `@/lib/mobile/money`.
- Produces:
  - `formatScheduleDays(title: string, days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>): string`
  - `formatMoneySummary(estimates: EstimateHit[], invoices: InvoiceHit[]): string`
  - `dayLabelFromKey(dateKey: string): string` (newly **exported**, already exists as a private function)

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/format.test.ts` (if the file exists, append these
`describe` blocks instead of replacing it):

```ts
import { describe, it, expect } from "vitest";
import {
  formatScheduleDays,
  formatWeeklyLookahead,
  formatMoneySummary,
  dayLabelFromKey,
} from "../format";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

function row(over: Partial<TodayScheduleRow> = {}): TodayScheduleRow {
  return {
    id: "job_1",
    scheduledStart: "2026-08-13T17:30:00.000Z", // 1:30 PM Eastern
    customerName: "Devon Robinson",
    technicianName: "Dan",
    zone: "East",
    compass: "",
    miles: 4,
    driveMinutes: 9,
    address: "123 Main St, Averill Park",
    service: "Water Heater Repair",
    customerPhone: "5185550142",
    status: "Scheduled",
    lat: 42.6,
    lng: -73.5,
    ...over,
  };
}

describe("dayLabelFromKey", () => {
  it("renders a date key as a short weekday label", () => {
    expect(dayLabelFromKey("2026-08-13")).toBe("Thu Aug 13");
  });
});

describe("formatScheduleDays", () => {
  it("omits the per-day heading for a single day, since the title carries it", () => {
    const out = formatScheduleDays("Tomorrow — Thu Aug 13", [
      { dateKey: "2026-08-13", rows: [row()] },
    ]);
    expect(out).toContain("*Tomorrow — Thu Aug 13* — 1 job");
    expect(out).not.toContain("*Thu Aug 13*\n");
    expect(out).toContain("Devon Robinson");
  });

  it("renders a per-day heading for each day when there are several", () => {
    const out = formatScheduleDays("Next week", [
      { dateKey: "2026-08-10", rows: [row()] },
      { dateKey: "2026-08-11", rows: [] },
    ]);
    expect(out).toContain("*Next week* — 1 job");
    expect(out).toContain("*Mon Aug 10*");
    expect(out).toContain("*Tue Aug 11*");
    expect(out).toContain("No jobs");
  });

  it("pluralizes the job count", () => {
    const out = formatScheduleDays("Next week", [
      { dateKey: "2026-08-10", rows: [row(), row({ id: "job_2" })] },
    ]);
    expect(out).toContain("— 2 jobs");
  });

  it("says so plainly when a single day is empty", () => {
    const out = formatScheduleDays("Thu Aug 13", [{ dateKey: "2026-08-13", rows: [] }]);
    expect(out).toContain("— 0 jobs");
    expect(out).toContain("No jobs");
  });
});

// formatWeeklyLookahead is what the 6am digest posts. Refactoring it to
// delegate must not change a single byte of that message.
describe("formatWeeklyLookahead regression", () => {
  it("renders exactly what formatScheduleDays renders with the 'Week ahead' title", () => {
    const days = [
      { dateKey: "2026-08-10", rows: [row()] },
      { dateKey: "2026-08-11", rows: [] },
      { dateKey: "2026-08-12", rows: [row({ id: "job_2", customerName: "Ada Miller" })] },
    ];
    expect(formatWeeklyLookahead(new Date("2026-08-10T12:00:00Z"), days)).toBe(
      formatScheduleDays("Week ahead", days)
    );
  });

  it("still opens with the Week ahead header and a total", () => {
    const out = formatWeeklyLookahead(new Date("2026-08-10T12:00:00Z"), [
      { dateKey: "2026-08-10", rows: [row()] },
      { dateKey: "2026-08-11", rows: [] },
    ]);
    expect(out.startsWith("*Week ahead* — 1 job")).toBe(true);
  });
});

describe("formatMoneySummary", () => {
  const estimates = [
    { id: "e1", customerId: "c1", customerName: "Devon Robinson", amountCents: 120000, status: "Scheduled" },
    { id: "e2", customerId: "c2", customerName: "Ada Miller", amountCents: 45000, status: null },
  ];
  const invoices = [
    { id: "i1", customerId: "c3", customerName: "Sam Patel", amountCents: 85000, status: "open", dueDate: "2026-07-27", overdueDays: 12 },
    { id: "i2", customerId: "c4", customerName: "Rae Okafor", amountCents: 30000, status: "open", dueDate: "2026-08-20", overdueDays: null },
  ];

  it("totals estimates and invoices in dollars", () => {
    const out = formatMoneySummary(estimates, invoices);
    expect(out).toContain("$1,650.00"); // 120000 + 45000
    expect(out).toContain("$1,150.00"); // 85000 + 30000
  });

  it("counts the overdue invoices separately", () => {
    expect(formatMoneySummary(estimates, invoices)).toContain("1 overdue");
  });

  it("marks how many days an invoice is overdue", () => {
    expect(formatMoneySummary(estimates, invoices)).toContain("12 days overdue");
  });

  it("handles a null amount without rendering NaN", () => {
    const out = formatMoneySummary(
      [{ id: "e3", customerId: null, customerName: null, amountCents: null, status: null }],
      []
    );
    expect(out).not.toContain("NaN");
    expect(out).toContain("Unknown customer");
  });

  it("says so plainly when there is nothing outstanding", () => {
    const out = formatMoneySummary([], []);
    expect(out).toContain("No open estimates");
    expect(out).toContain("No unpaid invoices");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/__tests__/format.test.ts`
Expected: FAIL — `formatScheduleDays`, `formatMoneySummary`, `dayLabelFromKey` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/slack/format.ts`:

(a) Export the existing private helper — change its declaration only:

```ts
// "2026-07-27" -> "Mon Jul 27". Parsed as local noon so the label can never
// slip a day from a timezone edge. Exported because the slash commands build
// single-day titles ("Tomorrow — Thu Aug 13") from the same label the day
// headings use.
export function dayLabelFromKey(dateKey: string): string {
  return dayLabel(new Date(`${dateKey}T12:00:00Z`));
}
```

(b) Add the generalized renderer and rewrite `formatWeeklyLookahead` to delegate.
**Replace** the existing `formatWeeklyLookahead` with these two functions:

```ts
// The one schedule renderer. The weekly digest, the week-ahead command and the
// single-day commands all render through this, so they cannot drift apart.
//
// A single day omits the per-day heading: its title already names the date
// ("Tomorrow — Thu Aug 13"), and repeating it directly underneath reads as a
// formatting bug rather than as emphasis.
export function formatScheduleDays(
  title: string,
  days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>
): string {
  const total = days.reduce((n, d) => n + d.rows.length, 0);
  const header = `*${title}* — ${total} ${total === 1 ? "job" : "jobs"}`;

  if (days.length === 1) {
    const body = days[0].rows.length === 0 ? "No jobs" : days[0].rows.map(jobLines).join("\n\n");
    return [header, "", body].join("\n\n");
  }

  const sections = days.map((d) => {
    const heading = `*${dayLabelFromKey(d.dateKey)}*`;
    const body = d.rows.length === 0 ? "No jobs" : d.rows.map(jobLines).join("\n\n");
    return `${heading}\n${body}`;
  });
  return [header, "", ...sections].join("\n\n");
}

// `now` is unused but kept in the signature: this is what the 6am cron and the
// /admin button call (src/lib/notifications/digest.ts), and changing its shape
// would ripple into both for no benefit.
export function formatWeeklyLookahead(
  now: Date,
  days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>
): string {
  return formatScheduleDays("Week ahead", days);
}
```

(c) Add the money renderer. Put the `import type` line with the **other imports
at the top of the file** (it is erased at compile time, so it cannot create a
runtime cycle), and the rest at the end:

```ts
// --- top of file, beside the existing imports ---
import type { EstimateHit, InvoiceHit } from "@/lib/mobile/money";

// --- end of file ---

// How many lines of each list to print before collapsing the rest into a
// count. The whole point of this message is to be readable on a phone; 25
// unpaid invoices rendered in full is a wall nobody scrolls.
const MONEY_LIST_LIMIT = 5;

function moneyLines(
  heading: string,
  emptyText: string,
  count: number,
  totalCents: number,
  suffix: string,
  lines: string[]
): string {
  if (count === 0) return `*${heading}* — ${emptyText}`;
  const shown = lines.slice(0, MONEY_LIST_LIMIT);
  const rest = count - shown.length;
  return [
    `*${heading}* — ${count} · ${formatCents(totalCents)}${suffix}`,
    ...shown,
    ...(rest > 0 ? [`… and ${rest} more`] : []),
  ].join("\n");
}

export function formatMoneySummary(estimates: EstimateHit[], invoices: InvoiceHit[]): string {
  const estTotal = estimates.reduce((n, e) => n + (e.amountCents ?? 0), 0);
  const invTotal = invoices.reduce((n, i) => n + (i.amountCents ?? 0), 0);
  const overdue = invoices.filter((i) => i.overdueDays != null).length;

  const estimateBlock = moneyLines(
    "Open estimates",
    "No open estimates",
    estimates.length,
    estTotal,
    "",
    estimates.map((e) => `• ${e.customerName ?? "Unknown customer"} — ${formatCents(e.amountCents)}`)
  );

  const invoiceBlock = moneyLines(
    "Unpaid invoices",
    "No unpaid invoices",
    invoices.length,
    invTotal,
    overdue > 0 ? `  ·  ${overdue} overdue` : "",
    invoices.map((i) => {
      const late = i.overdueDays != null ? `  ·  ${i.overdueDays} days overdue` : "";
      return `• ${i.customerName ?? "Unknown customer"} — ${formatCents(i.amountCents)}${late}`;
    })
  );

  return ["*Money*", "", estimateBlock, "", invoiceBlock].join("\n");
}
```

- [ ] **Step 4: Run the whole suite to verify nothing regressed**

Run: `npm test`
Expected: PASS. The `formatWeeklyLookahead` regression tests and every existing
digest test must still pass — this refactor must not change the 6am message.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/format.ts src/lib/slack/__tests__/format.test.ts
git commit -m "feat(slack): generalize the schedule renderer and add a money summary"
```

---

### Task 3: Command parsing

**Files:**
- Create: `src/lib/slack/commands.ts`
- Test: `src/lib/slack/__tests__/commands.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Command = { kind: "today" | "tomorrow" | "week" | "nextWeek" | "money" | "help" } | { kind: "weekday"; dow: number }`
  - `parseCommand(text: string): Command` — pure, no clock.

`dow` is `0`=Sunday … `6`=Saturday, matching `localParts().dow`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/commands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCommand } from "../commands";

describe("parseCommand", () => {
  it.each([
    ["today", "today"],
    ["tomorrow", "tomorrow"],
    ["week", "week"],
    ["this week", "week"],
    ["next week", "nextWeek"],
    ["money", "money"],
  ])("parses %j as %s", (text, kind) => {
    expect(parseCommand(text)).toEqual({ kind });
  });

  it("is case and whitespace insensitive", () => {
    expect(parseCommand("  NEXT   Week ")).toEqual({ kind: "nextWeek" });
  });

  it.each([
    ["sunday", 0],
    ["monday", 1],
    ["tue", 2],
    ["wednesday", 3],
    ["thu", 4],
    ["friday", 5],
    ["sat", 6],
  ])("parses %j as weekday %i", (text, dow) => {
    expect(parseCommand(text)).toEqual({ kind: "weekday", dow });
  });

  it("treats empty input as help, since that is what typing the bare command does", () => {
    expect(parseCommand("")).toEqual({ kind: "help" });
    expect(parseCommand("   ")).toEqual({ kind: "help" });
  });

  it("parses an explicit help request", () => {
    expect(parseCommand("help")).toEqual({ kind: "help" });
  });

  // A slash command is discovered by typing at it. A dead end teaches nothing,
  // so anything unrecognized shows the list rather than an error.
  it("falls back to help for anything unrecognized", () => {
    expect(parseCommand("what's on for thursday")).toEqual({ kind: "help" });
    expect(parseCommand("asdf")).toEqual({ kind: "help" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/__tests__/commands.test.ts`
Expected: FAIL — cannot resolve `../commands`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/slack/commands.ts`:

```ts
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
  if (dow !== undefined) return { kind: "weekday", dow };

  // Unrecognized input returns help rather than an error — see the module note.
  return { kind: "help" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slack/__tests__/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/commands.ts src/lib/slack/__tests__/commands.test.ts
git commit -m "feat(slack): parse /trinity subcommands"
```

---

### Task 4: Resolving a command to a date window

**Files:**
- Modify: `src/lib/slack/commands.ts`
- Test: `src/lib/slack/__tests__/commands.test.ts`

**Interfaces:**
- Consumes: `parseCommand`, `Command` (Task 3); `weekRange`, `localParts` from `@/lib/dashboard/week`; `dayLabelFromKey` from `./format` (Task 2).
- Produces: `resolveWindow(cmd: Command, now: Date): { anchor: Date; days: number; title: string } | null` — returns `null` for `help` and `money`, which have no date window.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/slack/__tests__/commands.test.ts`. **Merge the two imports
into the existing `import ... from "../commands"` line at the top of the file**
rather than adding a second import mid-file — `import/first` will flag it:

```ts
// at the top: import { parseCommand, resolveWindow } from "../commands";
import { localParts } from "@/lib/dashboard/week";

// Saturday 2026-08-08, 08:00 Eastern (12:00 UTC, EDT).
const SAT = new Date("2026-08-08T12:00:00Z");

describe("resolveWindow", () => {
  it("returns null for commands with no date window", () => {
    expect(resolveWindow({ kind: "help" }, SAT)).toBeNull();
    expect(resolveWindow({ kind: "money" }, SAT)).toBeNull();
  });

  it("resolves today to a one-day window on the current local date", () => {
    const w = resolveWindow({ kind: "today" }, SAT)!;
    expect(w.days).toBe(1);
    expect(localParts(w.anchor).d).toBe(8);
  });

  it("resolves tomorrow to the next local calendar day", () => {
    const w = resolveWindow({ kind: "tomorrow" }, SAT)!;
    expect(w.days).toBe(1);
    expect(localParts(w.anchor).d).toBe(9);
    expect(w.title).toBe("Tomorrow — Sun Aug 9");
  });

  it("resolves week to the Monday of the current local week", () => {
    const w = resolveWindow({ kind: "week" }, SAT)!;
    expect(w.days).toBe(7);
    expect(localParts(w.anchor).dow).toBe(1);
    expect(localParts(w.anchor).d).toBe(3); // Mon 2026-08-03
    expect(w.title).toBe("Week ahead");
  });

  it("resolves next week to the following Monday", () => {
    const w = resolveWindow({ kind: "nextWeek" }, SAT)!;
    expect(w.days).toBe(7);
    expect(localParts(w.anchor).d).toBe(10); // Mon 2026-08-10
    expect(w.title).toBe("Next week");
  });

  it("resolves a weekday to its next occurrence", () => {
    // Saturday asking for Tuesday -> Tue 2026-08-11.
    const w = resolveWindow({ kind: "weekday", dow: 2 }, SAT)!;
    expect(w.days).toBe(1);
    expect(localParts(w.anchor).d).toBe(11);
    expect(w.title).toBe("Tue Aug 11");
  });

  // Explicit per the spec: asking on a Thursday for "thursday" means today,
  // not a week out.
  it("counts today as the next occurrence of its own weekday", () => {
    const w = resolveWindow({ kind: "weekday", dow: 6 }, SAT)!; // Saturday
    expect(localParts(w.anchor).d).toBe(8);
    expect(w.title).toBe("Sat Aug 8");
  });

  // DST-safety. 2026-11-01 is the fall-back Sunday in America/New_York; a week
  // built by adding fixed 24h multiples drifts off local midnight after it.
  it("returns seven distinct local days across a DST transition", () => {
    const beforeFallBack = new Date("2026-10-28T12:00:00Z"); // Wed 2026-10-28
    const w = resolveWindow({ kind: "nextWeek" }, beforeFallBack)!;
    expect(w.days).toBe(7);
    expect(localParts(w.anchor).dow).toBe(1);
    expect(localParts(w.anchor).d).toBe(2); // Mon 2026-11-02
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/__tests__/commands.test.ts`
Expected: FAIL — `resolveWindow` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/slack/commands.ts`:

```ts
import { weekRange, localParts } from "@/lib/dashboard/week";
import { dayLabelFromKey } from "./format";
import { localDateKey } from "@/lib/notifications/schedule";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slack/__tests__/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/commands.ts src/lib/slack/__tests__/commands.test.ts
git commit -m "feat(slack): resolve /trinity subcommands to DST-safe date windows"
```

---

### Task 5: Rendering a command to a message

**Files:**
- Modify: `src/lib/slack/commands.ts`
- Test: `src/lib/slack/__tests__/render.test.ts`

**Interfaces:**
- Consumes: `Command`, `resolveWindow`; `getScheduleDays` from `@/lib/dashboard/queries`; `renderDigest` from `@/lib/notifications/digest`; `listOpenEstimates`, `listUnpaidInvoices` from `@/lib/mobile/money`; `formatScheduleDays`, `formatMoneySummary` from `./format`.
- Produces:
  - `HELP_TEXT: string`
  - `renderCommand(cmd: Command, now: Date): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/render.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getScheduleDaysMock, renderDigestMock, estimatesMock, invoicesMock } = vi.hoisted(() => ({
  getScheduleDaysMock: vi.fn(),
  renderDigestMock: vi.fn(),
  estimatesMock: vi.fn(),
  invoicesMock: vi.fn(),
}));

vi.mock("@/lib/dashboard/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/queries")>()),
  getScheduleDays: getScheduleDaysMock,
}));
vi.mock("@/lib/notifications/digest", () => ({ renderDigest: renderDigestMock }));
vi.mock("@/lib/mobile/money", () => ({
  listOpenEstimates: estimatesMock,
  listUnpaidInvoices: invoicesMock,
}));

import { renderCommand, HELP_TEXT } from "../commands";

const SAT = new Date("2026-08-08T12:00:00Z");

describe("renderCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getScheduleDaysMock.mockResolvedValue([{ dateKey: "2026-08-09", rows: [] }]);
    renderDigestMock.mockResolvedValue("*Today — Sat Aug 8* — 2 jobs");
    estimatesMock.mockResolvedValue([]);
    invoicesMock.mockResolvedValue([]);
  });

  // today and week must be the SAME string the 6am cron and the /admin button
  // send, which is what renderDigest exists to guarantee.
  it("renders today through renderDigest, not a second implementation", async () => {
    const out = await renderCommand({ kind: "today" }, SAT);
    expect(renderDigestMock).toHaveBeenCalledWith("digest", SAT);
    expect(getScheduleDaysMock).not.toHaveBeenCalled();
    expect(out).toBe("*Today — Sat Aug 8* — 2 jobs");
  });

  it("renders week through renderDigest", async () => {
    renderDigestMock.mockResolvedValue("*Week ahead* — 9 jobs");
    const out = await renderCommand({ kind: "week" }, SAT);
    expect(renderDigestMock).toHaveBeenCalledWith("week", SAT);
    expect(out).toBe("*Week ahead* — 9 jobs");
  });

  it("asks getScheduleDays for a one-day window for tomorrow", async () => {
    await renderCommand({ kind: "tomorrow" }, SAT);
    expect(getScheduleDaysMock).toHaveBeenCalledWith(expect.any(Date), 1);
  });

  it("asks getScheduleDays for a seven-day window for next week", async () => {
    getScheduleDaysMock.mockResolvedValue([{ dateKey: "2026-08-10", rows: [] }]);
    await renderCommand({ kind: "nextWeek" }, SAT);
    expect(getScheduleDaysMock).toHaveBeenCalledWith(expect.any(Date), 7);
  });

  it("titles a tomorrow result with its date", async () => {
    const out = await renderCommand({ kind: "tomorrow" }, SAT);
    expect(out).toContain("*Tomorrow — Sun Aug 9*");
  });

  it("renders money from both money queries", async () => {
    estimatesMock.mockResolvedValue([
      { id: "e1", customerId: "c1", customerName: "Devon Robinson", amountCents: 120000, status: null },
    ]);
    const out = await renderCommand({ kind: "money" }, SAT);
    expect(estimatesMock).toHaveBeenCalled();
    expect(invoicesMock).toHaveBeenCalledWith(SAT);
    expect(out).toContain("*Money*");
    expect(out).toContain("Devon Robinson");
  });

  it("renders help without touching the database", async () => {
    const out = await renderCommand({ kind: "help" }, SAT);
    expect(out).toBe(HELP_TEXT);
    expect(getScheduleDaysMock).not.toHaveBeenCalled();
    expect(renderDigestMock).not.toHaveBeenCalled();
  });

  it("lists every supported subcommand in the help text", () => {
    for (const word of ["today", "tomorrow", "week", "next week", "money"]) {
      expect(HELP_TEXT).toContain(word);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/__tests__/render.test.ts`
Expected: FAIL — `renderCommand` / `HELP_TEXT` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/slack/commands.ts`:

```ts
import { getScheduleDays } from "@/lib/dashboard/queries";
import { renderDigest } from "@/lib/notifications/digest";
import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { formatScheduleDays, formatMoneySummary } from "./format";

export const HELP_TEXT = [
  "*Trinity* — ask for a schedule or the money.",
  "",
  "`/trinity today` — today's jobs",
  "`/trinity tomorrow` — tomorrow's jobs",
  "`/trinity week` — this Monday to Sunday",
  "`/trinity next week` — next Monday to Sunday",
  "`/trinity thursday` — the next Thursday (any weekday works)",
  "`/trinity money` — open estimates and unpaid invoices",
].join("\n");

export async function renderCommand(cmd: Command, now: Date): Promise<string> {
  if (cmd.kind === "help") return HELP_TEXT;

  if (cmd.kind === "money") {
    const [estimates, invoices] = await Promise.all([
      listOpenEstimates(),
      listUnpaidInvoices(now),
    ]);
    return formatMoneySummary(estimates, invoices);
  }

  // today and week go through renderDigest so a command and the 6am post are
  // the same string by construction, not by two implementations agreeing today
  // and drifting next month. src/lib/notifications/digest.ts exists for exactly
  // this reason — do not reimplement either here.
  if (cmd.kind === "today") return renderDigest("digest", now);
  if (cmd.kind === "week") return renderDigest("week", now);

  const window = resolveWindow(cmd, now)!;
  const days = await getScheduleDays(window.anchor, window.days);
  return formatScheduleDays(window.title, days);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slack/__tests__/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/commands.ts src/lib/slack/__tests__/render.test.ts
git commit -m "feat(slack): render /trinity commands from the shared query layer"
```

---

### Task 6: Posting the answer back to Slack

**Files:**
- Create: `src/lib/slack/respond.ts`
- Test: `src/lib/slack/__tests__/respond.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `postToResponseUrl(responseUrl: string, text: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/respond.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postToResponseUrl } from "../respond";

const URL_ = "https://hooks.slack.com/commands/T1/2/abc";

describe("postToResponseUrl", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("posts ephemerally so customer data is not left in channel history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await postToResponseUrl(URL_, "*Week ahead* — 9 jobs");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      response_type: "ephemeral",
      replace_original: true,
      text: "*Week ahead* — 9 jobs",
    });
  });

  it("returns true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    expect(await postToResponseUrl(URL_, "hi")).toBe(true);
  });

  // Nothing downstream can retry this, so a failure must be swallowed and
  // logged rather than thrown into an already-acknowledged request.
  it("returns false and does not throw when Slack rejects the post", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
    expect(await postToResponseUrl(URL_, "hi")).toBe(false);
  });

  it("returns false and does not throw when the request errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await postToResponseUrl(URL_, "hi")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/__tests__/respond.test.ts`
Expected: FAIL — cannot resolve `../respond`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/slack/respond.ts`:

```ts
// Posting a slash-command answer back to Slack.
//
// Distinct from postSlack() in ./client.ts, which posts to a configured
// *incoming webhook* (one fixed channel, used by the digests). A slash command
// instead supplies a per-invocation `response_url`, which is what lets the
// answer land where the person typed and needs no bot token or OAuth scopes.
const TIMEOUT_MS = 10_000;

export async function postToResponseUrl(responseUrl: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Ephemeral: this carries customer names, street addresses and phone
        // numbers, and only the person who asked needs to see them. Switching
        // to "in_channel" is a deliberate decision, not a default.
        response_type: "ephemeral",
        // Replaces the "Working on it…" acknowledgement rather than stacking
        // a second message under it.
        replace_original: true,
        text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[slack] response_url post failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Log the message only, never the raw error object: some failure paths
    // embed the request, and response_url is bearer-equivalent — anyone
    // holding it can post into that conversation. Same rule as ./client.ts.
    console.error("[slack] response_url post threw:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slack/__tests__/respond.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/respond.ts src/lib/slack/__tests__/respond.test.ts
git commit -m "feat(slack): post slash-command answers to response_url"
```

---

### Task 7: The route handler

**Files:**
- Create: `src/app/api/slack/command/route.ts`
- Test: `src/app/api/slack/command/__tests__/route.test.ts`
- Modify: `package.json` (add `@vercel/functions`)

**Interfaces:**
- Consumes: `verifySlackSignature` (Task 1), `parseCommand` + `renderCommand` (Tasks 3, 5), `postToResponseUrl` (Task 6).
- Produces: `POST(req: Request): Promise<Response>`, `maxDuration`.

- [ ] **Step 1: Add the dependency**

```bash
npm install @vercel/functions
```

- [ ] **Step 2: Write the failing test**

Create `src/app/api/slack/command/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const { renderCommandMock, postMock, waitUntilMock } = vi.hoisted(() => ({
  renderCommandMock: vi.fn(),
  postMock: vi.fn(),
  // The real waitUntil defers work past the response. Running it inline lets
  // the tests assert on what the deferred work did.
  waitUntilMock: vi.fn((p: Promise<unknown>) => p),
}));

vi.mock("@/lib/slack/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack/commands")>()),
  renderCommand: renderCommandMock,
}));
vi.mock("@/lib/slack/respond", () => ({ postToResponseUrl: postMock }));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));

import { POST } from "../route";

const SECRET = "test-signing-secret";
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/2/abc";

function slackRequest(
  text: string,
  opts: { secret?: string; tsOffsetSec?: number; retry?: boolean } = {}
): Request {
  const body = new URLSearchParams({
    command: "/trinity",
    text,
    user_id: "U123",
    response_url: RESPONSE_URL,
  }).toString();
  const ts = String(Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0));
  const sig =
    "v0=" + createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "x-slack-signature": sig,
    "x-slack-request-timestamp": ts,
  };
  if (opts.retry) headers["x-slack-retry-num"] = "1";

  return new Request("https://ops.trinity.plumbing/api/slack/command", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/slack/command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_COMMANDS_ENABLED = "true";
    renderCommandMock.mockResolvedValue("*Week ahead* — 9 jobs");
    postMock.mockResolvedValue(true);
    waitUntilMock.mockImplementation((p: Promise<unknown>) => p);
  });

  afterEach(() => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_COMMANDS_ENABLED;
  });

  describe("auth", () => {
    it("rejects a request signed with the wrong secret", async () => {
      const res = await POST(slackRequest("week", { secret: "not-the-secret" }));
      expect(res.status).toBe(401);
      expect(renderCommandMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
    });

    it("rejects a stale request", async () => {
      const res = await POST(slackRequest("week", { tsOffsetSec: -600 }));
      expect(res.status).toBe(401);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });

    // An unset secret must never mean "no verification required".
    it("refuses to run when SLACK_SIGNING_SECRET is unset", async () => {
      delete process.env.SLACK_SIGNING_SECRET;
      const res = await POST(slackRequest("week"));
      expect(res.status).toBe(503);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("kill switch", () => {
    it("does nothing when SLACK_COMMANDS_ENABLED is unset", async () => {
      delete process.env.SLACK_COMMANDS_ENABLED;
      const res = await POST(slackRequest("week"));
      expect(res.status).toBe(200);
      expect((await res.json()).text).toMatch(/not enabled/i);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });

    it("treats any value other than the exact string 'true' as off", async () => {
      process.env.SLACK_COMMANDS_ENABLED = "TRUE";
      const res = await POST(slackRequest("week"));
      expect((await res.json()).text).toMatch(/not enabled/i);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("acknowledgement", () => {
    it("acknowledges 200 with an ephemeral placeholder", async () => {
      const res = await POST(slackRequest("week"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ response_type: "ephemeral" });
    });

    it("defers the real work rather than doing it before responding", async () => {
      await POST(slackRequest("week"));
      expect(waitUntilMock).toHaveBeenCalledTimes(1);
    });

    it("posts the rendered answer to response_url", async () => {
      await POST(slackRequest("week"));
      expect(postMock).toHaveBeenCalledWith(RESPONSE_URL, "*Week ahead* — 9 jobs");
    });

    it("passes the parsed command through to renderCommand", async () => {
      await POST(slackRequest("next week"));
      expect(renderCommandMock).toHaveBeenCalledWith({ kind: "nextWeek" }, expect.any(Date));
    });
  });

  // Slack retries on timeout or a non-2xx. Without this guard the same schedule
  // is posted three times.
  describe("retries", () => {
    it("does no work when Slack marks the request as a retry", async () => {
      const res = await POST(slackRequest("week", { retry: true }));
      expect(res.status).toBe(200);
      expect(renderCommandMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe("failures", () => {
    // A raw Supabase error can carry customer rows. It must never reach Slack.
    it("posts a plain apology and never the raw error", async () => {
      renderCommandMock.mockRejectedValue(new Error("customers query failed: row Devon Robinson"));

      await POST(slackRequest("week"));

      expect(postMock).toHaveBeenCalledTimes(1);
      const [, text] = postMock.mock.calls[0];
      expect(text).not.toContain("Devon Robinson");
      expect(text).toMatch(/couldn't/i);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/app/api/slack/command/__tests__/route.test.ts`
Expected: FAIL — cannot resolve `../route`.

- [ ] **Step 4: Write minimal implementation**

Create `src/app/api/slack/command/route.ts`:

```ts
// The /trinity slash command.
//
// This route is NOT covered by src/middleware.ts's Supabase session gate — a
// slash command arrives from Slack's servers with no cookies, and a redirect to
// /app/login would be all Slack ever saw. The signature check below is
// therefore the whole of the authentication. Do not remove it, and do not add
// /api/slack/* to the middleware matcher (there is a regression test in
// src/__tests__/middleware.test.ts holding both halves of that).
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "@/lib/slack/verify";
import { parseCommand, renderCommand } from "@/lib/slack/commands";
import { postToResponseUrl } from "@/lib/slack/respond";

// A schedule read pages every job, customer and technician row. Comfortably
// more than the 10s an interactive default allows on a cold start.
export const maxDuration = 60;

// Declared at the top, not the bottom: `const` is not hoisted, and the
// no-response_url branch below reads this synchronously. Declaring it after
// that branch throws a ReferenceError from the temporal dead zone.
const FAILURE_TEXT = "I couldn't reach the schedule just now — try again in a moment.";

function ephemeral(text: string) {
  return NextResponse.json({ response_type: "ephemeral", text });
}

export async function POST(req: Request) {
  // Read the body ONCE, as text. Slack signs the raw bytes; parsing and
  // re-serializing changes them and every signature fails.
  const rawBody = await req.text();

  // Default off, exactly like slackAlertsEnabled() — so this can deploy and be
  // observed before it is allowed to answer anyone.
  if (process.env.SLACK_COMMANDS_ENABLED !== "true") {
    return ephemeral("Trinity commands are not enabled on this deployment.");
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    // Distinct from a bad signature, and safe to say out loud: an unconfigured
    // variable is a setup mistake the operator needs named, not an attacker
    // hint. Without this the failure looks identical to a signing mismatch.
    return ephemeral("SLACK_SIGNING_SECRET is not set on this deployment — see docs/SLACK-ROLLOUT.md");
  }

  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    signingSecret,
    nowMs: Date.now(),
  });
  if (!ok) {
    // No detail in the body, and the presented signature is never logged.
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Slack retries on a timeout or non-2xx. We already acknowledged the first
  // delivery and are still working on it, so a retry must do nothing —
  // otherwise the same schedule is posted two or three times.
  if (req.headers.get("x-slack-retry-num")) {
    return new NextResponse(null, { status: 200 });
  }

  const params = new URLSearchParams(rawBody);
  const responseUrl = params.get("response_url");
  const cmd = parseCommand(params.get("text") ?? "");

  if (!responseUrl) {
    // Nowhere to send the real answer, so answer inline. Only reachable from a
    // hand-made request, since Slack always supplies one.
    return ephemeral(await renderCommand(cmd, new Date()).catch(() => FAILURE_TEXT));
  }

  // Acknowledge now, answer after. A schedule read cannot finish inside Slack's
  // 3-second budget, and a late 200 shows the user a timeout error and triggers
  // the retry the guard above then has to swallow.
  waitUntil(
    (async () => {
      let text: string;
      try {
        text = await renderCommand(cmd, new Date());
      } catch (err) {
        // Log the message; post a plain sentence. A raw Supabase error can
        // carry customer rows, and this reply lands in a chat window.
        console.error("[slack] command failed:", err instanceof Error ? err.message : String(err));
        text = FAILURE_TEXT;
      }
      await postToResponseUrl(responseUrl, text);
    })()
  );

  return ephemeral("Working on it…");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/api/slack/command/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/app/api/slack/command/
git commit -m "feat(slack): add the /trinity slash command route"
```

---

### Task 8: Pin the middleware boundary, document the rollout

**Files:**
- Modify: `src/__tests__/middleware.test.ts`
- Modify: `.env.example`
- Modify: `docs/SLACK-ROLLOUT.md`

**Interfaces:**
- Consumes: `config` from `@/middleware` (already imported by the existing test).
- Produces: nothing.

**Context for the implementer:** `/api/slack/*` is **already** outside the
matcher in `src/middleware.ts:112-119`, so there is nothing to change there.
This task pins that fact so a future broadening of the matcher (say to
`/api/:path*`) cannot silently break Slack — the failure mode is a `302` to a
login page that Slack reports as nothing useful.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/middleware.test.ts`, add to the existing
`describe("matcher coverage", ...)` block:

```ts
    // /api/slack/* must stay OUTSIDE the matcher. A slash command arrives from
    // Slack's servers with no Supabase session, so a gated route would answer
    // every command with a 302 to /app/login -- which Slack surfaces as a bare
    // "didn't work" with nothing in it to diagnose. The route authenticates
    // itself with SLACK_SIGNING_SECRET instead (src/lib/slack/verify.ts); this
    // assertion is what stops a later broad pattern like "/api/:path*" from
    // quietly taking that away.
    it("leaves the Slack command route outside the session gate", () => {
      const gatesSlack = config.matcher.some(
        (p) => p.startsWith("/api/slack") || p === "/api/:path*"
      );
      expect(gatesSlack).toBe(false);
    });
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS.

This is the one test in the plan that passes on first write — it is pinning
existing correct behavior rather than driving new code. To confirm it actually
holds something, temporarily add `"/api/slack/:path*"` to the matcher in
`src/middleware.ts`, re-run, watch it FAIL, then remove it again.

- [ ] **Step 3: Document the environment variables**

In `.env.example`, append:

```bash
# --- Slack /trinity slash commands -------------------------------------------
# Slack app -> Basic Information -> App Credentials -> Signing Secret.
# This is the ONLY authentication on /api/slack/command.
SLACK_SIGNING_SECRET=

# Kill switch. Commands are inert unless this is the exact string "true"
# ("1", "yes" and "TRUE" all count as off), matching SLACK_ALERTS_ENABLED.
SLACK_COMMANDS_ENABLED=
```

- [ ] **Step 4: Document the rollout**

In `docs/SLACK-ROLLOUT.md`, add this section immediately before `## Rollback`:

```markdown
---

## Slash commands — `/trinity`

Separate from the notifications above and independently switchable. These read
the same Supabase mirror the digests do and post nothing on their own — they
only answer when someone types.

### Step A — Create the command

In the same Slack app: **Slash Commands → Create New Command**.

- **Command:** `/trinity`
- **Request URL:** `https://<your-vercel-domain>/api/slack/command`
- **Short description:** `Schedule and money, on demand`
- **Usage hint:** `today | tomorrow | week | next week | thursday | money`

Reinstall the app to the workspace if Slack asks.

### Step B — Set the signing secret

**Basic Information → App Credentials → Signing Secret**, then:

```bash
vercel env add SLACK_SIGNING_SECRET
```

This is the only thing authenticating the command route — `/api/slack/*` sits
outside the app's login gate, because a slash command arrives from Slack's
servers with no session cookie. Treat it like the password it is.

### Step C — Flip the switch

```bash
vercel env add SLACK_COMMANDS_ENABLED   # value: true (exactly this string)
```

Redeploy, then type `/trinity today` and compare against `/dashboard`, and
`/trinity week` against the Monday digest. They are rendered by the same code
and should agree exactly.

### What it costs

Nothing per use. There is no AI in this path and no Anthropic API key — the
commands are a fixed vocabulary rendered from Supabase. Why it works that way,
and what was ruled out, is in
`docs/superpowers/specs/2026-08-08-slack-commands-mcp-design.md`.

### Who can use it

Anyone in the workspace. This was a deliberate decision, taken knowing the
replies carry customer names, street addresses and phone numbers. Replies are
**ephemeral** (only the person who typed the command sees them, and nothing is
left in channel history) and everything is read-only, so the exposure is
disclosure rather than damage. To restrict it later, add a `user_id` allowlist
check in `src/lib/slack/commands.ts` — the route already has `user_id` in hand.

### Rollback

Set `SLACK_COMMANDS_ENABLED` to anything other than `true` (or delete it) and
redeploy. The command then replies "not enabled" and touches no data. The
notification settings above are unaffected either way.
```

- [ ] **Step 5: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: all tests pass; the build (typecheck + lint) succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/middleware.test.ts .env.example docs/SLACK-ROLLOUT.md
git commit -m "test(middleware): pin /api/slack outside the session gate; document rollout"
```

---

## Deliberately not implemented

**Message-length splitting.** The spec says that if a day's output ever exceeds
Slack's message limits, it should split on day boundaries rather than truncate
mid-job. No task implements this, because it is not reachable at current volume:
`src/lib/slack/format.ts:36` records the account as running 5–6 jobs a day, so a
full week renders at roughly 4,500 characters against a limit an order of
magnitude larger. Building a splitter now would be untested code guarding a
condition that cannot occur.

**If the account grows** — or a week ever renders long enough that Slack
truncates it — the fix belongs in `formatScheduleDays()`, returning `string[]`
and posting each chunk with `postToResponseUrl` (`response_url` accepts up to 5
posts). Recorded here so it is a known deferral rather than a gap.

## Verification checklist

Before calling this done, run each and confirm the output — do not assume:

- [ ] `npm test` — all suites pass, including the pre-existing digest tests.
- [ ] `npm run build` — typecheck and lint clean.
- [ ] The `formatWeeklyLookahead` regression test passes, proving the 6am digest
      message is byte-identical to before.
- [ ] Temporarily adding `/api/slack/:path*` to the middleware matcher makes the
      new middleware test FAIL (then remove it).
- [ ] No `ANTHROPIC_API_KEY`, `MCP_AUTH_TOKEN`, `MCP_ENABLED`, or `/api/mcp`
      appears anywhere in the diff — Part B is deferred.
