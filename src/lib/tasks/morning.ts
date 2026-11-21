// The automatic morning checklist: once per Eastern day, at the first cron run
// between 7 and 11am. Same order as the other morning posts: read Fieldy and
// group BEFORE claiming, so a Fieldy outage throws before the claim and the
// next 15-minute run tries again. Once claimed, a failed Slack post is picked
// up by syncWithFieldy (the checklist is saved but unrendered).
import type { SupabaseClient } from "@supabase/supabase-js";
import { completedTasks, pendingTasks, uniqueById } from "@/lib/fieldy/report";
import { claim } from "@/lib/notifications/dedupe";
import { isFieldyDailyDue, localDateKey } from "@/lib/notifications/schedule";
import { buildChecklist, type ChecklistDeps } from "./checklist";
import { groupByRules, validateGrouping, type Grouping, type Organizer } from "./organize";
import type { BuiltBy } from "./store";

export type ChecklistPlan = { grouping: Grouping; builtBy: BuiltBy; finishedYesterday: number };

const RECORDINGS_HOURS = 24;

/** Reads Fieldy (throws if it can't) and groups the open tasks: AI first, rules if that returns null. */
export async function planChecklist(deps: Pick<ChecklistDeps, "fieldy" | "now">, organize: Organizer): Promise<ChecklistPlan> {
  const now = deps.now();
  const all = uniqueById(await deps.fieldy.tasks());
  const open = pendingTasks(all);
  const finishedYesterday = completedTasks(all, now).length;

  // Recordings only help the grouping; without them it still works.
  const since = new Date(now.getTime() - RECORDINGS_HOURS * 3_600_000).toISOString();
  const recordings = await deps.fieldy.conversations(since, now.toISOString()).catch((err: unknown) => {
    console.warn(`[tasks] recordings skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  const proposed = await organize(open, recordings);
  if (proposed) return { grouping: validateGrouping(proposed, open), builtBy: "morning_ai", finishedYesterday };
  return { grouping: validateGrouping(groupByRules(open, now), open), builtBy: "morning_rules", finishedYesterday };
}

export async function runChecklistMorningPass(supabase: SupabaseClient, deps: ChecklistDeps, organize: Organizer): Promise<boolean> {
  const now = deps.now();
  if (!isFieldyDailyDue(now)) return false;
  const day = localDateKey(now);
  // Dave may have built today's checklist in ChatGPT before 7.
  if (await deps.store.getByDay(day)) return false;

  const plan = await planChecklist(deps, organize);
  if (!(await claim(supabase, "fieldy_checklist", day))) return false;
  // Grouping takes a while: ChatGPT may have built it meanwhile. Keep Dave's.
  if (await deps.store.getByDay(day)) return false;

  await buildChecklist(deps, plan.grouping, plan.builtBy, plan.finishedYesterday);
  return true;
}
