// The Fieldy checklist's part of /api/cron/sync: the morning post and the
// sync with Fieldy. Gated by SLACK_FIELDY_ENABLED and the settings it needs.
// Each pass is caught separately and logged by message only (FieldyApiError
// and SlackApiError messages carry codes, never task text).
import type { SupabaseClient } from "@supabase/supabase-js";
import { fieldyEnabled } from "@/lib/fieldy/fieldy";
import { syncWithFieldy } from "./checklist";
import { checklistConfigMissing, liveChecklistDeps, liveOrganizer } from "./deps";
import { runChecklistMorningPass } from "./morning";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runFieldyChecklistPasses(supabase: SupabaseClient, now: Date): Promise<void> {
  if (!fieldyEnabled()) return;
  const missing = checklistConfigMissing();
  if (missing) {
    console.warn(`[fieldy] checklist skipped: ${missing}`);
    return;
  }
  const deps = liveChecklistDeps(supabase, () => now);
  try {
    await runChecklistMorningPass(supabase, deps, liveOrganizer());
  } catch (err) {
    console.error("[cron] fieldy checklist morning pass failed:", message(err));
  }
  try {
    await syncWithFieldy(deps);
  } catch (err) {
    console.error("[cron] fieldy checklist sync failed:", message(err));
  }
}
