// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { runDecision, type OAuthDecisionApi } from "../decision";

function api(over: Partial<OAuthDecisionApi> = {}): OAuthDecisionApi {
  return {
    approveAuthorization: vi.fn(async () => ({ data: { redirect_url: "https://chatgpt.com/cb?code=abc&state=s" }, error: null })),
    denyAuthorization: vi.fn(async () => ({ data: { redirect_url: "https://chatgpt.com/cb?error=access_denied" }, error: null })),
    ...over,
  } as OAuthDecisionApi;
}

describe("runDecision", () => {
  it("approves without letting Supabase redirect the (non-existent) browser", async () => {
    const oauth = api();
    expect(await runDecision(oauth, "auth-1", "approve")).toEqual({ redirectUrl: "https://chatgpt.com/cb?code=abc&state=s" });
    expect(oauth.approveAuthorization).toHaveBeenCalledWith("auth-1", { skipBrowserRedirect: true });
    expect(oauth.denyAuthorization).not.toHaveBeenCalled();
  });

  it("denies", async () => {
    const oauth = api();
    expect(await runDecision(oauth, "auth-1", "deny")).toEqual({ redirectUrl: "https://chatgpt.com/cb?error=access_denied" });
    expect(oauth.denyAuthorization).toHaveBeenCalledWith("auth-1", { skipBrowserRedirect: true });
  });

  it("returns an error message when Supabase fails", async () => {
    const oauth = api({
      approveAuthorization: vi.fn(async () => ({ data: null, error: { message: "authorization expired" } })),
    } as Partial<OAuthDecisionApi>);
    expect(await runDecision(oauth, "auth-1", "approve")).toEqual({ error: "authorization expired" });
  });

  it("refuses an empty authorization id without calling Supabase", async () => {
    const oauth = api();
    expect(await runDecision(oauth, "", "approve")).toEqual({ error: "This sign-in request is missing its ID." });
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
  });
});
