import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FieldyApiError } from "@/lib/fieldy/client";

const { claimMock } = vi.hoisted(() => ({ claimMock: vi.fn() }));
vi.mock("@/lib/notifications/dedupe", () => ({ claim: claimMock }));

import { planChecklist, runChecklistMorningPass } from "../morning";
import type { Organizer } from "../organize";
import { makeDeps, task } from "./fakes";

const SUPABASE = {} as SupabaseClient;
const AT_8AM = new Date("2026-11-23T13:00:00.000Z");
const AT_659AM = new Date("2026-11-23T11:59:00.000Z");
const TASKS = [
  task("t1", "Order the Navien"),
  task("t2", "Call Mrs. Smith"),
  task("y1", "Done yesterday", { status: "completed", completionDate: "2026-11-22T18:00:00.000Z" }),
];
const aiOrganizer: Organizer = async (open) => [{ name: "Today", items: open.map((t) => ({ taskId: t.id, text: t.title })) }];
const deadOrganizer: Organizer = async () => null;

beforeEach(() => {
  claimMock.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("planChecklist", () => {
  it("groups the open tasks and counts yesterday's finished ones", async () => {
    const { deps } = makeDeps({ tasks: TASKS, now: AT_8AM });
    const plan = await planChecklist(deps, aiOrganizer);
    expect(plan.builtBy).toBe("morning_ai");
    expect(plan.finishedYesterday).toBe(1);
    expect(plan.grouping.groups[0].items.map((i) => i.taskId)).toEqual(["t2", "t1"]);
  });

  it("falls back to rules when the organizer returns null", async () => {
    const { deps } = makeDeps({ tasks: TASKS, now: AT_8AM });
    const plan = await planChecklist(deps, deadOrganizer);
    expect(plan.builtBy).toBe("morning_rules");
    expect(plan.grouping.groups.map((g) => g.name)).toEqual(["No date"]);
  });

  it("still plans when recordings can't be read", async () => {
    const { deps } = makeDeps({ tasks: TASKS, now: AT_8AM });
    deps.fieldy.conversations = async () => {
      throw new FieldyApiError("http_500", "GET /conversations");
    };
    await expect(planChecklist(deps, aiOrganizer)).resolves.toMatchObject({ builtBy: "morning_ai" });
  });

  it("passes the last 24 hours of recordings to the organizer", async () => {
    const { deps, fieldy } = makeDeps({ tasks: TASKS, now: AT_8AM });
    const rec = [{ id: "c1", title: "Troy", summary: "s", startTime: "2026-11-23T12:00:00.000Z" }];
    fieldy.setRecordings(rec);
    const seen: unknown[] = [];
    await planChecklist(deps, async (_open, recordings) => {
      seen.push(recordings);
      return [];
    });
    expect(seen).toEqual([rec]);
  });
});

describe("runChecklistMorningPass", () => {
  it("posts once in the window and claims the day", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_8AM });
    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(true);
    expect(claimMock).toHaveBeenCalledWith(SUPABASE, "fieldy_checklist", "2026-11-23");
    expect(slack.posts).toHaveLength(1);

    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(false);
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(slack.posts).toHaveLength(1);
  });

  it("does nothing before 7am", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_659AM });
    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(false);
    expect(slack.posts).toHaveLength(0);
  });

  it("posts with the rules note when AI grouping fails", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_8AM });
    await runChecklistMorningPass(SUPABASE, deps, deadOrganizer);
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Grouped by date; AI grouping didn't run");
  });

  it("throws before claiming when Fieldy is down, so the next run retries", async () => {
    const { deps } = makeDeps({ now: AT_8AM });
    deps.fieldy.tasks = async () => {
      throw new FieldyApiError("http_503");
    };
    await expect(runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).rejects.toMatchObject({ code: "http_503" });
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("doesn't post when another run already claimed the day", async () => {
    claimMock.mockResolvedValueOnce(false);
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_8AM });
    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(false);
    expect(slack.posts).toHaveLength(0);
  });
});
