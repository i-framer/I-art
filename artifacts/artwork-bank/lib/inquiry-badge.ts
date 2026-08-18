/**
 * Badge label computation for inquiry email-delivery state.
 *
 * Extracted from the Inquiries page so the same logic can be imported by tests
 * and asserted against real DB rows without duplicating or guessing the strings.
 */
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

export const BADGE_RETRYING = "Email delivery failed — retrying" as const;
export const BADGE_PERMANENT = "Notification permanently failed" as const;

/**
 * Returns the badge label that the Inquiries page renders for a given inquiry
 * row, or `null` when no badge should appear.
 *
 * Mirrors the inline JSX condition at page.tsx (badge block):
 *   inq.emailError &&
 *     (inq.emailAttempts >= MAX_EMAIL_ATTEMPTS ? PERMANENT : RETRYING)
 */
export function getInquiryEmailBadgeLabel(
  emailError: string | null | undefined,
  emailAttempts: number,
): typeof BADGE_RETRYING | typeof BADGE_PERMANENT | null {
  if (!emailError) return null;
  return emailAttempts >= MAX_EMAIL_ATTEMPTS ? BADGE_PERMANENT : BADGE_RETRYING;
}
