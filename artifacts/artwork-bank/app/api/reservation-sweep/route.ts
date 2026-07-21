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

export async function POST(request: Request) {
  const secret = process.env.RESERVATION_SWEEP_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await sweepStaleReservations();
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Reservation sweep failed:", err?.message ?? err);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}
