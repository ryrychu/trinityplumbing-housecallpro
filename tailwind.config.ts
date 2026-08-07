import type { Config } from "tailwindcss";

// Trinity's brand identity is a DARK theme with a single gold accent, shared by
// both trinity.plumbing (residential) and trinityplumbingny (commercial).
// Source of truth: docs/color-scheme.md.
//
// Shade naming note: on a dark surface the usual Tailwind 50->900 ramp reads
// backwards (the "light" end is the background, not the foreground). So each
// semantic color exposes two deliberate slots instead of a numeric ramp:
//   <name>        the bright foreground (text, icons, bars)
//   <name>-tint   the dark, desaturated background (badge/chip fills)
// e.g. `bg-brand-tint text-brand` = gold text on a dark gold chip.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          page: "#121212",
          card: "#1b1b1b",
          raised: "#222222",
          elevated: "#2a2a2a",
          divider: "#2d2d2d",
          border: "#343434",
        },
        ink: {
          primary: "#f6f3e9", // warm off-white — headings & values
          muted: "#b7b09b", // warm gray — labels & secondary text
          faint: "#8f887a", // captions & empty states (~4.9:1 on surface-card)
          inverse: "#111111", // dark text on gold fills
        },
        brand: { DEFAULT: "#f2c400", tint: "#3d3200", bright: "#ffd633" },
        danger: { DEFAULT: "#ff6b6b", tint: "#3a1414" },
        warn: { DEFAULT: "#ffb347", tint: "#4a3014" },
        success: { DEFAULT: "#8fd46d", tint: "#20351a" },
        info: { DEFAULT: "#7cc4ff", tint: "#12304a" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
        // Section headers and the wordmark only — never a headline figure.
        display: ["var(--font-display)", "Barlow Condensed", "Inter", "sans-serif"],
        // Figures that align vertically (time rail, ring ticks, table columns).
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      keyframes: {
        // The dial plots the day in clock order, so its marks arrive in clock
        // order too — the animation says something true rather than decorating.
        "dial-mark-in": {
          from: { opacity: "0", transform: "scale(0.4)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "dial-mark-in": "dial-mark-in 380ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
