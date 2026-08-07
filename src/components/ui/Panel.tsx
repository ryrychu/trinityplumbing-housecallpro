// The one container in the app. A hairline border and a card surface, and
// nothing else — the previous version carried a black drop shadow, which on a
// #121212 page is invisible work. Depth here comes from the surface step
// (page -> card), the way the palette was designed to give it.
export function Panel({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={`rounded-xl border border-surface-divider bg-surface-card ${className}`}>
      {children}
    </Tag>
  );
}
