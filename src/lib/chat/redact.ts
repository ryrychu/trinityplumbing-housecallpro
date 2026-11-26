// Masks phone numbers and email addresses in chat text before it is saved.
// Prices ("$1,250"), dates, ZIP codes and model numbers are left alone.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// US numbers: an optional +1 or 1, an area code with or without parentheses,
// then 3 and 4 digits, joined by nothing, a space, a dot or a dash. Never the
// middle of a longer run of digits, and never right after a "$".
const PHONE = /(?<![\d$])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g;

export function redact(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}
