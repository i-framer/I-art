/**
 * Sends an operator alert when the automated Slack smoke test fails.
 *
 * Called by the `slack-reconnect-smoke` GitHub Actions workflow on failure via:
 *
 *   PROBE_RESPONSE_BODY="$(cat /tmp/slack_smoke_body.json 2>/dev/null || true)" \
 *   WORKFLOW_RUN_URL="https://github.com/owner/repo/actions/runs/$GITHUB_RUN_ID" \
 *     pnpm --filter @workspace/artwork-bank exec tsx scripts/notify-smoke-failure.ts
 *
 * Notification: Email only (SMTP or Resend + PLATFORM_ADMIN_EMAIL).
 * The probe already confirmed Slack is broken, so Slack notifications are
 * intentionally skipped here — they would fail for the same reason the test did.
 *
 * The script always exits 0 — notification failures must not mask the original
 * smoke-test failure that the caller reports.
 */

import { sendSmokeTestFailureEmail } from "../lib/email";

const probeResponseBody = process.env.PROBE_RESPONSE_BODY ?? "";
const workflowRunUrl = process.env.WORKFLOW_RUN_URL ?? "";

async function main() {
  console.error(
    "[slack-smoke notifier] Smoke test failed — sending operator email alert…",
  );

  const emailSent = await sendSmokeTestFailureEmail({
    probeResponseBody,
    workflowRunUrl,
  });

  if (emailSent) {
    console.error("[slack-smoke notifier] Alert email sent to PLATFORM_ADMIN_EMAIL.");
  } else {
    console.error(
      "[slack-smoke notifier] Could not send alert email — PLATFORM_ADMIN_EMAIL or an\n" +
        "    email transport (SMTP_HOST or RESEND_API_KEY) is not configured.\n" +
        "    Set these secrets in the GitHub Actions repository settings to enable\n" +
        "    email fallback alerts for Slack smoke-test failures.",
    );
  }

  // Always exit 0 — the workflow step that detected the failure owns the
  // non-zero exit code; this notifier is best-effort.
  process.exit(0);
}

main().catch((err) => {
  console.error("[slack-smoke notifier] Unexpected error:", err);
  process.exit(0);
});
