import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = () =>
  JSON.parse(readFileSync(path.join(root, "public/manifest.webmanifest"), "utf8"));

describe("PWA manifest", () => {
  // start_url and scope decide what the installed icon opens and what the
  // service worker may control. Getting scope wrong silently un-installs push
  // later, so both are pinned.
  it("scopes the installed app to /app", () => {
    const m = manifest();
    expect(m.start_url).toBe("/app/today");
    expect(m.scope).toBe("/app/");
    expect(m.display).toBe("standalone");
  });

  it("uses the Trinity dark surface so iOS does not flash white on launch", () => {
    const m = manifest();
    expect(m.background_color).toBe("#121212");
    expect(m.theme_color).toBe("#121212");
  });

  // iOS needs a real PNG apple-touch-icon; an SVG will not install.
  it("ships every icon file it declares", () => {
    for (const icon of manifest().icons) {
      const rel = icon.src.replace(/^\//, "");
      expect(existsSync(path.join(root, "public", rel.replace(/^public\//, "")))).toBe(true);
    }
    expect(existsSync(path.join(root, "public/icons/apple-touch-icon.png"))).toBe(true);
  });

  it("declares a maskable icon so Android does not letterbox it", () => {
    expect(manifest().icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  });
});
