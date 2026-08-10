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

import { appendFileSync } from "fs";
import { sendSmokeTestFailureEmail } from "../lib/email";

const probeResponseBody = process.env.PROBE_RESPONSE_BODY ?? "";
const workflowRunUrl = process.env.WORKFLOW_RUN_URL ?? "";

/**
 * Append a Markdown block to the GitHub Actions step summary (GITHUB_STEP_SUMMARY).
 * Silently ignored when the env var is not set (i.e. outside GitHub Actions).
 */
function appendStepSummary(lines: string[]): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    appendFileSync(summaryFile, lines.join("\n") + "\n");
  } catch {
    // Non-critical — must never propagate.
  }
}

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
    appendStepSummary([
      "",
      "> ✅ **Smoke-test failure alert email sent** to `PLATFORM_ADMIN_EMAIL`.",
    ]);
  } else {
    const msg =
      "Could not send alert email — PLATFORM_ADMIN_EMAIL or an " +
      "email transport (SMTP_HOST or RESEND_API_KEY) is not configured or failed. " +
      "Set these secrets in the GitHub Actions repository settings to enable " +
      "email fallback alerts for Slack smoke-test failures.";

    console.error("[slack-smoke notifier] " + msg);

    // Emit a GitHub Actions warning annotation so the failure is visible
    // in the step log, the workflow run summary, and any PR check annotations.
    console.log(`::warning::Slack smoke-test alert email was NOT delivered. ${msg}`);

    // Also write a structured block to the step summary so the operator
    // sees clear remediation steps in the workflow run UI.
    appendStepSummary([
      "",
      "### ⚠️ Smoke-test failure alert email was NOT sent",
      "",
      "The operator will **not** receive an email notification for this Slack failure.",
      "Ensure the following GitHub Actions repository secrets are configured and valid:",
      "",
      "| Secret | Purpose |",
      "| --- | --- |",
      "| `PLATFORM_ADMIN_EMAIL` | Recipient address for failure alerts |",
      "| `SMTP_HOST` | Mail-server hostname (own SMTP server) |",
      "| `SMTP_PORT` | Mail-server port (default 587) |",
      "| `SMTP_USER` | SMTP username |",
      "| `SMTP_PASS` | SMTP password |",
      "",
      "Alternatively, set `RESEND_API_KEY` + `PLATFORM_ADMIN_EMAIL` to use the Resend API.",
      "",
      "> If an SMTP error was logged above, the transport is configured but broken.",
      "> Fix the SMTP credentials or switch to Resend to restore email alerting.",
    ]);
  }

  // Always exit 0 — the workflow step that detected the failure owns the
  // non-zero exit code; this notifier is best-effort.
  process.exit(0);
}

main().catch((err) => {
  console.error("[slack-smoke notifier] Unexpected error:", err);
  process.exit(0);
});
