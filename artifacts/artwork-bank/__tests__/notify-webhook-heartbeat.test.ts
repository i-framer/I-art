/**
 * Tests for notify-webhook-heartbeat.ts
 *
 * Verifies that:
 *   1. The bot-token channel sends the correct Slack payload and exits 0.
 *   2. The incoming-webhook channel is tried when the bot-token channel is
 *      unavailable, and sends the correct payload.
 *   3. The script falls through to the CI-banner fallback when neither
 *      Slack channel is configured.
 *   4. The bot-token channel error is handled gracefully and the script
 *      falls through to the incoming-webhook channel.
 *   5. The incoming-webhook channel error is handled gracefully and the
 *      script falls through to the CI banner.
 *   6. The Slack message text includes the probed URL, HTTP status, and
 *      today's UTC date.
 *   7. The GitHub Actions workflow YAML wires all three Slack env vars in
 *      the "Send daily heartbeat" step so a secret-name drift is caught at
 *      edit time, not days later when the daily message stops appearing.
 *
 * The script is a standalone entry-point that reads env vars at module load
 * time and calls process.exit() liberally.  Each test resets modules and
 * re-imports the script under a fresh set of env vars so those top-level
 * reads pick up the test values.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Response-alike returned by the fetch mock. */
function makeOkJsonResponse(body: object) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function makeOkTextResponse(body: string = "ok") {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  };
}

function makeErrorResponse(status: number, body = "error") {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ ok: false, error: body }),
    text: () => Promise.resolve(body),
  };
}

/**
 * Run the heartbeat script with the given env vars, mocking fetch and
 * process.exit.  Returns the captured fetch calls and console output.
 */
async function runHeartbeat(env: Record<string, string | undefined>, fetchMock: ReturnType<typeof vi.fn>) {
  // Capture console output
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
    logLines.push(args.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
    errorLines.push(args.map(String).join(" "));
  });

  // Mock process.exit so the script doesn't actually exit.
  //
  // process.exit is typed as (): never, so the mock must always throw to
  // satisfy that type.  The heartbeat script's main().catch() guard calls
  // process.exit(0) a second time when the first call throws; that second
  // throw becomes an unhandled rejection.  We suppress it with a one-shot
  // unhandledRejection listener registered before the import so Vitest does
  // not report a false-positive error.
  let exitCode: number | undefined;
  let exited = false;
  const SENTINEL = "process.exit — absorbed by heartbeat test guard";
  const unhandledGuard = (reason: unknown) => {
    if (reason instanceof Error && reason.message === SENTINEL) return;
    // Re-emit unexpected rejections so they are not silently swallowed.
    throw reason;
  };
  process.on("unhandledRejection", unhandledGuard);

  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: any): never => {
    exitCode = code as number;
    if (!exited) {
      exited = true;
      throw new Error(`process.exit(${code})`);
    }
    // Second call (from the .catch() guard) — throw the sentinel so the
    // unhandledRejection listener above can absorb it cleanly.
    throw new Error(SENTINEL);
  }) as typeof process.exit);

  // Apply env vars
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "WEBHOOK_URL",
    "HTTP_CODE",
    "WORKFLOW_RUN_URL",
    "SLACK_BILLING_ALERTS_CHANNEL",
    "SLACK_BOT_TOKEN",
    "SLACK_WEBHOOK_URL",
  ];
  for (const key of ENV_KEYS) {
    restore[key] = process.env[key];
    if (env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  // Install fetch mock globally
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = fetchMock;

  // Fresh module load — env vars are read at the top of the script
  vi.resetModules();

  try {
    await import("../scripts/notify-webhook-heartbeat.js");
  } catch (err: any) {
    // process.exit() throws — that's expected.  Any other error is real.
    if (!err?.message?.startsWith("process.exit(")) {
      throw err;
    }
  }

  // Give any async tails a tick to settle
  await new Promise((r) => setTimeout(r, 0));

  // Restore env
  for (const key of ENV_KEYS) {
    if (restore[key] !== undefined) {
      process.env[key] = restore[key];
    } else {
      delete process.env[key];
    }
  }

  // Restore fetch, console, and unhandled-rejection guard
  (globalThis as any).fetch = originalFetch;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  process.removeListener("unhandledRejection", unhandledGuard);

  return { exitCode, logLines, errorLines, fetchCalls: fetchMock.mock.calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("notify-webhook-heartbeat — bot-token channel", () => {
  it("sends via Slack bot token when channel + token are configured and fetch succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse({ ok: true }),
    );

    const { exitCode, logLines, fetchCalls } = await runHeartbeat(
      {
        WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
        HTTP_CODE: "405",
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
      },
      fetchMock,
    );

    // Should call Slack's chat.postMessage endpoint exactly once
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");

    // Authorization header must carry the bot token
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer xoxb-test-token");

    // Body must carry channel and text
    const body = JSON.parse(init.body as string);
    expect(body.channel).toBe("ops-alerts");
    expect(body.text).toContain("daily heartbeat");

    // Confirm the script logged success and exited cleanly
    expect(logLines.some((l) => l.includes("bot token"))).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("strips a leading # from the channel name before sending", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse({ ok: true }),
    );

    const { fetchCalls } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "#ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
      },
      fetchMock,
    );

    const body = JSON.parse((fetchCalls[0] as [string, RequestInit])[1].body as string);
    expect(body.channel).toBe("ops-alerts"); // # stripped
  });

  it("includes the probed URL and HTTP status in the Slack message text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse({ ok: true }),
    );

    const { fetchCalls } = await runHeartbeat(
      {
        WEBHOOK_URL: "https://example.com/api/stripe/webhook",
        HTTP_CODE: "405",
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
      },
      fetchMock,
    );

    const body = JSON.parse((fetchCalls[0] as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("https://example.com/api/stripe/webhook");
    expect(body.text).toContain("405");
  });

  it("includes today's UTC date in the Slack message text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse({ ok: true }),
    );

    const { fetchCalls } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
      },
      fetchMock,
    );

    const todayUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const body = JSON.parse((fetchCalls[0] as [string, RequestInit])[1].body as string);
    expect(body.text).toContain(todayUtc);
  });

  it("includes the workflow run URL as a link when WORKFLOW_RUN_URL is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse({ ok: true }),
    );

    const { fetchCalls } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
        WORKFLOW_RUN_URL: "https://github.com/owner/repo/actions/runs/12345",
      },
      fetchMock,
    );

    const body = JSON.parse((fetchCalls[0] as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("https://github.com/owner/repo/actions/runs/12345");
  });
});

describe("notify-webhook-heartbeat — bot-token failure → incoming webhook fallback", () => {
  it("falls through to the incoming-webhook channel when the bot-token fetch returns a non-ok HTTP status", async () => {
    const fetchMock = vi
      .fn()
      // First call: bot-token → HTTP error
      .mockResolvedValueOnce(makeErrorResponse(401, "invalid_auth"))
      // Second call: incoming webhook → success
      .mockResolvedValueOnce(makeOkTextResponse("ok"));

    const { exitCode, fetchCalls } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-bad-token",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/GOOD",
      },
      fetchMock,
    );

    expect(fetchCalls).toHaveLength(2);
    expect((fetchCalls[0] as [string])[0]).toBe("https://slack.com/api/chat.postMessage");
    expect((fetchCalls[1] as [string])[0]).toBe("https://hooks.slack.com/services/T/B/GOOD");
    expect(exitCode).toBe(0);
  });

  it("falls through to the incoming-webhook channel when the bot-token Slack API returns ok:false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeOkJsonResponse({ ok: false, error: "channel_not_found" }))
      .mockResolvedValueOnce(makeOkTextResponse("ok"));

    const { exitCode, fetchCalls } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/GOOD",
      },
      fetchMock,
    );

    expect(fetchCalls).toHaveLength(2);
    expect(exitCode).toBe(0);
  });

  it("falls through to the incoming-webhook channel when the bot-token fetch throws a network error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(makeOkTextResponse("ok"));

    const { exitCode, fetchCalls } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/GOOD",
      },
      fetchMock,
    );

    expect(fetchCalls).toHaveLength(2);
    expect(exitCode).toBe(0);
  });
});

describe("notify-webhook-heartbeat — incoming-webhook channel (no bot token)", () => {
  it("sends via incoming webhook when only SLACK_WEBHOOK_URL is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkTextResponse("ok"));

    const { exitCode, logLines, fetchCalls } = await runHeartbeat(
      {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/WEBHOOK",
      },
      fetchMock,
    );

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/T/B/WEBHOOK");

    const body = JSON.parse(init.body as string);
    expect(body.text).toContain("daily heartbeat");
    expect(logLines.some((l) => l.includes("incoming webhook"))).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("sends the correct Content-Type to the incoming webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkTextResponse("ok"));

    const { fetchCalls } = await runHeartbeat(
      {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/WEBHOOK",
      },
      fetchMock,
    );

    const headers = (fetchCalls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("notify-webhook-heartbeat — CI-banner fallback (no Slack config)", () => {
  it("emits a prominent CI-banner log and exits 0 when no Slack channel or webhook is configured", async () => {
    const fetchMock = vi.fn(); // should never be called

    const { exitCode, logLines } = await runHeartbeat(
      {
        WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
        HTTP_CODE: "405",
      },
      fetchMock,
    );

    // fetch must not be called when no Slack config is present
    expect(fetchMock).not.toHaveBeenCalled();

    // The banner must be emitted
    const bannerLine = logLines.find((l) => l.includes("STRIPE WEBHOOK PROBE HEARTBEAT"));
    expect(bannerLine).toBeDefined();

    // Banner must include probed URL and HTTP status
    expect(logLines.some((l) => l.includes("https://i-art.com.au/api/stripe/webhook"))).toBe(true);
    expect(logLines.some((l) => l.includes("405"))).toBe(true);

    expect(exitCode).toBe(0);
  });

  it("logs a notice that no channel is configured when neither SLACK_BILLING_ALERTS_CHANNEL nor SLACK_WEBHOOK_URL are set", async () => {
    const fetchMock = vi.fn();

    const { logLines } = await runHeartbeat({}, fetchMock);

    const noticeLine = logLines.find((l) => l.includes("No Slack channel") || l.includes("no Slack channel"));
    expect(noticeLine).toBeDefined();
  });
});

describe("notify-webhook-heartbeat — incoming-webhook failure → CI banner fallback", () => {
  it("falls through to CI banner when the incoming webhook returns a non-ok status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeErrorResponse(500, "server_error"));

    const { exitCode, logLines } = await runHeartbeat(
      {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/BAD",
      },
      fetchMock,
    );

    // Falls through — banner must still appear
    const bannerLine = logLines.find((l) => l.includes("STRIPE WEBHOOK PROBE HEARTBEAT"));
    expect(bannerLine).toBeDefined();
    expect(exitCode).toBe(0);
  });

  it("falls through to CI banner when both bot-token and incoming webhook fail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(401, "invalid_auth"))
      .mockResolvedValueOnce(makeErrorResponse(500, "server_error"));

    const { exitCode, logLines } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-bad-token",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/BAD",
      },
      fetchMock,
    );

    const bannerLine = logLines.find((l) => l.includes("STRIPE WEBHOOK PROBE HEARTBEAT"));
    expect(bannerLine).toBeDefined();
    expect(exitCode).toBe(0);
  });
});

describe("notify-webhook-heartbeat — always exits 0", () => {
  it("exits 0 even when fetch throws for all configured channels", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("network timeout"));

    const { exitCode } = await runHeartbeat(
      {
        SLACK_BILLING_ALERTS_CHANNEL: "ops-alerts",
        SLACK_BOT_TOKEN: "xoxb-test-token",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/WEBHOOK",
      },
      fetchMock,
    );

    expect(exitCode).toBe(0);
  });

  it("exits 0 when no env vars are configured at all", async () => {
    const fetchMock = vi.fn();
    const { exitCode } = await runHeartbeat({}, fetchMock);
    expect(exitCode).toBe(0);
  });
});

describe("notify-webhook-heartbeat — bot-token is skipped when channel env var is missing", () => {
  it("does not call the Slack API when SLACK_BOT_TOKEN is set but SLACK_BILLING_ALERTS_CHANNEL is not", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkTextResponse("ok"));

    await runHeartbeat(
      {
        SLACK_BOT_TOKEN: "xoxb-test-token",
        // no SLACK_BILLING_ALERTS_CHANNEL
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/WEBHOOK",
      },
      fetchMock,
    );

    // The one fetch call should be to the incoming webhook, NOT chat.postMessage
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://hooks.slack.com/services/T/B/WEBHOOK");
  });
});

// ── Workflow YAML structural check ─────────────────────────────────────────────
//
// Verifies that the "Send daily heartbeat" step in the GitHub Actions workflow
// YAML wires all three Slack env vars from repository secrets.  This catches a
// secret-name drift the moment stripe-webhook-health.yml is edited — not days
// later when the daily Slack message stops appearing.
//
// Each test locates the env-var key on its own line and then asserts that the
// *same* line contains the expected secrets.<NAME> reference.  This means a
// swapped mapping (e.g. SLACK_BOT_TOKEN: ${{ secrets.SLACK_WEBHOOK_URL }})
// is caught even though both strings would appear somewhere in the block.

describe("stripe-webhook-health.yml — Send daily heartbeat step env wiring", () => {
  /**
   * Read the workflow YAML as plain text and return the individual lines of the
   * env block that belongs to the "Send daily heartbeat" step.
   *
   * Strategy:
   *   1. Split on lines.
   *   2. Find the line that contains `name: Send daily heartbeat`.
   *   3. From there, find the `env:` line that opens the step's env block.
   *   4. Collect all indented key lines until the indentation drops back to the
   *      step level (or EOF), which marks the end of the env block.
   */
  function extractHeartbeatEnvLines(): string[] {
    const workflowPath = resolve(
      __dirname,
      "../../../.github/workflows/stripe-webhook-health.yml",
    );
    const lines = readFileSync(workflowPath, "utf8").split("\n");

    // Locate the step by its name
    const stepNameIdx = lines.findIndex((l) =>
      l.includes("name: Send daily heartbeat"),
    );
    if (stepNameIdx === -1) {
      throw new Error(
        'Could not find "name: Send daily heartbeat" in stripe-webhook-health.yml',
      );
    }

    // Determine the step's indentation depth from the `- name:` line
    const stepIndent = lines[stepNameIdx].match(/^(\s*)-\s/)?.[1]?.length ?? 0;

    // Find the `env:` key that belongs to this step (before the next step at
    // the same indentation level starts)
    let envIdx = -1;
    for (let i = stepNameIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // A new step at the same level signals we've left the current step
      const indent = line.match(/^(\s*)\S/)?.[1]?.length ?? 0;
      if (indent <= stepIndent && line.trimStart().startsWith("- ")) break;
      if (line.trimStart().startsWith("env:")) {
        envIdx = i;
        break;
      }
    }
    if (envIdx === -1) {
      throw new Error(
        '"Send daily heartbeat" step has no env: block in stripe-webhook-health.yml',
      );
    }

    // Collect env key lines (deeper indentation than `env:` line itself)
    const envLineIndent = lines[envIdx].match(/^(\s*)/)?.[1]?.length ?? 0;
    const envLines: string[] = [lines[envIdx]];
    for (let i = envIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        envLines.push(line);
        continue;
      }
      const indent = line.match(/^(\s*)\S/)?.[1]?.length ?? 0;
      if (indent <= envLineIndent) break;
      envLines.push(line);
    }

    return envLines;
  }

  /**
   * Find the line that declares the given env var key, then assert that the
   * *same* line references the expected secret.  A cross-wired mapping such as
   *   SLACK_BOT_TOKEN: ${{ secrets.SLACK_WEBHOOK_URL }}
   * would fail even though both strings appear elsewhere in the block.
   */
  function assertEnvVarMapsToSecret(envVarName: string, secretName: string): void {
    const envLines = extractHeartbeatEnvLines();
    const declarationLine = envLines.find((l) =>
      new RegExp(`\\b${envVarName}\\s*:`).test(l),
    );
    expect(
      declarationLine,
      `Expected env block to contain a line declaring ${envVarName}`,
    ).toBeDefined();
    expect(
      declarationLine,
      `Expected ${envVarName} to be mapped to secrets.${secretName} on the same line`,
    ).toMatch(new RegExp(`secrets\\.${secretName}\\b`));
  }

  it("maps SLACK_BILLING_ALERTS_CHANNEL to secrets.SLACK_BILLING_ALERTS_CHANNEL on the same line", () => {
    assertEnvVarMapsToSecret("SLACK_BILLING_ALERTS_CHANNEL", "SLACK_BILLING_ALERTS_CHANNEL");
  });

  it("maps SLACK_BOT_TOKEN to secrets.SLACK_BOT_TOKEN on the same line", () => {
    assertEnvVarMapsToSecret("SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN");
  });

  it("maps SLACK_WEBHOOK_URL to secrets.SLACK_WEBHOOK_URL on the same line", () => {
    assertEnvVarMapsToSecret("SLACK_WEBHOOK_URL", "SLACK_WEBHOOK_URL");
  });
});
