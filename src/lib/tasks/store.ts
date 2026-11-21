// Where Dave's daily checklist lives between changes: the grouping, which
// Slack message shows it, and which items are ticked. Tables: migration 0008.
// Server-only, through the service-role client.
import type { SupabaseClient } from "@supabase/supabase-js";

export type BuiltBy = "morning_ai" | "morning_rules" | "chatgpt";
export type DoneVia = "chatgpt" | "slack" | "fieldy";

export type ChecklistRow = {
  id: number;
  /** Eastern calendar day, YYYY-MM-DD. */
  day: string;
  channelId: string;
  messageTs: string | null;
  builtBy: BuiltBy;
  version: number;
  renderedVersion: number;
  overflow: number;
  finishedYesterday: number;
  /** Last change to the row (ISO). */
  updatedAt: string;
};

export type ItemRow = {
  checklistId: number;
  position: number;
  groupName: string;
  text: string;
  fieldyTaskId: string;
  doneAt: string | null;
  doneVia: DoneVia | null;
};

export type NewItem = Omit<ItemRow, "checklistId">;

export interface ChecklistStore {
  getByDay(day: string): Promise<ChecklistRow | null>;
  getById(id: number): Promise<ChecklistRow | null>;
  /** The day's checklist, created if missing. Safe to call twice for the same day. */
  create(input: { day: string; channelId: string; builtBy: BuiltBy }): Promise<ChecklistRow>;
  updateMeta(id: number, meta: { builtBy: BuiltBy; overflow: number; finishedYesterday: number }): Promise<void>;
  /** Records the Slack message only if none is recorded yet; true if this call set it. */
  claimMessageTs(id: number, ts: string): Promise<boolean>;
  /** Items in position order. */
  listItems(id: number): Promise<ItemRow[]>;
  replaceItems(id: number, items: NewItem[]): Promise<void>;
  /** Adds at the end; does nothing if the task is already on this checklist. */
  appendItem(id: number, item: { groupName: string; text: string; fieldyTaskId: string }): Promise<void>;
  setDone(id: number, fieldyTaskIds: string[], doneAt: string | null, via: DoneVia | null): Promise<void>;
  /** version + 1; returns the new version. */
  touch(id: number): Promise<number>;
  markRendered(id: number, version: number): Promise<void>;
  /** Checklists from `sinceDay` on whose Slack message is behind the database (or was never posted). */
  listBehind(sinceDay: string): Promise<ChecklistRow[]>;
}

const CHECKLIST_COLS = "id, day, channel_id, message_ts, built_by, version, rendered_version, overflow, finished_yesterday, updated_at";
const ITEM_COLS = "checklist_id, position, group_name, text, fieldy_task_id, done_at, done_via";

type Err = { message: string } | null;

function check(op: string, error: Err): void {
  // Supabase puts row data in `details`, not `message`; only the message is used.
  if (error) throw new Error(`[tasks] ${op} failed: ${error.message}`);
}

function toChecklist(r: Record<string, unknown>): ChecklistRow {
  return {
    id: Number(r.id),
    day: String(r.day),
    channelId: String(r.channel_id),
    messageTs: (r.message_ts as string | null) ?? null,
    builtBy: r.built_by as BuiltBy,
    version: Number(r.version),
    renderedVersion: Number(r.rendered_version),
    overflow: Number(r.overflow),
    finishedYesterday: Number(r.finished_yesterday),
    updatedAt: String(r.updated_at),
  };
}

function toItem(r: Record<string, unknown>): ItemRow {
  return {
    checklistId: Number(r.checklist_id),
    position: Number(r.position),
    groupName: String(r.group_name),
    text: String(r.text),
    fieldyTaskId: String(r.fieldy_task_id),
    doneAt: (r.done_at as string | null) ?? null,
    doneVia: (r.done_via as DoneVia | null) ?? null,
  };
}

export function supabaseChecklistStore(db: SupabaseClient): ChecklistStore {
  async function getByDay(day: string): Promise<ChecklistRow | null> {
    const { data, error } = await db.from("task_checklists").select(CHECKLIST_COLS).eq("day", day).maybeSingle();
    check("getByDay", error);
    return data ? toChecklist(data as Record<string, unknown>) : null;
  }

  return {
    getByDay,

    async getById(id) {
      const { data, error } = await db.from("task_checklists").select(CHECKLIST_COLS).eq("id", id).maybeSingle();
      check("getById", error);
      return data ? toChecklist(data as Record<string, unknown>) : null;
    },

    async create({ day, channelId, builtBy }) {
      const { error } = await db
        .from("task_checklists")
        .upsert({ day, channel_id: channelId, built_by: builtBy }, { onConflict: "day", ignoreDuplicates: true });
      check("create", error);
      const row = await getByDay(day);
      if (!row) throw new Error("[tasks] create failed: row missing after insert");
      return row;
    },

    async updateMeta(id, meta) {
      const { error } = await db
        .from("task_checklists")
        .update({
          built_by: meta.builtBy,
          overflow: meta.overflow,
          finished_yesterday: meta.finishedYesterday,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      check("updateMeta", error);
    },

    async claimMessageTs(id, ts) {
      const { data, error } = await db
        .from("task_checklists")
        .update({ message_ts: ts, updated_at: new Date().toISOString() })
        .eq("id", id)
        .is("message_ts", null)
        .select("id");
      check("claimMessageTs", error);
      return Array.isArray(data) && data.length === 1;
    },

    async listItems(id) {
      const { data, error } = await db.from("task_checklist_items").select(ITEM_COLS).eq("checklist_id", id).order("position");
      check("listItems", error);
      return ((data ?? []) as Record<string, unknown>[]).map(toItem);
    },

    async replaceItems(id, items) {
      const { error } = await db.rpc("task_checklist_replace_items", {
        p_id: id,
        p_items: items.map((i) => ({
          position: i.position,
          group_name: i.groupName,
          text: i.text,
          fieldy_task_id: i.fieldyTaskId,
          done_at: i.doneAt,
          done_via: i.doneVia,
        })),
      });
      check("replaceItems", error);
    },

    async appendItem(id, item) {
      const { error } = await db.rpc("task_checklist_append_item", {
        p_id: id,
        p_group: item.groupName,
        p_text: item.text,
        p_task_id: item.fieldyTaskId,
      });
      check("appendItem", error);
    },

    async setDone(id, fieldyTaskIds, doneAt, via) {
      if (fieldyTaskIds.length === 0) return;
      const { error } = await db
        .from("task_checklist_items")
        .update({ done_at: doneAt, done_via: via })
        .eq("checklist_id", id)
        .in("fieldy_task_id", fieldyTaskIds);
      check("setDone", error);
    },

    async touch(id) {
      const { data, error } = await db.rpc("task_checklist_touch", { p_id: id });
      check("touch", error);
      if (typeof data !== "number") throw new Error("[tasks] touch failed: checklist not found");
      return data;
    },

    async markRendered(id, version) {
      const { error } = await db.rpc("task_checklist_rendered", { p_id: id, p_version: version });
      check("markRendered", error);
    },

    async listBehind(sinceDay) {
      const { data, error } = await db.from("task_checklists").select(CHECKLIST_COLS).eq("behind", true).gte("day", sinceDay);
      check("listBehind", error);
      return ((data ?? []) as Record<string, unknown>[]).map(toChecklist);
    },
  };
}
