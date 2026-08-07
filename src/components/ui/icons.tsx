// The app's icons, drawn on one grid at one stroke weight and inheriting
// currentColor. Emoji were doing this job and could not take the brand colour,
// rendered differently on every OS, and faked their inactive state with a
// grayscale filter.

function Glyph({ children, className = "h-5 w-5" }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export function PhoneIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" />
    </Glyph>
  );
}

export function CompassIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M15.5 8.5l-2 5-5 2 2-5 5-2Z" />
    </Glyph>
  );
}

export function ChevronRightIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M9.5 5l7 7-7 7" />
    </Glyph>
  );
}
