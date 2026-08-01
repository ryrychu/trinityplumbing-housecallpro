import { NearbySearch } from "./NearbySearch";

export const dynamic = "force-dynamic";

export default function DispatchPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-8 border-b border-surface-divider pb-5">
        <h1 className="text-2xl font-semibold text-ink-primary">Are we already going near there?</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Before you pick a day, check where Trinity is already booked. Days with work nearby come
          first, closest first — so a new job can join a trip instead of becoming one.
        </p>
      </header>
      <NearbySearch />
    </main>
  );
}
