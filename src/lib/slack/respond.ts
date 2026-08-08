// Posting a slash-command answer back to Slack.
//
// Distinct from postSlack() in ./client.ts, which posts to a configured
// *incoming webhook* (one fixed channel, used by the digests). A slash command
// instead supplies a per-invocation `response_url`, which is what lets the
// answer land where the person typed and needs no bot token or OAuth scopes.
const TIMEOUT_MS = 10_000;

export async function postToResponseUrl(responseUrl: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Ephemeral: this carries customer names, street addresses and phone
        // numbers, and only the person who asked needs to see them. Switching
        // to "in_channel" is a deliberate decision, not a default.
        response_type: "ephemeral",
        // Replaces the "Working on it…" acknowledgement rather than stacking
        // a second message under it.
        replace_original: true,
        text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[slack] response_url post failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Log the message only, never the raw error object: some failure paths
    // embed the request, and response_url is bearer-equivalent — anyone
    // holding it can post into that conversation. Same rule as ./client.ts.
    console.error("[slack] response_url post threw:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
