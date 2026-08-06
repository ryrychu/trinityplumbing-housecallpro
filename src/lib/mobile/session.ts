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
      get: (name: string) => cookieStore.get(name)?.value,
      set: (name: string, value: string, options: Record<string, unknown>) => {
        // Server Components cannot set cookies; middleware refreshes the
        // session instead, so a throw here is expected and harmless.
        try {
          cookieStore.set({ name, value, ...options });
        } catch {}
      },
      remove: (name: string, options: Record<string, unknown>) => {
        try {
          cookieStore.set({ name, value: "", ...options });
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
