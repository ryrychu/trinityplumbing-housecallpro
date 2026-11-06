// Parsing for `/trinity declined …`, the turned-down call log.
//
//   /trinity declined busy [phone] [note]
//   /trinity declined distance [phone] [note]
//   /trinity declined undo
//   /trinity declined week
//   /trinity declined              (usage)
//
// The phone number is pulled out of the text wherever it appears, so
// "busy 518-555-0100 wanted Tuesday" and "busy wanted Tuesday 518 555 0100"
// both work. It is only ever used to build a salted hash for repeat-caller
// de-duplication; the raw number is never stored, so it is also scrubbed from
// the note.

export type DeclinedReason = "busy" | "distance";

export type DeclinedCommand =
  | {
      kind: "declinedLog";
      reason: DeclinedReason;
      /** 10 digits, or null when no phone was given. Never stored as-is. */
      phone: string | null;
      note: string | null;
      userId: string | null;
    }
  | { kind: "declinedUndo"; userId: string | null }
  | { kind: "declinedWeek" }
  | { kind: "declinedUsage" };

export const NOTE_MAX = 200;

// US numbers: optional +1, optional parentheses, space/dot/dash separators.
// The digit lookarounds stop it matching inside a longer run of digits.
const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
// A 7-digit local number ("555-0100") is too short to de-dupe on, but it is
// still a phone number and must not end up stored in a note.
const LOCAL_PHONE_RE = /(?<!\d)\d{3}[\s.-]\d{4}(?!\d)/g;

export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function scrubPhones(text: string): string {
  return text
    .replace(new RegExp(PHONE_RE.source, "g"), " ")
    .replace(LOCAL_PHONE_RE, " ");
}

/**
 * `rest` is everything after the word "declined", in its original case so the
 * note keeps the capitalisation Ella typed.
 */
export function parseDeclined(rest: string, userId: string | null): DeclinedCommand {
  const text = rest.trim().replace(/\s+/g, " ");
  if (text === "") return { kind: "declinedUsage" };

  const [first, ...others] = text.split(" ");
  const word = first.toLowerCase();
  const tail = others.join(" ");

  if (word === "undo" && tail === "") return { kind: "declinedUndo", userId };
  if (word === "week" && tail === "") return { kind: "declinedWeek" };
  if (word !== "busy" && word !== "distance") return { kind: "declinedUsage" };

  const match = tail.match(PHONE_RE);
  const phone = match ? normalizePhone(match[0]) : null;
  const note = scrubPhones(tail).replace(/\s+/g, " ").trim().slice(0, NOTE_MAX).trim();

  return { kind: "declinedLog", reason: word, phone, note: note || null, userId };
}
