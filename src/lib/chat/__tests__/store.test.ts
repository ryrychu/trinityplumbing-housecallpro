import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteExpiredChats, supabaseChatStore } from "../store";

// Stand-in for the two Supabase chains the store uses:
//   db.rpc(fn, args)  and  db.from(table).delete().lt(column, value)
function fakeDb(error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: null, error }));
  const deletes: Array<[string, string, string]> = [];
  const from = vi.fn((table: string) => ({
    delete: () => ({
      lt: async (column: string, value: string) => {
        deletes.push([table, column, value]);
        return { error };
      },
    }),
  }));
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, deletes };
}

const TURN = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  site: "trinity",
  userText: "Call me at 518-348-3032 or jane@example.com",
  reply: "Sure, or call us at (518) 348-3032.",
  emergency: true,
};

describe("supabaseChatStore.saveTurn", () => {
  it("saves the turn in one call, with phone numbers and emails masked", async () => {
    const { db, rpc } = fakeDb();
    await supabaseChatStore(db).saveTurn(TURN);
    expect(rpc).toHaveBeenCalledWith("chat_save_turn", {
      p_conversation_id: TURN.conversationId,
      p_site: "trinity",
      p_user_text: "Call me at [phone] or [email]",
      p_reply: "Sure, or call us at [phone].",
      p_emergency: true,
    });
  });

  it("throws with the database's message", async () => {
    const { db } = fakeDb({ message: "db down" });
    await expect(supabaseChatStore(db).saveTurn(TURN)).rejects.toThrow("[chat] save failed: db down");
  });
});

describe("deleteExpiredChats", () => {
  it("deletes conversations started over 90 days ago and rate-limit rows over 2 days old", async () => {
    const { db, deletes } = fakeDb();
    await deleteExpiredChats(db, new Date("2026-11-26T12:00:00.000Z"));
    expect(deletes).toEqual([
      ["chat_conversations", "started_at", "2026-08-28T12:00:00.000Z"],
      ["chat_rate_limits", "window_start", "2026-11-24T12:00:00.000Z"],
    ]);
  });

  it("throws naming the table when a delete fails", async () => {
    const { db } = fakeDb({ message: "relation does not exist" });
    await expect(deleteExpiredChats(db, new Date())).rejects.toThrow(
      "[chat] retention failed for chat_conversations: relation does not exist"
    );
  });
});
