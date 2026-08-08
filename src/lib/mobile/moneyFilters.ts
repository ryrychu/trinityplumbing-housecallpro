import type { EstimateHit, InvoiceHit } from "./money";

// Filtering happens in the browser, not the route. The Money payload already
// carries every open estimate and every unpaid invoice — tens of rows, not
// thousands — so narrowing them is instant, costs no round trip, and keeps
// working from the service worker's cache with no signal. A `?q=` parameter
// would give up all three of those for nothing.

/** Case- and punctuation-insensitive, so "oconnor" finds "O'Connor". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function matchesQuery(name: string | null, query: string): boolean {
  const term = normalize(query);
  if (!term) return true;
  // A row whose customer never synced has no name to match. It is excluded
  // from a search rather than always shown: someone typing a name is asking to
  // see that name, and an unnamed row is not an answer to it.
  return normalize(name ?? "").includes(term);
}

export interface EstimateFilters {
  query: string;
  /** A scheduleStatus() label, or "all". */
  status: string;
}

export function filterEstimates(rows: EstimateHit[], f: EstimateFilters): EstimateHit[] {
  return rows.filter(
    (r) => matchesQuery(r.customerName, f.query) && (f.status === "all" || r.status === f.status)
  );
}

export interface InvoiceFilters {
  query: string;
  overdueOnly: boolean;
}

export function filterInvoices(rows: InvoiceHit[], f: InvoiceFilters): InvoiceHit[] {
  return rows.filter(
    (r) => matchesQuery(r.customerName, f.query) && (!f.overdueOnly || r.overdueDays != null)
  );
}

export function sumCents(rows: Array<{ amountCents: number | null }>): number {
  return rows.reduce((total, r) => total + (r.amountCents ?? 0), 0);
}

/**
 * The status labels actually present, in the order scheduleStatus() emits them
 * rather than alphabetically — an estimate's life runs needs-scheduling →
 * scheduled → in progress → complete, and a dropdown that reads S, C, I, N
 * makes the reader re-sort it in their head.
 *
 * Derived from the rows rather than hardcoded, so the control never offers a
 * filter that would return nothing.
 */
const STATUS_ORDER = ["Needs Scheduling", "Scheduled", "En Route", "In Progress", "Completed"];

export function statusOptions(rows: EstimateHit[]): string[] {
  const present = new Set(rows.map((r) => r.status).filter((s): s is string => s !== null));
  const known = STATUS_ORDER.filter((s) => present.has(s));
  // Anything scheduleStatus() emits that this list has not been taught about
  // still gets an option, appended rather than dropped.
  // Array.from rather than a spread: the project targets ES5, where spreading
  // a Set needs downlevelIteration.
  const unknown = Array.from(present)
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  return [...known, ...unknown];
}

export function countOverdue(rows: InvoiceHit[]): number {
  return rows.filter((r) => r.overdueDays != null).length;
}
