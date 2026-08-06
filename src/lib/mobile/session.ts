import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// The ANON key, not the service key. This client exists only to read and
// refresh the signed-in user's session; every data query still goes through
// getSupabaseServerClient() inside a route handler. Keeping the two clients
// separate is what lets the app skip RLS entirely — see the spec.
export function getSupabaseAuthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      // Current (non-deprecated) adapter shape — see src/middleware.ts for
      // why the old get/set/remove shim matters (it drops the `headers`
      // setAll receives). Those headers aren't forwarded here, and can't be:
      // unlike middleware, a Server Component has no response object to
      // attach headers to — next/headers exposes only the cookie jar. That's
      // fine structurally, not a gap: every route this runs from (/app/*,
      // /api/app/*) is matched by src/middleware.ts, which runs first,
      // performs the refresh, and already sets those headers on the
      // response it produces. By the time this file runs later in the same
      // request, the session is already current.
      setAll: (cookiesToSet) => {
        // Server Components cannot set cookies; middleware refreshes the
        // session instead, so a throw here is expected and harmless.
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set({ name, value, ...options }));
        } catch {}
      },
    },
  });
}

export async function requireUser(): Promise<{ id: string; email: string | null } | null> {
  const { data } = await getSupabaseAuthClient().auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
