/**
 * Health check for the orphan-sweep notification configuration.
 *
 * Reports which operator notification channels are active without triggering
 * a sweep.  Useful for verifying the deployment is set up correctly:
 *
 *   curl /api/storage/orphan-sweep/health
 *
 * Response shape:
 * ```json
 * {
 *   "notificationChannels": {
 *     "slack": true,        // SLACK_BILLING_ALERTS_CHANNEL is set and non-empty
 *     "email": false        // PLATFORM_ADMIN_EMAIL or email transport missing
 *   },
 *   "anyConfigured": true   // false → sweep errors will set notificationSkipped:true
 * }
 * ```
 *
 * When `anyConfigured` is false the operator should configure at least one of:
 *   - SLACK_BILLING_ALERTS_CHANNEL (Slack)
 *   - PLATFORM_ADMIN_EMAIL + SMTP_HOST or RESEND_API_KEY (email)
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const slackConfigured = Boolean(
    process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim(),
  );
  // Mirrors isEmailTransportConfigured() from lib/email.ts
  const emailTransportConfigured =
    Boolean(process.env.SMTP_HOST) || Boolean(process.env.RESEND_API_KEY);
  const emailConfigured =
    emailTransportConfigured && Boolean(process.env.PLATFORM_ADMIN_EMAIL);
  const anyConfigured = slackConfigured || emailConfigured;

  return NextResponse.json({
    notificationChannels: {
      slack: slackConfigured,
      email: emailConfigured,
    },
    anyConfigured,
  });
}
