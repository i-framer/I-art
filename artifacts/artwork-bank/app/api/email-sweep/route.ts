/**
 * Cron-style trigger for the confirmation-email sweep.
 *
 * The sweep also runs automatically on an interval (see instrumentation.ts),
 * so this route is mainly for external cron services or manual triggering.
 * When EMAIL_SWEEP_SECRET is set, requests must carry it as a Bearer token.
 */
import { NextResponse } from "next/server";
import { sweepUnsentConfirmationEmails } from "@/lib/email-sweep";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.EMAIL_SWEEP_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await sweepUnsentConfirmationEmails();
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Email sweep failed:", err?.message ?? err);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}
