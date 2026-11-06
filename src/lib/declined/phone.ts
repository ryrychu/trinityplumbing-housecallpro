import { createHmac } from "node:crypto";

/**
 * Salted HMAC of a normalized 10-digit number. A plain hash of a phone number
 * is reversible by trying all ten billion of them; the salt
 * (DECLINED_PHONE_SALT) is what makes the value useless without the
 * deployment's secret. The same function hashes /trinity declined entries and
 * #declined-calls shares, which is what lets the two match up.
 */
export function hashPhone(phone: string, salt: string): string {
  return createHmac("sha256", salt).update(phone).digest("hex");
}
