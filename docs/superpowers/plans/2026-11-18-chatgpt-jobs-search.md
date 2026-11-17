# Trinity Jobs Word-by-Word Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Trinity Jobs ChatGPT connector find jobs and customers from plain-language questions ("the jobs at planet fitness on aviation rd"), report which words matched, and steer ChatGPT to confirm partial matches with the user.

**Architecture:** A pure module (`search.ts`) turns the question into search words, labels which words matched which fields, ranks results and writes the guidance note. A query module (`searchQueries.ts`) pre-selects candidate rows from Supabase. The MCP server rewires `find_customer` onto these and adds `search_jobs` and server `instructions`. Only the connector changes; the mobile app's `searchCustomers` is untouched.

**Tech Stack:** Next.js 14 route handlers, `@modelcontextprotocol/sdk` 1.32 (`McpServer`, `Client.getInstructions()`), `zod` 4, `@supabase/supabase-js` (PostgREST `or()`/`ilike` with JSON paths), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-18-chatgpt-jobs-search-design.md`

## Global Constraints

- **Read-only.** No writes to HouseCall Pro or Supabase. No migrations.
- Every tool keeps the annotations `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }` (the existing `READ_ONLY` constant).
- `src/lib/mobile/customers.ts` (`searchCustomers`) must not change.
- `get_customer_history`, `get_job`, `get_schedule`, `get_money_summary` must not change.
- Search words are lowercase `[a-z0-9]` tokens only; nothing else reaches a PostgREST `or()` filter.
- `MAX_TERMS = 5`, `JOB_MATCH_LIMIT = 50`, `CUSTOMER_MATCH_LIMIT = 25` (existing).
- Failed queries return `isError: true` with exactly "Couldn't search jobs just now. Try again in a minute." or "Couldn't search customers just now. Try again in a minute." — never the raw error.
- Every tool result is JSON text with `dataAsOf` (via the existing `ok()` helper).
- Kill switch `MCP_JOBS_ENABLED` and routes are unchanged.
- Known pre-existing state: `npx tsc --noEmit` reports exactly 8 errors, all in `src/app/api/app/**` route test files. There must be no others. A jsdom "Not implemented: navigation" line in the full test output is pre-existing.
- Work only in `d:/TrinityPlumbing/.worktrees/housecallpro-chatgpt-search` (branch `feat/chatgpt-jobs-search`). Run all commands from there.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/mcp/jobs/search.ts` | Create | Pure: `searchTerms`, `matchJob`, `matchCustomer`, `rankJobs`, `rankCustomers`, `termsMatched`, `searchNote`, `customerName`, `formatAddress`; candidate types |
| `src/lib/mcp/jobs/searchQueries.ts` | Create | Supabase pre-selection: `findJobCandidates`, `findCustomerCandidates` |
| `src/lib/mcp/jobs/server.ts` | Modify | `JobsDeps` changes, `find_customer` rewrite, `search_jobs`, `SERVER_INSTRUCTIONS` |
| `src/lib/mcp/jobs/deps.ts` | Modify | Wire the two query functions |
| `src/lib/mcp/jobs/__tests__/search.test.ts` | Create | Pure-function tests |
| `src/lib/mcp/jobs/__tests__/searchQueries.test.ts` | Create | Query tests with a fake Supabase |
| `src/lib/mcp/jobs/__tests__/fixtures.ts` | Modify | Candidate fixtures, `stubDeps` |
| `src/lib/mcp/jobs/__tests__/server.test.ts` | Modify | Tool tests |
| `src/app/api/mcp/jobs/__tests__/route.test.ts` | Modify | 6 tools, instructions |
| `README.md` | Modify | Search + Refresh note |

---

### Task 1: Pure search functions

**Files:**
- Create: `src/lib/mcp/jobs/search.ts`
- Test: `src/lib/mcp/jobs/__tests__/search.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/lib/mcp/jobs/search.ts`):
  - `MAX_TERMS = 5`, `JOB_MATCH_LIMIT = 50`
  - `interface SearchWords { terms: string[]; phoneDigits: string | null; dropped: string[] }`
  - `searchTerms(query: string): SearchWords`
  - `interface CustomerAddress { street: string | null; city: string | null }`
  - `interface JobCandidate { id: string; customerId: string | null; scheduledStart: string | null; workStatus: string | null; onMyWayAt: string | null; amountCents: number | null; street: string | null; city: string | null; description: string | null; jobType: string | null; customer: { id: string; name: string | null; company: string | null; tags: string[] } | null }`
  - `interface CustomerCandidate { id: string; firstName: string | null; lastName: string | null; company: string | null; phone: string | null; city: string | null; notes: string | null; tags: string[]; addresses: CustomerAddress[] }`
  - `type JobMatchOn = "job address" | "job town" | "job description" | "job type" | "customer name" | "customer company" | "customer tag"`
  - `type CustomerMatchOn = "name" | "company" | "city" | "address" | "tag" | "note" | "phone"`
  - `interface Match<On> { term: string; on: On }`
  - `interface CustomerMatch { matched: Match<CustomerMatchOn>[]; matchedAddresses: string[] }`
  - `interface RankedJob { job: JobCandidate; matched: Match<JobMatchOn>[] }`
  - `interface RankedCustomer extends CustomerMatch { customer: CustomerCandidate }`
  - `matchJob(job: JobCandidate, terms: string[]): Match<JobMatchOn>[]`
  - `matchCustomer(c: CustomerCandidate, terms: string[], phoneDigits: string | null): CustomerMatch`
  - `rankJobs(rows: RankedJob[]): RankedJob[]`, `rankCustomers(rows: RankedCustomer[]): RankedCustomer[]`
  - `termsMatched(terms: string[], matches: { term: string }[][]): { matchedTerms: string[]; unmatchedTerms: string[] }`
  - `searchNote(kind: "jobs" | "customers", terms: string[], matchedTerms: string[], unmatchedTerms: string[], count: number, truncatedAt: number | null): string | undefined`
  - `customerName(c: { firstName: string | null; lastName: string | null; company: string | null }): string`
  - `formatAddress(a: CustomerAddress): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/mcp/jobs/__tests__/search.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  MAX_TERMS,
  customerName,
  formatAddress,
  matchCustomer,
  matchJob,
  rankCustomers,
  rankJobs,
  searchNote,
  searchTerms,
  termsMatched,
  type CustomerCandidate,
  type JobCandidate,
} from "../search";

// Synthetic data only.
function job(over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    id: "job_1",
    customerId: "cus_gym",
    scheduledStart: "2026-03-09T17:00:00Z",
    workStatus: "complete rated",
    onMyWayAt: null,
    amountCents: 25000,
    street: "99 Aviation Road",
    city: "Queensbury",
    description: "Replace toilet flange",
    jobType: null,
    customer: { id: "cus_gym", name: "Kay Example", company: "Gymco", tags: [] },
    ...over,
  };
}

function customer(over: Partial<CustomerCandidate> = {}): CustomerCandidate {
  return {
    id: "cus_gym",
    firstName: "Kay ",
    lastName: "Example",
    company: "Gymco ",
    phone: "(518) 555-0142",
    city: "Albany",
    notes: null,
    tags: [],
    addresses: [
      { street: "10 Main St", city: "Albany" },
      { street: "99 Aviation Road", city: "Queensbury" },
    ],
    ...over,
  };
}

describe("searchTerms", () => {
  it("turns Dave's sentence into the words that matter", () => {
    expect(searchTerms("find the jobs we did at planet fitness on aviation rd")).toEqual({
      terms: ["planet", "fitness", "aviation"],
      phoneDigits: null,
      dropped: [],
    });
  });

  it("drops street suffixes and splits on punctuation", () => {
    expect(searchTerms("Troy-Schenectady Rd.").terms).toEqual(["troy", "schenectady"]);
    expect(searchTerms("Clifton Country Road").terms).toEqual(["clifton", "country"]);
  });

  it("keeps house numbers and drops one-letter tokens", () => {
    expect(searchTerms("578 Aviation Rd N").terms).toEqual(["578", "aviation"]);
  });

  it("de-duplicates and caps at five words", () => {
    const r = searchTerms("alpha beta gamma delta epsilon zeta alpha");
    expect(MAX_TERMS).toBe(5);
    expect(r.terms).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    expect(r.dropped).toEqual(["zeta"]);
  });

  it("treats seven or more digits as a phone number, not as words", () => {
    expect(searchTerms("who has phone number (518) 555-0142")).toEqual({
      terms: [],
      phoneDigits: "5185550142",
      dropped: [],
    });
  });

  it("finds a phone number among other words", () => {
    expect(searchTerms("Kay at 518.555.0142")).toEqual({ terms: ["kay"], phoneDigits: "5185550142", dropped: [] });
    expect(searchTerms("1-518-555-0142").phoneDigits).toBe("15185550142");
  });

  it("keeps a house number and ZIP code as words, not a phone number", () => {
    expect(searchTerms("578 Aviation Rd Queensbury 12804")).toEqual({
      terms: ["578", "aviation", "queensbury", "12804"],
      phoneDigits: null,
      dropped: [],
    });
  });

  it("returns no words for a question made only of filler", () => {
    expect(searchTerms("find the jobs")).toEqual({ terms: [], phoneDigits: null, dropped: [] });
  });
});

describe("matchJob", () => {
  it("labels where each word matched, in word order", () => {
    expect(matchJob(job(), ["aviation", "gymco", "flange", "queensbury"])).toEqual([
      { term: "aviation", on: "job address" },
      { term: "gymco", on: "customer company" },
      { term: "flange", on: "job description" },
      { term: "queensbury", on: "job town" },
    ]);
  });

  it("matches job type, customer name and customer tags, ignoring case", () => {
    const j = job({
      jobType: "Commercial Service",
      customer: { id: "cus_gym", name: "Kay Example", company: null, tags: ["planet fitness"] },
    });
    expect(matchJob(j, ["commercial", "example", "planet"])).toEqual([
      { term: "commercial", on: "job type" },
      { term: "example", on: "customer name" },
      { term: "planet", on: "customer tag" },
    ]);
  });

  it("returns nothing for a row that only matched a JSON key in the database", () => {
    expect(matchJob(job(), ["name"])).toEqual([]);
  });
});

describe("matchCustomer", () => {
  it("lists exactly the saved addresses that matched", () => {
    const addresses = Array.from({ length: 13 }, (_, i) =>
      i === 9 ? { street: "99 Aviation Road", city: "Queensbury" } : { street: `${i + 1}0 Main St`, city: "Albany" }
    );
    const r = matchCustomer(customer({ addresses }), ["aviation"], null);
    expect(r.matched).toEqual([{ term: "aviation", on: "address" }]);
    expect(r.matchedAddresses).toEqual(["99 Aviation Road, Queensbury"]);
  });

  it("labels name, company, city, address, tag, note and phone", () => {
    const c = customer({ tags: ["planet fitness"], notes: "Locker room sink leaks" });
    expect(matchCustomer(c, ["kay", "gymco", "albany", "planet", "locker"], "5185550142").matched).toEqual([
      { term: "kay", on: "name" },
      { term: "gymco", on: "company" },
      { term: "albany", on: "city" },
      { term: "albany", on: "address" },
      { term: "planet", on: "tag" },
      { term: "locker", on: "note" },
      { term: "5185550142", on: "phone" },
    ]);
  });

  it("matches a phone typed with or without the leading 1", () => {
    expect(matchCustomer(customer({ phone: "15185550142" }), [], "5185550142").matched).toEqual([
      { term: "5185550142", on: "phone" },
    ]);
    expect(matchCustomer(customer({ phone: "518-555-0142" }), [], "15185550142").matched).toEqual([
      { term: "15185550142", on: "phone" },
    ]);
    expect(matchCustomer(customer({ phone: null }), [], "5185550142").matched).toEqual([]);
  });
});

describe("ranking", () => {
  it("puts jobs matching more words first, then newest first, undated last", () => {
    const one = (id: string, when: string | null) => ({
      job: job({ id, scheduledStart: when }),
      matched: [{ term: "aviation", on: "job address" as const }],
    });
    const two = {
      job: job({ id: "job_two", scheduledStart: "2024-01-01T15:00:00Z" }),
      matched: [
        { term: "aviation", on: "job address" as const },
        { term: "gymco", on: "customer company" as const },
      ],
    };
    const ranked = rankJobs([one("job_old", "2025-01-01T15:00:00Z"), one("job_none", null), two, one("job_new", "2026-01-01T15:00:00Z")]);
    expect(ranked.map((r) => r.job.id)).toEqual(["job_two", "job_new", "job_old", "job_none"]);
  });

  it("puts customers matching more words first, then by name", () => {
    const row = (id: string, firstName: string, terms: string[]) => ({
      customer: customer({ id, firstName, lastName: null }),
      matched: terms.map((term) => ({ term, on: "name" as const })),
      matchedAddresses: [],
    });
    const ranked = rankCustomers([row("c1", "Zed", ["a"]), row("c2", "Amy", ["a"]), row("c3", "Max", ["a", "b"])]);
    expect(ranked.map((r) => r.customer.id)).toEqual(["c3", "c2", "c1"]);
  });
});

describe("termsMatched", () => {
  it("splits the words into matched and unmatched, keeping their order", () => {
    expect(termsMatched(["planet", "fitness", "aviation"], [[{ term: "aviation" }], [{ term: "aviation" }]])).toEqual({
      matchedTerms: ["aviation"],
      unmatchedTerms: ["planet", "fitness"],
    });
  });
});

describe("searchNote", () => {
  it("asks for something to search when there are no words", () => {
    expect(searchNote("jobs", [], [], [], 0, null)).toBe(
      "Give a name, business, street, town or phone number to search for."
    );
  });

  it("asks for another detail when nothing matched", () => {
    expect(searchNote("jobs", ["zebra", "quartz"], [], ["zebra", "quartz"], 0, null)).toBe(
      'Nothing in Trinity\'s records matched "zebra", "quartz". Ask the user for another detail: the street or town, the customer\'s name, or roughly when the work was done.'
    );
  });

  it("tells ChatGPT to confirm a partial match", () => {
    expect(searchNote("jobs", ["planet", "fitness", "aviation"], ["aviation"], ["planet", "fitness"], 10, null)).toBe(
      'Nothing in Trinity\'s records mentions "planet", "fitness". These jobs matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.'
    );
  });

  it("says nothing when every word matched", () => {
    expect(searchNote("customers", ["smith"], ["smith"], [], 3, null)).toBeUndefined();
  });

  it("adds the truncation advice, alone or after the partial-match note", () => {
    expect(searchNote("jobs", ["aviation"], ["aviation"], [], 50, 50)).toBe(
      "Showing the first 50; ask the user for a date or a town to narrow it down."
    );
    expect(searchNote("customers", ["smith", "zz"], ["smith"], ["zz"], 25, 25)).toBe(
      'Nothing in Trinity\'s records mentions "zz". These customers matched "smith". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer. Showing the first 25; ask the user for a date or a town to narrow it down.'
    );
  });
});

describe("display helpers", () => {
  it("builds a trimmed name, falling back to the company", () => {
    expect(customerName({ firstName: "Kay ", lastName: " Example", company: "Gymco" })).toBe("Kay Example");
    expect(customerName({ firstName: null, lastName: "  ", company: " Gymco " })).toBe("Gymco");
    expect(customerName({ firstName: null, lastName: null, company: null })).toBe("Unnamed customer");
  });

  it("formats an address and skips empty parts", () => {
    expect(formatAddress({ street: " 99 Aviation Road ", city: "Queensbury" })).toBe("99 Aviation Road, Queensbury");
    expect(formatAddress({ street: null, city: "Queensbury" })).toBe("Queensbury");
    expect(formatAddress({ street: null, city: " " })).toBeNull();
  });
});
```

Run: `npx vitest run src/lib/mcp/jobs/__tests__/search.test.ts`
Expected: FAIL (cannot find module `../search`).

- [ ] **Step 2: Implement**

Create `src/lib/mcp/jobs/search.ts`:

```ts
// Word-by-word matching for the Trinity Jobs search tools. Pure: no I/O. The
// database only pre-selects candidates; these functions decide what is
// returned and record which words matched where, so ChatGPT can tell the user
// what it found and what it couldn't.
// Spec: docs/superpowers/specs/2026-11-18-chatgpt-jobs-search-design.md

export const MAX_TERMS = 5;
export const JOB_MATCH_LIMIT = 50;

// Words people use to ask, not to identify anything.
const FILLER = new Set([
  "a", "an", "the", "at", "on", "in", "of", "for", "to", "and", "or", "we", "our", "us", "i", "me", "my",
  "did", "do", "done", "does", "find", "show", "get", "list", "give", "tell", "what", "which", "where",
  "when", "any", "all", "job", "jobs", "work", "worked", "customer", "customers", "place", "location",
  "please", "there", "that", "this", "those", "these", "from", "with", "by", "who", "has", "have", "had",
  "is", "are", "was", "about", "phone", "number", "call", "called", "named", "name",
]);

// "Aviation Rd" must find "Aviation Road", so the street type is not searched.
const STREET_SUFFIXES = new Set([
  "rd", "road", "st", "street", "ave", "av", "avenue", "dr", "drive", "ln", "lane", "blvd", "boulevard",
  "ct", "court", "pl", "way", "hwy", "highway", "rte", "route", "pkwy", "parkway", "tpke", "turnpike",
  "ext", "extension", "cir", "circle", "ter", "terrace",
]);

export interface SearchWords {
  terms: string[];
  phoneDigits: string | null;
  dropped: string[];
}

// Digits joined only by phone punctuation. A house number and a ZIP code with
// words between them are separate runs, so they never add up to a phone.
const DIGIT_RUN = /\d(?:[\s().+-]*\d)*/g;

// Lowercase [a-z0-9] tokens only: nothing that could change the meaning of a
// PostgREST or() filter survives this.
export function searchTerms(query: string): SearchWords {
  let rest = query.toLowerCase();
  let phoneDigits: string | null = null;
  for (const run of rest.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 11) {
      phoneDigits = digits;
      rest = rest.replace(run, " ");
      break;
    }
  }
  const words: string[] = [];
  for (const token of rest.match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 2 || FILLER.has(token) || STREET_SUFFIXES.has(token)) continue;
    if (!words.includes(token)) words.push(token);
  }
  return { terms: words.slice(0, MAX_TERMS), phoneDigits, dropped: words.slice(MAX_TERMS) };
}

export interface CustomerAddress {
  street: string | null;
  city: string | null;
}

export interface JobCandidate {
  id: string;
  customerId: string | null;
  scheduledStart: string | null;
  workStatus: string | null;
  onMyWayAt: string | null;
  amountCents: number | null;
  street: string | null;
  city: string | null;
  description: string | null;
  jobType: string | null;
  customer: { id: string; name: string | null; company: string | null; tags: string[] } | null;
}

export interface CustomerCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  city: string | null;
  notes: string | null;
  tags: string[];
  addresses: CustomerAddress[];
}

export type JobMatchOn =
  | "job address"
  | "job town"
  | "job description"
  | "job type"
  | "customer name"
  | "customer company"
  | "customer tag";

export type CustomerMatchOn = "name" | "company" | "city" | "address" | "tag" | "note" | "phone";

export interface Match<On> {
  term: string;
  on: On;
}

export interface CustomerMatch {
  matched: Match<CustomerMatchOn>[];
  matchedAddresses: string[];
}

export interface RankedJob {
  job: JobCandidate;
  matched: Match<JobMatchOn>[];
}

export interface RankedCustomer extends CustomerMatch {
  customer: CustomerCandidate;
}

const clean = (s: string | null | undefined) => (s ?? "").trim();
const contains = (value: string | null | undefined, term: string) => !!value && value.toLowerCase().includes(term);

export function formatAddress(a: CustomerAddress): string | null {
  return [clean(a.street), clean(a.city)].filter(Boolean).join(", ") || null;
}

export function customerName(c: { firstName: string | null; lastName: string | null; company: string | null }): string {
  return [clean(c.firstName), clean(c.lastName)].filter(Boolean).join(" ") || clean(c.company) || "Unnamed customer";
}

export function matchJob(job: JobCandidate, terms: string[]): Match<JobMatchOn>[] {
  const fields: [JobMatchOn, (string | null)[]][] = [
    ["job address", [job.street]],
    ["job town", [job.city]],
    ["job description", [job.description]],
    ["job type", [job.jobType]],
    ["customer name", [job.customer?.name ?? null]],
    ["customer company", [job.customer?.company ?? null]],
    ["customer tag", job.customer?.tags ?? []],
  ];
  const matched: Match<JobMatchOn>[] = [];
  for (const term of terms) {
    for (const [on, values] of fields) {
      if (values.some((v) => contains(v, term))) matched.push({ term, on });
    }
  }
  return matched;
}

export function matchCustomer(c: CustomerCandidate, terms: string[], phoneDigits: string | null): CustomerMatch {
  const fullName = [clean(c.firstName), clean(c.lastName)].filter(Boolean).join(" ");
  const addresses = c.addresses.map(formatAddress).filter((a): a is string => a !== null);
  const matched: Match<CustomerMatchOn>[] = [];
  const matchedAddresses: string[] = [];
  for (const term of terms) {
    if (contains(fullName, term)) matched.push({ term, on: "name" });
    if (contains(c.company, term)) matched.push({ term, on: "company" });
    if (contains(c.city, term)) matched.push({ term, on: "city" });
    const hits = addresses.filter((a) => contains(a, term));
    if (hits.length > 0) {
      matched.push({ term, on: "address" });
      for (const a of hits) if (!matchedAddresses.includes(a)) matchedAddresses.push(a);
    }
    if (c.tags.some((t) => contains(t, term))) matched.push({ term, on: "tag" });
    if (contains(c.notes, term)) matched.push({ term, on: "note" });
  }
  if (phoneDigits && c.phone) {
    // Stored numbers may carry punctuation or a leading 1; either side may.
    const stored = c.phone.replace(/\D/g, "");
    if (stored.length >= 7 && (stored.includes(phoneDigits) || phoneDigits.endsWith(stored))) {
      matched.push({ term: phoneDigits, on: "phone" });
    }
  }
  return { matched, matchedAddresses };
}

const distinctTerms = (matched: { term: string }[]) => new Set(matched.map((m) => m.term)).size;
// Undated jobs sort last among equals (0 is older than any real date).
const startTime = (iso: string | null) => (iso ? Date.parse(iso) : 0);

export function rankJobs(rows: RankedJob[]): RankedJob[] {
  return [...rows].sort(
    (a, b) =>
      distinctTerms(b.matched) - distinctTerms(a.matched) ||
      startTime(b.job.scheduledStart) - startTime(a.job.scheduledStart)
  );
}

export function rankCustomers(rows: RankedCustomer[]): RankedCustomer[] {
  return [...rows].sort(
    (a, b) =>
      distinctTerms(b.matched) - distinctTerms(a.matched) ||
      customerName(a.customer).localeCompare(customerName(b.customer))
  );
}

export function termsMatched(
  terms: string[],
  matches: { term: string }[][]
): { matchedTerms: string[]; unmatchedTerms: string[] } {
  const hit = new Set(matches.flat().map((m) => m.term));
  return { matchedTerms: terms.filter((t) => hit.has(t)), unmatchedTerms: terms.filter((t) => !hit.has(t)) };
}

const quoted = (words: string[]) => words.map((w) => `"${w}"`).join(", ");

// The note is how the connector gets ChatGPT to check with the user: it can't
// ask the user itself, but it can tell ChatGPT exactly what to say.
export function searchNote(
  kind: "jobs" | "customers",
  terms: string[],
  matchedTerms: string[],
  unmatchedTerms: string[],
  count: number,
  truncatedAt: number | null
): string | undefined {
  if (terms.length === 0) return "Give a name, business, street, town or phone number to search for.";
  if (count === 0) {
    return `Nothing in Trinity's records matched ${quoted(terms)}. Ask the user for another detail: the street or town, the customer's name, or roughly when the work was done.`;
  }
  const parts: string[] = [];
  if (unmatchedTerms.length > 0) {
    parts.push(
      `Nothing in Trinity's records mentions ${quoted(unmatchedTerms)}. These ${kind} matched ${quoted(matchedTerms)}. Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.`
    );
  }
  if (truncatedAt !== null) {
    parts.push(`Showing the first ${truncatedAt}; ask the user for a date or a town to narrow it down.`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/mcp/jobs/__tests__/search.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/jobs/search.ts src/lib/mcp/jobs/__tests__/search.test.ts
git commit -m "feat(mcp): word-by-word matching for Trinity Jobs search"
```

---

### Task 2: Supabase candidate queries

**Files:**
- Create: `src/lib/mcp/jobs/searchQueries.ts`
- Test: `src/lib/mcp/jobs/__tests__/searchQueries.test.ts`

**Interfaces:**
- Consumes: `CustomerAddress`, `CustomerCandidate`, `JobCandidate` types from `src/lib/mcp/jobs/search.ts` (Task 1); `getSupabaseServerClient()` from `src/lib/supabase/client.ts`. (Customers are loaded by a local `customersById` that chunks like `selectByIds` but throws on error; `selectByIds` itself is not used.)
- Produces:
  - `findJobCandidates(terms: string[]): Promise<JobCandidate[]>`
  - `findCustomerCandidates(terms: string[], phoneDigits: string | null): Promise<CustomerCandidate[]>`
  - Both throw `Error("job search failed: …")` / `Error("customer search failed: …")` on a query error, and return `[]` without querying when there's nothing to search.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/mcp/jobs/__tests__/searchQueries.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { findCustomerCandidates, findJobCandidates } from "../searchQueries";

interface Call {
  table: string;
  select?: string;
  or?: string;
  in?: [string, string[]];
  limit?: number;
}
type Reply = { data: unknown[] | null; error: { message: string } | null };

// A stand-in Supabase client: records each query and answers it with
// `respond`. Every builder method returns the builder; awaiting it resolves.
function fakeSupabase(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  supabaseMock.mockReturnValue({
    from(table: string) {
      const call: Call = { table };
      calls.push(call);
      const builder = {
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        or(filter: string) {
          call.or = filter;
          return builder;
        },
        in(column: string, ids: string[]) {
          call.in = [column, ids];
          return builder;
        },
        limit(n: number) {
          call.limit = n;
          return builder;
        },
        then(resolve: (v: Reply) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(respond(call)).then(resolve, reject);
        },
      };
      return builder;
    },
  });
  return calls;
}

const JOB_ROW = {
  id: "job_1",
  customer_id: "cus_gym",
  scheduled_start: "2026-03-09T17:00:00Z",
  work_status: "complete rated",
  total_amount_cents: 25000,
  street: "99 Aviation Road",
  city: "Queensbury",
  description: "Replace toilet flange",
  job_type: null,
  on_my_way_at: null,
};

beforeEach(() => vi.clearAllMocks());

describe("findJobCandidates", () => {
  it("searches job fields and customer names, then attaches customers", async () => {
    const calls = fakeSupabase((c) => {
      if (c.table === "jobs" && c.or) return { data: [JOB_ROW], error: null };
      if (c.table === "customers" && c.or) return { data: [{ id: "cus_two" }], error: null };
      if (c.table === "jobs" && c.in) {
        return { data: [JOB_ROW, { ...JOB_ROW, id: "job_2", customer_id: "cus_two" }], error: null };
      }
      if (c.table === "customers" && c.in) {
        return {
          data: [
            { id: "cus_gym", first_name: "Kay ", last_name: "Example", company: "Gymco ", tags: ["planet fitness"] },
            { id: "cus_two", first_name: null, last_name: null, company: null, tags: null },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const result = await findJobCandidates(["aviation"]);

    const jobSearch = calls.find((c) => c.table === "jobs" && c.or)!;
    expect(jobSearch.or).toBe(
      "raw->address->>street.ilike.%aviation%,raw->address->>city.ilike.%aviation%,raw->>description.ilike.%aviation%,raw->job_fields->job_type->>name.ilike.%aviation%"
    );
    expect(jobSearch.select).toContain("street:raw->address->>street");
    expect(jobSearch.select).toContain("on_my_way_at:raw->work_timestamps->>on_my_way_at");
    expect(jobSearch.limit).toBe(200);

    const customerSearch = calls.find((c) => c.table === "customers" && c.or)!;
    expect(customerSearch.or).toBe(
      "first_name.ilike.%aviation%,last_name.ilike.%aviation%,company.ilike.%aviation%,raw->>tags.ilike.%aviation%"
    );
    expect(customerSearch.limit).toBe(50);

    const theirJobs = calls.find((c) => c.table === "jobs" && c.in)!;
    expect(theirJobs.in).toEqual(["customer_id", ["cus_two"]]);
    expect(theirJobs.limit).toBe(300);

    // job_1 came back from both searches but appears once.
    expect(result.map((j) => j.id)).toEqual(["job_1", "job_2"]);
    expect(result[0]).toEqual({
      id: "job_1",
      customerId: "cus_gym",
      scheduledStart: "2026-03-09T17:00:00Z",
      workStatus: "complete rated",
      onMyWayAt: null,
      amountCents: 25000,
      street: "99 Aviation Road",
      city: "Queensbury",
      description: "Replace toilet flange",
      jobType: null,
      customer: { id: "cus_gym", name: "Kay Example", company: "Gymco", tags: ["planet fitness"] },
    });
    expect(result[1].customer).toEqual({ id: "cus_two", name: null, company: null, tags: [] });
  });

  it("skips the customer-jobs query when no customer matched", async () => {
    const calls = fakeSupabase((c) => (c.table === "jobs" && c.or ? { data: [JOB_ROW], error: null } : { data: [], error: null }));
    await findJobCandidates(["aviation"]);
    expect(calls.some((c) => c.table === "jobs" && c.in)).toBe(false);
  });

  it("throws on a query error", async () => {
    fakeSupabase((c) => (c.table === "jobs" ? { data: null, error: { message: "boom" } } : { data: [], error: null }));
    await expect(findJobCandidates(["aviation"])).rejects.toThrow("job search failed: boom");
  });

  it("fails the search when the customer lookup fails, instead of dropping jobs", async () => {
    fakeSupabase((c) => {
      if (c.table === "jobs") return { data: [JOB_ROW], error: null };
      if (c.table === "customers" && c.in) return { data: null, error: { message: "lookup down" } };
      return { data: [], error: null };
    });
    await expect(findJobCandidates(["aviation"])).rejects.toThrow("job search failed: lookup down");
  });

  it("does not query when there are no words", async () => {
    const calls = fakeSupabase(() => ({ data: [], error: null }));
    expect(await findJobCandidates([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("findCustomerCandidates", () => {
  const CUSTOMER_ROW = {
    id: "cus_gym",
    first_name: "Kay ",
    last_name: "Example",
    company: "Gymco ",
    phone: "5185550142",
    city: "Albany",
    notes: null,
    tags: ["planet fitness"],
    addresses: [
      { street: "10 Main St", city: "Albany", zip: "12205" },
      { street: "99 Aviation Road", city: "Queensbury" },
    ],
  };

  it("searches every saved address, tags and notes, one query per word", async () => {
    const calls = fakeSupabase(() => ({ data: [CUSTOMER_ROW], error: null }));
    const result = await findCustomerCandidates(["aviation", "gymco"], null);

    expect(calls).toHaveLength(2);
    expect(calls[0].or).toBe(
      "first_name.ilike.%aviation%,last_name.ilike.%aviation%,company.ilike.%aviation%,city.ilike.%aviation%,notes.ilike.%aviation%,raw->>addresses.ilike.%aviation%,raw->>tags.ilike.%aviation%"
    );
    expect(calls[0].select).toContain("addresses:raw->addresses");
    expect(calls[0].limit).toBe(50);

    // Same customer from both words appears once.
    expect(result).toEqual([
      {
        id: "cus_gym",
        firstName: "Kay ",
        lastName: "Example",
        company: "Gymco ",
        phone: "5185550142",
        city: "Albany",
        notes: null,
        tags: ["planet fitness"],
        addresses: [
          { street: "10 Main St", city: "Albany" },
          { street: "99 Aviation Road", city: "Queensbury" },
        ],
      },
    ]);
  });

  it("searches the phone the same two ways the mobile search does", async () => {
    const calls = fakeSupabase(() => ({ data: [], error: null }));
    await findCustomerCandidates([], "5185550142");
    expect(calls).toHaveLength(1);
    expect(calls[0].or).toBe("phone.ilike.%5185550142%,phone.ilike.%5%1%8%5%5%5%0%1%4%2%");
  });

  it("treats a missing or malformed address list as no addresses", async () => {
    fakeSupabase(() => ({ data: [{ ...CUSTOMER_ROW, addresses: null, tags: null }], error: null }));
    const [c] = await findCustomerCandidates(["gymco"], null);
    expect(c.addresses).toEqual([]);
    expect(c.tags).toEqual([]);
  });

  it("throws on a query error", async () => {
    fakeSupabase(() => ({ data: null, error: { message: "boom" } }));
    await expect(findCustomerCandidates(["gymco"], null)).rejects.toThrow("customer search failed: boom");
  });

  it("does not query when there is nothing to search", async () => {
    const calls = fakeSupabase(() => ({ data: [], error: null }));
    expect(await findCustomerCandidates([], null)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
```

Run: `npx vitest run src/lib/mcp/jobs/__tests__/searchQueries.test.ts`
Expected: FAIL (cannot find module `../searchQueries`).

- [ ] **Step 2: Implement**

Create `src/lib/mcp/jobs/searchQueries.ts`:

```ts
// Supabase reads behind the Trinity Jobs search tools. These only pre-select:
// a row comes back if a search word appears anywhere in a searched field,
// including inside raw JSON. search.ts then decides what really matched.
// Spec: docs/superpowers/specs/2026-11-18-chatgpt-jobs-search-design.md
import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { CustomerAddress, CustomerCandidate, JobCandidate } from "./search";

type Supabase = ReturnType<typeof getSupabaseServerClient>;
const ID_CHUNK = 200;

const JOB_COLUMNS =
  "id, customer_id, scheduled_start, work_status, total_amount_cents, street:raw->address->>street, city:raw->address->>city, description:raw->>description, job_type:raw->job_fields->job_type->>name, on_my_way_at:raw->work_timestamps->>on_my_way_at";
const CUSTOMER_COLUMNS = "id, first_name, last_name, company, phone, city, notes, tags, addresses:raw->addresses";

const JOBS_PER_TERM = 200;
const CUSTOMERS_PER_TERM = 50;
const JOBS_PER_CUSTOMER_MATCH = 300;

interface JobRow {
  id: string;
  customer_id: string | null;
  scheduled_start: string | null;
  work_status: string | null;
  total_amount_cents: number | null;
  street: string | null;
  city: string | null;
  description: string | null;
  job_type: string | null;
  on_my_way_at: string | null;
}

interface CustomerNameRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  tags: string[] | null;
}

interface CustomerRow extends CustomerNameRow {
  phone: string | null;
  city: string | null;
  notes: string | null;
  addresses: unknown;
}

// Terms come from searchTerms(): lowercase [a-z0-9] only, so nothing in them
// can change the meaning of a PostgREST or() filter.
const anyContains = (columns: string[], term: string) => columns.map((c) => `${c}.ilike.%${term}%`).join(",");

export async function findJobCandidates(terms: string[]): Promise<JobCandidate[]> {
  if (terms.length === 0) return [];
  const supabase = getSupabaseServerClient();

  const perTerm = await Promise.all(
    terms.map(async (term) => {
      const [byJob, byCustomer] = await Promise.all([
        supabase
          .from("jobs")
          .select(JOB_COLUMNS)
          .or(
            anyContains(
              ["raw->address->>street", "raw->address->>city", "raw->>description", "raw->job_fields->job_type->>name"],
              term
            )
          )
          .limit(JOBS_PER_TERM),
        // A customer's own addresses deliberately don't pull in its jobs: a
        // customer with 13 locations would return every location's jobs.
        supabase
          .from("customers")
          .select("id")
          .or(anyContains(["first_name", "last_name", "company", "raw->>tags"], term))
          .limit(CUSTOMERS_PER_TERM),
      ]);
      if (byJob.error) throw new Error(`job search failed: ${byJob.error.message}`);
      if (byCustomer.error) throw new Error(`job search failed: ${byCustomer.error.message}`);

      const jobs = (byJob.data ?? []) as unknown as JobRow[];
      const ids = ((byCustomer.data ?? []) as unknown as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) return jobs;

      const theirJobs = await supabase
        .from("jobs")
        .select(JOB_COLUMNS)
        .in("customer_id", ids)
        .limit(JOBS_PER_CUSTOMER_MATCH);
      if (theirJobs.error) throw new Error(`job search failed: ${theirJobs.error.message}`);
      return [...jobs, ...((theirJobs.data ?? []) as unknown as JobRow[])];
    })
  );

  const rows = new Map<string, JobRow>();
  for (const row of perTerm.flat()) rows.set(row.id, row);

  const customerIds = Array.from(
    new Set(Array.from(rows.values()).map((r) => r.customer_id).filter((id): id is string => !!id))
  );
  const customers = await customersById(supabase, customerIds);
  const byId = new Map(customers.map((c) => [c.id, c]));

  return Array.from(rows.values()).map((r) => toJobCandidate(r, r.customer_id ? byId.get(r.customer_id) : undefined));
}

export async function findCustomerCandidates(terms: string[], phoneDigits: string | null): Promise<CustomerCandidate[]> {
  if (terms.length === 0 && !phoneDigits) return [];
  const supabase = getSupabaseServerClient();

  const filters = terms.map((t) =>
    anyContains(["first_name", "last_name", "company", "city", "notes", "raw->>addresses", "raw->>tags"], t)
  );
  // The same two phone patterns as the mobile app's searchCustomers: the digits
  // as typed, and with `%` between each digit so a punctuated number matches.
  if (phoneDigits) {
    filters.push(`phone.ilike.%${phoneDigits}%,phone.ilike.%${phoneDigits.split("").join("%")}%`);
  }

  const results = await Promise.all(
    filters.map((f) => supabase.from("customers").select(CUSTOMER_COLUMNS).or(f).limit(CUSTOMERS_PER_TERM))
  );

  const rows = new Map<string, CustomerRow>();
  for (const r of results) {
    if (r.error) throw new Error(`customer search failed: ${r.error.message}`);
    for (const row of (r.data ?? []) as unknown as CustomerRow[]) rows.set(row.id, row);
  }
  return Array.from(rows.values()).map(toCustomerCandidate);
}

// Like selectByIds (chunked, so the id list never makes an over-long URL), but
// a failure fails the search: a job found only by its customer's name or tag
// must not silently vanish because the name lookup broke.
async function customersById(supabase: Supabase, ids: string[]): Promise<CustomerNameRow[]> {
  const out: CustomerNameRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, first_name, last_name, company, tags")
      .in("id", ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`job search failed: ${error.message}`);
    out.push(...((data ?? []) as unknown as CustomerNameRow[]));
  }
  return out;
}

function toJobCandidate(r: JobRow, c: CustomerNameRow | undefined): JobCandidate {
  return {
    id: r.id,
    customerId: r.customer_id,
    scheduledStart: r.scheduled_start,
    workStatus: r.work_status,
    onMyWayAt: r.on_my_way_at,
    amountCents: r.total_amount_cents,
    street: r.street,
    city: r.city,
    description: r.description,
    jobType: r.job_type,
    customer: c
      ? {
          id: c.id,
          name: [c.first_name, c.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || null,
          company: c.company?.trim() || null,
          tags: c.tags ?? [],
        }
      : null,
  };
}

function toAddresses(raw: unknown): CustomerAddress[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ street?: unknown; city?: unknown } | null>).map((a) => ({
    street: typeof a?.street === "string" ? a.street : null,
    city: typeof a?.city === "string" ? a.city : null,
  }));
}

function toCustomerCandidate(r: CustomerRow): CustomerCandidate {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    company: r.company,
    phone: r.phone,
    city: r.city,
    notes: r.notes,
    tags: r.tags ?? [],
    addresses: toAddresses(r.addresses),
  };
}
```

- [ ] **Step 3: Run the tests and type-check**

Run: `npx vitest run src/lib/mcp/jobs/__tests__/searchQueries.test.ts` → all PASS.
Run: `npx tsc --noEmit` → exactly the 8 pre-existing errors, none in `src/lib/mcp/jobs/`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/jobs/searchQueries.ts src/lib/mcp/jobs/__tests__/searchQueries.test.ts
git commit -m "feat(mcp): Supabase candidate queries for Trinity Jobs search"
```

---

### Task 3: Rebuild `find_customer` on the word-by-word search

**Files:**
- Modify: `src/lib/mcp/jobs/server.ts` (imports; `JobsDeps.searchCustomers`; the `find_customer` registration; add `customerResult`; fix `READ_ONLY` spacing)
- Modify: `src/lib/mcp/jobs/deps.ts`
- Modify: `src/lib/mcp/jobs/__tests__/fixtures.ts`
- Modify: `src/lib/mcp/jobs/__tests__/server.test.ts`
- Modify: `src/app/api/mcp/jobs/__tests__/route.test.ts` (the "runs a tool end to end" assertion)

**Interfaces:**
- Consumes (Task 1): `searchTerms`, `matchCustomer`, `rankCustomers`, `termsMatched`, `searchNote`, `customerName`, `formatAddress`, types `CustomerCandidate`, `CustomerMatch`. (Task 2): `findCustomerCandidates(terms, phoneDigits)`.
- Produces: `JobsDeps.findCustomerCandidates(terms: string[], phoneDigits: string | null): Promise<CustomerCandidate[]>` (replacing `searchCustomers`); fixtures `CUSTOMER_CANDIDATE`, `GYM_CUSTOMER`; `find_customer` result `{ query, terms, matchedTerms, unmatchedTerms, count, truncated, customers: [{ id, name, company, phone, address, addressCount, matchedAddresses, matched }], note?, dataAsOf }`.

- [ ] **Step 1: Update the fixtures**

In `src/lib/mcp/jobs/__tests__/fixtures.ts`, add to the imports:

```ts
import type { CustomerCandidate } from "../search";
```

Add below `CUSTOMER_DETAIL`:

```ts
export const CUSTOMER_CANDIDATE: CustomerCandidate = {
  id: "cus_1",
  firstName: "Pat",
  lastName: "Example",
  company: null,
  phone: "5185550142",
  city: "Averill Park",
  notes: null,
  tags: [],
  addresses: [{ street: "12 Elm St", city: "Averill Park" }],
};

// A gym owner billed under her own name with 13 locations; the Aviation Road
// gym is the 10th saved address. Synthetic, modelled on the case that found
// the gap.
export const GYM_CUSTOMER: CustomerCandidate = {
  id: "cus_gym",
  firstName: "Kay ",
  lastName: "Example",
  company: "Gymco ",
  phone: null,
  city: "Albany",
  notes: null,
  tags: [],
  addresses: Array.from({ length: 13 }, (_, i) =>
    i === 9 ? { street: "99 Aviation Road", city: "Queensbury" } : { street: `${i + 1}0 Main St`, city: "Albany" }
  ),
};
```

In `stubDeps`, replace the line `searchCustomers: async () => [CUSTOMER_HIT],` with:

```ts
    findCustomerCandidates: async () => [CUSTOMER_CANDIDATE],
```

- [ ] **Step 2: Write the failing tests**

In `src/lib/mcp/jobs/__tests__/server.test.ts`:

1. Change the fixtures import line to:

```ts
import { CUSTOMER_CANDIDATE, GYM_CUSTOMER, NOW, SYNCED_AT, connect, scheduleRow, stubDeps, text } from "./fixtures";
```

(Keep `CUSTOMER_HIT` in the import only if it is still used elsewhere in the file after this step.)

2. Delete the two existing tests `"finds customers and stamps the customers sync time"` and `"flags results that hit the match cap"`.

3. Append this block to the end of the file:

```ts
describe("find_customer", () => {
  it("finds a customer by any saved address and says which words matched", async () => {
    const calls: Array<[string[], string | null]> = [];
    const { deps, freshnessCalls } = stubDeps({
      findCustomerCandidates: async (terms, phone) => {
        calls.push([terms, phone]);
        return [CUSTOMER_CANDIDATE, GYM_CUSTOMER];
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "find_customer", arguments: { query: "planet fitness on aviation rd" } }))
    );

    expect(calls).toEqual([[["planet", "fitness", "aviation"], null]]);
    expect(body).toMatchObject({
      query: "planet fitness on aviation rd",
      terms: ["planet", "fitness", "aviation"],
      matchedTerms: ["aviation"],
      unmatchedTerms: ["planet", "fitness"],
      count: 1,
      truncated: false,
      dataAsOf: SYNCED_AT,
    });
    expect(body.customers).toEqual([
      {
        id: "cus_gym",
        name: "Kay Example",
        company: "Gymco",
        phone: null,
        address: "10 Main St, Albany",
        addressCount: 13,
        matchedAddresses: ["99 Aviation Road, Queensbury"],
        matched: [{ term: "aviation", on: "address" }],
      },
    ]);
    expect(body.note).toBe(
      'Nothing in Trinity\'s records mentions "planet", "fitness". These customers matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.'
    );
    expect(freshnessCalls).toEqual([["customers"]]);
  });

  it("still finds a customer by phone number", async () => {
    const calls: Array<[string[], string | null]> = [];
    const { deps } = stubDeps({
      findCustomerCandidates: async (terms, phone) => {
        calls.push([terms, phone]);
        return [CUSTOMER_CANDIDATE];
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "518-555-0142" } })));
    expect(calls).toEqual([[[], "5185550142"]]);
    expect(body.terms).toEqual(["5185550142"]);
    expect(body.customers[0]).toMatchObject({ id: "cus_1", matched: [{ term: "5185550142", on: "phone" }] });
    expect(body.note).toBeUndefined();
  });

  it("flags results past the match cap", async () => {
    const { deps } = stubDeps({
      findCustomerCandidates: async () =>
        Array.from({ length: 30 }, (_, i) => ({ ...CUSTOMER_CANDIDATE, id: `cus_${i}`, lastName: "Smith" })),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "smith" } })));
    expect(body.count).toBe(25);
    expect(body.truncated).toBe(true);
    expect(body.note).toBe("Showing the first 25; ask the user for a date or a town to narrow it down.");
  });

  it("asks for something to search when the question is only filler, without querying", async () => {
    let queried = false;
    const { deps } = stubDeps({
      findCustomerCandidates: async () => {
        queried = true;
        return [];
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "find the customer" } })));
    expect(queried).toBe(false);
    expect(body).toMatchObject({ count: 0, customers: [], note: "Give a name, business, street, town or phone number to search for." });
  });

  it("hides the raw error when the search fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = stubDeps({
      findCustomerCandidates: async () => {
        throw new Error("customer search failed: Pat Example, 12 Elm St");
      },
    });
    const client = await connect(deps);
    const res = await client.callTool({ name: "find_customer", arguments: { query: "pat" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Couldn't search customers just now. Try again in a minute.");
  });
});
```

4. In `src/app/api/mcp/jobs/__tests__/route.test.ts`, in the test "runs a tool end to end", replace `expect(body.customers).toEqual([CUSTOMER_HIT]);` with:

```ts
    expect(body.customers.map((c: { id: string }) => c.id)).toEqual(["cus_1"]);
```

and remove `CUSTOMER_HIT` from that file's fixtures import (keep `stubDeps`).

Run: `npx vitest run src/lib/mcp/jobs src/app/api/mcp/jobs`
Expected: FAIL (`findCustomerCandidates` is not part of `JobsDeps`; old `find_customer` result shape).

- [ ] **Step 3: Implement in `server.ts`**

1. Replace `import type { CustomerDetail, CustomerHit } from "@/lib/mobile/customers";` with:

```ts
import type { CustomerDetail } from "@/lib/mobile/customers";
```

and add below the other imports:

```ts
import {
  customerName,
  formatAddress,
  matchCustomer,
  rankCustomers,
  searchNote,
  searchTerms,
  termsMatched,
  type CustomerCandidate,
  type CustomerMatch,
} from "./search";
```

2. In `interface JobsDeps`, replace `searchCustomers(query: string): Promise<CustomerHit[]>;` with:

```ts
  findCustomerCandidates(terms: string[], phoneDigits: string | null): Promise<CustomerCandidate[]>;
```

3. Fix the spacing typo: `const READ_ONLY ={` → `const READ_ONLY = {`.

4. Add this helper below `scheduleJob`:

```ts
function customerResult(c: CustomerCandidate, m: CustomerMatch) {
  return {
    id: c.id,
    name: customerName(c),
    company: c.company?.trim() || null,
    phone: c.phone,
    address: c.addresses[0] ? formatAddress(c.addresses[0]) : null,
    addressCount: c.addresses.length,
    matchedAddresses: m.matchedAddresses,
    matched: m.matched,
  };
}
```

5. Replace the whole `server.registerTool("find_customer", …)` call with:

```ts
  server.registerTool(
    "find_customer",
    {
      title: "Find customer",
      description: `Find customers by name, company, any saved address, town, tag, note or phone number. Pass the user's words as they said them. Each customer lists which words matched, which saved addresses matched, and the id that get_customer_history needs. Returns up to ${CUSTOMER_MATCH_LIMIT}. ${SOURCE_NOTE}`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("The user's words, e.g. 'Smith', 'planet fitness on aviation rd' or '518 555 0142'."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      const words = searchTerms(query);
      // The phone number counts as one more search word when reporting.
      const terms = words.phoneDigits ? [...words.terms, words.phoneDigits] : words.terms;
      if (terms.length === 0) {
        return ok(deps, ["customers"], {
          query,
          terms,
          matchedTerms: [],
          unmatchedTerms: [],
          count: 0,
          truncated: false,
          customers: [],
          note: searchNote("customers", [], [], [], 0, null),
        });
      }
      try {
        const candidates = await deps.findCustomerCandidates(words.terms, words.phoneDigits);
        const ranked = rankCustomers(
          candidates
            .map((customer) => ({ customer, ...matchCustomer(customer, words.terms, words.phoneDigits) }))
            .filter((r) => r.matched.length > 0)
        );
        const shown = ranked.slice(0, CUSTOMER_MATCH_LIMIT);
        const truncated = ranked.length > CUSTOMER_MATCH_LIMIT;
        const { matchedTerms, unmatchedTerms } = termsMatched(terms, ranked.map((r) => r.matched));
        const note = searchNote(
          "customers",
          terms,
          matchedTerms,
          unmatchedTerms,
          shown.length,
          truncated ? CUSTOMER_MATCH_LIMIT : null
        );
        return await ok(deps, ["customers"], {
          query,
          terms,
          matchedTerms,
          unmatchedTerms,
          count: shown.length,
          truncated,
          customers: shown.map((r) => customerResult(r.customer, r)),
          ...(note && { note }),
        });
      } catch (err) {
        return fail("find_customer", "Couldn't search customers just now. Try again in a minute.", err);
      }
    }
  );
```

- [ ] **Step 4: Wire the live dependency**

In `src/lib/mcp/jobs/deps.ts`:

- Change `import { getCustomerDetail, searchCustomers } from "@/lib/mobile/customers";` to `import { getCustomerDetail } from "@/lib/mobile/customers";`
- Add `import { findCustomerCandidates } from "./searchQueries";`
- Change `import { CUSTOMER_MATCH_LIMIT, type JobsDeps } from "./server";` to `import type { JobsDeps } from "./server";`
- Replace `searchCustomers: (query) => searchCustomers(query, CUSTOMER_MATCH_LIMIT),` with `findCustomerCandidates,`

- [ ] **Step 5: Run the tests and checks**

Run: `npx vitest run src/lib/mcp src/app/api/mcp` → all PASS.
Run: `npx tsc --noEmit` → exactly the 8 pre-existing errors.
Run: `npx vitest run` → full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/jobs/server.ts src/lib/mcp/jobs/deps.ts src/lib/mcp/jobs/__tests__/fixtures.ts src/lib/mcp/jobs/__tests__/server.test.ts src/app/api/mcp/jobs/__tests__/route.test.ts
git commit -m "feat(mcp): find_customer searches every address and reports matched words"
```

---

### Task 4: `search_jobs` tool and server instructions

**Files:**
- Modify: `src/lib/mcp/jobs/server.ts`
- Modify: `src/lib/mcp/jobs/deps.ts`
- Modify: `src/lib/mcp/jobs/__tests__/fixtures.ts`
- Modify: `src/lib/mcp/jobs/__tests__/server.test.ts`
- Modify: `src/app/api/mcp/jobs/__tests__/route.test.ts`

**Interfaces:**
- Consumes (Task 1): `matchJob`, `rankJobs`, `termsMatched`, `searchNote`, `searchTerms`, `formatAddress`, `JOB_MATCH_LIMIT`, types `JobCandidate`, `JobMatchOn`, `Match`. (Task 2): `findJobCandidates(terms)`. (Task 3): the `./search` import block and `customerResult` already in `server.ts`. Existing: `scheduleStatus` from `@/lib/dashboard/queries`, `dateOf`, `timeLabel`, `formatMoney`, `ok`, `fail`.
- Produces: `JobsDeps.findJobCandidates(terms: string[]): Promise<JobCandidate[]>`; exported `SERVER_INSTRUCTIONS: string`; tool `search_jobs`; fixtures `jobCandidate(over)`, `gymJobs()`.

- [ ] **Step 1: Update the fixtures**

In `src/lib/mcp/jobs/__tests__/fixtures.ts`, change the search import to `import type { CustomerCandidate, JobCandidate } from "../search";` and add:

```ts
export function jobCandidate(over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    id: "job_x",
    customerId: "cus_gym",
    scheduledStart: null,
    workStatus: "complete rated",
    onMyWayAt: null,
    amountCents: 25000,
    street: "99 Aviation Road",
    city: "Queensbury",
    description: "Commercial Service Call Fee",
    jobType: null,
    customer: { id: "cus_gym", name: "Kay Example", company: "Gymco", tags: [] },
    ...over,
  };
}

const GYM_JOB_DATES = [
  "2026-11-23T18:00:00Z",
  "2026-11-11T19:00:00Z",
  "2026-10-02T16:00:00Z",
  "2026-04-06T15:00:00Z",
  "2026-04-03T13:00:00Z",
  "2026-03-23T19:00:00Z",
  "2026-03-09T17:00:00Z",
  "2026-03-04T20:00:00Z",
  "2025-07-16T17:00:00Z",
  "2025-04-29T15:00:00Z",
];

// Ten jobs at the Aviation Road gym, newest first. Nothing in them says
// "planet" or "fitness", like the real records.
export function gymJobs(): JobCandidate[] {
  return GYM_JOB_DATES.map((d, i) =>
    jobCandidate({ id: `job_g${i + 1}`, scheduledStart: d, workStatus: i === 0 ? "scheduled" : "complete rated" })
  );
}
```

In `stubDeps`, add after `findCustomerCandidates: …`:

```ts
    findJobCandidates: async () => [],
```

- [ ] **Step 2: Write the failing tests**

In `src/lib/mcp/jobs/__tests__/server.test.ts`:

1. Add `gymJobs, jobCandidate` to the fixtures import, and change the server import to:

```ts
import { CUSTOMER_MATCH_LIMIT, SERVER_INSTRUCTIONS, type JobsDeps } from "../server";
```

(Drop `CUSTOMER_MATCH_LIMIT` from it if nothing in the file uses it.)

2. In the existing test `"registers exactly the five tools"`, rename it to `"registers exactly the six tools"` and change the expected list to:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_customer",
      "get_customer_history",
      "get_job",
      "get_money_summary",
      "get_schedule",
      "search_jobs",
    ]);
```

3. Append to the end of the file:

```ts
describe("search_jobs", () => {
  it("finds the gym's jobs by street and asks to confirm the business name", async () => {
    const calls: string[][] = [];
    const { deps, freshnessCalls } = stubDeps({
      findJobCandidates: async (terms) => {
        calls.push(terms);
        return gymJobs();
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(
      text(
        await client.callTool({
          name: "search_jobs",
          arguments: { query: "find the jobs we did at planet fitness on aviation rd" },
        })
      )
    );

    expect(calls).toEqual([["planet", "fitness", "aviation"]]);
    expect(body).toMatchObject({
      terms: ["planet", "fitness", "aviation"],
      matchedTerms: ["aviation"],
      unmatchedTerms: ["planet", "fitness"],
      count: 10,
      truncated: false,
      dataAsOf: SYNCED_AT,
    });
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(gymJobs().map((j) => j.id));
    expect(body.jobs[0]).toEqual({
      id: "job_g1",
      date: "2026-11-23",
      time: "1:00 PM",
      status: "Scheduled",
      service: "Commercial Service Call Fee",
      address: "99 Aviation Road, Queensbury",
      customer: "Kay Example",
      company: "Gymco",
      customerId: "cus_gym",
      amount: "$250.00",
      amountCents: 25000,
      matched: [{ term: "aviation", on: "job address" }],
    });
    expect(body.jobs[1].status).toBe("Completed");
    expect(body.note).toBe(
      'Nothing in Trinity\'s records mentions "planet", "fitness". These jobs matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.'
    );
    expect(freshnessCalls).toEqual([["jobs", "customers"]]);
  });

  it("puts jobs matching more of the words first", async () => {
    const { deps } = stubDeps({
      findJobCandidates: async () => [
        ...gymJobs(),
        jobCandidate({ id: "job_p", scheduledStart: "2024-01-01T15:00:00Z", description: "Planet Fitness locker room" }),
      ],
    });
    const client = await connect(deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "search_jobs", arguments: { query: "planet fitness aviation" } }))
    );
    expect(body.jobs[0].id).toBe("job_p");
    expect(body.unmatchedTerms).toEqual([]);
    expect(body.note).toBeUndefined();
  });

  it("asks for another detail when nothing matches", async () => {
    const { deps } = stubDeps({ findJobCandidates: async () => [jobCandidate({ id: "job_z" })] });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "zebra" } })));
    expect(body).toMatchObject({ count: 0, jobs: [], unmatchedTerms: ["zebra"] });
    expect(body.note).toBe(
      'Nothing in Trinity\'s records matched "zebra". Ask the user for another detail: the street or town, the customer\'s name, or roughly when the work was done.'
    );
  });

  it("caps at 50 jobs and says so", async () => {
    const { deps } = stubDeps({
      findJobCandidates: async () => Array.from({ length: 60 }, (_, i) => jobCandidate({ id: `job_${i}` })),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "aviation" } })));
    expect(body.count).toBe(50);
    expect(body.truncated).toBe(true);
    expect(body.note).toBe("Showing the first 50; ask the user for a date or a town to narrow it down.");
  });

  it("asks for something to search when the question is only filler, without querying", async () => {
    let queried = false;
    const { deps } = stubDeps({
      findJobCandidates: async () => {
        queried = true;
        return [];
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "show me the jobs" } })));
    expect(queried).toBe(false);
    expect(body).toMatchObject({ count: 0, jobs: [], note: "Give a name, business, street, town or phone number to search for." });
  });

  it("hides the raw error when the search fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = stubDeps({
      findJobCandidates: async () => {
        throw new Error("job search failed: Kay Example, 99 Aviation Road");
      },
    });
    const client = await connect(deps);
    const res = await client.callTool({ name: "search_jobs", arguments: { query: "aviation" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Couldn't search jobs just now. Try again in a minute.");
  });
});

describe("server instructions", () => {
  it("tells ChatGPT to confirm partial matches with the user", async () => {
    const client = await connect(stubDeps().deps);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain("unmatchedTerms");
    expect(SERVER_INSTRUCTIONS).toContain("search_jobs");
  });
});
```

4. In `src/app/api/mcp/jobs/__tests__/route.test.ts`, in `"initializes as trinity-jobs and lists the five tools"`: rename it to `"initializes as trinity-jobs with instructions and lists the six tools"`, replace the line `expect((await init.json()).result.serverInfo.name).toBe("trinity-jobs");` with

```ts
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe("trinity-jobs");
    expect(initBody.result.instructions).toContain("search_jobs");
```

and the expected names with

```ts
    expect(names).toEqual([
      "find_customer",
      "get_customer_history",
      "get_job",
      "get_money_summary",
      "get_schedule",
      "search_jobs",
    ]);
```

Run: `npx vitest run src/lib/mcp/jobs src/app/api/mcp/jobs`
Expected: FAIL (`search_jobs` not registered; `SERVER_INSTRUCTIONS` not exported; `findJobCandidates` not in `JobsDeps`).

- [ ] **Step 3: Implement in `server.ts`**

1. Add a value import (keep the existing `import type { DashboardSnapshot, TodayScheduleRow } …` line):

```ts
import { scheduleStatus } from "@/lib/dashboard/queries";
```

2. Replace the `./search` import block from Task 3 with:

```ts
import {
  JOB_MATCH_LIMIT,
  customerName,
  formatAddress,
  matchCustomer,
  matchJob,
  rankCustomers,
  rankJobs,
  searchNote,
  searchTerms,
  termsMatched,
  type CustomerCandidate,
  type CustomerMatch,
  type JobCandidate,
  type JobMatchOn,
  type Match,
} from "./search";
```

3. In `interface JobsDeps`, add after `findCustomerCandidates(…)`:

```ts
  findJobCandidates(terms: string[]): Promise<JobCandidate[]>;
```

4. Below `SOURCE_NOTE`, add:

```ts
// Sent to ChatGPT when it connects. MCP can't make ChatGPT ask the user
// anything; this, the tool descriptions and each result's note are how the
// connector gets it to check partial matches before answering.
export const SERVER_INSTRUCTIONS =
  "Trinity Jobs searches Trinity Plumbing's copy of HouseCall Pro. People ask in plain language by business name or street (\"the jobs at Planet Fitness on Aviation Rd\"), and customers are often filed under an owner or company name instead. Use search_jobs for questions about work at a place, and find_customer for questions about a customer. When a result has unmatchedTerms, tell the user which words didn't match, show what did match, and ask them to confirm before answering. When nothing matches, ask for a street, town, customer name or rough date. Never invent jobs or customers that aren't in a result.";
```

5. Below `customerResult`, add:

```ts
function jobResult(j: JobCandidate, matched: Match<JobMatchOn>[]) {
  return {
    id: j.id,
    date: dateOf(j.scheduledStart),
    time: j.scheduledStart ? timeLabel(j.scheduledStart) : null,
    status: scheduleStatus({ work_status: j.workStatus, raw: { work_timestamps: { on_my_way_at: j.onMyWayAt } } }),
    service: j.jobType?.trim() || j.description?.split("\n")[0]?.trim() || null,
    address: formatAddress({ street: j.street, city: j.city }),
    customer: j.customer?.name ?? null,
    company: j.customer?.company ?? null,
    customerId: j.customerId,
    amount: formatMoney(j.amountCents),
    amountCents: j.amountCents,
    matched,
  };
}
```

6. Change the server construction to:

```ts
  const server = new McpServer({ name: "trinity-jobs", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
```

7. Add this tool immediately before `return server;`:

```ts
  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs",
      description: `Find jobs by place, business or kind of work: the job's street, town, description or job type, or the customer's name, company or tag. Pass the user's words as they said them. Each job lists which words matched it. Returns up to ${JOB_MATCH_LIMIT}, the jobs matching the most words first, then newest first. ${SOURCE_NOTE}`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("The user's words, e.g. 'planet fitness on aviation rd' or 'water heater in Troy'."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      // Jobs have no phone field, so a phone number in the question is ignored here.
      const { terms } = searchTerms(query);
      if (terms.length === 0) {
        return ok(deps, ["jobs", "customers"], {
          query,
          terms,
          matchedTerms: [],
          unmatchedTerms: [],
          count: 0,
          truncated: false,
          jobs: [],
          note: searchNote("jobs", [], [], [], 0, null),
        });
      }
      try {
        const candidates = await deps.findJobCandidates(terms);
        const ranked = rankJobs(
          candidates.map((job) => ({ job, matched: matchJob(job, terms) })).filter((r) => r.matched.length > 0)
        );
        const shown = ranked.slice(0, JOB_MATCH_LIMIT);
        const truncated = ranked.length > JOB_MATCH_LIMIT;
        const { matchedTerms, unmatchedTerms } = termsMatched(terms, ranked.map((r) => r.matched));
        const note = searchNote("jobs", terms, matchedTerms, unmatchedTerms, shown.length, truncated ? JOB_MATCH_LIMIT : null);
        return await ok(deps, ["jobs", "customers"], {
          query,
          terms,
          matchedTerms,
          unmatchedTerms,
          count: shown.length,
          truncated,
          jobs: shown.map((r) => jobResult(r.job, r.matched)),
          ...(note && { note }),
        });
      } catch (err) {
        return fail("search_jobs", "Couldn't search jobs just now. Try again in a minute.", err);
      }
    }
  );
```

- [ ] **Step 4: Wire the live dependency**

In `src/lib/mcp/jobs/deps.ts`, change the search import to `import { findCustomerCandidates, findJobCandidates } from "./searchQueries";` and add `findJobCandidates,` next to `findCustomerCandidates,` in `liveJobsDeps()`.

- [ ] **Step 5: Run the tests and checks**

Run: `npx vitest run src/lib/mcp src/app/api/mcp` → all PASS.
Run: `npx tsc --noEmit` → exactly the 8 pre-existing errors.
Run: `npx vitest run` → full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/jobs/server.ts src/lib/mcp/jobs/deps.ts src/lib/mcp/jobs/__tests__/fixtures.ts src/lib/mcp/jobs/__tests__/server.test.ts src/app/api/mcp/jobs/__tests__/route.test.ts
git commit -m "feat(mcp): search_jobs tool and instructions to confirm partial matches"
```

---

### Task 5: README note and full verification

**Files:**
- Modify: `README.md` (the "ChatGPT jobs & customers connector (`/api/mcp/jobs`)" section)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Document the search and the Refresh step**

In `README.md`, directly after the line ``To turn it off, unset `MCP_JOBS_ENABLED` and redeploy.`` in the jobs connector section, insert:

```markdown

**Searching.** `search_jobs` and `find_customer` take the user's words as
typed ("the jobs at planet fitness on aviation rd"). They drop filler words
and street suffixes, search each remaining word separately (job street, town,
description and type; customer name, company, every saved address, tags and
notes), and report which words matched and which didn't. When only some words
match, the result tells ChatGPT to show what it found and ask the user to
confirm. Customers billed under an owner or company name are easier to find if
they carry a tag in HouseCall Pro (e.g. "Planet Fitness").

**After changing the connector's tools,** click **Refresh** on the plugin in
ChatGPT (workspace admin). ChatGPT doesn't pick up new or changed tools on its
own.

Spec for the search: `docs/superpowers/specs/2026-11-18-chatgpt-jobs-search-design.md`.
```

- [ ] **Step 2: Full verification**

- `npx vitest run` → all PASS.
- `npx tsc --noEmit` → exactly the 8 pre-existing errors in `src/app/api/app/**` route tests; none elsewhere.
- `npm run lint` → no errors.
- `npm run build` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Trinity Jobs search and the ChatGPT Refresh step"
```
