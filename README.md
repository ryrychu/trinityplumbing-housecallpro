# Trinity Plumbing — Housecall Pro Integration (Phase 1)

A Next.js 14 app that syncs Housecall Pro data (customers, jobs, estimates,
invoices, technicians, tags, notes, attachments) into a dedicated Supabase
Postgres database via webhooks (real-time) and a Vercel Cron polling backfill,
and surfaces it through an Operations Dashboard and a Geographic Scheduling
Assistant. The dashboard reads only from Supabase — it never calls Housecall
Pro directly.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
npm test                     # Vitest
npm run build                # production build / typecheck / lint
```

## Environment variables (set in Vercel → Project → Settings → Environment Variables)

- `HOUSECALL_API_KEY` — Bearer token for the Housecall Pro public API.
- `HOUSECALL_WEBHOOK_SECRET` — shared secret used to verify webhook signatures.
- `NEXT_PUBLIC_SUPABASE_URL` — the new dedicated Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key.
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (server-only, never exposed to the client).
- `CRON_SECRET` — shared secret for authorizing the `/api/cron/sync` polling route.

## Database

The schema lives in `supabase/migrations/0001_init_schema.sql`. Apply it to a
new, dedicated Supabase project (not the existing `inquiries.trinity.plumbing`
instance):

```bash
npx supabase link --project-ref <your-new-project-ref>
npx supabase db push
```

## Housecall Pro webhook setup

In the Housecall Pro dashboard's webhook settings, point event subscriptions
(customer, job, estimate, invoice, employee create/update events) at:

`https://<your-vercel-domain>/api/webhooks/housecall`

Use the same secret you set for `HOUSECALL_WEBHOOK_SECRET`. The signature is an
HMAC-SHA256 of the raw request body sent in the `X-HousecallPro-Signature`
header — confirm this header name against your account's webhook settings and
update `src/app/api/webhooks/housecall/route.ts` if it differs.

## Deploy

```bash
vercel link
vercel env add HOUSECALL_API_KEY
vercel env add HOUSECALL_WEBHOOK_SECRET
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add CRON_SECRET
vercel --prod
```

The Vercel Cron job defined in `vercel.json` runs the backfill sync every 15
minutes automatically once deployed — no manual scheduling needed. Confirm
whether your Vercel plan authorizes cron requests via a `Bearer $CRON_SECRET`
`Authorization` header or the built-in `x-vercel-cron` header, and adjust the
auth check in `src/app/api/cron/sync/route.ts` accordingly before deploying.
