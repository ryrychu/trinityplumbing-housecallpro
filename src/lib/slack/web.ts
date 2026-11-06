// The two Slack Web API calls the bot token is used for: reading
// #declined-calls (conversations.history) and posting the Monday summary there
// (chat.postMessage). Everything else in this app posts through incoming
// webhooks and needs no token.
//
// Errors THROW. The declined-calls report reads before it claims and posts, so
// a failed read must stop the pass rather than look like an empty week.
// Error messages carry only Slack's error code, never the token or message text.
const TIMEOUT_MS = 10_000;
const API = "https://slack.com/api";
// Slack recommends no more than 200 per page. An internal (customer-built) app
// keeps Tier 3 limits on conversations.history (50+ requests a minute); the
// 2025 limit of 1 request a minute and 15 messages applies only to
// commercially distributed non-Marketplace apps:
// https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
const PAGE_SIZE = 200;
// Five weeks of one channel is a few pages at most. A runaway cursor loop
// should fail loudly rather than burn the rate limit.
const MAX_PAGES = 20;

/** The fields of a conversations.history message this app reads. */
export type SlackMessage = {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  attachments?: SlackAttachment[];
};

export type SlackAttachment = {
  is_share?: boolean;
  is_msg_unfurl?: boolean;
  from_url?: string;
  text?: string;
  fallback?: string;
  message_blocks?: Array<{ message?: { blocks?: unknown[] } }>;
};

type SlackResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

// Read methods take form-encoded arguments; not every one accepts a JSON body.
// chat.postMessage takes JSON.
async function call(
  method: string,
  token: string,
  args: Record<string, string> | { json: Record<string, unknown> }
): Promise<SlackResponse> {
  const json = "json" in args && typeof args.json === "object";
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body: json
      ? JSON.stringify((args as { json: Record<string, unknown> }).json)
      : new URLSearchParams(args as Record<string, string>).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 429) {
    throw new Error(`[slack] ${method} rate limited (retry after ${res.headers.get("retry-after") ?? "?"}s)`);
  }
  if (!res.ok) throw new Error(`[slack] ${method} failed: HTTP ${res.status}`);

  const data = (await res.json()) as SlackResponse;
  if (!data.ok) throw new Error(`[slack] ${method} failed: ${data.error ?? "unknown_error"}`);
  return data;
}

/**
 * Every top-level message in the channel between two instants (Unix seconds,
 * Slack's `oldest`/`latest`). Thread replies are not included: those come only
 * from conversations.replies, which this never calls.
 */
export async function fetchChannelHistory(
  token: string,
  channel: string,
  oldestSec: number,
  latestSec: number
): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await call("conversations.history", token, {
      channel,
      oldest: String(oldestSec),
      latest: String(latestSec),
      inclusive: "true",
      limit: String(PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(data.messages ?? []));

    cursor = data.response_metadata?.next_cursor || undefined;
    if (!data.has_more || !cursor) return out;
  }
  throw new Error(`[slack] conversations.history: more than ${MAX_PAGES} pages`);
}

export async function postMessage(token: string, channel: string, text: string): Promise<void> {
  await call("chat.postMessage", token, {
    json: { channel, text, unfurl_links: false, unfurl_media: false },
  });
}
