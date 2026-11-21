// The morning checklist's grouping, from the OpenAI Responses API with a
// strict JSON schema. Sends task titles, due dates and the last day's
// recording titles and summaries; nothing else. store:false so OpenAI keeps no
// stored response (it may still hold API data up to 30 days for abuse checks).
//
// Never throws: any failure returns null and the caller groups by date instead,
// so an OpenAI outage still gets Dave his list. Logs only an error code.
//
// Model: gpt-6-luna, checked 2026-11-21 at
// https://developers.openai.com/api/docs/models/compare (v1/responses, Structured Outputs).
// OPENAI_MODEL overrides it without a code change.
import type { ConversationSummary, FieldyTask } from "@/lib/fieldy/client";
import { dayKeyOf } from "@/lib/fieldy/report";
import type { ProposedGroup } from "./organize";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
const TIMEOUT_MS = 30_000;

export const GROUPING_INSTRUCTIONS = [
  "You organize the to-do list of Dave, who owns a plumbing company.",
  "Put every task id you are given in exactly one group. Never invent ids.",
  "Group tasks that belong together: the same job, customer or address, or the same kind of errand (calls to return, parts to order, paperwork).",
  'Use at most 10 groups, with short names like "Troy boiler job" or "Calls to return".',
  "'text' is the task's title, shortened to 70 characters or fewer if needed. Never add names, numbers or details that aren't in the title.",
  "The recordings only help you see which tasks go together. Don't make tasks out of them.",
].join(" ");

export const GROUPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "items"],
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["taskId", "text"],
              properties: { taskId: { type: "string" }, text: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

function skip(code: string): null {
  console.warn(`[tasks] AI grouping skipped: ${code}`);
  return null;
}

/** The model's text from a completed Responses API reply; null on a refusal or anything unexpected. */
export function outputText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { status?: unknown; output?: unknown };
  if (d.status !== "completed" || !Array.isArray(d.output)) return null;
  for (const item of d.output as Array<{ type?: unknown; content?: unknown }>) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type === "refusal") return null;
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return null;
}

function toGroups(value: unknown): ProposedGroup[] | null {
  if (!value || typeof value !== "object") return null;
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const out: ProposedGroup[] = [];
  for (const g of groups as Array<{ name?: unknown; items?: unknown }>) {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.items)) return null;
    const items: ProposedGroup["items"] = [];
    for (const i of g.items as Array<{ taskId?: unknown; text?: unknown }>) {
      if (!i || typeof i.taskId !== "string" || typeof i.text !== "string") return null;
      items.push({ taskId: i.taskId, text: i.text });
    }
    out.push({ name: g.name, items });
  }
  return out;
}

export async function groupWithOpenAI(
  open: FieldyTask[],
  recordings: ConversationSummary[],
  opts: { apiKey?: string | null; model?: string } = {}
): Promise<ProposedGroup[] | null> {
  const apiKey = opts.apiKey === undefined ? process.env.OPENAI_API_KEY || null : opts.apiKey;
  if (!apiKey) return skip("key_not_set");
  if (open.length === 0) return [];
  const model = opts.model ?? (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);

  const input = JSON.stringify({
    tasks: open.map((t) => ({ id: t.id, title: t.title, due: dayKeyOf(t.date) })),
    recordings: recordings.map((r) => ({ startTime: r.startTime, title: r.title, summary: r.summary })),
  });

  let res: Response;
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: GROUPING_INSTRUCTIONS,
        input,
        store: false,
        text: { format: { type: "json_schema", name: "checklist", strict: true, schema: GROUPING_SCHEMA } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return skip(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) return skip(`http_${res.status}`);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return skip("bad_response");
  }
  const text = outputText(data);
  if (text === null) return skip("no_output");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return skip("bad_json");
  }
  return toGroups(parsed) ?? skip("schema_mismatch");
}
