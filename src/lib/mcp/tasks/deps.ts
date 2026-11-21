// Live wiring and kill switch for the Trinity Tasks connector.
import { checklistConfigMissing, liveChecklistDeps } from "@/lib/tasks/deps";
import type { TasksDeps } from "./server";

export function liveTasksDeps(): TasksDeps {
  return {
    checklist: liveChecklistDeps(),
    ownerUserId: process.env.MCP_TASKS_OWNER_USER_ID || null,
    configMissing: checklistConfigMissing,
  };
}

// Off unless exactly "true", like the other connectors.
export function mcpTasksEnabled(): boolean {
  return process.env.MCP_TASKS_ENABLED === "true";
}
