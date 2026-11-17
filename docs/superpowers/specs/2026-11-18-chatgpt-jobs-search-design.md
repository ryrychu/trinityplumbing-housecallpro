# Trinity Jobs Connector: Word-by-Word Search: Design

**Date:** 2026-11-18
**Status:** Approved by Ryan on 2026-11-18.
**Builds on:** `2026-11-17-chatgpt-jobs-connector-design.md` (PR #4, live as "Trinity Jobs" at `https://ops.trinity.plumbing/api/mcp/jobs`).

## Why

Dave asked Trinity Jobs: "find the jobs we did at planet fitness on aviation rd". It found nothing, although there are 10 such jobs. Investigation on 2026-11-16 found three causes:

- The customer is **"Kati Cerra / Ignitefh"**, one record with **13 saved addresses**. 578 Aviation Road is address 10. The mirror copies only the first address into `address_line1`, so `find_customer("Aviation")` misses it.
- The jobs carry the address themselves (`jobs.raw.address.street` = "578 Aviation Road", city "Glens Falls North"). No tool searches job addresses.
- "Planet Fitness" appears nowhere in the customer, its addresses or the job descriptions.

Dave isn't technical. He asks by place or business name, not by customer record. The connector has to find what it can from his wording, say which words matched, and get ChatGPT to confirm with him.

## Goal

For "find the jobs we did at planet fitness on aviation rd", ChatGPT answers along the lines of: "I couldn't find 'Planet Fitness' by name, but Ignitefh has 10 jobs at 578 Aviation Road. Are these the ones you mean?" It then lists them.

## Decisions

| Decision | Choice |
|---|---|
| Read vs write | **Read-only**, unchanged |
| New tool | `search_jobs`: find jobs by place, business or job description |
| `find_customer` | Upgraded to search every saved address, tags and notes, with per-word match reporting. **Connector-only.** The mobile app's `searchCustomers` stays unchanged, because its result shows only the first address, so an "Aviation" hit would read as "475 Albany Shaker Road" there. |
| Matching | **Word by word.** The query is split into search words; each word is searched separately; every result reports which words it matched and where. Words nothing matched are reported back. |
| Asking the user | MCP can't make ChatGPT ask. The connector does it through (a) a `note` in each result when only some words matched, (b) tool descriptions, and (c) server `instructions` sent on connect. |
| Data source | Supabase mirror. No new tables, columns or migrations. |
| Kill switch | `MCP_JOBS_ENABLED`, unchanged |

## Search words: `searchTerms(query)`

A pure function in `src/lib/mcp/jobs/search.ts`.

1. Lowercase. Take the tokens matching `/[a-z0-9]+/g`. Punctuation is dropped, so "troy-schenectady" becomes `troy`, `schenectady`. This also keeps PostgREST `or()` filters safe: no commas, parentheses, asterisks, dots or quotes can reach them.
2. Drop **filler words**: `a, an, the, at, on, in, of, for, to, and, or, we, our, us, i, me, my, did, do, done, does, find, show, get, list, give, tell, what, which, where, when, any, all, job, jobs, work, worked, customer, customers, place, location, please, there, that, this, those, these, from, with, by`.
3. Drop **street suffixes**: `rd, road, st, street, ave, av, avenue, dr, drive, ln, lane, blvd, boulevard, ct, court, pl, way, hwy, highway, rte, route, pkwy, parkway, tpke, turnpike, ext, extension, cir, circle, ter, terrace`.
4. Drop tokens shorter than 2 characters. Numbers of 2 or more digits are kept, so a house number like "578" counts.
5. De-duplicate, keeping first-seen order. Keep at most **5** terms. Extra terms go in `dropped`.
6. **Phone:** if the query contains 7 or more digits in total, `phoneDigits` = all of its digits, and those digit tokens are removed from `terms`.

Returns `{ terms: string[]; phoneDigits: string | null; dropped: string[] }`.

Example: "find the jobs we did at planet fitness on aviation rd" → `terms: ["planet", "fitness", "aviation"]`, `phoneDigits: null`, `dropped: []`.

## `search_jobs`

**Input:** `query`, 1 to 200 characters.

**Candidates:** `findJobCandidates(terms)` in `src/lib/mcp/jobs/searchQueries.ts`, a Supabase read. For each term, in parallel:

- **Jobs by their own fields:** `jobs` rows where any of these contains the term (`ilike *term*`): `raw->address->>street`, `raw->address->>city`, `raw->>description`, `raw->job_fields->job_type->>name`. Limit 200 per term.
- **Jobs by customer:** `customers` where `first_name`, `last_name`, `company` or `raw->>tags` contains the term (limit 50 per term). Then those customers' jobs (`.in("customer_id", ids)`, limit 300). A customer's *address* deliberately doesn't pull in its jobs: Ignitefh has 13 locations, and "aviation" must not return all 13 locations' jobs.

The candidate rows are merged and de-duplicated by job id. Their customers are then loaded with `selectByIds` (`id, first_name, last_name, company, tags`).

Each candidate carries: `id`, `customerId`, `scheduledStart`, `workStatus`, `onMyWayAt` (for `scheduleStatus`), `amountCents`, `street`, `city`, `description`, `jobType`, `customer: { id, name, company, tags } | null`.

The database filter only pre-selects. **The matching in JavaScript decides what's returned.** `matchJob(candidate, terms)` checks each term, case-insensitively, against each field and labels the hits: `job address`, `job town`, `job description`, `job type`, `customer name`, `customer company`, `customer tag`. A candidate with no labelled hit is dropped. This also discards rows that matched only because a JSON key such as `"name"` contained the term.

**Ranking:** most distinct matched terms first, then newest `scheduledStart` first (nulls last). Cap **50**, and set `truncated` when more matched.

**Result JSON:**

```json
{
  "query": "...",
  "terms": ["planet", "fitness", "aviation"],
  "matchedTerms": ["aviation"],
  "unmatchedTerms": ["planet", "fitness"],
  "count": 10,
  "truncated": false,
  "jobs": [
    {
      "id": "job_...",
      "date": "2026-03-09",
      "time": "12:00 PM",
      "status": "Completed",
      "service": "Replace toilet flange and Flushometer",
      "address": "578 Aviation Road, Glens Falls North",
      "customer": "Kati Cerra",
      "company": "Ignitefh",
      "customerId": "cus_...",
      "amount": "$...",
      "amountCents": 0,
      "matched": [{ "term": "aviation", "on": "job address" }]
    }
  ],
  "note": "...",
  "dataAsOf": "..."
}
```

- `status` comes from `scheduleStatus({ work_status, raw: { work_timestamps: { on_my_way_at } } })`, the same labels as everywhere else. `date` and `time` come from `localDateKey` and `timeLabel`. `service` is the job type name, falling back to the first line of the description, as in `getJobDetail`. Names and companies are trimmed.
- `dataAsOf` is `mirrorSyncedAt(["jobs", "customers"])`.

## `find_customer` (upgraded)

**Input:** `query`, 1 to 200 characters (was 100).

**Candidates:** `findCustomerCandidates(terms, phoneDigits)` in `searchQueries.ts`. For each term, in parallel: `customers` where any of `first_name`, `last_name`, `company`, `city`, `notes`, `raw->>addresses`, `raw->>tags` contains the term (limit 50 per term). If `phoneDigits` is set, also run the phone filters `searchCustomers` uses today: the digit substring, plus the separator-tolerant pattern. Select `id, first_name, last_name, company, phone, city, notes, tags, addresses:raw->addresses`.

**Matching:** `matchCustomer(candidate, terms, phoneDigits)` labels hits as `name`, `company`, `city`, `address`, `tag`, `note` or `phone`. For `address`, it records each matching saved address as `"street, city"` in `matchedAddresses`. Candidates with no labelled hit are dropped.

For reporting, `phoneDigits` counts as one more search word, shown as the digits. It appears in `terms` and in `matchedTerms` or `unmatchedTerms` on the result, and in the note. `search_jobs` ignores `phoneDigits`: jobs have no phone field.

**Ranking:** most distinct matched terms first (a phone match counts as one), then name A–Z. Cap at `CUSTOMER_MATCH_LIMIT` (25), with `truncated`.

**Result JSON:** `query`, `terms`, `matchedTerms`, `unmatchedTerms`, `count`, `truncated`, `customers`, `note`, `dataAsOf` (`mirrorSyncedAt(["customers"])`). Each customer has:

- `id`, `name`, `company`, `phone`
- `address`: the first saved address
- `addressCount`
- `matchedAddresses`: e.g. `["578 Aviation Road, Glens Falls North"]`
- `matched: [{ term, on }]`

## Notes and instructions

`searchNote(kind, terms, matchedTerms, unmatchedTerms, count)` is pure and builds the `note`:

| Situation | Note |
|---|---|
| No usable search words (everything was filler) | `Give a name, business, street, town or phone number to search for.` (count 0) |
| Nothing matched | `Nothing in Trinity's records matched "a", "b". Ask the user for another detail: the street or town, the customer's name, or roughly when the work was done.` |
| Some words unmatched, results found | `Nothing in Trinity's records mentions "planet", "fitness". These {jobs|customers} matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.` |
| Every word matched | No `note` |

If `truncated` is set, append: ` Showing the first {N}; ask the user for a date or a town to narrow it down.`

**Server instructions**, passed as `new McpServer({ name, version }, { instructions })`:

> Trinity Jobs searches Trinity Plumbing's copy of HouseCall Pro. People ask in plain language by business name or street ("the jobs at Planet Fitness on Aviation Rd"), and customers are often filed under an owner or company name instead. Use search_jobs for questions about work at a place, and find_customer for questions about a customer. When a result has unmatchedTerms, tell the user which words didn't match, show what did match, and ask them to confirm before answering. When nothing matches, ask for a street, town, customer name or rough date. Never invent jobs or customers that aren't in a result.

Tool descriptions:

- `search_jobs`: "Find jobs by place, business or kind of work: the job's street, town, description or job type, or the customer's name, company or tag. Pass the user's words as they said them. Each job lists which words matched it."
- `find_customer`: "Find customers by name, company, any saved address, town, tag, note or phone number. Pass the user's words as they said them. Each customer lists which words matched and which saved addresses matched."

Both end with the existing `SOURCE_NOTE`.

## Units

| File | Change | Purpose |
|---|---|---|
| `src/lib/mcp/jobs/search.ts` | New | Pure functions: `searchTerms`, `matchJob`, `matchCustomer`, `rankJobs`, `rankCustomers`, `searchNote`, plus the `JobCandidate` and `CustomerCandidate` types. No I/O. |
| `src/lib/mcp/jobs/searchQueries.ts` | New | `findJobCandidates(terms)` and `findCustomerCandidates(terms, phoneDigits)`. Supabase reads only. They throw on query error, and the tool's `fail()` turns that into the fixed message. |
| `src/lib/mcp/jobs/server.ts` | Modify | `JobsDeps`: replace `searchCustomers(query)` with `findCustomerCandidates(terms, phoneDigits)`, and add `findJobCandidates(terms)`. Rewrite `find_customer` on the new functions. Add `search_jobs`. Add server `instructions`. The other four tools are unchanged. |
| `src/lib/mcp/jobs/deps.ts` | Modify | Wire the two new query functions. Drop the `searchCustomers` import. |
| Tests | New/modify | See below |

`src/lib/mobile/customers.ts` (`searchCustomers`) is **not changed**.

## Error handling

The same as the other tools. A failed query returns `isError: true` with a fixed message ("Couldn't search jobs just now. Try again in a minute." / "Couldn't search customers just now. Try again in a minute."). The raw error is logged server-side only. A query with no usable words isn't an error: it returns `count: 0` with the guidance note, and no query runs.

## Testing (vitest)

- **`search.test.ts`** (pure):
  - `searchTerms`: the Planet Fitness sentence becomes `planet, fitness, aviation`; suffix and filler removal; punctuation splitting; the 5-term cap with `dropped`; phone detection ("call 518-555-0142" gives `phoneDigits: "5185550142"`, and those digits are not terms); "578" kept; an all-filler query gives no terms.
  - `matchJob`: each label; case-insensitivity; a candidate matching only a JSON key is dropped.
  - `matchCustomer`: `matchedAddresses` lists exactly the matching saved addresses, so for an Ignitefh-like fixture with 13 addresses, "aviation" gives exactly `["578 Aviation Road, Glens Falls North"]`; phone labelling.
  - `rankJobs` and `rankCustomers` ordering.
  - `searchNote`: each row of the table, plus the truncation suffix.
- **`searchQueries.test.ts`** (mocked Supabase, as in `src/lib/mobile/__tests__/customers.test.ts`): the `or()` filter strings contain the expected JSON paths and terms; customer-matched jobs use `.in("customer_id", …)`; a query error throws; no query runs for empty terms.
- **`server.test.ts`:**
  - `search_jobs` returns the expected shape, `unmatchedTerms` and the note, using an Ignitefh fixture where "planet fitness on aviation rd" gives 10 jobs, all matched on `job address`, plus the note.
  - `find_customer` gives `matchedAddresses`, keeps phone search working, and sets `truncated`.
  - Both hide raw errors.
  - The server now exposes 6 tools, all read-only.
- **`route.test.ts`:** `tools/list` returns 6 tools, and `initialize` returns the `instructions` string.

## Rollout

Merge → Vercel deploys (the switch is already on). In ChatGPT, Dave or an admin clicks **Refresh** on the Trinity Jobs plugin so it picks up the new tool and instructions. Updated actions are not applied automatically. Then ask "find the jobs we did at planet fitness on aviation rd" and expect the 10 Aviation Road jobs plus a confirmation question.

Optional data fix, outside the code: tag the Ignitefh customer "Planet Fitness" in HouseCall Pro. After the next sync, "Planet Fitness" matches through `customer tag` with no follow-up question.

## Out of scope

- Changing the mobile app's customer search
- Fuzzy or misspelling matching ("aviaton"). This is substring matching per word only.
- Database indexes. About 3k jobs and 1.5k customers; `ilike` on jsonb paths is fine at this size.
- Any write to HCP
