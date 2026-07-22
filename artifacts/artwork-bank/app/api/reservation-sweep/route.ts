/**
 * Cron-style trigger for the stale-reservation sweep.
 *
 * The sweep also runs automatically on an interval (see
 * lib/email-sweep-scheduler.ts), so this route is mainly for external cron
 * services or manual triggering. When RESERVATION_SWEEP_SECRET is set,
 * requests must carry it as a Bearer token — same pattern as the email
 * retry sweep endpoint.
 */
import { NextResponse } from "next/server";
import { sweepStaleReservations } from "@/lib/reservation-sweep";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  // Accept the sweep secret or Vercel's CRON_SECRET (Vercel cron sends
  // "Authorization: Bearer $CRON_SECRET" and can only issue GET requests).
  const secrets = [
    process.env.RESERVATION_SWEEP_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean);
  if (secrets.length === 0) return true; // no secret configured — open (dev)
  const auth = request.headers.get("authorization");
  return secrets.some((s) => auth === `Bearer ${s}`);
}

async function runSweep(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await sweepStaleReservations();
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Reservation sweep failed:", err?.message ?? err);
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
