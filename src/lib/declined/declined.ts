// Turned-down call log: what `/trinity declined …` does, and the Monday post.
//
// Ella logs each call Trinity turns down (crew too busy, or a contract
// customer too far away). Dave reads a weekly total in the schedule channel;
// around 15 a week is the point to hire another van and plumber.
//
// Nothing here reads Slack history and nothing needs a bot token: logging
// arrives through the existing signed slash command, and the report goes out
// through the existing SLACK_WEBHOOK_SCHEDULE incoming webhook.
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { claim } from "@/lib/notifications/dedupe";
import { isWeeklyLookaheadDue } from "@/lib/notifications/schedule";
import { postSlack } from "@/lib/slack/client";
import type { DeclinedCommand, DeclinedReason } from "./parse";
import {
  formatSplit,
  formatWeekSummary,
  formatWeeklyReport,
  reportWindowStart,
  tally,
  thisWeek,
  weekBefore,
  weekKey,
  type DeclinedRow,
} from "./tally";

// Off unless exactly "true", like SLACK_ALERTS_ENABLED and SLACK_COMMANDS_ENABLED.
// Covers both the command and the Monday post, so this can deploy before the
// migration is applied without anyone writing to a table that isn't there.
export function declinedEnabled(): boolean {
  return process.env.SLACK_DECLINED_ENABLED === "true";
}

export const DISABLED_TEXT = "Turned-down call logging isn't switched on yet.";

export const USAGE_TEXT = [
  "*Log a turned-down call*",
  "`/trinity declined busy` — crew too busy",
  "`/trinity declined distance` — contract customer too far away",
  "Add the caller's number and a short note if you have them:",
  "`/trinity declined busy 518-555-0100 wanted Tuesday`",
  "",
  "`/trinity declined undo` — remove the last one you logged",
  "`/trinity declined week` — this week and last week so far",
].join("\n");

const NO_SALT_TEXT =
  "Not logged: DECLINED_PHONE_SALT is not set on this deployment, so the phone number " +
  "can't be stored safely. Log it again without the number, or ask Ryan to set it.";

/**
 * Salted HMAC of the normalized 10-digit number. A plain hash of a phone
 * number is reversible by trying all ten billion of them; the salt is what
 * makes the stored value useless without the deployment's secret.
 */
export function hashPhone(phone: string, salt: string): string {
  return createHmac("sha256", salt).update(phone).digest("hex");
}

export type StoredRow = DeclinedRow & {
  id: number;
  slack_user_id: string;
  note: string | null;
};

export type NewRow = Omit<StoredRow, "id">;

/** The few reads and writes this feature needs; swapped for an in-memory one in tests. */
export interface DeclinedStore {
  insert(row: NewRow): Promise<void>;
  listSince(fromIso: string, toIso: string): Promise<DeclinedRow[]>;
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
        .select("created_at, reason, phone_hash")
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: true });
      if (error) throw new Error(`[declined] read failed: ${error.message}`);
      return (data ?? []) as DeclinedRow[];
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

async function weekRows(store: DeclinedStore, now: Date): Promise<DeclinedRow[]> {
  const week = thisWeek(now);
  return store.listSince(week.startIso, week.endIso);
}

function runningTotal(rows: DeclinedRow[]): string {
  const t = tally(rows);
  return `This week so far: *${t.total}* (${formatSplit(t)}).`;
}

export async function renderDeclined(
  cmd: DeclinedCommand,
  now: Date,
  store: DeclinedStore = supabaseDeclinedStore(getSupabaseServerClient())
): Promise<string> {
  if (!declinedEnabled()) return DISABLED_TEXT;

  switch (cmd.kind) {
    case "declinedUsage":
      return USAGE_TEXT;

    case "declinedWeek": {
      const rows = await store.listSince(weekBefore(thisWeek(now)).startIso, thisWeek(now).endIso);
      return formatWeekSummary(rows, now);
    }

    case "declinedUndo": {
      if (!cmd.userId) return "Couldn't tell who you are, so nothing was removed.";
      const removed = await store.deleteLatestBy(cmd.userId);
      if (!removed) return "You haven't logged any turned-down calls, so there's nothing to undo.";
      const rows = await weekRows(store, now);
      return [
        `Removed your last entry: ${REASON_LABEL[removed.reason]}, logged ${new Intl.DateTimeFormat(
          "en-US",
          { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        ).format(new Date(removed.created_at))}.`,
        runningTotal(rows),
      ].join("\n");
    }

    case "declinedLog": {
      if (!cmd.userId) return "Couldn't tell who you are, so nothing was logged.";

      let phoneHash: string | null = null;
      if (cmd.phone) {
        const salt = process.env.DECLINED_PHONE_SALT;
        if (!salt) return NO_SALT_TEXT;
        phoneHash = hashPhone(cmd.phone, salt);
      }

      const before = await weekRows(store, now);
      const repeat = phoneHash !== null && before.some((r) => r.phone_hash === phoneHash);

      const row: NewRow = {
        created_at: now.toISOString(),
        reason: cmd.reason,
        slack_user_id: cmd.userId,
        note: cmd.note,
        phone_hash: phoneHash,
      };
      await store.insert(row);

      const lines = [`Logged: turned down, ${REASON_LABEL[cmd.reason]}.`];
      if (cmd.note) lines.push(`Note: ${cmd.note}`);
      if (repeat) lines.push("That number was already logged this week, so it isn't counted twice.");
      lines.push(runningTotal([...before, row]));
      return lines.join("\n");
    }
  }
}

/**
 * The Monday-morning post. Called from /api/cron/sync on every run; posts at
 * most once per reported week (claim() ledger, kind "declined_weekly", keyed
 * by that week's Monday). Builds the text BEFORE claiming, so a failed read
 * leaves the week unclaimed for the next 15-minute run instead of losing it.
 */
export async function runDeclinedReportPass(
  supabase: SupabaseClient,
  now: Date,
  store: DeclinedStore = supabaseDeclinedStore(supabase)
): Promise<boolean> {
  if (!declinedEnabled()) return false;
  if (!isWeeklyLookaheadDue(now)) return false;

  const rows = await store.listSince(reportWindowStart(now), now.toISOString());
  const text = formatWeeklyReport(rows, now);

  const reported = weekKey(weekBefore(thisWeek(now)));
  if (!(await claim(supabase, "declined_weekly", reported))) return false;

  return postSlack(process.env.SLACK_WEBHOOK_SCHEDULE, text);
}

