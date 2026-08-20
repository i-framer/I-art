/**
 * Derive a friendly display name from an email address.
 * "jane.smith@example.com" → "Jane Smith"
 * "j@x.co"                → "J"
 * null/undefined           → "" (caller renders the fallback)
 */
export function senderDisplayName(email: string | null | undefined): string {
  if (!email) return "";

  const quotedLocalPart = email.startsWith('"')
    ? findQuotedLocalPart(email)
    : null;
  const local = quotedLocalPart
    ? unescapeQuotedLocalPart(quotedLocalPart.slice(1, -1))
    : (email.split("@")[0] ?? "");
  const displayName = local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

  // Keep the existing quoted-local-part display contract while removing
  // backslashes that only escaped characters in the address syntax.
  return quotedLocalPart ? `"${displayName}"` : displayName;
}

/**
 * Return the complete quoted local-part, stopping at its unescaped closing
 * quote. This matters for valid addresses such as "jane\@doe"@example.com,
 * where the first @ belongs to the local-part.
 */
function findQuotedLocalPart(email: string): string | null {
  let escaped = false;

  for (let index = 1; index < email.length; index += 1) {
    const character = email[index];

    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"' && email[index + 1] === "@") {
      return email.slice(0, index + 1);
    }
  }

  return null;
}

function unescapeQuotedLocalPart(localPart: string): string {
  return localPart.replace(/\\([\s\S])/g, "$1");
}
