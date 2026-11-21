// Test doubles shared by the checklist, morning, connector and Slack-tap tests.
import { FieldyApiError, type ConversationSummary, type FieldyTask, type TaskUpdate } from "@/lib/fieldy/client";
import type { ChecklistRow, ChecklistStore, ItemRow } from "../store";

// 8:00 AM Eastern, Mon Nov 23 2026.
export const NOW = new Date("2026-11-23T13:00:00.000Z");
export const TODAY = "2026-11-23";

export function task(id: string, title: string, extra: Partial<FieldyTask> = {}): FieldyTask {
  return { id, title, status: "approved", date: null, completionDate: null, ...extra };
}

/** ChecklistStore in memory, with the same version rules as migration 0008. */
export function memoryStore() {
  let nextId = 1;
  const lists = new Map<number, ChecklistRow>();
  const items = new Map<number, ItemRow[]>();

  const store: ChecklistStore = {
    async getByDay(day) {
      const row = Array.from(lists.values()).find((l) => l.day === day);
      return row ? { ...row } : null;
    },
    async getById(id) {
      const row = lists.get(id);
      return row ? { ...row } : null;
    },
    async create({ day, channelId, builtBy }) {
      const existing = await store.getByDay(day);
      if (existing) return existing;
      const row: ChecklistRow = {
        id: nextId++,
        day,
        channelId,
        messageTs: null,
        builtBy,
        version: 1,
        renderedVersion: 0,
        overflow: 0,
        finishedYesterday: 0,
      };
      lists.set(row.id, row);
      items.set(row.id, []);
      return { ...row };
    },
    async updateMeta(id, meta) {
      Object.assign(lists.get(id)!, meta);
    },
    async setMessageTs(id, ts) {
      lists.get(id)!.messageTs = ts;
    },
    async listItems(id) {
      return (items.get(id) ?? []).map((i) => ({ ...i })).sort((a, b) => a.position - b.position);
    },
    async replaceItems(id, next) {
      items.set(
        id,
        next.map((i) => ({ ...i, checklistId: id }))
      );
    },
    async appendItem(id, item) {
      const list = items.get(id)!;
      if (list.some((i) => i.fieldyTaskId === item.fieldyTaskId)) return;
      const position = list.reduce((max, i) => Math.max(max, i.position), 0) + 1;
      list.push({ checklistId: id, position, ...item, doneAt: null, doneVia: null });
    },
    async setDone(id, ids, doneAt, via) {
      for (const i of items.get(id) ?? []) {
        if (ids.includes(i.fieldyTaskId)) {
          i.doneAt = doneAt;
          i.doneVia = via;
        }
      }
    },
    async touch(id) {
      const row = lists.get(id)!;
      row.version += 1;
      return row.version;
    },
    async markRendered(id, version) {
      const row = lists.get(id)!;
      row.renderedVersion = Math.max(row.renderedVersion, version);
    },
    async listBehind(sinceDay) {
      return Array.from(lists.values())
        .filter((l) => l.day >= sinceDay && l.renderedVersion < l.version)
        .map((l) => ({ ...l }));
    },
  };

  return { store, lists, items };
}

/** Fieldy with tasks in memory. Records every write. */
export function fakeFieldy(initial: FieldyTask[] = []) {
  const state = new Map(initial.map((t) => [t.id, { ...t }]));
  const updates: Array<[string, TaskUpdate]> = [];
  const created: Array<{ title: string; date: string }> = [];
  let recordings: ConversationSummary[] = [];
  let updateCalls = 0;
  let failAt: { n: number; err: Error } | null = null;
  let nextId = 100;

  const port = {
    async tasks(): Promise<FieldyTask[]> {
      return Array.from(state.values())
        .filter((t) => ["new", "approved", "completed"].includes(t.status))
        .map((t) => ({ ...t }));
    },
    async completed(): Promise<FieldyTask[]> {
      return Array.from(state.values())
        .filter((t) => t.status === "completed")
        .map((t) => ({ ...t }));
    },
    async update(id: string, update: TaskUpdate): Promise<FieldyTask> {
      updateCalls += 1;
      if (failAt && failAt.n === updateCalls) throw failAt.err;
      const t = state.get(id);
      if (!t) throw new FieldyApiError("http_404", "PATCH /tasks/{id}");
      updates.push([id, update]);
      t.status = update.status;
      t.completionDate = update.status === "completed" ? update.completionDate : null;
      return { ...t };
    },
    async create(input: { title: string; date: string }): Promise<FieldyTask> {
      const t: FieldyTask = { id: `t${nextId++}`, title: input.title, status: "new", date: input.date, completionDate: null };
      state.set(t.id, t);
      created.push(input);
      return { ...t };
    },
    async conversations(): Promise<ConversationSummary[]> {
      return recordings;
    },
  };

  return {
    port,
    state,
    updates,
    created,
    setRecordings(r: ConversationSummary[]) {
      recordings = r;
    },
    /** The nth update call (1-based, counted from now on) throws `err`. */
    failUpdateAt(n: number, err: Error) {
      failAt = { n: updateCalls + n, err };
    },
  };
}

/** Slack that records posts and updates. `onUpdate` runs inside each update, before it returns. */
export function fakeSlack(opts: { onUpdate?: () => Promise<void> } = {}) {
  const posts: Array<{ channel: string; text: string; blocks: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  let n = 0;
  const port = {
    async post(channel: string, text: string, blocks: unknown[]): Promise<string> {
      posts.push({ channel, text, blocks });
      n += 1;
      return `171.${n}`;
    },
    async update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void> {
      updates.push({ channel, ts, text, blocks });
      if (opts.onUpdate) await opts.onUpdate();
    },
  };
  return {
    port,
    posts,
    updates,
    /** The blocks Slack is showing now. */
    lastBlocks(): unknown[] {
      const all = [...posts, ...updates];
      return all.length ? all[all.length - 1].blocks : [];
    },
  };
}
