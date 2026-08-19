/**
 * Derive a friendly display name from an email address.
 * "jane.smith@example.com" → "Jane Smith"
 * "j@x.co"                → "J"
 * null/undefined           → "" (caller renders the fallback)
 */
export function senderDisplayName(email: string | null | undefined): string {
  if (!email) return "";
  const local = email.split("@")[0] ?? "";
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
