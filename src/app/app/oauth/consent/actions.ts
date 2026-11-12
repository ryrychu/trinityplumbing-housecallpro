"use server";

// Approve or deny a ChatGPT connector sign-in. Supabase Auth runs the OAuth
// flow; this only records the signed-in user's decision and sends the browser
// back to ChatGPT.
import { redirect } from "next/navigation";
import { getSupabaseAuthClient } from "@/lib/mobile/session";
import { runDecision } from "./decision";

export async function decideAuthorization(formData: FormData): Promise<void> {
  const id = String(formData.get("authorization_id") ?? "");
  const decision = formData.get("decision") === "approve" ? "approve" : "deny";

  const result = await runDecision(getSupabaseAuthClient().auth.oauth, id, decision);
  if ("error" in result) {
    const qs = new URLSearchParams({ authorization_id: id, error: result.error });
    redirect(`/app/oauth/consent?${qs}`);
  }
  redirect(result.redirectUrl);
}
