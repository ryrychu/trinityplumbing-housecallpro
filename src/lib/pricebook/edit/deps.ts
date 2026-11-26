// Live wiring for the Trinity Price Book Editor, its switches and settings.
import { randomUUID } from "node:crypto";
import { HousecallPricebookClient } from "@/lib/housecall/pricebook";
import { HousecallPricebookWriter } from "@/lib/housecall/pricebookWrite";
import { createPricebookLoader, type PricebookItem } from "@/lib/mcp/pricebook";
import { postMessage, postThreadReply, updateMessage } from "@/lib/slack/web";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { EditDeps } from "./apply";
import type { ServiceDeps } from "./serviceChecklist";
import { supabasePricebookEditStore } from "./store";

export const NOT_EDITOR_TEXT = "The price book editor is only available to Dave and Ella.";

export function pricebookEditEnabled(): boolean {
  return process.env.MCP_PRICEBOOK_EDIT_ENABLED === "true";
}

export function parseEditors(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(":");
    const id = (i === -1 ? p : p.slice(0, i)).trim();
    const name = (i === -1 ? "" : p.slice(i + 1)).trim();
    if (id) out.set(id, name || id);
  }
  return out;
}

export function pricebookSlackUsers(): string[] {
  return (process.env.SLACK_PRICEBOOK_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function serviceConfigMissing(): string | null {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "SLACK_BOT_TOKEN is not set";
  if (!token.startsWith("xoxb-")) return "SLACK_BOT_TOKEN is not a bot token (xoxb-…)";
  if (!process.env.SLACK_PRICEBOOK_CHANNEL_ID) return "SLACK_PRICEBOOK_CHANNEL_ID is not set";
  return null;
}

// Fresh every time (ttl 0): edits must see HCP as it is now.
function freshItems(): () => Promise<PricebookItem[]> {
  const load = createPricebookLoader(new HousecallPricebookClient(), { ttlMs: 0, includeCategoryUuid: true });
  return async () => (await load()).items;
}

export function liveEditDeps(): EditDeps {
  return {
    store: supabasePricebookEditStore(getSupabaseServerClient()),
    writer: new HousecallPricebookWriter(),
    loadItems: freshItems(),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
}

export function liveServiceDeps(editors: Map<string, string> = parseEditors(process.env.MCP_PRICEBOOK_EDITORS)): ServiceDeps {
  const token = () => process.env.SLACK_BOT_TOKEN ?? "";
  return {
    store: supabasePricebookEditStore(getSupabaseServerClient()),
    slack: {
      post: (channel, text, blocks) => postMessage(token(), channel, text, blocks),
      update: (channel, ts, text, blocks) => updateMessage(token(), channel, ts, text, blocks),
      reply: (channel, threadTs, text) => postThreadReply(token(), channel, threadTs, text),
    },
    channelId: process.env.SLACK_PRICEBOOK_CHANNEL_ID ?? "",
    loadItems: freshItems(),
    now: () => new Date(),
    newId: () => randomUUID(),
    nameOf: (id) => editors.get(id) ?? id,
  };
}

export async function listAllCategories(): Promise<Array<{ uuid: string; name: string; parentUuid: string | null }>> {
  const client = new HousecallPricebookClient();
  const out: Array<{ uuid: string; name: string; parentUuid: string | null }> = [];
  let level: Array<string | undefined> = [undefined];
  while (level.length > 0 && out.length < 300) {
    const next: string[] = [];
    for (const parent of level) {
      const res = await client.listMaterialCategories(parent);
      for (const c of res.items) {
        out.push({ uuid: c.uuid, name: c.name ?? "", parentUuid: parent ?? null });
        next.push(c.uuid);
      }
    }
    level = next;
  }
  return out;
}
