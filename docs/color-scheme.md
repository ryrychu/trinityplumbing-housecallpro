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

## Relationship to Trinity Plumbing NY (commercial)

As of the commercial redesign, **both sites share this dark + gold identity.** The commercial
site (`trinityplumbingny`) reuses the same near-black surfaces and warm off-white text, with
gold `#f2c400` as the single brand accent (CTAs, links, icon chips). Implementation note: the
commercial Tailwind config keeps its existing **token names** (`surface.*`, `text.*`,
`brand.navy/accent/amber/...`) but maps their **values** onto this palette — so `brand.navy`
is repurposed as the deep-ink band background (`#0d0f14`) used by heroes, the CTA band, and the
footer, while `brand.accent` and `brand.amber` both resolve to the gold `#f2c400`. The shared
threads across both sites are the **Inter font** and the **gold accent** `#f2c400`.