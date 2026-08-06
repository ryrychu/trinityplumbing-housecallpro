// HCP stores phone numbers in whatever shape they were entered. Search has to
// meet the user wherever they type, so both sides are reduced to digits.
export function normalizePhone(input: string): string {
  const digits = (input ?? "").replace(/\D/g, "");
  // 11 digits starting with 1 is a US number with its country code attached.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function formatPhone(digits: string | null): string | null {
  if (!digits) return null;
  if (digits.length !== 10) return digits;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
