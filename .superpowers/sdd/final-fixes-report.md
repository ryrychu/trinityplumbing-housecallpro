# Finish Phase 1 — Final Whole-Branch Review Fixes

Branch: `finish-phase-1`. Baseline 99/99, lint + build clean → after fixes **105/105, lint clean, build clean**.

## FIX 1 — Town-first zone even when coordinates are missing (BUG)
File: `src/lib/dashboard/queries.ts` (`todaySchedule` mapping).
- Imported `zoneForTown` from `@/lib/geo/townZones`.
- When coords are missing we now call `zoneForTown(town)`. A known town → `{ zone, compass: "", source: "town" }`; only an unrecognized town falls through to `{ zone: "Unknown", compass: "", source: "distance" }`. When coords exist, `classifyZone(lat, lng, town)` is still used.
- Test (queries.test.ts): new "resolves zone from a known town when coordinates are missing" — a today job with town "Albany" and null lat/lng asserts `zone === "Albany Zone"` (and miles/driveMinutes null).

## FIX 2 — Revenue excludes canceled jobs
File: `src/lib/dashboard/queries.ts`.
- Added `const CANCELED_JOB_STATUSES = new Set(["pro canceled", "user canceled"]);`.
- Both `revenueBookedThisWeekCents` and `revenueScheduledNextWeekCents` reducers now filter out jobs whose lowercased `work_status` is in that set, in addition to the window filter.
- Test: added `j7` (`user canceled`, inside this week, 88000¢) to `defaultJobs()`; new test "excludes canceled jobs from booked revenue even when in-window" asserts `revenueBookedThisWeekCents` stays 35000 (would be 123000 on regression).

## FIX 3 — Distance + drive-time in Today's Schedule
Files: `src/lib/dashboard/queries.ts`, `src/app/dashboard/components/TodaySchedulePanel.tsx`.
- `TodayScheduleRow` gained `miles: number | null` and `driveMinutes: number | null`. When coords exist they are computed via `distanceFromAverillPark(lat, lng)`; when missing, both null.
- Panel gained "Miles" (`j.miles ?? "—"`) and "Drive" (`j.driveMinutes != null ? \`${j.driveMinutes} min\` : "—"`) columns.
- Test: existing "builds today's schedule" test extended to assert `entry.miles`/`entry.driveMinutes` are numbers for j1 (has coords).

## FIX 4 — Eastern-time day/week windows (DST-safe)
Files: `src/lib/dashboard/week.ts` (replaced verbatim with America/New_York impl), `src/lib/dashboard/__tests__/week.test.ts`.
- Updated expected ISO instants to ET local midnight (July 2026 EDT = 04:00 UTC): weekRange this = `2026-07-20T04:00Z..2026-07-27T04:00Z`, next = `2026-07-27T04:00Z..2026-08-03T04:00Z`; dayRange(07-22) = `2026-07-22T04:00Z..2026-07-23T04:00Z`; Sunday 07-26 still maps to the same week.
- Added DST-awareness test: `dayRange(2026-01-15T14:00Z)` → `2026-01-15T05:00Z..2026-01-16T05:00Z` (EST, UTC−5).
- Verified queries.test.ts fixtures still land in intended windows after the 4h shift (j1 today, j2 this-week, j5 next-week, j3/j4 prior week excluded, pagination job 07-22T00:00Z still in this-week). No queries fixture timestamps needed changing.

## FIX 5 — Attachments backfill via the cron incremental pass
Files: `src/lib/sync/attachments.ts`, `src/lib/sync/incremental.ts`, tests.
- `syncAttachments` gained optional 5th param `opts: { rehost?: boolean } = { rehost: true }`. When `rehost === false`, the `rehost()` loop is skipped entirely (storage_path stays null) and only metadata is upserted. Webhook default behavior unchanged.
- Added `created_at: string | null` to `AttachmentRow`, `RawAttachment`, and the row object (`att.created_at ?? null`).
- `incremental.ts`: after the successful parent `upsert(rows)`, for `customers`/`jobs` it calls `syncAttachments(supabase, parentType, rows[i].id, fresh[i], { rehost: false })` per fresh item, each wrapped in try/catch that console.error-logs and continues (never fails the incremental sync).
- Tests: attachments.test.ts "with rehost:false, upserts metadata without calling fetch or storage" (RED→GREEN evidence below); incremental.test.ts "backfills attachment metadata (rehost:false) for fresh jobs without fetching".

## FIX 6 — Minor correctness in the delete path
File: `src/lib/sync/syncService.ts`, test.
- Attachments cascade-delete now captures `{ error: attErr }` and console.error-logs on failure (no throw — cleanup).
- The two webhook-path `syncAttachments(...)` calls are wrapped in try/catch that console.error-logs and swallows (rehost stays default true).
- Test: new "deletes a job and cascades the attachments delete with parent_type 'job'" asserts the jobs primary delete AND the attachments cascade delete scoped to `parent_type: "job"` + `parent_id`.

## TDD evidence (RED/GREEN)
- FIX 5 attachments: RED — `expect(fetchSpy).not.toHaveBeenCalled()` failed ("Number of calls: 1") before adding the `rehost` param. GREEN after implementing the metadata-only branch (5/5).
- FIX 4/1/2/3 queries + week: expected assertions updated first, then source, ending 9/9 (queries) and 5/5 (week).
- FIX 6 syncService: cascade/swallow test added, 13/13.
- FIX 5 incremental: backfill test added, 5/5.

## Final results
- Full suite: **105 passed (17 files)** — was 99.
- Lint (`npm run lint`): **No ESLint warnings or errors**.
- Build (`npm run build`): clean.
