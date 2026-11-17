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
    // Seven (no area code), ten, or eleven with a leading 1. Dates and ZIP+4
    // codes are other digit counts, so they stay searchable words.
    if (digits.length === 7 || digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) {
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
// ask the user itself, but it can tell ChatGPT exactly what to say. `capped`
// means a database query hit its row limit, so the candidates may be a subset.
export function searchNote(
  kind: "jobs" | "customers",
  terms: string[],
  matchedTerms: string[],
  unmatchedTerms: string[],
  count: number,
  truncatedAt: number | null,
  capped: boolean
): string | undefined {
  const advice = kind === "jobs" ? "a date, house number or customer name" : "the customer's name or street";
  if (terms.length === 0) {
    return kind === "jobs"
      ? "Give a street, town, business or customer name, or kind of work to search for. To find jobs by phone number, use find_customer, then get_customer_history."
      : "Give a name, business, street, town or phone number to search for.";
  }
  if (count === 0) {
    return capped
      ? `Nothing among the records checked matched ${quoted(terms)}, but some words matched more records than one search covers. Ask the user for ${advice}.`
      : `Nothing in Trinity's records matched ${quoted(terms)}. Ask the user for another detail: the street or town, the customer's name, or roughly when the work was done.`;
  }
  const parts: string[] = [];
  if (unmatchedTerms.length > 0) {
    const opening = capped ? "None of the records checked mention" : "Nothing in Trinity's records mentions";
    parts.push(
      `${opening} ${quoted(unmatchedTerms)}. These ${kind} matched ${quoted(matchedTerms)}. Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.`
    );
  }
  if (truncatedAt !== null) {
    parts.push(`Showing the first ${truncatedAt}; ask the user for ${advice} to narrow it down.`);
  } else if (capped) {
    parts.push(
      `Some words matched more records than one search covers, so this list may be incomplete; ask the user for ${advice} to narrow it down.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
