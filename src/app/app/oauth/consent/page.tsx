// Consent screen for the ChatGPT price book connector. Supabase Auth sends the
// browser here mid-OAuth with ?authorization_id=…; middleware has already made
// sure the visitor is signed in (it guards /app/*).
import { redirect } from "next/navigation";
import { getSupabaseAuthClient } from "@/lib/mobile/session";
import { decideAuthorization } from "./actions";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-6 py-10">
      <h1 className="font-display text-3xl font-bold uppercase leading-none tracking-wide text-ink-primary">
        Trinity <span className="text-ink-faint">Ops</span>
      </h1>
      {children}
    </main>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <Shell>
      <p role="alert" className="mt-6 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
        {message}
      </p>
      <p className="mt-4 text-sm text-ink-muted">Go back to ChatGPT and try connecting again.</p>
    </Shell>
  );
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: { authorization_id?: string; error?: string };
}) {
  const authorizationId = searchParams.authorization_id;
  if (!authorizationId) return <Problem message="This sign-in link is missing its request ID." />;

  const { data, error } = await getSupabaseAuthClient().auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) return <Problem message="This sign-in request has expired or isn't valid." />;

  // Already approved once: Supabase hands back the redirect straight away.
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  const appName = data.client?.name || "An app";

  return (
    <Shell>
      <p className="mt-6 text-base text-ink-primary">
        <strong>{appName}</strong> wants <strong>read-only</strong> access to the Trinity price book in HouseCall Pro.
      </p>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-ink-muted">
        <li>It can see services, materials, prices, costs and descriptions.</li>
        <li>It cannot change prices or anything else in HouseCall Pro.</li>
        <li>It cannot see customers, jobs or invoices.</li>
      </ul>
      <p className="mt-4 text-sm text-ink-muted">
        Signed in as <span className="text-ink-primary">{data.user?.email}</span>
      </p>

      {searchParams.error && (
        <p role="alert" className="mt-4 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {searchParams.error}
        </p>
      )}

      <form action={decideAuthorization} className="mt-8 space-y-3">
        <input type="hidden" name="authorization_id" value={data.authorization_id} />
        <button
          type="submit"
          name="decision"
          value="approve"
          className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-brand text-base font-bold text-ink-inverse"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="flex min-h-[48px] w-full items-center justify-center rounded-xl border border-surface-border bg-surface-card text-base font-bold text-ink-primary"
        >
          Deny
        </button>
      </form>
    </Shell>
  );
}
