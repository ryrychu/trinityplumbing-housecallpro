// Test doubles for the price book editor.
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { HcpWriteError, type HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import type { ChangeRow, NewChange, PreviewRow, PricebookEditStore } from "../types";

// 10:00 AM Eastern, Sat Nov 21 2026.
export const NOW = new Date("2026-11-21T15:00:00.000Z");
export const DAVE = "u-dave";
export const ELLA = "u-ella";

export function item(over: Partial<PricebookItem> & { uuid: string }): PricebookItem {
  return {
    kind: "material", name: "PEX tee", category: "PEX", categoryUuid: "c-pex", description: "1/2 inch PEX brass tee fitting",
    priceCents: 250, costCents: 90, unit: "each", partNumber: "PX-T12", updatedAt: null, taxable: true, ...over,
  };
}

export function memoryStore(now: () => Date = () => NOW) {
  const changes: ChangeRow[] = [];
  const previews = new Map<string, PreviewRow>();
  let nextId = 1;
  const store: PricebookEditStore = {
    async insertChanges(input: NewChange[]) {
      const out = input.map((c) => ({ ...c, id: nextId++, resolvedBy: null, slackChannelId: null, slackMessageTs: null, createdAt: now().toISOString(), resolvedAt: null }));
      changes.push(...out);
      return out.map((r) => ({ ...r }));
    },
    async getChange(id) { const r = changes.find((c) => c.id === id); return r ? { ...r } : null; },
    async listBatch(b) { return changes.filter((c) => c.batchId === b).map((c) => ({ ...c })); },
    async listRecent(since, limit) { return changes.filter((c) => c.createdAt >= since).slice().reverse().slice(0, limit).map((c) => ({ ...c })); },
    async listPendingServices() { return changes.filter((c) => c.kind === "service_request" && c.status === "pending").map((c) => ({ ...c })); },
    async setStatus(ids, status, opts = {}) {
      for (const c of changes) if (ids.includes(c.id)) {
        c.status = status; c.resolvedBy = opts.resolvedBy ?? null; c.resolvedAt = opts.resolvedAt ?? null;
        if (opts.errorCode !== undefined) c.errorCode = opts.errorCode;
      }
    },
    async updateAfter(id, after) { const c = changes.find((x) => x.id === id); if (c) c.after = after; },
    async setSlackMessage(b, ch, ts) { for (const c of changes) if (c.batchId === b) { c.slackChannelId = ch; c.slackMessageTs = ts; } },
    async createPreview(p) { previews.set(p.id, { ...p, appliedAt: null }); },
    async getPreview(id) { const p = previews.get(id); return p ? { ...p } : null; },
    async claimPreview(id, by, nowIso) {
      const p = previews.get(id);
      if (!p || p.appliedAt || p.createdBy !== by || p.expiresAt <= nowIso) return null;
      p.appliedAt = nowIso;
      return { ...p };
    },
  };
  return { store, changes, previews };
}

/** HCP with materials in memory; services are read-only like the real API. */
export function fakeWriter(initial: PricebookItem[]) {
  const items = new Map(initial.map((i) => [i.uuid, { ...i }]));
  const updates: Array<[string, HcpMaterialFields]> = [];
  const created: Array<[string, HcpMaterialFields]> = [];
  let failStatus: number | null = null;
  let failOnUuid: string | null = null;
  let n = 0;
  const writer = {
    async updateMaterial(uuid: string, f: HcpMaterialFields) {
      if (failStatus && (!failOnUuid || failOnUuid === uuid)) throw new HcpWriteError(failStatus, "/api/price_book/materials/{uuid}");
      const it = items.get(uuid);
      if (!it || it.kind !== "material") throw new HcpWriteError(404, "/api/price_book/materials/{uuid}");
      updates.push([uuid, f]);
      if (f.name !== undefined) it.name = f.name;
      if (f.description !== undefined) it.description = f.description;
      if (f.price !== undefined) it.priceCents = f.price;
      if (f.cost !== undefined) it.costCents = f.cost;
      if (f.unit_of_measure !== undefined) it.unit = f.unit_of_measure;
      if (f.part_number !== undefined) it.partNumber = f.part_number;
      if (f.taxable !== undefined) it.taxable = f.taxable;
    },
    async createMaterial(categoryUuid: string, f: HcpMaterialFields & { name: string; price: number }) {
      if (failStatus) throw new HcpWriteError(failStatus, "/api/price_book/materials");
      const uuid = `new-${++n}`;
      items.set(uuid, item({ uuid, name: f.name, priceCents: f.price, costCents: f.cost ?? null, description: f.description ?? "", categoryUuid, category: null }));
      created.push([categoryUuid, f]);
      return { uuid };
    },
    async getMaterial(uuid: string) {
      const it = items.get(uuid);
      return it && it.kind === "material" ? { ...it } : null;
    },
  };
  return {
    writer, items, updates, created,
    all: () => Array.from(items.values()).map((i) => ({ ...i })),
    /** Every write (or only writes to `uuid`) fails with this status; null clears it. */
    failWith(status: number | null, uuid: string | null = null) { failStatus = status; failOnUuid = uuid; },
  };
}

export function fakeSlack() {
  const posts: Array<{ channel: string; text: string; blocks: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const replies: Array<{ channel: string; threadTs: string; text: string }> = [];
  let n = 0;
  return {
    posts, updates, replies,
    port: {
      async post(channel: string, text: string, blocks: unknown[]) { posts.push({ channel, text, blocks }); return `900.${++n}`; },
      async update(channel: string, ts: string, text: string, blocks: unknown[]) { updates.push({ channel, ts, text, blocks }); },
      async reply(channel: string, threadTs: string, text: string) { replies.push({ channel, threadTs, text }); },
    },
    lastBlocks(): unknown[] { const all = [...posts, ...updates]; return all.length ? all[all.length - 1].blocks : []; },
  };
}

export function ids() { let n = 0; return () => `id-${++n}`; }
