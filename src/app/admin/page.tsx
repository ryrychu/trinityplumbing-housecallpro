import { TriggerPanel } from "./TriggerPanel";

// Nothing here is cached: the whole point is to render the schedule as it
// stands the moment someone presses a button.
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-8 border-b border-surface-divider pb-5">
        <h1 className="text-2xl font-semibold text-ink-primary">Send a Slack message</h1>
        <p className="mt-2 text-sm text-ink-muted">
          The schedule digests send on their own between 6 a.m. and noon Eastern, every day. Use
          these to preview one, or to send it outside that window.
        </p>
      </header>
      <TriggerPanel />
    </main>
  );
}
