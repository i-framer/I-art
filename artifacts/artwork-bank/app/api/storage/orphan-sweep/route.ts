/**
 * One-off (but idempotent) trigger for the orphaned-image storage sweep.
 *
 * Finds every artwork_image row whose parent artwork no longer exists in the
 * database and deletes both the stored file and the stale DB row.
 *
 * This cleans up files left behind by artworks deleted before the fix that
 * made deleteArtwork also remove stored image files.
 *
 * When ORPHAN_SWEEP_SECRET is set, requests must supply it as a Bearer token:
 *   Authorization: Bearer <secret>
 * When no secret is configured the endpoint is open in development. In
 * production (NODE_ENV === "production") at least one of ORPHAN_SWEEP_SECRET
 * or CRON_SECRET must be set — an unconfigured production deployment returns
 * 403 to prevent strangers from triggering the sweep.
 *
 * ## Notification channels
 * When the sweep completes with errors the route attempts to notify the
 * operator via Slack (SLACK_BILLING_ALERTS_CHANNEL) and/or email
 * (PLATFORM_ADMIN_EMAIL + SMTP_HOST or RESEND_API_KEY).  If neither channel
 * is configured the 207 response body includes `notificationSkipped: true` so
 * a caller polling the endpoint can detect the misconfiguration without tailing
 * server logs.  Use GET /api/storage/orphan-sweep/health to check which
 * channels are currently active without triggering a sweep.
 */
import { NextResponse } from "next/server";
import { BlobStoreNotFoundError } from "@vercel/blob";
import { sweepOrphanedImageFiles } from "@/lib/orphan-image-sweep";
import { StorageNotConfiguredError } from "@/lib/object-storage";
import { sendOrphanSweepSlackNotification } from "@/lib/slack";
import { sendOrphanSweepErrorNotification } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Returns true when at least one operator notification channel is configured:
 * - Slack: SLACK_BILLING_ALERTS_CHANNEL is set to a non-empty string
 * - Email: a transport (SMTP_HOST or RESEND_API_KEY) AND PLATFORM_ADMIN_EMAIL are set
 *
 * Mirrors the checks in lib/email.ts (isEmailTransportConfigured / smtpConfigured)
 * but uses env vars directly so it is not affected by test mocks of @/lib/email.
 *
 * Used to set `notificationSkipped` in the sweep response so operators can
 * detect a silent misconfiguration without tailing server logs.
 */
function isAnyNotificationChannelConfigured(): boolean {
  const slackConfigured = Boolean(
    process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim(),
  );
  // Mirrors isEmailTransportConfigured() from lib/email.ts
  const emailTransportConfigured =
    Boolean(process.env.SMTP_HOST) || Boolean(process.env.RESEND_API_KEY);
  const emailConfigured =
    emailTransportConfigured && Boolean(process.env.PLATFORM_ADMIN_EMAIL);
  return slackConfigured || emailConfigured;
}

function isAuthorized(request: Request): boolean {
  // Accept the sweep secret or Vercel's CRON_SECRET (Vercel cron sends
  // "Authorization: Bearer $CRON_SECRET" and can only issue GET requests).
  const secrets = [
    process.env.ORPHAN_SWEEP_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean);

  if (secrets.length === 0) {
    // In production, refuse to run open — the operator must configure a secret.
    if (process.env.NODE_ENV === "production") return false;
    // In development/test, allow open access for convenience.
    return true;
  }

  const auth = request.headers.get("authorization");
  return secrets.some((s) => auth === `Bearer ${s}`);
}

async function runSweep(request: Request) {
  if (!isAuthorized(request)) {
    const secrets = [
      process.env.ORPHAN_SWEEP_SECRET,
      process.env.CRON_SECRET,
    ].filter(Boolean);
    if (secrets.length === 0 && process.env.NODE_ENV === "production") {
      console.error(
        "[orphan-sweep] Endpoint blocked: no ORPHAN_SWEEP_SECRET or CRON_SECRET " +
          "is configured. Set at least one to enable this endpoint in production."
      );
      return NextResponse.json(
        {
          error:
            "Forbidden: ORPHAN_SWEEP_SECRET (or CRON_SECRET) must be set in production.",
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await sweepOrphanedImageFiles();
    console.log("[orphan-sweep] completed:", result);

    // When errors occurred, notify the operator via Slack and/or email so they
    // don't have to spot the failure from logs or the HTTP 207 response.
    if (result.errors > 0) {
      // Both Slack and email notifications are best-effort: a throw from either
      // must never change the HTTP status or mask the sweep result.
      let slackFailure: string | undefined;
      try {
        const slackResult = await sendOrphanSweepSlackNotification({
          errors: result.errors,
          failedPaths: result.failedPaths,
        });
        slackFailure = slackResult.ok ? undefined : slackResult.error;
      } catch (slackErr) {
        slackFailure = slackErr instanceof Error ? slackErr.message : String(slackErr);
        console.error(
          "[orphan-sweep] Slack notification threw (sweep result unaffected):",
          slackFailure,
        );
      }
      // Fire email regardless of Slack outcome; include Slack failure info if present.
      // sendOrphanSweepErrorNotification re-throws on transport failure — catch
      // here so a notification error never masks the sweep result or changes the
      // HTTP status code.
      let emailFailure: string | undefined;
      try {
        await sendOrphanSweepErrorNotification({
          errors: result.errors,
          failedPaths: result.failedPaths,
          slackFailure,
        });
      } catch (notifyErr) {
        emailFailure =
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        console.error(
          "[orphan-sweep] Email notification failed (sweep result unaffected):",
          emailFailure,
        );
      }

      // When BOTH channels failed the operator has no way to learn about the
      // sweep errors from Slack or email — surface the delivery failures
      // explicitly in the 207 response body so a caller polling the endpoint
      // can detect the situation without tailing server logs.
      if (slackFailure !== undefined && emailFailure !== undefined) {
        return NextResponse.json(
          {
            ...result,
            notificationFailure: {
              slack: slackFailure,
              email: emailFailure,
            },
          },
          { status: 207 },
        );
      }

      // When no channel is configured at all, both notification attempts above
      // silently skipped (returned without error).  Surface this as
      // `notificationSkipped: true` so a caller polling the endpoint can detect
      // the misconfiguration — without needing to tail server logs.
      if (!isAnyNotificationChannelConfigured()) {
        console.warn(
          "[orphan-sweep] Sweep completed with errors but no notification " +
            "channel is configured (set SLACK_BILLING_ALERTS_CHANNEL and/or " +
            "PLATFORM_ADMIN_EMAIL + email transport). " +
            "Returning notificationSkipped:true in the 207 body.",
        );
        return NextResponse.json(
          { ...result, notificationSkipped: true },
          { status: 207 },
        );
      }
    }

    // When per-row storage errors occurred, use 207 Multi-Status so operators
    // are alerted even when some rows were cleaned up successfully.
    const status = result.errors > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      err instanceof BlobStoreNotFoundError ||
      err instanceof StorageNotConfiguredError
    ) {
      console.error("[orphan-sweep] Storage misconfigured:", msg);
      return NextResponse.json(
        {
          error:
            "Storage misconfigured: check BLOB_READ_WRITE_TOKEN / PRIVATE_OBJECT_DIR.",
        },
        { status: 500 },
      );
    }
    console.error("Orphan image sweep failed:", msg);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return runSweep(request);
}

/** GET for convenience — easy to trigger from a browser or curl without a body. */
export async function GET(request: Request) {
  return runSweep(request);
}
