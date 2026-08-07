// How many times the reader has moved between screens inside this app since
// the page loaded.
//
// Module scope is the whole trick. A cold load — a shared link, a notification,
// the installed app launching straight onto a job URL — starts a fresh module
// and therefore a depth of 0, which is exactly the truth: there is nothing
// behind this screen to go back to. window.history.length cannot tell you that,
// because in a browser tab it counts everywhere the reader went before they
// ever reached Trinity, and router.back() there walks them out of the app
// entirely.
let depth = 0;

export function recordNavigation(): void {
  depth += 1;
}

export function canGoBack(): boolean {
  return depth > 0;
}

// Tests only — module state survives between cases in a file otherwise.
export function resetNavigationDepth(): void {
  depth = 0;
}
