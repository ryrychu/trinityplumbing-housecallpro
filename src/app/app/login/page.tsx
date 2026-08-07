"use client";

import { Suspense, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@/components/ui/Spinner";

// useSearchParams() opts the page out of static prerendering unless it's
// wrapped in Suspense — without this, `next build` fails on this page.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

// `next` is attacker-controlled query input, not something safe to trust just
// because middleware only ever writes an internal /app/... path there —
// anyone can hand a real person a link like
// /app/login?next=https://evil.example (or the protocol-relative
// //evil.example) and, without this check, a *successful* sign-in would
// hard-navigate straight off-origin (Next's router takes the external-URL
// branch for any string that parses as absolute). The two accounts that can
// sign in here hold the only credentials to 1,497 customers' names,
// addresses and phone numbers — exactly who's worth phishing with a
// same-origin link. Anything other than an internal /app/ path is rejected.
function safeNextPath(next: string | null): string {
  if (next && next.startsWith("/app/")) return next;
  return "/app/today";
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // Everything from here is wrapped, because anything that throws rather
    // than returning an error leaves the button spinning forever with nothing
    // on screen to say why — a dead end with no way back but a reload. It is
    // not hypothetical: a malformed NEXT_PUBLIC_SUPABASE_URL makes
    // createBrowserClient throw on construction, and no signInWithPassword
    // error is ever returned to handle.
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      );
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        // Deliberately not "no account with that email" — that would confirm
        // which addresses exist to anyone who finds this page.
        setError("Email or password is incorrect.");
        setBusy(false);
        return;
      }
      // Deliberately no setBusy(false) on the success path. The credentials are
      // good and this screen is on its way out, but replace() + refresh() still
      // have to round-trip before the next one paints. Clearing it here would
      // put the button back to "Sign in", enabled, for that whole gap — which
      // reads as "nothing happened, press it again", and pressing it again
      // fires a second sign-in. It stays spinning until this component
      // unmounts.
      router.replace(safeNextPath(params.get("next")));
      router.refresh();
    } catch {
      // Separate wording from the rejected-password case on purpose: this one
      // is not about the credentials, and telling someone their password is
      // wrong when the app never got to ask sends them off changing it.
      setError("Couldn't reach the sign-in service. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center px-6">
      {/* Same wordmark treatment as the dashboard header — this is the first
          screen anyone sees, and it was the one place still setting the
          product's name in the body face. */}
      <h1 className="font-display text-3xl font-bold uppercase leading-none tracking-wide text-ink-primary">
        Trinity <span className="text-ink-faint">Ops</span>
      </h1>
      <p className="mt-2 text-sm text-ink-muted">Sign in to continue.</p>

      {/* aria-busy marks the whole form, not just the button: while the request
          is out, none of it is accepting input. */}
      <form onSubmit={onSubmit} aria-busy={busy} className="mt-8 space-y-3">
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          required
          disabled={busy}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint disabled:opacity-50"
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint disabled:opacity-50"
        />
        {error && (
          <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-bold text-ink-inverse disabled:opacity-70"
        >
          {busy && <Spinner />}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-8 text-xs leading-relaxed text-ink-faint">
        On iPhone, open this page in <strong className="text-ink-muted">Safari</strong> and choose
        Share → Add to Home Screen. Notifications only work from the installed app, and the
        installed app signs in separately from the browser.
      </p>
    </main>
  );
}
