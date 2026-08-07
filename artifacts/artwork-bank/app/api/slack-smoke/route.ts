/**
 * POST /api/slack-smoke
 *
 * Runs a live smoke test against the Replit Slack connector by calling both
 * sendBillingAlertSlackNotification and sendIframerAccountSlackNotification
 * with labelled synthetic payloads. Designed to be triggered after a Slack
 * connector reconnect to confirm the full alert path is still healthy.
 *
 * Authentication:
 *   When SLACK_SMOKE_SECRET (or the general CRON_SECRET) is set, requests
 *   must carry it as a Bearer token in the Authorization header.
 *   When neither is set the endpoint is open (dev/test convenience).
 *
 * Response (always JSON):
 *   200 { ok: true,  results: [{ test, ok }] }          — all probes passed
 *   200 { ok: false, results: [{ test, ok, error? }] }  — one or more failed
 *   401 { error: "Unauthorized" }                        — bad / missing token
 *   503 { error: "Channel not configured", ... }         — env var missing
 *
 * The response is always 200 (not 5xx) when the endpoint itself ran
 * successfully — the caller should inspect `ok` in the body.
 *
 * GitHub Actions example (workflow_dispatch):
 *
 *   curl -sf -X POST \
 *     -H "Authorization: Bearer ${{ secrets.SLACK_SMOKE_SECRET }}" \
 *     "${{ secrets.ARTWORK_BANK_URL }}/api/slack-smoke" \
 *   | jq -e '.ok'
 */

import { NextResponse } from "next/server";
import {
  sendBillingAlertSlackNotification,
  sendIframerAccountSlackNotification,
} from "@/lib/slack";

export const dynamic = "force-dynamic";

/**
 * Returns "ok" when the request is authorised, "forbidden" when the endpoint
 * is open but we're in production (no secret configured), or "unauthorized"
 * when a secret is configured but the token does not match.
 */
function checkAuth(request: Request): "ok" | "forbidden" | "unauthorized" {
  const secrets = [
    process.env.SLACK_SMOKE_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean);

  if (secrets.length === 0) {
    // No secret configured.  In production this is a misconfiguration — deny
    // the request so the endpoint can never be openly triggered in production.
    if (process.env.NODE_ENV === "production") return "forbidden";
    // In development / test, allow open access for convenience.
    return "ok";
  }

  const auth = request.headers.get("authorization");
  return secrets.some((s) => auth === `Bearer ${s}`) ? "ok" : "unauthorized";
}

type ProbeResult =
  | { test: string; ok: true }
  | { test: string; ok: false; error: string };

export async function POST(request: Request) {
  const authResult = checkAuth(request);
  if (authResult === "forbidden") {
    return NextResponse.json(
      {
        error: "Forbidden",
        detail:
          "SLACK_SMOKE_SECRET (or CRON_SECRET) must be set in production. " +
          "Configure the secret in the deployed app environment to enable this endpoint.",
      },
      { status: 403 },
    );
  }
  if (authResult === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const channel = process.env.SLACK_BILLING_ALERTS_CHANNEL?.trim();
  if (!channel) {
    return NextResponse.json(
      {
        ok: false,
        error: "Channel not configured",
        detail:
          "SLACK_BILLING_ALERTS_CHANNEL is not set. " +
          "Set it to the target Slack channel name or ID before running the smoke test.",
      },
      { status: 503 },
    );
  }

  const ts = Date.now();
  const results: ProbeResult[] = [];

  // ── Probe 1: billing alert ─────────────────────────────────────────────────
  try {
    const r = await sendBillingAlertSlackNotification({
      stripeEventId: `evt_smoke_reconnect_${ts}`,
      eventType: "customer.subscription.updated",
      customerId: "cus_smoke_test",
      subscriptionId: "sub_smoke_test",
      reason: "Slack connector reconnect smoke test — please ignore",
    });
    if (r.ok) {
      results.push({ test: "billing-alert", ok: true });
    } else {
      results.push({ test: "billing-alert", ok: false, error: r.error });
    }
  } catch (err) {
    results.push({
      test: "billing-alert",
      ok: false,
      error: (err as any)?.message ?? String(err),
    });
  }

  // ── Probe 2: comp-removed alert ────────────────────────────────────────────
  try {
    const r = await sendIframerAccountSlackNotification({
      action: "comp-removed",
      tenantName: "Smoke Test Gallery",
      tenantSlug: `smoke-test-${ts}`,
      accountId: "ifr-smoke-reconnect-001",
      adminEmail: "platform-admin@example.com",
    });
    if (r.ok) {
      results.push({ test: "comp-removed-alert", ok: true });
    } else {
      results.push({ test: "comp-removed-alert", ok: false, error: r.error });
    }
  } catch (err) {
    results.push({
      test: "comp-removed-alert",
      ok: false,
      error: (err as any)?.message ?? String(err),
    });
  }

  const allOk = results.every((r) => r.ok);

  if (!allOk) {
    console.error(
      "[slack-smoke] One or more probes failed:",
      JSON.stringify(results),
    );
  } else {
    console.log("[slack-smoke] All probes passed:", JSON.stringify(results));
  }

  return NextResponse.json({ ok: allOk, results });
}

/** GET is accepted for convenience (e.g. curl without -X POST). */
export async function GET(request: Request) {
  return POST(request);
}
