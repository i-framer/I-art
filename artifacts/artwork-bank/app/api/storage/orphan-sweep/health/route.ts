/**
 * Health check for the orphan-sweep notification and auth configuration.
 *
 * Reports which operator notification channels are active and which auth
 * secrets are configured, without triggering a sweep.  Useful for verifying
 * the deployment is set up correctly:
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
 *   "anyConfigured": true,  // false → sweep errors will set notificationSkipped:true
 *   "auth": {
 *     "orphanSweepSecret": false,  // ORPHAN_SWEEP_SECRET is set and non-empty
 *     "cronSecret": true,          // CRON_SECRET is set and non-empty
 *     "anySecretConfigured": true  // false → sweep is open (non-production only)
 *   }
 * }
 * ```
 *
 * When `anyConfigured` is false the operator should configure at least one of:
 *   - SLACK_BILLING_ALERTS_CHANNEL (Slack)
 *   - PLATFORM_ADMIN_EMAIL + SMTP_HOST or RESEND_API_KEY (email)
 *
 * When `auth.anySecretConfigured` is false in production, all requests will
 * be rejected with 403.  Configure at least one of:
 *   - ORPHAN_SWEEP_SECRET
 *   - CRON_SECRET
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

  const orphanSweepSecret = Boolean(process.env.ORPHAN_SWEEP_SECRET?.trim());
  const cronSecret = Boolean(process.env.CRON_SECRET?.trim());
  const anySecretConfigured = orphanSweepSecret || cronSecret;

  return NextResponse.json({
    notificationChannels: {
      slack: slackConfigured,
      email: emailConfigured,
    },
    anyConfigured,
    auth: {
      orphanSweepSecret,
      cronSecret,
      anySecretConfigured,
    },
  });
}
