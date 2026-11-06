// Counting #declined-calls. When Ellah turns a call down she forwards (shares)
// the original #calls message into #declined-calls. One forwarded message there
// is one declined call. Everything else in the channel is conversation: her
// weekly total line, Dave's replies, the bot's own summary, joins and leaves.
//
// Slack does not publish a schema for a forwarded message. The shape below is
// what forwards and older-style shares both carry in practice: a top-level
// message (no subtype; `text` is the optional comment) with an attachment
// marked `is_share: true` and/or `is_msg_unfurl: true`, the original text in
// `attachment.text`, and the original's blocks in
// `attachment.message_blocks[].message.blocks`. Either flag counts, so a pasted
// message link that unfurls the original counts the same way.
//
// Nothing read here is stored or logged. The phone number is turned into the
// same salted hash /trinity declined uses, only in memory, and the text is
// dropped.
import { findPhone } from "./parse";
import { hashPhone } from "./phone";
import type { DeclinedRow } from "./tally";
import type { SlackAttachment, SlackMessage } from "@/lib/slack/web";

function sharedAttachments(msg: SlackMessage): SlackAttachment[] {
  return (msg.attachments ?? []).filter((a) => a.is_share === true || a.is_msg_unfurl === true);
}

export function isDeclinedShare(msg: SlackMessage): boolean {
  if (msg.type !== undefined && msg.type !== "message") return false;
  // Joins, leaves, topic changes, bot_message, thread_broadcast ("also send to
  // channel" thread replies) all carry a subtype. A forward does not.
  if (msg.subtype) return false;
  // Any bot or app post, including this app's own Monday summary.
  if (msg.bot_id) return false;
  // conversations.history returns top-level messages only, but a thread parent
  // carries thread_ts === ts and still counts; anything else is a reply.
  if (msg.thread_ts && msg.thread_ts !== msg.ts) return false;
  return sharedAttachments(msg).length > 0;
}

// Every string under a "text" key in a block tree: rich_text elements, section
// text objects, fields. Shared bot posts use section blocks, people's posts
// use rich_text; this covers both without knowing which.
function blockText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) blockText(n, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "text" && typeof value === "string") out.push(value);
      else blockText(value, out);
    }
  }
}

/** The forwarded original's text. Never the comment, never author names. */
export function sharedText(msg: SlackMessage): string {
  const parts: string[] = [];
  for (const a of sharedAttachments(msg)) {
    if (a.text) parts.push(a.text);
    for (const mb of a.message_blocks ?? []) blockText(mb.message?.blocks, parts);
  }
  return parts.join("\n");
}

/** Slack ts ("1730520000.123456") to ISO. */
export function tsToIso(ts: string): string {
  return new Date(Math.round(Number(ts) * 1000)).toISOString();
}

/**
 * The channel's declined calls as tally rows. The time is when it was shared
 * into #declined-calls (the message's own ts), not when the caller rang.
 * No salt: a share still counts, just without repeat-caller matching.
 */
export function channelRows(messages: SlackMessage[], salt: string | undefined): DeclinedRow[] {
  return messages.filter(isDeclinedShare).map((msg) => {
    const phone = salt ? findPhone(sharedText(msg)) : null;
    return {
      created_at: tsToIso(msg.ts),
      reason: null,
      phone_hash: phone && salt ? hashPhone(phone, salt) : null,
    };
  });
}
