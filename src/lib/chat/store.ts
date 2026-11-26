// Saves website chat turns (migration 0010) and deletes old ones. Server-only,
// through the service-role client. Text is masked here (redact.ts), so no
// caller can save a phone number or email by mistake.
import type { SupabaseClient } from "@supabase/supabase-js";
import { redact } from "./redact";

export const CHAT_RETENTION_DAYS = 90;
export const RATE_LIMIT_RETENTION_DAYS = 2;
const DAY_MS = 86_400_000;

export type ChatTurn = {
  conversationId: string;
  site: string;
  /** The visitor's latest message, as sent. */
  userText: string;
  reply: string;
  emergency: boolean;
};

export interface ChatStore {
  /** Saves one visitor message and its reply, masked. Throws on a database error. */
  saveTurn(turn: ChatTurn): Promise<void>;
}

export function supabaseChatStore(db: SupabaseClient): ChatStore {
  return {
    async saveTurn(turn) {
      const { error } = await db.rpc("chat_save_turn", {
        p_conversation_id: turn.conversationId,
        p_site: turn.site,
        p_user_text: redact(turn.userText),
        p_reply: redact(turn.reply),
        p_emergency: turn.emergency,
      });
      // Supabase puts row data in `details`, not `message`; only the message is used.
      if (error) throw new Error(`[chat] save failed: ${error.message}`);
    },
  };
}

function before(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * The cron sync's retention step: conversations 90 days after they started
 * (their messages go with them, on delete cascade) and rate-limit rows after 2 days.
 */
export async function deleteExpiredChats(db: SupabaseClient, now: Date): Promise<void> {
  const chats = await db.from("chat_conversations").delete().lt("started_at", before(now, CHAT_RETENTION_DAYS));
  if (chats.error) throw new Error(`[chat] retention failed for chat_conversations: ${chats.error.message}`);
  const limits = await db.from("chat_rate_limits").delete().lt("window_start", before(now, RATE_LIMIT_RETENTION_DAYS));
  if (limits.error) throw new Error(`[chat] retention failed for chat_rate_limits: ${limits.error.message}`);
}
