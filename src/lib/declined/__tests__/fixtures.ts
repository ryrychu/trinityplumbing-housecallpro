// SYNTHETIC Slack messages for #declined-calls tests. Every name, address and
// number here is made up (518-555-01xx is a fictional-use range). The shapes
// follow what Slack returns for forwards and shares; see channel.ts.
import type { SlackMessage } from "@/lib/slack/web";

/** Slack ts for an ISO instant. */
export function tsOf(iso: string): string {
  return `${Date.parse(iso) / 1000}.000100`;
}

function richText(text: string) {
  return [
    {
      type: "rich_text",
      block_id: "b1",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
    },
  ];
}

/** The current "Forward" UI: empty comment, is_share + is_msg_unfurl, original in text and message_blocks. */
export function forwarded(iso: string, original: string, comment = ""): SlackMessage {
  return {
    type: "message",
    ts: tsOf(iso),
    user: "U_ELLAH",
    text: comment,
    attachments: [
      {
        is_share: true,
        is_msg_unfurl: true,
        from_url: "https://example.slack.com/archives/C_CALLS/p1730000000000100",
        fallback: `[November 2nd, 2026 9:00 AM] Office Phone: ${original}`,
        text: original,
        message_blocks: [{ message: { blocks: richText(original) } }],
      },
    ],
  };
}

/** Older "Share message" shape: is_share only, original in attachment.text, no message_blocks. */
export function sharedOldStyle(iso: string, original: string): SlackMessage {
  return {
    type: "message",
    ts: tsOf(iso),
    user: "U_ELLAH",
    text: "",
    attachments: [
      {
        is_share: true,
        from_url: "https://example.slack.com/archives/C_CALLS/p1730000000000200",
        fallback: original,
        text: original,
      },
    ],
  };
}

/** A forward whose original was a bot post with section blocks and no attachment text. */
export function forwardedBlocksOnly(iso: string, original: string): SlackMessage {
  return {
    type: "message",
    ts: tsOf(iso),
    user: "U_ELLAH",
    text: "",
    attachments: [
      {
        is_msg_unfurl: true,
        from_url: "https://example.slack.com/archives/C_CALLS/p1730000000000300",
        message_blocks: [
          { message: { blocks: [{ type: "section", text: { type: "mrkdwn", text: original } }] } },
        ],
      },
    ],
  };
}

export function plain(iso: string, text: string, user = "U_ELLAH"): SlackMessage {
  return { type: "message", ts: tsOf(iso), user, text };
}

export const SAMPLE_CALL = "Pat Example, 12 Sample St, Testville. 518-555-0142. No heat, wants someone today";
