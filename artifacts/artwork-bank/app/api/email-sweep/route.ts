/**
 * Cron-style trigger for the confirmation-email sweep.
 *
 * The sweep also runs automatically on an interval (see instrumentation.ts),
 * so this route is mainly for external cron services or manual triggering.
 * When EMAIL_SWEEP_SECRET is set, requests must carry it as a Bearer token:
 *   Authorization: Bearer <secret>
 * When no secret is configured the endpoint is open in development. In
 * production (NODE_ENV === "production") at least one of EMAIL_SWEEP_SECRET
 * or CRON_SECRET must be set — an unconfigured production deployment returns
 * 403 to prevent strangers from triggering the sweep.
 */
import { NextResponse } from "next/server";
import {
  sweepUnsentConfirmationEmails,
  sweepUnsentGalleryAlerts,
  sweepUnsentStatusEmails,
  sweepUnsentInquiryEmails,
  clearAllStuckNonces,
} from "@/lib/email-sweep";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  // Accept the sweep secret or Vercel's CRON_SECRET (Vercel cron sends
  // "Authorization: Bearer $CRON_SECRET" and can only issue GET requests).
  const secrets = [
    process.env.EMAIL_SWEEP_SECRET,
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
      process.env.EMAIL_SWEEP_SECRET,
      process.env.CRON_SECRET,
    ].filter(Boolean);
    if (secrets.length === 0 && process.env.NODE_ENV === "production") {
      console.error(
        "[email-sweep] Endpoint blocked: no EMAIL_SWEEP_SECRET or CRON_SECRET " +
          "is configured. Set at least one to enable this endpoint in production."
      );
      return NextResponse.json(
        {
          error:
            "Forbidden: EMAIL_SWEEP_SECRET (or CRON_SECRET) must be set in production.",
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Self-heal: clear stuck-nonce rows (emailClaimNonce IS NOT NULL AND
    // emailLastAttemptAt IS NULL) across all tenants before the inquiry sweep
    // runs.  This makes crashed-worker rows retryable within one sweep cycle
    // instead of waiting for manual admin action.
    const stuckNoncesCleared = await clearAllStuckNonces();
    if (stuckNoncesCleared > 0) {
      console.log(`[email-sweep] self-heal: cleared ${stuckNoncesCleared} stuck-nonce inquiry row(s)`);
    }

    const [confirmResult, galleryResult, statusResult, inquiryResult] = await Promise.all([
      sweepUnsentConfirmationEmails(),
      sweepUnsentGalleryAlerts(),
      sweepUnsentStatusEmails(),
      sweepUnsentInquiryEmails(),
    ]);
    // Top-level totals kept for backward compatibility (monitoring scripts).
    const scanned = confirmResult.scanned + galleryResult.scanned + statusResult.scanned + inquiryResult.scanned;
    const sent    = confirmResult.sent    + galleryResult.sent    + statusResult.sent    + inquiryResult.sent;
    const failed  = confirmResult.failed  + galleryResult.failed  + statusResult.failed  + inquiryResult.failed;
    const skipped = confirmResult.skipped + galleryResult.skipped + statusResult.skipped + inquiryResult.skipped;
    const body = { scanned, sent, failed, skipped, stuckNoncesCleared, confirmResult, galleryResult, statusResult, inquiryResult };
    console.log("[email-sweep] completed:", body);
    // 207 Multi-Status when any pass had per-row failures.
    return NextResponse.json(body, { status: failed > 0 ? 207 : 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Email sweep failed:", msg);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return runSweep(request);
}

/** GET is used by Vercel cron (crons can only issue GET requests). */
export async function GET(request: Request) {
  return runSweep(request);
}
