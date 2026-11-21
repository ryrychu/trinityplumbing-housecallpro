// The real Fieldy, Slack, Supabase and OpenAI behind the checklist service.
// Kept apart from checklist.ts so the service and its tests never import live wiring.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTask, fieldyApiKey, listConversations, listTasks, updateTask } from "@/lib/fieldy/client";
import { fieldyTaskSource } from "@/lib/fieldy/fieldy";
import { deleteMessage, postMessage, updateMessage } from "@/lib/slack/web";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { ChecklistDeps, FieldyPort } from "./checklist";
import { groupWithOpenAI } from "./openai";
import type { Organizer } from "./organize";
import { supabaseChecklistStore } from "./store";

export function liveFieldyPort(): FieldyPort {
  return {
    tasks: () => fieldyTaskSource().tasks(),
    completed: () => listTasks("completed"),
    update: updateTask,
    create: createTask,
    conversations: listConversations,
  };
}

/** The first setting the checklist is missing, or null when it has them all. Names only, never values. */
export function checklistConfigMissing(): string | null {
  if (!fieldyApiKey()) return "FIELDY_API_KEY is not set";
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "SLACK_BOT_TOKEN is not set";
  if (!token.startsWith("xoxb-")) return "SLACK_BOT_TOKEN is not a bot token (xoxb-…)";
  if (!process.env.SLACK_FIELDY_CHANNEL_ID) return "SLACK_FIELDY_CHANNEL_ID is not set";
  return null;
}

/** Reads the Slack settings when each call runs, so building deps never throws. */
export function liveChecklistDeps(supabase: SupabaseClient = getSupabaseServerClient(), now: () => Date = () => new Date()): ChecklistDeps {
  return {
    fieldy: liveFieldyPort(),
    store: supabaseChecklistStore(supabase),
    slack: {
      post: (channel, text, blocks) => postMessage(process.env.SLACK_BOT_TOKEN ?? "", channel, text, blocks),
      update: (channel, ts, text, blocks) => updateMessage(process.env.SLACK_BOT_TOKEN ?? "", channel, ts, text, blocks),
      delete: (channel, ts) => deleteMessage(process.env.SLACK_BOT_TOKEN ?? "", channel, ts),
    },
    channelId: process.env.SLACK_FIELDY_CHANNEL_ID ?? "",
    now,
  };
}

export function liveOrganizer(): Organizer {
  return (open, recordings) => groupWithOpenAI(open, recordings);
}
