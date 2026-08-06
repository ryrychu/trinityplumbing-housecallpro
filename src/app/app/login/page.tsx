"use client";

import { Suspense, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { useRouter, useSearchParams } from "next/navigation";

// useSearchParams() opts the page out of static prerendering unless it's
// wrapped in Suspense — without this, `next build` fails on this page.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
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
    router.replace(params.get("next") ?? "/app/today");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold tracking-tight">Trinity Ops</h1>
      <p className="mt-1 text-sm text-ink-faint">Sign in to continue.</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-3">
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
        />
        {error && (
          <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] w-full rounded-xl bg-brand text-base font-bold text-ink-inverse disabled:opacity-60"
        >
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
