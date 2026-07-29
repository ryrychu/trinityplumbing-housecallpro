//
// Slack incoming-webhook poster. Every failure is swallowed and logged: a Slack
// outage must never fail the sync the dashboard depends on.

// Alerts are OFF unless explicitly enabled, so the notifier can be deployed and
// observed in logs before it is allowed to post anything. Given ~2,200 already-
// paid invoices, an accidental default-on is a Slack flood.
export function slackAlertsEnabled(): boolean {
  return process.env.SLACK_ALERTS_ENABLED === "true";
}

const TIMEOUT_MS = 10_000;

export async function postSlack(
  webhookUrl: string | undefined,
  text: string
): Promise<boolean> {
  if (!webhookUrl) {
    // Unconfigured is a deliberate no-op, not an error — logged distinctly from
    // a genuine post failure so the two are separable in Vercel logs.
    console.warn("[slack] skipped: webhook url not configured");
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[slack] post failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[slack] post threw:", err);
    return false;
  }
}
