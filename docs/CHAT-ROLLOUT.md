# Website chat rollout

The chat bubble on trinity.plumbing answers questions about services, the
service area, hours and the published prices, and hands anyone ready for help
to a phone call or the contact form. The site shows the bubble; this app
answers it at `POST /api/chat`. Spec:
`docs/superpowers/specs/2026-11-26-site-chatbot-design.md`.

Nothing answers until `CHAT_ENABLED=true`. Do steps 3 to 5 in one sitting:
once the site deploys with its two variables the bubble appears, and until
step 5 anyone who types gets "The chat is off right now…" with the Call and
Send a request buttons (and the bubble then hides for the rest of their visit).

## Go-live (Ryan)

1. **Migration, then merge.** Run `supabase/migrations/0010_site_chat.sql` in
   the ops Supabase SQL editor, then merge the ops branch. Running it first
   avoids `[cron] chat retention pass failed` every 15 minutes after the
   deploy. Check RLS is on:

   ```sql
   select relname, relrowsecurity from pg_class
   where relname in ('chat_conversations', 'chat_messages', 'chat_rate_limits');
   ```

   All three show `true`. Check the app's role can run the two chat functions:

   ```sql
   select has_function_privilege('service_role', 'chat_rate_limit_hit(text, timestamptz)', 'execute') as rate_limit,
          has_function_privilege('service_role', 'chat_save_turn(uuid, text, text, text, boolean)', 'execute') as save_turn;
   ```

   Both show `true`.
2. **Ops settings.** Vercel (ops) → Production:
   - `CHAT_SITES` = `trinity=https://trinity.plumbing|https://www.trinity.plumbing`
   - `CHAT_IP_SALT` = a new random value, marked Sensitive:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - confirm `OPENAI_API_KEY` is set (the Fieldy checklist already uses it)
   - leave `CHAT_ENABLED` unset

   Redeploy. Check (Git Bash):

   ```bash
   curl -i -X POST https://ops.trinity.plumbing/api/chat \
     -H "Origin: https://trinity.plumbing" -H "Content-Type: application/json" -d '{}'
   ```

   Expect `503`, `{"off":true}` and `access-control-allow-origin: https://trinity.plumbing`.
3. **Site.** Merge the site branch (trinity-plumbing-service `feat/site-chat`).
   Vercel (site) → Production:
   - `NEXT_PUBLIC_CHAT_ENDPOINT=https://ops.trinity.plumbing/api/chat`
   - `NEXT_PUBLIC_CHAT_SITE=trinity`

   Redeploy (both are baked in at build time). Open
   `https://trinity.plumbing/chat-knowledge.json`: it lists the prices from
   the pricing page.
4. **OpenAI usage cap, then read the answers.** In the OpenAI dashboard for
   Dave's org, set a monthly budget with an email alert (Settings → Limits at
   the time of writing; search the dashboard for "limits" if it moved). Then,
   with the real key in `.env.local`:

   ```bash
   npm run chat:eval
   ```

   Read every answer against its "expect" line. Stop and fix the rules in
   `src/lib/chat/prompt.ts` if any answer quotes an unlisted price, does
   arithmetic, offers a discount, promises a time, or has the wrong emergency
   flag. "(none …)" with `incomplete_max_output_tokens` above it: set
   `CHAT_MAX_OUTPUT_TOKENS=500` and run it again.
5. **Switch on.** Vercel (ops) → `CHAT_ENABLED=true` → redeploy. On the live
   site, on a phone and a desktop:
   - "How much is a drain cleaning service call?" → "from $75"
   - "I smell gas" → leave the house first; a yellow "Call now" button at the top
   - "Can you do it for $50?" → no discount, the listed price
   - Supabase → `chat_messages` has the turns, with any phone number shown as `[phone]`
6. **Read chats daily for a week**, then decide on the other sites.

## Reading chats

```sql
select c.started_at at time zone 'America/New_York' as started,
       m.role, m.emergency, m.text
from chat_messages m
join chat_conversations c on c.id = m.conversation_id
where c.site = 'trinity' and c.started_at > now() - interval '1 day'
order by c.started_at, m.id;
```

Phone numbers and emails are saved as `[phone]` and `[email]`. Conversations
are deleted 90 days after they start by the cron sync.

## Kill switch

`CHAT_ENABLED` to anything but `true`, then redeploy ops. The bubble shows
"The chat is off right now…" with the Call and Send a request buttons and
hides for the rest of that visit. To remove the bubble from the site entirely,
unset `NEXT_PUBLIC_CHAT_ENDPOINT` on the site and redeploy it.

## If something's off

| What you see | Cause |
|---|---|
| No bubble on the site | `NEXT_PUBLIC_CHAT_ENDPOINT` or `NEXT_PUBLIC_CHAT_SITE` unset, or set without a redeploy; or that browser tab already saw "off" this session |
| "The chat is off right now…" | `CHAT_ENABLED` isn't exactly `true` |
| "Sorry, I can't answer right now. Call us at (518) 348-3032…" on every message, CORS error in the browser console | The page's origin isn't in `CHAT_SITES` exactly (bare vs `www`, `http`, a trailing slash); or `CHAT_SITES`/`CHAT_IP_SALT` is missing or invalid, so the preflight gets 403 (logs: `[chat] off: <setting>`) |
| "Sorry, I can't answer right now. Call us at (518) 348-3032…" from the server | OpenAI failed: logs show `[chat] answer skipped: <code>` |
| "Sorry, I can't answer right now. Call us or send a request…" (no number) | The knowledge file never loaded (`[chat] knowledge for trinity not loaded: <code>`), or the counters failed (`[chat] rate limit check failed:`, usually migration 0010 not run) |
| `[chat] answer skipped: incomplete_max_output_tokens` | Replies hit the output cap; set `CHAT_MAX_OUTPUT_TOKENS=500` |
| "You've sent a lot of messages in a short time…" | Per-visitor cap (`CHAT_IP_LIMIT`, default 20 per 10 minutes) |
| "The chat is busy right now…" | The site's daily cap (`CHAT_SITE_DAILY_LIMIT`, default 500 per UTC day) |
| `[cron] chat retention pass failed` every 15 minutes | Migration 0010 not run |
| A new price isn't quoted | The site wasn't redeployed, or this app's copy is up to an hour old |

The per-visitor limit keys on the `x-real-ip` header, which Vercel sets. If a
proxy such as Cloudflare is ever put in front of ops.trinity.plumbing, every
visitor would share one limit, so check this before adding one.

## Rollback

Set `CHAT_ENABLED` to anything but `true` and redeploy. Nothing outside the
three chat tables is written. To delete everything saved:
`delete from chat_conversations where site = 'trinity';` (messages go with it).
