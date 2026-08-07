import Image from "next/image";
import type { DashboardSnapshot } from "@/lib/dashboard/queries";
import { DispatchDial } from "@/components/chart/DispatchDial";
import { RunSheet } from "@/components/schedule/RunSheet";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Panel } from "@/components/ui/Panel";
import { Figure } from "@/components/ui/Figure";
import { TechnicianWorkloadPanel } from "./components/TechnicianWorkloadPanel";

// Whole dollars. Cents on a week's booked revenue are four characters of noise
// on a figure nobody reconciles from this screen, and dropping them is what
// lets the number stay one line at 44px on a 360px phone. The Money tab
// already rounded the same way; now the two agree.
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/**
 * Everything the dashboard draws, given a snapshot. Split from the page so the
 * page is only the data fetch and this is only the layout — which is what lets
 * it be rendered against fixtures without a Supabase round-trip.
 */
export function DashboardView({
  snapshot,
  asOfDate,
  asOfTime,
}: {
  snapshot: DashboardSnapshot;
  asOfDate: string;
  asOfTime: string;
}) {
  const jobs = snapshot.todaySchedule;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-12 pt-5 sm:px-6 lg:px-8">
      <header className="mb-7 flex items-center gap-3 border-b border-surface-divider pb-5">
        {/* Decorative: the <h1> beside it already names the company, so an alt
            here would make a screen reader announce it twice. The asset is a
            raster PNG inside an SVG wrapper, hence `unoptimized` — Next's image
            optimizer rejects SVG without dangerouslyAllowSVG. */}
        <Image
          src="/trinity-logo.svg"
          alt=""
          width={44}
          height={44}
          unoptimized
          priority
          className="h-10 w-10 shrink-0 sm:h-11 sm:w-11"
        />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold uppercase leading-none tracking-wide text-ink-primary sm:text-3xl">
            Trinity <span className="text-ink-faint">Operations</span>
          </h1>
          <p className="mt-1.5 text-xs text-ink-muted">
            {asOfDate}
            {" · as of "}
            {asOfTime}
          </p>
        </div>
      </header>

      {/* The day leads, and it leads with where the work is. Everything that
          follows is context for a question already asked. */}
      <section className="mb-9">
        {/* No count in the rule: the "Jobs today" figure inside this band is
            the count, and the dial reports separately how many of them it could
            place. Three numbers for one fact is two too many. */}
        <SectionHeader>The day</SectionHeader>

        <div className="grid gap-4 lg:grid-cols-5">
          {/* self-start, or the grid stretches this panel to the run sheet's
              height and the dial floats in a column of empty card. */}
          <Panel className="min-w-0 px-3 py-4 lg:col-span-2 lg:self-start">
            {jobs.length > 0 ? (
              <DispatchDial jobs={jobs} />
            ) : (
              <p className="px-4 py-10 text-center text-sm text-ink-faint">
                No jobs scheduled today.
              </p>
            )}
          </Panel>

          {/* min-w-0, for the same reason the run sheet's customer name needs
              it: a grid item's automatic minimum size is its content, so one
              long service-and-technician line stretches this column past its
              track and squeezes the dial. body{overflow-x:hidden} then hides
              the evidence, so it reads as "the panel is cut off" rather than
              as an overflow. */}
          <div className="min-w-0 lg:col-span-3">
            <Panel className="mb-4">
              <div className="grid grid-cols-3 divide-x divide-surface-divider">
                <div className="px-4 py-3.5">
                  <Figure value={jobs.length} label="Jobs today" />
                </div>
                <div className="px-4 py-3.5">
                  <Figure value={snapshot.jobsInProgress} label="Running now" />
                </div>
                <div className="px-4 py-3.5">
                  {/* Today-scoped, not the all-time emergencyCalls field — under
                      a header reading "The day" the lifetime count would be a
                      different number wearing the same label. */}
                  <Figure
                    value={snapshot.emergencyCallsToday}
                    label="Emergency"
                    tone={snapshot.emergencyCallsToday > 0 ? "danger" : "default"}
                  />
                </div>
              </div>
            </Panel>

            {/* No job detail screen exists outside the installable app, so these
                rows are static here rather than links that dead-end at a login. */}
            <RunSheet jobs={jobs} linkJobs={false} />
          </div>
        </div>
      </section>

      <section className="mb-9">
        <SectionHeader>Pipeline</SectionHeader>
        <Panel>
          <div className="grid grid-cols-3 divide-x divide-surface-divider">
            <div className="px-4 py-3.5">
              <Figure value={snapshot.openEstimates} label="Open estimates" />
            </div>
            <div className="px-4 py-3.5">
              <Figure value={snapshot.upcomingEstimates} label="Upcoming" />
            </div>
            <div className="px-4 py-3.5">
              <Figure
                value={snapshot.pendingInvoices}
                label="Unpaid invoices"
                tone={snapshot.pendingInvoices > 0 ? "warn" : "default"}
              />
            </div>
          </div>
        </Panel>
      </section>

      <div className="grid gap-9 lg:grid-cols-2">
        <section className="min-w-0">
          <SectionHeader>Revenue</SectionHeader>
          <Panel>
            <div className="grid grid-cols-2 divide-x divide-surface-divider">
              <div className="px-4 py-3.5">
                <Figure
                  value={money(snapshot.revenueBookedThisWeekCents)}
                  label="Booked"
                  caption="This week"
                  tone="success"
                />
              </div>
              <div className="px-4 py-3.5">
                <Figure
                  value={money(snapshot.revenueScheduledNextWeekCents)}
                  label="Scheduled"
                  caption="Next week"
                  tone="success"
                />
              </div>
            </div>
          </Panel>
        </section>

        <section className="min-w-0">
          <SectionHeader>Crew</SectionHeader>
          <TechnicianWorkloadPanel rows={snapshot.technicianWorkload} />
        </section>
      </div>

      <section className="mt-9">
        <SectionHeader>Tagged work</SectionHeader>
        <Panel>
          <div className="grid grid-cols-2 divide-x divide-surface-divider">
            <div className="px-4 py-3.5">
              <Figure value={snapshot.emergencyCalls} label="Emergency" size="compact" />
            </div>
            <div className="px-4 py-3.5">
              <Figure value={snapshot.commercialJobs} label="Commercial" size="compact" />
            </div>
          </div>
          {/* These two count tags, and Trinity only started tagging on
              2026-08-01 (docs/PHASE-1.x-BACKLOG.md). Roughly 3,000 earlier jobs
              carry no tag and never will. Sitting unlabelled beside today's
              live counts they read as all-time totals, which is the one thing
              they are not — hence their own band, at half the size, saying so. */}
          <p className="border-t border-surface-divider px-4 py-2.5 text-xs text-ink-faint">
            Counts tagged jobs only, from August 2026 forward. Around 3,000 earlier jobs are
            unclassified.
          </p>
        </Panel>
      </section>
    </main>
  );
}
