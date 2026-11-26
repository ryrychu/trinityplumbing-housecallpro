// Fixed-window message counters in chat_rate_limits (migration 0010). Each
// message counts in two windows: the visitor's IP (hashed, never stored raw)
// per CHAT_IP_WINDOW_MINUTES, and the whole site per UTC day. Each count is
// one atomic upsert through chat_rate_limit_hit, so concurrent requests can't
// both slip under a limit.
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatLimits } from "./config";

export type RateInput = { site: string; ipHash: string; limits: ChatLimits; now: Date };
export type RateResult = { ok: true } | { ok: false; scope: "ip" | "site" };

const DAY_MS = 86_400_000;

/**
 * Salted HMAC of the IP, like hashPhone in src/lib/declined/phone.ts. A plain
 * hash of an IPv4 address is reversible by trying all four billion of them.
 */
export function hashIp(ip: string, salt: string): string {
  return createHmac("sha256", salt).update(ip).digest("hex");
}

/** The start of the window `now` falls in, as ISO. Day windows start at midnight UTC. */
export function windowStart(now: Date, windowMs: number): string {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
}

async function hit(db: SupabaseClient, key: string, start: string): Promise<number> {
  const { data, error } = await db.rpc("chat_rate_limit_hit", { p_key: key, p_window_start: start });
  if (error) throw new Error(`[chat] rate limit check failed: ${error.message}`);
  const count = data === null || data === undefined ? Number.NaN : Number(data);
  if (!Number.isInteger(count) || count < 1) throw new Error("[chat] rate limit check failed: no count returned");
  return count;
}

/** Counts this message and says whether it may go to the model. Throws on a database error. */
export async function checkRateLimit(db: SupabaseClient, input: RateInput): Promise<RateResult> {
  const ipCount = await hit(db, `ip:${input.site}:${input.ipHash}`, windowStart(input.now, input.limits.ipWindowMs));
  if (ipCount > input.limits.ipMax) return { ok: false, scope: "ip" };
  const siteCount = await hit(db, `site:${input.site}`, windowStart(input.now, DAY_MS));
  if (siteCount > input.limits.siteDailyMax) return { ok: false, scope: "site" };
  return { ok: true };
}
