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
import { sweepUnsentConfirmationEmails } from "@/lib/email-sweep";

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
    const result = await sweepUnsentConfirmationEmails();
    console.log("[email-sweep] completed:", result);
    // When per-row failures occurred, use 207 Multi-Status so operators are
    // alerted even when some rows were processed successfully.
    const status = result.failed > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
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
