# Trinity Ops Mobile — Navigation & Drill-Down Design

**Date:** 2026-08-07
**Status:** approved, not yet implemented
**Scope:** the installable app at `/app/*`, plus one security fix to `/dashboard`

## Problem

The app is five tabs and two detail screens, and the routes between them are
incomplete in ways that dead-end the person holding the phone:

1. **A job cannot reach its customer.** `getJobDetail()` already returns
   `customerId` (`src/lib/mobile/jobDetail.ts`) and no screen reads it. Customer
   → job works; job → customer does not, so from a job there is no path to that
   customer's number or history.
2. **Back always goes to Today.** The job screen hardcodes `/app/today`, so
   arriving from Schedule, Customers or Dispatch and pressing back lands
   somewhere the reader was not.
3. **Nothing on Today is tappable except the run sheet.** The dial's marks show
   a readout but cannot open the job behind them; the three figures are dead
   text.
4. **The two detail screens never got the redesign.** They still carry emoji
   buttons and hand-set headers, so they read as a different application from
   the five tabs.
5. **Money rows link nowhere.** An unpaid invoice is the row most likely to need
   acting on, and it cannot reach the phone number that would let you act.

## Security fix, shipped separately first

`src/middleware.ts` matches `/app/:path*`, `/api/app/:path*`, `/dispatch` and
`/api/dispatch/:path*`. **`/dashboard` is not matched**, and it renders full
customer names and street addresses to anyone with the URL — the same class of
data the middleware's own comment says the login screen exists to protect. This
predates the redesign; the redesign did not widen it.

Pass 1 adds `/dashboard` and `/admin` to the matcher and ships on its own, so
the fix is reviewable without feature changes riding along.

`/admin` is included because its page is currently public; only
`/api/admin/trigger` checks `ADMIN_TRIGGER_TOKEN`. Gating the page is defence in
depth and does not remove that token check.

**Deploy-order hazard, same one `/dispatch` hit:** the Supabase accounts must
exist before this deploys, or the owner loses a working dashboard. Recorded in
`docs/MOBILE-INSTALL.md`.

## Design

### Where "back" goes

Back becomes history-based (`router.back()`) with a declared fallback for the
case where there is no history — a cold load straight into a job URL, which
happens every time a notification or a shared link is opened.

Fallback targets: job → `/app/today`, customer → `/app/customers`. These are the
current hardcoded destinations, so behaviour on a cold load is unchanged; what
changes is that an in-app navigation now returns to where it came from.

### Tapping a dial mark

Two steps, not one. There is no hover on a phone, so a single tap cannot both
reveal which job a mark is and act on it without guessing which the reader
meant.

- First tap selects the mark and fills the readout under the dial (existing
  behaviour).
- The readout itself becomes the link into that job.

This keeps the readout — the thing that makes the dial legible — and adds the
route without making the marks a minefield of accidental navigations.

### Tapping a figure

The three figures on Today become links where a destination genuinely exists:

| Figure | Destination | Why |
|---|---|---|
| Running | none | The run sheet below already shows which jobs are running, with their status pills. A filtered view of one or two rows is not worth a route. |
| Emergency | none | Same — the tagged jobs are in the run sheet. |
| Unpaid | `/app/money` (invoices) | The list is on another tab and is the one you act on. |

Only one of the three earns a link. Making all three tappable for symmetry would
promise two destinations that do not exist.

### Detail screens onto the design system

Both screens adopt `ScreenHeader`, `Panel`, `SectionHeader` and `Figure`, and
the emoji action buttons become the same drawn icons the tab bar uses. Call and
Directions stay plain `tel:` / `maps:` anchors — no API call, and they work
offline, which is the whole reason they are anchors today.

A shared `DetailHeader` carries the back control, so the two screens cannot
drift apart again. It is *not* a wrapper around `ScreenHeader`: a tab title is a
UI label and wears the condensed display face in caps, while a detail title is a
person's name out of the database. Uppercasing content mangles it — "McDonald"
is not "MCDONALD" — so names stay in the body face and the display face stays on
labels.

### Money rows

Each estimate and invoice row links to `/app/customers/<id>`, which already
carries the phone number, the address and the full job history.

**This needs an API change.** `listOpenEstimates()` / `listUnpaidInvoices()`
return `customerName` but no id. Both must also return `customerId`, nullable —
a row whose customer never synced renders unlinked rather than as a dead link.

## Out of scope

- A crew view on mobile. Workload is a dispatcher's question, not a driver's.
- Linking dispatch results to jobs. The screen answers "which day", and a list
  of job links would change what it is for.
- Desktop navigation. The app is used on a phone.

## Testing

- `getJobDetail` already has coverage; add a case asserting `customerId` reaches
  the payload, since a screen now depends on it.
- Money route tests extend to assert `customerId` is present and nullable.
- Component tests for the back control's fallback when history is empty, and for
  a Money row rendering unlinked when `customerId` is null.
- Existing `JobRow`, `StatusPill` and `TabBar` tests must stay green untouched.

## Task list

1. **Pass 1 — gate `/dashboard` and `/admin`.** Middleware matcher plus a note
   in `docs/MOBILE-INSTALL.md`. Ships alone.
2. `BackLink` component: `router.back()` with a declared fallback. Tests.
3. `DetailHeader` built on `ScreenHeader` + `BackLink`.
4. Migrate the job screen onto the system; add the customer link.
5. Migrate the customer screen onto the system.
6. Dial readout becomes a link into the selected job.
7. Unpaid figure links to `/app/money`.
8. `customerId` through the money lib, the route and the rows. Tests.
9. Verify: `npm test`, `npm run build`, screenshots at 390px.
