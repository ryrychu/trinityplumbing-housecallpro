# Mobile App Install Runbook

The mobile app is done and merged. It does not work yet — three things below
require a human to act by hand, in the order given, before anyone puts this
on a phone. Read the whole document before starting.

---

## ⚠️ Create the accounts BEFORE this branch is deployed

Read this before you merge, not after.

This branch puts the **existing desktop `/dispatch` page behind a login.** That
page works today with no sign-in at all. The moment this deploys, it stops
working for everyone — including the owner — until a Supabase account exists to
sign in with. **Those accounts do not exist yet.**

So the order is not "deploy, then set up accounts." It is:

1. Create the accounts (Step 1 below).
2. Verify you can sign in.
3. *Then* deploy.

Get this backwards and the owner loses access to a page that worked that
morning, with no way to fix it from a phone. If a deploy has already happened,
the fix is the same — create the accounts — it is just being done under
pressure instead of ahead of time.

Why the page is gated at all: it calls `/api/dispatch/nearby`, which returns
full customer names, street addresses, phone numbers, technicians, services and
coordinates for up to 100 miles and 60 days — exactly the data the new login
screen exists to protect — and it answered anyone who asked. The page and that
API are gated together deliberately: gating only the API would leave the page
loading and then silently failing, and gating only the page would leave the
data open to anyone calling the route directly.

---

## Step 1 — Create the accounts (this blocks everything else)

There is no public sign-up page. That is not the same as it being
impossible to create an account: the anon key is public by design (it ships
in the browser bundle), and until you flip the switch below, anyone who
finds the URL can call Supabase's sign-up endpoint directly and register
themselves. From there they'd be signed in like any other user, looking at
1,497 customers' names, addresses and phone numbers. Do these two steps
together, not one and then "later":

1. **Supabase Dashboard → Authentication → Users → Add user.** Create one
   account per person who needs the app, with **Auto Confirm** turned on
   (otherwise the account sits unconfirmed and can't sign in until someone
   clicks an email link that may never arrive, since this flow doesn't send
   one).
2. **Supabase Dashboard → Authentication → Providers → Email → disable
   "Enable sign ups."** This is the actual gate. Do it in the same sitting
   you create the first account — don't leave sign-ups open "just for now."

Nothing about the app's code enforces this. It is entirely a dashboard
setting, and it is the one prerequisite that turns "deployed" into "safe to
deploy."

---

## Step 2 — Install on an iPhone

**Must be done in Safari.** Chrome on iOS cannot install a home-screen app —
it's a platform restriction, not a bug in this build — so "Add to Home
Screen" either doesn't appear or doesn't produce a real app in Chrome.

1. Open `https://<your-domain>/app/today` in **Safari**.
2. Tap the Share icon, then **Add to Home Screen**.
3. Open the app from the home screen icon, not from Safari. It launches
   standalone — no address bar, no Safari chrome.
4. **Sign in again inside the installed app.** The home-screen app has its
   own storage, separate from Safari's. Being signed into Safari does not
   carry over. This is expected and only needs to happen once per device.

**There are no push notifications yet.** That's Phase 2. Nothing in this
build will alert anyone to anything — the app has to be opened to show
current data.

---

## Verification checklist

Do these in order on the device you just installed to (or in a desktop
browser first if you want a dry run before touching the phone — the offline
sequence in particular is easier to drive from a laptop with DevTools).

| # | Step | Expected result |
|---|------|------------------|
| 1 | While signed out, load `/app/today` | Redirects to `/app/login`. |
| 2 | Sign in | Lands on Today, showing the correct date in **Eastern time** (not the device's local time zone if it differs, not UTC). |
| 3 | Tap each of the five tabs — Today, Schedule, Customers, Money, Dispatch | All five load. **Three of the five tabs show a freshness stamp** (e.g. "Synced 12 min ago"): Today, Schedule and Money. The job and customer **detail** screens show one too, once you open a record. **Customers and Dispatch do not, and are not supposed to:** both are search forms that fetch when you type or submit rather than on load, so neither has a single "as of" moment to report. Don't go hunting for a stamp on those two — it cannot appear, and it isn't a bug. |
| 3a | Look at what the stamp says | It dates the **mirror**, not the request — "Synced 12 min ago" means the sync last ran 12 minutes ago, not that this page loaded 12 minutes ago. If any screen says **"⚠ Sync is behind"**, the cron has likely stopped; check `/api/cron/sync` before trusting anything else in the app. One deliberate gap to know about: **Today's stamp covers the day's jobs, not its "Unpaid" counter** — that figure comes from invoices, which are reconciled at most once every ~20 hours by design, so it can be older than the stamp suggests. Money's stamp is the honest one for invoice figures. |
| 4 | Open a job from Today | Shows status, address, booked amount, and invoice. |
| 5 | On a job's detail screen, tap the phone number, then the address | Phone: prompts to call. Address: opens Maps. |
| 6 | Search Customers by a known customer's name | Finds them. |
| 7 | Search Customers by `(518) 555-0142` (with the punctuation, as a person would type it) | Finds the matching customer, punctuation and all. |
| 8 | Run the **offline sequence** below | Previously-visited tabs render with "Offline — showing data from …"; a tab never opened while online shows "Not saved for offline use yet" instead of another tab's content. |

### The offline sequence — do this exactly in this order

This is the one check in the whole list that has actually caught a real bug,
and the bug only shows up if you do the steps in this order.

1. **Clear all site data for the domain first** (Safari: Settings → Safari →
   Advanced → Website Data → find the domain → delete. Chrome DevTools:
   Application → Storage → Clear site data). This forces a true first
   install — you're about to test what a brand-new user sees.
2. **Load `/app/today` while signed out.** It will redirect to
   `/app/login` — that's expected. Nothing is cached yet at this point (see
   below); you are putting the browser in the state a brand-new user is
   actually in before signing in.
3. Sign in.
4. Tap through all five tabs once, online, so each one has a chance to load
   real data.
5. Turn on Airplane Mode (or DevTools → Network → Offline).
6. Tap all five tabs again.

**What this is actually checking.** The bug being guarded against is the
service worker saving the **login page's HTML** under all five tab names, so
that every offline tap shows a login screen forever — unrecoverable on a
phone without clearing site data.

The mechanism matters, because debugging against the wrong one wastes hours.
It is **not** true that the app caches the five tabs at step 2 while signed
out. Two things prevent that, and this sequence tests both:

1. **The service worker is never registered on the login page.**
   `ServiceWorkerRegistrar.tsx` returns early on `/app/login`, so at step 2
   nothing is registered and nothing is cached. Registration happens after
   step 3, when signing in navigates to `/app/today` — a client-side
   `router.replace()`, not a page load, which is why the registrar watches
   the pathname rather than only checking once on mount. By then the browser
   has a session, so the five precache requests return real pages.
2. **The worker refuses a redirected response anyway.** `sw.js` checks
   `!response.redirected` before storing anything, in both `precache()` and
   the shell fetch handler. This is the backstop that still holds if a
   previously-signed-in browser triggers a background install, or if a
   session expires mid-use and middleware 307s a shell request to login.

So the order is not what creates the risk — it is what puts a **real, empty,
signed-out browser** through the whole install path, which is the only state
in which either defence can be observed failing. Signing in before clearing
site data tests neither.

If step 6 ever shows a login screen instead of Today/Schedule/Customers/
Money/Dispatch content on any tab, one of those two defences has broken —
stop and report it before letting anyone else install.

**Bumping `VERSION` in `public/sw.js` wipes every user's offline data.** The
`activate` handler deletes every cache whose name doesn't match the current
version, so a changed `VERSION` drops both the shell and the saved API
responses. Nothing is lost permanently — each screen refills the moment it is
opened online — but until then, every tab a user hasn't revisited shows "not
saved for offline use yet". Bump it when the worker's own logic changes;
don't bump it casually, and don't bump it right before someone goes into a
basement.

---

## Known Phase 1 limits

- **No push notifications.** Phase 2. The app only shows what's current when
  someone opens it.
- **No writes.** Nothing in the mobile app creates or changes data — no
  notes, no approve/decline, no new customers. Read-only, same as the
  desktop dashboard.
- **No desktop layout.** This is a phone app. Nobody has built or tested a
  tablet or desktop-width version of `/app/*`.
- **The desktop `/dispatch` page now requires a sign-in.** It did not before.
  This is the change the warning at the top of this document is about: the
  sign-in requirement now covers `/app/*`, `/api/app/*`, `/dispatch` and
  `/api/dispatch/*`. Anyone used to opening `/dispatch` on a laptop without
  signing in will be sent to `/app/login` — which is the mobile login screen,
  the only one this app has. It works fine in a desktop browser; it just
  looks like a phone screen.
- **There is still no rate limiting on `/api/dispatch/nearby`.** Each call
  does three full-table pulls including the `raw` jsonb. It now requires a
  session, so this is a signed-in user hammering it rather than the open
  internet, but it is not free to call in a loop.

---

## One more thing to check by hand, no rush

The app icons on the home screen right now are placeholders — a flat dark
tile with a gold square, generated by `scripts/generate-app-icons.mjs`.
They're valid, functioning icons and the app installs fine with them, but
they are not the Trinity logo. Swap in real artwork
(`public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`)
before this goes on a client-facing or permanent device. Not a blocker for
internal testing — just don't let it stay this way by accident.

## One more thing to confirm with Supabase directly, no rush

The customer phone search was built to handle two possible ways the phone
number might be stored — as bare digits, or with the punctuation Housecall
Pro sends (parentheses, dashes, spaces) — because nobody has been able to
check which one it actually is: the `.env.local` in this repo holds
placeholder credentials, not real ones, so there's no way to query the live
database from here. Item 7 in the verification checklist above (searching
`(518) 555-0142`) is the practical test of this, and it should pass either
way — but if it doesn't, the next step is opening the `customers` table in
Supabase directly and checking a few rows of the `phone` column, then
reporting back what format is actually stored there.
