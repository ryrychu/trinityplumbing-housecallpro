"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/Panel";

type Action = "digest" | "week";

const ACTIONS: Array<{ id: Action; label: string; hint: string }> = [
  { id: "digest", label: "Today's schedule", hint: "The 6 a.m. daily digest — every job booked for today." },
  { id: "week", label: "Week ahead", hint: "The Monday look-ahead — Monday through Sunday of this week." },
];

// The token is a password for the company Slack, so it lives in sessionStorage,
// not localStorage: it survives the reloads of one sitting (the point — you
// shouldn't retype it between a preview and a post) but not a closed tab on a
// shared or forgotten machine.
const TOKEN_KEY = "trinity.adminToken";

type Result =
  | { kind: "preview"; label: string; text: string }
  | { kind: "posted"; label: string; text: string }
  | { kind: "error"; message: string; text?: string };

export function TriggerPanel() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  // Read on mount rather than in useState's initializer: this component is
  // server-rendered first, and sessionStorage does not exist there.
  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY) ?? "");
  }, []);

  function updateToken(next: string) {
    setToken(next);
    sessionStorage.setItem(TOKEN_KEY, next);
  }

  async function run(action: Action, post: boolean) {
    setBusy(`${action}:${post}`);
    setResult(null);
    try {
      const res = await fetch("/api/admin/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, token, post }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ kind: "error", message: data.error ?? `Request failed (${res.status})`, text: data.text });
      } else {
        setResult({ kind: post ? "posted" : "preview", label: data.label, text: data.text });
      }
    } catch (err) {
      // A network-level failure returns no JSON at all, so it needs its own
      // message — otherwise the panel just sits on "Working…" forever.
      setResult({ kind: "error", message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setBusy(null);
    }
  }

  const ready = token.trim().length > 0;

  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <label htmlFor="admin-token" className="block text-sm font-medium text-ink-primary">
          Admin token
        </label>
        <p className="mt-1 text-sm text-ink-faint">
          The value of <code className="font-mono text-ink-muted">ADMIN_TRIGGER_TOKEN</code> in Vercel.
          Kept for this tab only.
        </p>
        <input
          id="admin-token"
          type="password"
          value={token}
          onChange={(e) => updateToken(e.target.value)}
          autoComplete="off"
          placeholder="Paste the token"
          className="mt-3 w-full rounded-lg border border-surface-border bg-surface-raised px-3 py-2 font-mono text-sm text-ink-primary placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </Panel>

      {ACTIONS.map((a) => (
        <Panel key={a.id} className="p-5">
          <h2 className="text-base font-semibold text-ink-primary">{a.label}</h2>
          <p className="mt-1 text-sm text-ink-faint">{a.hint}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={!ready || busy !== null}
              onClick={() => run(a.id, false)}
              className="rounded-lg border border-surface-border bg-surface-raised px-4 py-2 text-sm font-medium text-ink-primary transition hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === `${a.id}:false` ? "Working…" : "Preview"}
            </button>
            <button
              type="button"
              disabled={!ready || busy !== null}
              onClick={() => run(a.id, true)}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-ink-inverse transition hover:bg-brand-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === `${a.id}:true` ? "Sending…" : "Send to Slack"}
            </button>
          </div>
        </Panel>
      ))}

      {result && (
        <Panel
          className={`p-5 ${
            result.kind === "error" ? "border-danger/50" : result.kind === "posted" ? "border-success/50" : ""
          }`}
        >
          {result.kind === "error" ? (
            <p className="text-sm font-medium text-danger">{result.message}</p>
          ) : (
            <p className="text-sm font-medium text-ink-primary">
              {result.kind === "posted" ? (
                <span className="text-success">Posted to Slack — {result.label}</span>
              ) : (
                <>Preview only — nothing sent. {result.label}</>
              )}
            </p>
          )}
          {result.text && (
            // whitespace-pre-wrap, because the digest's meaning is in its line
            // breaks and leading-space indents; collapsing them would preview a
            // different message than the one Slack receives.
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-page p-4 font-mono text-xs leading-relaxed text-ink-muted">
              {result.text}
            </pre>
          )}
        </Panel>
      )}
    </div>
  );
}
