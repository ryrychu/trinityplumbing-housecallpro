import { PhoneIcon, CompassIcon } from "@/components/ui/icons";

/**
 * Call and Directions — the two things anyone actually does from a phone in a
 * truck, so they sit above the record rather than under it.
 *
 * Both stay plain `tel:` / `maps:` anchors. That is not laziness: they make no
 * API call and so they keep working from the service worker's cache with no
 * signal, which is the state a technician is most often in when they need them.
 *
 * A missing number or address renders as a disabled-looking span rather than a
 * live link, because an anchor with no href is still focusable and still looks
 * tappable, and tapping it does nothing at all.
 */
export function ActionPair({
  phone,
  address,
}: {
  phone: string | null;
  address: string | null;
}) {
  const base =
    "flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl text-sm font-semibold";

  return (
    <div className="mb-5 flex gap-2">
      {phone ? (
        <a href={`tel:${phone}`} className={`${base} bg-brand text-ink-inverse`}>
          <PhoneIcon />
          Call
        </a>
      ) : (
        <span className={`${base} bg-surface-elevated text-ink-faint`}>
          <PhoneIcon />
          No number
        </span>
      )}

      {address ? (
        <a
          href={`maps:?q=${encodeURIComponent(address)}`}
          className={`${base} border border-surface-border text-ink-primary`}
        >
          <CompassIcon />
          Directions
        </a>
      ) : (
        <span className={`${base} border border-surface-divider text-ink-faint`}>
          <CompassIcon />
          No address
        </span>
      )}
    </div>
  );
}
