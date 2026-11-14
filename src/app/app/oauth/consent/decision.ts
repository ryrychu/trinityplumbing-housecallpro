// The approve/deny call, separate from actions.ts so it can be unit-tested and
// so the "use server" file exports nothing but the server action itself.

type ConsentResult = Promise<{ data: { redirect_url: string } | null; error: { message: string } | null }>;

export interface OAuthDecisionApi {
  approveAuthorization(id: string, options: { skipBrowserRedirect: boolean }): ConsentResult;
  denyAuthorization(id: string, options: { skipBrowserRedirect: boolean }): ConsentResult;
}

export async function runDecision(
  oauth: OAuthDecisionApi,
  id: string,
  decision: "approve" | "deny"
): Promise<{ redirectUrl: string } | { error: string }> {
  if (!id) return { error: "This sign-in request is missing its ID." };

  // skipBrowserRedirect: this runs on the server, where there is no window for
  // supabase-js to navigate. We redirect ourselves with the URL it returns.
  const opts = { skipBrowserRedirect: true };
  const { data, error } =
    decision === "approve" ? await oauth.approveAuthorization(id, opts) : await oauth.denyAuthorization(id, opts);

  if (error || !data?.redirect_url) return { error: error?.message ?? "Couldn't complete the sign-in request." };
  return { redirectUrl: data.redirect_url };
}
