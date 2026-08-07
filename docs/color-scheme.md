# Trinity.plumbing — Color Scheme (Residential Site)

Reference color tokens from the residential site **trinity.plumbing**.
Source of truth: `D:\Web Development\TrinityPlumbing\trinity-plumbing-service\tailwind.config.js`.

**Theme:** dark, with a gold/yellow accent, warm off-white text, and Inter typography.

---

## Brand accents

| Token | Hex | Swatch | Use |
|---|---|---|---|
| `brand.yellow` | `#f2c400` | 🟡 | Primary gold — CTAs, accents, links |
| `brand.yellow-soft` | `#3d3200` | 🟫 | Dark gold tint — badge / icon backgrounds |
| `brand.orange` | `#ffb347` | 🟠 | Secondary accent |
| `brand.orange-soft` | `#4a3014` | 🟫 | Orange tint background |
| `brand.green` | `#8fd46d` | 🟢 | Success / checkmarks |
| `brand.green-soft` | `#20351a` | 🟩 | Green tint background |
| `brand.red` | `#ff6b6b` | 🔴 | Alerts / emergency |
| `brand.red-soft` | `#3a1414` | 🟥 | Red tint background |

## Surfaces (dark)

| Token | Hex | Use |
|---|---|---|
| `surface.page` | `#121212` | Page background (near-black) |
| `surface.card` | `#1b1b1b` | Cards |
| `surface.raised` | `#222222` | Raised elements |
| `surface.elevated` | `#2a2a2a` | Elevated / hover |
| `surface.divider` | `#2d2d2d` | Dividers |
| `surface.border` | `#343434` | Borders |

## Text

| Token | Hex | Use |
|---|---|---|
| `text.primary` | `#f6f3e9` | Warm off-white — headings & body |
| `text.muted` | `#b7b09b` | Warm gray — secondary text |
| `text.inverse` | `#111111` | Dark text on gold buttons |

## Typography

- **Font:** Inter (weights 400–800), used for both `sans` and `heading`.
- Fallback stack: `Inter, system-ui, -apple-system, sans-serif`.

---

## Raw Tailwind tokens (copy/paste)

```js
colors: {
  surface: {
    page: '#121212',
    card: '#1b1b1b',
    raised: '#222222',
    elevated: '#2a2a2a',
    divider: '#2d2d2d',
    border: '#343434',
  },
  text: {
    primary: '#f6f3e9',
    muted: '#b7b09b',
    inverse: '#111111',
  },
  brand: {
    yellow: '#f2c400',
    'yellow-soft': '#3d3200',
    orange: '#ffb347',
    'orange-soft': '#4a3014',
    green: '#8fd46d',
    'green-soft': '#20351a',
    red: '#ff6b6b',
    'red-soft': '#3a1414',
  },
},
fontFamily: {
  sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
  heading: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
},
```

---

## What this app adds on top (internal ops only)

The operations dashboard and the installable app share the palette above
unchanged — same surfaces, same gold, same warm off-white. They add one thing
the marketing sites do not have, and it does **not** apply to trinity.plumbing
or trinityplumbingny:

- **A display face: Barlow Condensed** (`font-display`, weights 500–700), used
  only for section headers, screen titles, the wordmark, and the compass
  letters on the dispatch dial. Barlow's drawing comes out of American highway
  and rolling-stock signage, which is the vernacular an app about driving out
  of Averill Park lives in; condensed is also what lets a section header set at
  22px stay on one line on a 360px phone.
- **Inter stays the body and UI face**, and stays the face for every headline
  figure. A display face on a hero number reads as decoration, and the number
  is data.
- **Geist Mono (`font-mono`) is for figures that align vertically only** — the
  run sheet's time rail, the dial's ring ticks, table columns. Not for
  standalone headline numbers: equal-width digits open a visible gap under a
  lone `121` at display sizes.

Two colour rules the ops surfaces hold to, both narrower than the palette
itself allows:

- **Zones are identities, not states, so they are not colour-coded.** An
  earlier version painted the six dispatch zones in six hues, which spent the
  whole status palette on a label that already says what it is in words. The
  one exception is `Outside Service Area`, which genuinely is a state and keeps
  the danger token.
- **The dispatch dial is an emphasis chart, not a categorical one.** Every job
  is the same recessive `ink-muted` mark; gold marks the farthest job of the
  day and a hollow danger ring marks out-of-area work. The ring is a *shape*
  difference on purpose — danger and the mark grey sit at CVD ΔE 6.4, inside
  the band that is only legal with a second, non-colour channel carrying the
  same meaning.

## Relationship to Trinity Plumbing NY (commercial)

As of the commercial redesign, **both sites share this dark + gold identity.** The commercial
site (`trinityplumbingny`) reuses the same near-black surfaces and warm off-white text, with
gold `#f2c400` as the single brand accent (CTAs, links, icon chips). Implementation note: the
commercial Tailwind config keeps its existing **token names** (`surface.*`, `text.*`,
`brand.navy/accent/amber/...`) but maps their **values** onto this palette — so `brand.navy`
is repurposed as the deep-ink band background (`#0d0f14`) used by heroes, the CTA band, and the
footer, while `brand.accent` and `brand.amber` both resolve to the gold `#f2c400`. The shared
threads across both sites are the **Inter font** and the **gold accent** `#f2c400`.