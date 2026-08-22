import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = () =>
  JSON.parse(readFileSync(path.join(root, "public/manifest.webmanifest"), "utf8"));

describe("PWA manifest", () => {
  // start_url is what the installed icon opens; scope is which pages Chrome
  // will offer to install from and which URLs stay inside the app window.
  //
  // Scope is the whole origin on purpose. It used to be "/app/", which meant
  // the only page advertising an installable app was one nobody lands on: /
  // redirects to /dashboard, so a visitor hitting install got a plain browser
  // shortcut off favicon.ico instead of the app. Narrowing this again brings
  // that back. It is NOT the service worker's scope, which stays "/app/" --
  // see the header of public/sw.js.
  it("offers the install from anywhere on the origin, opening the app at Today", () => {
    const m = manifest();
    expect(m.start_url).toBe("/app/today");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    // The spec requires start_url to sit inside scope; a future edit that
    // narrows one without the other makes the manifest silently uninstallable.
    expect(m.start_url.startsWith(m.scope)).toBe(true);
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
