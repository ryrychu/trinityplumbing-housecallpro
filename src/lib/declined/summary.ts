// One line per declined call for the Monday post in #declined-calls, built from
// the text of the #calls message Ellah forwarded. Best effort: the office
// writes these by hand, so this only picks out what it can recognise and never
// fills in a name or town it didn't find.
//
// The usual shape is
//   (518) 555-0123
//   Jane Doe
//   12 Example St, Rensselaer, NY 12144
//   Cx called because the sump pump stopped. Pit nearly overflowing.
// but lines go missing, move around, or start with an @mention.
//
// In memory only: the result goes into the Slack post and nowhere else. Never
// log it.
import { findPhone, scrubPhones } from "./parse";

const NOTE_MAX = 80;

// Slack's own markup in message text: <@U123>, <#C123|calls>, <!here>,
// <tel:5185550123|(518) 555-0123>, <https://…|label>, <https://…>.
export function slackToPlain(text: string): string {
  return text
    .replace(/<[@!][^>]*>/g, " ")
    .replace(/<#[^|>]*\|([^>]*)>/g, "#$1")
    .replace(/<[^|>]+\|([^>]*)>/g, "$1")
    .replace(/<([^>]*)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "(518) 555-0123" from 10 digits. */
export function formatPhone(digits: string): string {
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function isPhoneLine(line: string): boolean {
  const phone = findPhone(line);
  if (!phone) return false;
  // What's left once the number is gone: nothing, or a label like "Phone:".
  const rest = line.replace(/[\d()+.\-\s]/g, "").replace(/^(phone|ph|tel|cell|mobile|number)\b:?/i, "");
  return rest.length <= 2;
}

// "…, Rensselaer, NY 12144" / "…, Hillsdale NY" / "…, Troy, New York 12180"
const TOWN_RE = /,\s*([A-Za-z][A-Za-z .'-]*?)\s*,?\s+(?:[A-Z]{2}|New York)\.?(?:\s+\d{5}(?:-\d{4})?)?\s*$/;
const STREET_RE = /^\d+[A-Za-z]?\s+\S+/;

function townOf(line: string): string | null {
  const m = line.match(TOWN_RE);
  return m ? m[1].trim() : null;
}

function isAddressLine(line: string): boolean {
  return TOWN_RE.test(line) || STREET_RE.test(line);
}

function looksLikeName(line: string): boolean {
  if (/\d/.test(line)) return false;
  if (!/^[A-Z]/.test(line)) return false;
  if (/[.!?:;]$/.test(line)) return false;
  const words = line.split(/\s+/);
  // Names are written Title Case ("Jane Doe", "Mary-Ann O'Neil"); a short
  // note ("No heat") usually isn't.
  return words.length <= 4 && line.length <= 40 && words.every((w) => /^[A-Z]/.test(w));
}

// "Cx called because …", "Customer is calling about …", "Called re: …"
const LEAD_IN =
  /^(?:(?:cx|customer|client|caller|homeowner|she|he|they)\s+)?(?:called|calls|calling|is calling|called in|reached out)\s*(?:in\s+)?(?:because|about|regarding|re:?|for|to say|asking about|asking for|wanting)?\s*(?:that\s+)?/i;

function shortNeed(text: string): string | null {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(LEAD_IN, "").trim();
  if (!t) return null;
  const sentence = t.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "").trim();
  if (!sentence) return null;
  return sentence.length > NOTE_MAX ? `${sentence.slice(0, NOTE_MAX - 1).trimEnd()}…` : sentence;
}

// The post is Slack mrkdwn: escape the three characters Slack treats as
// markup so a stray "<" can't become a mention or a link.
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One line for one forwarded call: "Jane Doe, Rensselaer: sump pump stopped",
 * "(518) 555-0123: no details", or "(no details)".
 */
export function summarizeCall(original: string): string {
  const lines = slackToPlain(original)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let phone: string | null = null;
  let town: string | null = null;
  let name: string | null = null;
  const noteLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isPhoneLine(line)) {
      phone ??= findPhone(line);
    } else if (isAddressLine(line)) {
      town ??= townOf(line);
    } else if (!name && i < lines.length - 1 && looksLikeName(line)) {
      // The last line is the note, so it is never taken as a name.
      name = line;
    } else {
      noteLines.push(line);
    }
  }

  const need = noteLines.length ? shortNeed(scrubPhones(noteLines.join(" "))) : null;
  // Fall back to a number that appears inside the note.
  phone ??= findPhone(lines.join(" "));

  const who = name
    ? town
      ? `${name}, ${town}`
      : name
    : phone
      ? town
        ? `${formatPhone(phone)}, ${town}`
        : formatPhone(phone)
      : town;

  let out: string;
  if (who && need) out = `${who}: ${need}`;
  else if (who) out = `${who}: no details`;
  else if (need) out = need;
  else out = "(no details)";
  return escapeMrkdwn(out);
}
