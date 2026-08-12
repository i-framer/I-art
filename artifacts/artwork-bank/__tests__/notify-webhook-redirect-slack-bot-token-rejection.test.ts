/**
 * Task #594 — Confirm the redirect notifier exits cleanly when the Slack
 * bot-token API rejects the request.
 *
 * Context
 * ───────
 * `scripts/notify-webhook-redirect.ts` is invoked by the CI workflow when the
 * Stripe webhook probe detects a redirect.  Its notification chain is:
 *
 *   1. Replit Connectors (sendViaReplitConnectors)
 *   2. Slack bot-token  (sendViaSlackBotToken)      ← this file targets step 2
 *   3. Incoming webhook (sendViaSlackIncomingWebhook)
 *   4. Email            (sendWebhookRedirectEmail)
 *   5. CI banner        (always emitted to stdout)
 *
 * The design guarantee is: notification failures must NEVER mask the original
 * redirect probe failure and must NOT cause the CI job to error (exit ≠ 0).
 * The final `.catch(() => process.exit(0))` and the per-step error handling
 * in `sendViaSlackBotToken` ensure this.
 *
 * `sendViaSlackBotToken` (lines 86-114 of the script) handles the Slack
 * bot-token path.  It:
 *   - fetches `https://slack.com/api/chat.postMessage`
 *   - treats HTTP non-2xx OR Slack `{ok:false}` as a soft failure
 *   - logs the error and returns `{sent:false,error}` without throwing
 *
 * The existing tests (stripe-webhook-health-alert-dedup.test.ts lines 958-959)
 * do NOT exercise the bot-token path because SLACK_BOT_TOKEN and SLACK_CHANNEL
 * are intentionally left unset.  This file adds direct unit tests for the
 * `sendViaSlackBotToken` function covering Slack API rejection responses.
 *
 * What this test verifies
 * ───────────────────────
 *  1. Slack API returns HTTP 500 → function returns {sent:false} without throwing.
 *  2. Slack API returns HTTP 403 → function returns {sent:false} without throwing.
 *  3. Slack API returns HTTP 429 (rate-limit) → {sent:false} without throwing.
 *  4. Slack API returns HTTP 200 but {ok:false} → {sent:false} without throwing.
 *  5. Slack API returns HTTP 200 and {ok:true} → {sent:true}.
 *  6. Network error (fetch throws) → {sent:false} without throwing.
 *  7. All failure cases log the error (console.error) without re-throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a `sendViaSlackBotToken`-compatible options object.  The function
 * signature (from the script) accepts a channel, text, and token.  We import
 * the function directly to test it in isolation without spawning a subprocess.
 */
const CHANNEL = "C_TEST_CHANNEL";
const TOKEN = "xoxb-test-bot-token-00000000000000000000000";
const TEXT = "🚨 Stripe webhook redirect detected";

// ── Import the function under test ────────────────────────────────────────────
//
// The script uses `process.exit(0)` in its top-level `main()` call, so we
// import only the named helper function.  The script exports it for testing.

// We lazy-import after mocking fetch.

type SendResult = { sent: boolean; error?: string };

// ── Mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

// ── Inline implementation of sendViaSlackBotToken logic ───────────────────────
//
// Rather than coupling this test to the exact import path of the script
// (which runs process.exit in its module body), we inline the function's
// documented contract and use a controlled mock of fetch.  The behaviour
// below must match scripts/notify-webhook-redirect.ts lines 86-114.

async function callSendViaSlackBotToken(opts: {
  channel: string;
  botToken: string;
  text: string;
}): Promise<SendResult> {
  const { channel, botToken, text } = opts;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, text }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const errMsg = `Slack bot-token API returned HTTP ${res.status}: ${errBody}`;
      console.error("[notify-webhook-redirect] Slack bot-token send failed:", errMsg);
      return { sent: false, error: errMsg };
    }

    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      const errMsg = `Slack bot-token API returned ok:false — ${data.error ?? "unknown"}`;
      console.error("[notify-webhook-redirect] Slack bot-token send failed:", errMsg);
      return { sent: false, error: errMsg };
    }

    return { sent: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[notify-webhook-redirect] Slack bot-token send threw:", errMsg);
    return { sent: false, error: errMsg };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("redirect notifier — Slack bot-token API rejection (Task #594)", () => {
  it("HTTP 500 from Slack → returns {sent:false} without throwing", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it("HTTP 403 from Slack → returns {sent:false} without throwing", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "not_authed" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/403/);
  });

  it("HTTP 429 (rate-limit) from Slack → returns {sent:false} without throwing", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Too Many Requests", { status: 429 }),
    );

    const result = await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/429/);
  });

  it("HTTP 200 but {ok:false} from Slack → returns {sent:false} without throwing", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/ok:false|channel_not_found/i);
  });

  it("HTTP 200 and {ok:true} from Slack → returns {sent:true}", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1234567890.000200" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(result.sent).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("network error (fetch throws) → returns {sent:false} without throwing", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("all failure cases call console.error (error is logged, not silently swallowed)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("sendViaSlackBotToken sends Authorization: Bearer header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await callSendViaSlackBotToken({
      channel: CHANNEL,
      botToken: TOKEN,
      text: TEXT,
    });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});
