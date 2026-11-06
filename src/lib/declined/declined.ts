// Declined calls: what `/trinity declined ...` does, and the Monday post.
//
// Ellah forwards each turned-down call from #calls into #declined-calls. The
// bot counts those forwards (read at report time with conversations.history;
// nothing from them is stored) together with any `/trinity declined
// busy|distance` entries, the backup path, which live in the declined_calls
// table. Dave reads the Monday total in #declined-calls; around 15 a week is
// the point to hire another van and plumber.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { claim } from "@/lib/notifications/dedupe";
import { isWeeklyLookaheadDue } from "@/lib/notifications/schedule";
import { fetchChannelHistory, postMessage, SlackApiError } from "@/lib/slack/web";
import { channelRows } from "./channel";
import { hashPhone } from "./phone";
import type { DeclinedCommand, DeclinedReason } from "./parse";
import {
  formatWeekSummary,
  formatWeeklyReport,
  reportWindowStart,
  runningTotal,
  thisWeek,
  weekBefore,
  weekKey,
  type DeclinedRow,
} from "./tally";

export { hashPhone };

// Off unless exactly "true", like SLACK_ALERTS_ENABLED and SLACK_COMMANDS_ENABLED.
// Covers the command, the channel count and the Monday post.
export function declinedEnabled(): boolean {
  return process.env.SLACK_DECLINED_ENABLED === "true";
}

export const DISABLED_TEXT = "Declined-call counting isn't switched on yet.";

export const USAGE_TEXT = [
  "*Log a declined call* (a backup for forwarding it to #declined-calls)",
  "`/trinity declined busy` — crew too busy",
  "`/trinity declined distance` — contract customer too far away",
  "Add the caller's number and a short note if you have them:",
  "`/trinity declined busy 518-555-0100 wanted Tuesday`",
  "",
  "`/trinity declined undo` — remove the last one you logged",
  "`/trinity declined week` — this week and last week, forwards included",
].join("\n");

const NO_SALT_TEXT =
  "Not logged: DECLINED_PHONE_SALT is not set on this deployment, so the phone number " +
  "can't be stored safely. Log it again without the number, or ask Ryan to set it.";

export type StoredRow = DeclinedRow & {
  id: number;
  slack_user_id: string;
  note: string | null;
};

export type NewRow = Omit<StoredRow, "id">;

/** What the reports read back: enough to count, plus the note for the Monday list. */
export type CommandRow = DeclinedRow & { note?: string | null };

/** The few reads and writes this feature needs; swapped for an in-memory one in tests. */
export interface DeclinedStore {
  insert(row: NewRow): Promise<void>;
  listSince(fromIso: string, toIso: string): Promise<CommandRow[]>;
  /** Deletes and returns the user's most recent row, or null if they have none. */
  deleteLatestBy(userId: string): Promise<StoredRow | null>;
}

export function supabaseDeclinedStore(supabase: SupabaseClient): DeclinedStore {
  return {
    async insert(row) {
      const { error } = await supabase.from("declined_calls").insert(row);
      if (error) throw new Error(`[declined] insert failed: ${error.message}`);
    },

    async listSince(fromIso, toIso) {
      const { data, error } = await supabase
        .from("declined_calls")
        .select("created_at, reason, phone_hash, note")
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: true });
      if (error) throw new Error(`[declined] read failed: ${error.message}`);
      return (data ?? []) as CommandRow[];
    },

    async deleteLatestBy(userId) {
      const { data, error } = await supabase
        .from("declined_calls")
        .select("id, created_at, reason, phone_hash, slack_user_id, note")
        .eq("slack_user_id", userId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1);
      if (error) throw new Error(`[declined] read failed: ${error.message}`);
      const row = (data?.[0] ?? null) as StoredRow | null;
      if (!row) return null;

      const del = await supabase.from("declined_calls").delete().eq("id", row.id);
      if (del.error) throw new Error(`[declined] delete failed: ${del.error.message}`);
      return row;
    },
  };
}

const REASON_LABEL: Record<DeclinedReason, string> = {
  busy: "too busy",
  distance: "too far (distance)",
};

/** Declined calls forwarded into #declined-calls, as tally rows. */
export interface ChannelSource {
  rowsBetween(fromIso: string, toIso: string): Promise<DeclinedRow[]>;
}

function channelConfig(): { token: string; channel: string } {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_DECLINED_CHANNEL_ID;
  // Codes of our own, shaped like Slack's, so one table explains every failure.
  if (!token) throw new SlackApiError("config", "token_not_set");
  if (!token.startsWith("xoxb-")) throw new SlackApiError("config", "token_not_bot");
  if (!channel) throw new SlackApiError("config", "channel_not_set");
  return { token, channel };
}

const FIXES: Record<string, string> = {
  token_not_set: "SLACK_BOT_TOKEN is not set. Add the Bot User OAuth Token (xoxb-…) in Vercel and redeploy.",
  token_not_bot:
    "SLACK_BOT_TOKEN is not a bot token. Use the Bot User OAuth Token, which starts with xoxb-, and redeploy.",
  channel_not_set: "SLACK_DECLINED_CHANNEL_ID is not set. Add the channel ID (C…) of #declined-calls in Vercel and redeploy.",
  not_in_channel: "The bot isn't in #declined-calls. In that channel, type /invite @ and pick the Trinity app.",
  missing_scope:
    "The app is missing a permission. Add it under OAuth & Permissions → Bot Token Scopes, reinstall the app, and update SLACK_BOT_TOKEN if it changed.",
  invalid_auth: "Slack doesn't accept SLACK_BOT_TOKEN. Copy the current Bot User OAuth Token into Vercel and redeploy.",
  not_authed: "Slack received no token. Check SLACK_BOT_TOKEN in Vercel and redeploy.",
  token_revoked: "SLACK_BOT_TOKEN was revoked. Reinstall the app, copy the new Bot User OAuth Token into Vercel, redeploy.",
  token_expired: "SLACK_BOT_TOKEN has expired. Reinstall the app, copy the new Bot User OAuth Token into Vercel, redeploy.",
  account_inactive: "The app's bot user is deactivated. Reinstall the app and update SLACK_BOT_TOKEN.",
  channel_not_found:
    "Slack can't find that channel. Check SLACK_DECLINED_CHANNEL_ID (C…, from the channel's About tab). If the channel is private, invite the bot and add groups:history.",
  ratelimited: "Slack is rate-limiting the read. Try again in a minute.",
};

/**
 * One line for the person who ran the command: Slack's error code and how to
 * fix it. Error codes and scope names only; never the token or message text.
 */
export function describeChannelError(err: unknown): string {
  if (!(err instanceof SlackApiError)) return "Couldn't reach Slack (network or timeout). Try again in a moment.";
  const code = /^[a-z0-9_]+$/i.test(err.code) ? err.code : "unknown_error";
  const needed = err.needed && /^[a-z0-9_:.,]+$/i.test(err.needed) ? err.needed : null;
  const label = needed ? `${code} (needs ${needed})` : code;
  const fix = FIXES[code] ?? (code.startsWith("http_5") ? "Slack had a server error. Try again in a moment." : "See the Slack API docs for this code.");
  return `${label}: ${fix}`;
}

export function slackChannelSource(): ChannelSource {
  return {
    async rowsBetween(fromIso, toIso) {
      const cfg = channelConfig();
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      const messages = await fetchChannelHistory(cfg.token, cfg.channel, Math.floor(from / 1000), Math.ceil(to / 1000));
      return channelRows(messages, process.env.DECLINED_PHONE_SALT).filter((r) => {
        const t = Date.parse(r.created_at);
        return t >= from && t < to;
      });
    },
  };
}

export type Deps = { store: DeclinedStore; channel: ChannelSource };

function defaultDeps(): Deps {
  return { store: supabaseDeclinedStore(getSupabaseServerClient()), channel: slackChannelSource() };
}

export function channelUnavailable(err: unknown): string {
  return `_Couldn't read #declined-calls, so this counts /trinity entries only._\n${describeChannelError(err)}`;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Gives /trinity entries their line in the Monday list. */
export function labelCommandRows(rows: CommandRow[]): DeclinedRow[] {
  return rows.map(({ note, ...row }) => ({
    ...row,
    label: `Logged with /trinity: ${row.reason ?? "declined"}${note ? ` — ${escapeMrkdwn(note)}` : ""}`,
  }));
}

/**
 * Command entries plus channel forwards. For an interactive reply a channel
 * failure degrades to command entries only, and says so; the Monday report
 * never does this (see runDeclinedReportPass).
 */
async function combinedRows(
  deps: Deps,
  fromIso: string,
  toIso: string
): Promise<{ rows: DeclinedRow[]; note: string | null }> {
  let failure: unknown = null;
  const [own, shared] = await Promise.all([
    deps.store.listSince(fromIso, toIso),
    deps.channel.rowsBetween(fromIso, toIso).catch((err) => {
      // The error message only: Slack error codes, never message text.
      console.error("[declined] channel read failed:", err instanceof Error ? err.message : String(err));
      failure = err;
      return null;
    }),
  ]);
  return shared ? { rows: [...own, ...shared], note: null } : { rows: own, note: channelUnavailable(failure) };
}

function withNote(lines: string[], note: string | null): string {
  return (note ? [...lines, note] : lines).join("\n");
}

export async function renderDeclined(cmd: DeclinedCommand, now: Date, deps: Deps = defaultDeps()): Promise<string> {
  if (!declinedEnabled()) return DISABLED_TEXT;
  const week = thisWeek(now);

  switch (cmd.kind) {
    case "declinedUsage":
      return USAGE_TEXT;

    case "declinedWeek": {
      const { rows, note } = await combinedRows(deps, weekBefore(week).startIso, week.endIso);
      return withNote([formatWeekSummary(rows, now)], note);
    }

    case "declinedUndo": {
      if (!cmd.userId) return "Couldn't tell who you are, so nothing was removed.";
      const removed = await deps.store.deleteLatestBy(cmd.userId);
      if (!removed || !removed.reason) {
        return "You haven't logged any declined calls with /trinity, so there's nothing to undo.";
      }
      const { rows, note } = await combinedRows(deps, week.startIso, week.endIso);
      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(removed.created_at));
      return withNote(
        [`Removed your last entry: ${REASON_LABEL[removed.reason]}, logged ${when}.`, runningTotal(rows, now)],
        note
      );
    }

    case "declinedLog": {
      if (!cmd.userId) return "Couldn't tell who you are, so nothing was logged.";

      let phoneHash: string | null = null;
      if (cmd.phone) {
        const salt = process.env.DECLINED_PHONE_SALT;
        if (!salt) return NO_SALT_TEXT;
        phoneHash = hashPhone(cmd.phone, salt);
      }

      const { rows: before, note } = await combinedRows(deps, week.startIso, week.endIso);
      const repeat = phoneHash !== null && before.some((r) => r.phone_hash === phoneHash);

      const row: NewRow = {
        created_at: now.toISOString(),
        reason: cmd.reason,
        slack_user_id: cmd.userId,
        note: cmd.note,
        phone_hash: phoneHash,
      };
      await deps.store.insert(row);

      const lines = [`Logged: declined, ${REASON_LABEL[cmd.reason]}.`];
      if (cmd.note) lines.push(`Note: ${cmd.note}`);
      if (repeat) lines.push("That number is already counted this week, so it isn't counted twice.");
      lines.push(runningTotal([...before, row], now));
      return withNote(lines, note);
    }
  }
}

export type ReportDeps = Deps & { post: (text: string) => Promise<void> };

function defaultReportDeps(supabase: SupabaseClient): ReportDeps {
  return {
    store: supabaseDeclinedStore(supabase),
    channel: slackChannelSource(),
    post: async (text) => {
      const cfg = channelConfig();
      await postMessage(cfg.token, cfg.channel, text);
    },
  };
}

/**
 * The Monday-morning post to #declined-calls. Called from /api/cron/sync on
 * every run; posts at most once per reported week (claim() ledger, kind
 * "declined_weekly", keyed by that week's Monday).
 *
 * Reads both sources and builds the text BEFORE claiming. A Slack or database
 * error throws before the claim, so nothing is posted and the next 15-minute
 * run tries again. Unlike the interactive reply, the report never falls back
 * to a partial count: a wrong number in front of Dave is worse than a late one.
 * Once claimed, a failed post is not retried (the ledger's rule everywhere:
 * losing a message beats posting it twice).
 */
export async function runDeclinedReportPass(
  supabase: SupabaseClient,
  now: Date,
  deps: ReportDeps = defaultReportDeps(supabase)
): Promise<boolean> {
  if (!declinedEnabled()) return false;
  if (!isWeeklyLookaheadDue(now)) return false;
  try {
    channelConfig();
  } catch (err) {
    console.warn(`[declined] weekly report skipped: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const from = reportWindowStart(now);
  const to = now.toISOString();
  const [own, shared] = await Promise.all([deps.store.listSince(from, to), deps.channel.rowsBetween(from, to)]);
  const text = formatWeeklyReport([...labelCommandRows(own), ...shared], now);

  const reported = weekKey(weekBefore(thisWeek(now)));
  if (!(await claim(supabase, "declined_weekly", reported))) return false;

  await deps.post(text);
  return true;
}
