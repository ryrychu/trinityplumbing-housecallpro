// A tap on a checklist checkbox in Slack. Slack sends the message as Dave saw
// it and which boxes in the tapped element are ticked now; the difference from
// the database is what to tick and untick. Both go through the same service as
// ChatGPT's mark_done / mark_not_done, so Fieldy is updated first.
//
// After every tap the message is re-rendered from the database: that is what
// "snaps back" a tap that wasn't allowed or that Fieldy refused.
import { FieldyApiError } from "@/lib/fieldy/client";
import { describeFieldyError } from "@/lib/fieldy/fieldy";
import { markDone, markNotDone, renderChecklist, type ChecklistDeps } from "./checklist";
import { parseActionId } from "./render";

export type BlockActionsPayload = {
  type?: string;
  user?: { id?: string };
  response_url?: string;
  message?: { blocks?: unknown[] };
  actions?: Array<{ action_id?: string; selected_options?: Array<{ value?: string }> }>;
};

export const NOT_ALLOWED_TEXT = "Only Dave can check these off.";
export const TAP_FAILED_TEXT = "Couldn't update the checklist just now. Try again in a minute.";

export function allowedSlackUsers(): string[] {
  return (process.env.SLACK_FIELDY_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The option values of the checkboxes element with this action_id in the tapped message, or null. */
export function optionValuesFor(blocks: unknown[] | undefined, actionId: string): string[] | null {
  for (const b of blocks ?? []) {
    const block = b as { type?: string; elements?: unknown[] };
    if (block.type !== "actions") continue;
    for (const e of block.elements ?? []) {
      const el = e as { action_id?: string; options?: Array<{ value?: unknown }> };
      if (el.action_id === actionId) {
        return (el.options ?? []).map((o) => o.value).filter((v): v is string => typeof v === "string");
      }
    }
  }
  return null;
}

export async function handleChecklistTap(
  payload: BlockActionsPayload,
  deps: ChecklistDeps,
  opts: { allowedUsers: string[]; note: (responseUrl: string, text: string) => Promise<unknown> }
): Promise<void> {
  const userId = payload.user?.id ?? "";
  const say = async (text: string) => {
    if (payload.response_url) await opts.note(payload.response_url, text);
  };

  for (const action of payload.actions ?? []) {
    const id = action.action_id ?? "";
    const parsed = parseActionId(id);
    if (!parsed) continue;
    const cl = await deps.store.getById(parsed.checklistId);
    if (!cl) continue;

    if (!opts.allowedUsers.includes(userId)) {
      await renderChecklist(deps, cl.id);
      await say(NOT_ALLOWED_TEXT);
      continue;
    }

    const values = optionValuesFor(payload.message?.blocks, id) ?? [];
    const selected = new Set((action.selected_options ?? []).map((o) => o.value));
    const byId = new Map((await deps.store.listItems(cl.id)).map((i) => [i.fieldyTaskId, i]));
    const tick: string[] = [];
    const untick: string[] = [];
    for (const v of values) {
      const item = byId.get(v);
      if (!item) continue;
      const isDone = item.doneAt !== null;
      if (selected.has(v) && !isDone) tick.push(v);
      if (!selected.has(v) && isDone) untick.push(v);
    }

    try {
      if (tick.length > 0) await markDone(deps, cl.id, tick, "slack");
      if (untick.length > 0) await markNotDone(deps, cl.id, untick, "slack");
      if (tick.length === 0 && untick.length === 0) await renderChecklist(deps, cl.id);
    } catch (err) {
      await renderChecklist(deps, cl.id).catch(() => undefined);
      if (err instanceof FieldyApiError) {
        await say(describeFieldyError(err));
      } else {
        console.error(`[tasks] checklist tap failed: ${err instanceof Error ? err.message : String(err)}`);
        await say(TAP_FAILED_TEXT);
      }
    }
  }
}
