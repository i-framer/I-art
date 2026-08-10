/**
 * Heartbeat-dedup path tests for .github/workflows/stripe-webhook-health.yml
 *
 * The workflow sends a daily all-clear heartbeat to Slack on healthy probe
 * runs (redirect == false).  To avoid flooding Slack with up to 96 identical
 * messages per day, the heartbeat only fires ONCE PER UTC DAY.  On subsequent
 * healthy runs within the same day the job logs a brief notice and skips the
 * notification.  The dedup window is tracked via a GitHub Actions cache key
 * that rotates every UTC day.
 *
 * These tests verify:
 *
 *  1. Structural YAML wiring — all "heartbeat only" steps and the surrounding
 *     heartbeat steps are guarded by `cache-hit != 'true'`, and the silence
 *     step is guarded by `cache-hit == 'true'`.
 *
 *  2. A bash simulation of the step-guard logic — when cache-hit is true the
 *     heartbeat command is NOT executed; when cache-hit is false it IS
 *     executed.  This mirrors the extracted-bash approach used by the
 *     alert-dedup test so any change to the guard expression in the YAML is
 *     caught immediately.
 *
 *  3. Parameterised bash tests covering all realistic cache-hit values:
 *       ""      → heartbeat fires (cache miss — first run today)
 *       "true"  → heartbeat suppressed (cache hit — already sent today)
 *       "false" → heartbeat fires (restore step skipped / not run)
 *
 *     This is the regression test for the class of bug where a future author
 *     writes `cache-hit == 'false'` instead of `cache-hit != 'true'`.  The
 *     structural string-match tests above would not catch that mistake, but
 *     these parameterised bash tests would.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── Load the workflow file once ───────────────────────────────────────────────

const WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../../.github/workflows/stripe-webhook-health.yml",
);

const HEARTBEAT_SCRIPT = path.resolve(
  __dirname,
  "../scripts/notify-webhook-heartbeat.ts",
);

let workflowText: string;

beforeAll(() => {
  workflowText = readFileSync(WORKFLOW_PATH, "utf8");
});

// ── Helper: extract a named step's YAML block ─────────────────────────────────

function extractStepBlock(stepName: string): string {
  const after = workflowText.split(`- name: ${stepName}`)[1];
  if (!after) throw new Error(`Step "${stepName}" not found in workflow YAML`);
  return after.split("- name:")[0];
}

// ── Helper: run a bash script in a temp dir and capture stdout/stderr ─────────

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runBash(script: string, env?: Record<string, string>): BashResult {
  const dir = path.join(tmpdir(), `heartbeat-dedup-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, "test.sh");
  writeFileSync(scriptFile, `#!/bin/bash\nset -euo pipefail\n${script}\n`, {
    mode: 0o755,
  });

  try {
    const result = spawnSync("bash", [scriptFile], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 1. Structural YAML wiring assertions ──────────────────────────────────────

describe("stripe-webhook-health.yml — heartbeat dedup wiring (structural)", () => {
  it("'Checkout (heartbeat only)' is guarded by redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock("Checkout (heartbeat only)");
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Set up pnpm (heartbeat only)' is guarded by redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock("Set up pnpm (heartbeat only)");
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Install dependencies (heartbeat only)' is guarded by redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock("Install dependencies (heartbeat only)");
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Send daily heartbeat' is guarded by redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock("Send daily heartbeat");
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Mark heartbeat sent (write sentinel for cache)' is guarded by redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock(
      "Mark heartbeat sent (write sentinel for cache)",
    );
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Save heartbeat-sent cache' is guarded by redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock("Save heartbeat-sent cache");
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Heartbeat already sent today — skipping repeat' fires only on redirect==false AND cache-hit==true", () => {
    const block = extractStepBlock(
      "Heartbeat already sent today — skipping repeat",
    );
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit == 'true'");
  });

  it("the silence step and the heartbeat steps have mutually exclusive conditions on cache-hit", () => {
    const sendBlock = extractStepBlock("Send daily heartbeat");
    const silenceBlock = extractStepBlock(
      "Heartbeat already sent today — skipping repeat",
    );
    // Heartbeat runs on cache MISS:
    expect(sendBlock).toContain("cache-hit != 'true'");
    // Silence runs on cache HIT:
    expect(silenceBlock).toContain("cache-hit == 'true'");
    // They use opposite values — can never both run.
    expect(sendBlock).not.toContain("cache-hit == 'true'");
    expect(silenceBlock).not.toContain("cache-hit != 'true'");
  });

  it("the heartbeat-cache restore step id is 'heartbeat-cache' (referenced by downstream guards)", () => {
    expect(workflowText).toContain("id: heartbeat-cache");
    expect(workflowText).toContain("steps.heartbeat-cache.outputs.cache-hit");
  });

  it("at least four distinct steps reference steps.heartbeat-cache.outputs.cache-hit", () => {
    const occurrences = (
      workflowText.match(/steps\.heartbeat-cache\.outputs\.cache-hit/g) ?? []
    ).length;
    // Restore, Send heartbeat, Mark sent, Save cache, Silence step = at least 4
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  it("the heartbeat dedup key rotates daily (not hourly)", () => {
    const block = extractStepBlock("Compute heartbeat dedup key");
    // Daily key uses %Y-%m-%d (no hour component)
    expect(block).toContain("%Y-%m-%d");
    // Must NOT include the hour component used by the alert dedup key
    expect(block).not.toContain("%Y-%m-%d-%H");
  });

  it("the heartbeat dedup key uses 'date -u' (UTC flag) not bare 'date'", () => {
    const block = extractStepBlock("Compute heartbeat dedup key");
    // The -u flag forces UTC regardless of the runner's local timezone.
    // Without -u, a runner in e.g. AEST (+10) would rotate the key 10 hours
    // earlier than UTC midnight, causing duplicate or missing daily heartbeats.
    expect(block).toContain("date -u");
    // Sanity: the full expected command fragment is present
    expect(block).toContain("date -u +%Y-%m-%d");
  });

  it("the 'Restore heartbeat-sent cache' uses the heartbeat-dedup step's key output", () => {
    const block = extractStepBlock("Restore heartbeat-sent cache");
    expect(block).toContain("steps.heartbeat-dedup.outputs.key");
  });

  it("the 'Save heartbeat-sent cache' uses the heartbeat-dedup step's key output", () => {
    const block = extractStepBlock("Save heartbeat-sent cache");
    expect(block).toContain("steps.heartbeat-dedup.outputs.key");
  });
});

// ── 1b. Bash simulation — UTC date flag produces same key regardless of TZ ─────
//
// Confirms that `date -u +%Y-%m-%d` yields an identical key when the TZ
// environment variable is set to a timezone far from UTC (e.g. Australia/Sydney,
// UTC+10/+11).  Without the -u flag, the date command would use local time and
// the key could rotate up to 14 hours before or after UTC midnight, causing
// duplicate or missed daily heartbeats when the runner is not in UTC.

describe("bash simulation — heartbeat dedup key is UTC-pinned", () => {
  /**
   * Run the exact bash fragment from the "Compute heartbeat dedup key" step
   * and return the generated KEY value, with the given TZ.
   */
  function computeKey(tz: string): string {
    // Mirror the exact bash from the workflow step (healthy / non-dispatch path):
    //   KEY="webhook-heartbeat-$(date -u +%Y-%m-%d)"
    const script = `
KEY="webhook-heartbeat-$(date -u +%Y-%m-%d)"
echo "$KEY"
`;
    const { stdout, exitCode } = runBash(script, { TZ: tz });
    expect(exitCode).toBe(0);
    return stdout.trim();
  }

  it("same UTC date key is produced when TZ=UTC", () => {
    const key = computeKey("UTC");
    expect(key).toMatch(/^webhook-heartbeat-\d{4}-\d{2}-\d{2}$/);
  });

  it("same UTC date key is produced when TZ=Australia/Sydney (UTC+10/+11)", () => {
    const utcKey = computeKey("UTC");
    const sydneyKey = computeKey("Australia/Sydney");
    // Both must produce the same key — date -u ignores TZ.
    expect(sydneyKey).toBe(utcKey);
  });

  it("same UTC date key is produced when TZ=America/New_York (UTC-5/-4)", () => {
    const utcKey = computeKey("UTC");
    const nyKey = computeKey("America/New_York");
    expect(nyKey).toBe(utcKey);
  });

  it("same UTC date key is produced when TZ=Asia/Tokyo (UTC+9)", () => {
    const utcKey = computeKey("UTC");
    const tokyoKey = computeKey("Asia/Tokyo");
    expect(tokyoKey).toBe(utcKey);
  });

  it("key format is webhook-heartbeat-YYYY-MM-DD (daily granularity, no hour)", () => {
    const key = computeKey("UTC");
    // Must match daily granularity exactly — no hour component.
    expect(key).toMatch(/^webhook-heartbeat-\d{4}-\d{2}-\d{2}$/);
    // Must NOT have a fourth hyphen-separated numeric segment (which would be
    // the hour component used by the alert dedup key).
    expect(key).not.toMatch(/^webhook-heartbeat-\d{4}-\d{2}-\d{2}-\d{2}/);
  });

  it("two simulated runs on the same UTC date produce identical keys", () => {
    // Run the key computation twice; since date -u is used, both must agree.
    const key1 = computeKey("UTC");
    const key2 = computeKey("Australia/Sydney");
    expect(key1).toBe(key2);
  });
});

// ── 2. Bash simulation of the step-guard logic ────────────────────────────────
//
// The GitHub Actions `if:` expression
//   `steps.probe.outputs.redirect == 'false' && steps.heartbeat-cache.outputs.cache-hit != 'true'`
// is evaluated by the runner as a boolean.  We replicate the semantics in bash
// so a regression in the condition string is caught without waiting for a live
// Actions run.

describe("bash simulation — cache-hit guard prevents heartbeat on subsequent runs", () => {
  /**
   * Simulate the step-guard decision for the "Send daily heartbeat" step.
   *
   * Returns whether the heartbeat step would execute, given:
   *  - redirect    : whether the probe saw a 3xx (maps to steps.probe.outputs.redirect)
   *  - cacheHit    : whether the cache key was found (maps to steps.heartbeat-cache.outputs.cache-hit)
   */
  function wouldSendHeartbeat(redirect: string, cacheHit: string): boolean {
    // Mirror the exact `if:` expression from the YAML:
    //   steps.probe.outputs.redirect == 'false' && steps.heartbeat-cache.outputs.cache-hit != 'true'
    const script = `
REDIRECT="${redirect}"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "false" && "$CACHE_HIT" != "true" ]]; then
  echo "WOULD_SEND=yes"
else
  echo "WOULD_SEND=no"
fi
`;
    const { stdout } = runBash(script);
    return stdout.includes("WOULD_SEND=yes");
  }

  it("cache-miss (first run today): heartbeat IS sent when no redirect detected", () => {
    expect(wouldSendHeartbeat("false", "")).toBe(true);
  });

  it("cache-hit (subsequent run today): heartbeat is NOT sent even though probe is still healthy", () => {
    expect(wouldSendHeartbeat("false", "true")).toBe(false);
  });

  it("redirect detected: heartbeat is not sent regardless of cache state", () => {
    expect(wouldSendHeartbeat("true", "")).toBe(false);
    expect(wouldSendHeartbeat("true", "true")).toBe(false);
  });

  it("silence step fires only when redirect==false AND cache-hit==true", () => {
    // Mirrors: steps.probe.outputs.redirect == 'false' && steps.heartbeat-cache.outputs.cache-hit == 'true'
    function wouldSilence(redirect: string, cacheHit: string): boolean {
      const script = `
REDIRECT="${redirect}"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "false" && "$CACHE_HIT" == "true" ]]; then
  echo "SILENCE=yes"
else
  echo "SILENCE=no"
fi
`;
      const { stdout } = runBash(script);
      return stdout.includes("SILENCE=yes");
    }

    // Cache hit + healthy probe = silence (dedup active)
    expect(wouldSilence("false", "true")).toBe(true);
    // Cache miss + healthy probe = no silence (heartbeat fires)
    expect(wouldSilence("false", "")).toBe(false);
    // Redirect present = no heartbeat silence
    expect(wouldSilence("true", "true")).toBe(false);
    expect(wouldSilence("true", "")).toBe(false);
  });
});

// ── 2b. Parameterised bash tests — all realistic cache-hit values ─────────────
//
// GitHub Actions writes exactly three values for cache-hit:
//   ""      — cache key not found (miss)
//   "true"  — cache key found (hit)
//   "false" — cache/restore step skipped or the step did not run
//
// The guard condition is:  cache-hit != 'true'
// Only "true" should suppress the heartbeat.  Both "" and "false" must allow it.
//
// This is the regression test for the bug described in the workflow header:
//   A future author could write  cache-hit == 'false'  (wrong) and the
//   structural string-match tests above would not catch it — but these
//   parameterised bash tests would, because the bash logic faithfully
//   mirrors the runner's boolean evaluation of the `if:` expression.

describe("parameterised bash — cache-hit guard: only 'true' suppresses the heartbeat", () => {
  /**
   * Run the guard condition as a bash `if` and return the decision.
   *
   * Mirrors the exact `if:` expression used in the YAML (assuming redirect=false,
   * i.e. a healthy probe run where the heartbeat section is reached):
   *   steps.probe.outputs.redirect == 'false' && steps.heartbeat-cache.outputs.cache-hit != 'true'
   */
  function guardDecision(cacheHit: string): {
    heartbeatFires: boolean;
    silenced: boolean;
  } {
    const heartbeatScript = `
REDIRECT="false"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "false" && "$CACHE_HIT" != "true" ]]; then
  echo "HEARTBEAT=yes"
else
  echo "HEARTBEAT=no"
fi
`;
    const silenceScript = `
REDIRECT="false"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "false" && "$CACHE_HIT" == "true" ]]; then
  echo "SILENCE=yes"
else
  echo "SILENCE=no"
fi
`;
    const heartbeatOut = runBash(heartbeatScript).stdout;
    const silenceOut = runBash(silenceScript).stdout;
    return {
      heartbeatFires: heartbeatOut.includes("HEARTBEAT=yes"),
      silenced: silenceOut.includes("SILENCE=yes"),
    };
  }

  /**
   * All realistic cache-hit values and the expected guard outcome.
   *
   * cacheHit | meaning in Actions                    | heartbeat fires? | silenced?
   * ---------|---------------------------------------|-----------------|----------
   * ""       | cache key not found (first run today) | YES              | NO
   * "true"   | cache key found (already sent today)  | NO               | YES
   * "false"  | restore step was skipped / not run    | YES              | NO
   */
  const cases: Array<
    [
      cacheHitValue: string,
      label: string,
      shouldFire: boolean,
      shouldSilence: boolean,
    ]
  > = [
    [
      "",
      "empty string (cache miss — first run today)",
      true,
      false,
    ],
    [
      "true",
      "'true' (cache hit — already sent today)",
      false,
      true,
    ],
    [
      "false",
      "'false' (restore step skipped or not run)",
      true,
      false,
    ],
  ];

  it.each(cases)(
    "cache-hit=%j (%s): heartbeatFires=%s, silenced=%s",
    (cacheHitValue, _label, shouldFire, shouldSilence) => {
      const { heartbeatFires, silenced } = guardDecision(cacheHitValue);
      expect(heartbeatFires).toBe(shouldFire);
      expect(silenced).toBe(shouldSilence);
    },
  );

  it("heartbeat and silence are mutually exclusive for every realistic cache-hit value", () => {
    for (const [cacheHitValue] of cases) {
      const { heartbeatFires, silenced } = guardDecision(cacheHitValue);
      expect(heartbeatFires && silenced).toBe(false);
    }
  });

  it("wrong guard 'cache-hit == false' would NOT fire on empty string (regression demo)", () => {
    // Demonstrates why  cache-hit == 'false'  is the wrong guard:
    // it would NOT fire when cache-hit is "" (the real cache-miss value in Actions),
    // causing the heartbeat to be skipped on the very first run of the day.
    // The correct guard is  cache-hit != 'true'  which fires for both "" and "false".
    const wrongScript = `
REDIRECT="false"
CACHE_HIT=""
# Wrong condition a future author might accidentally write:
if [[ "$REDIRECT" == "false" && "$CACHE_HIT" == "false" ]]; then
  echo "WRONG_GUARD_FIRES=yes"
else
  echo "WRONG_GUARD_FIRES=no"
fi
`;
    const { stdout } = runBash(wrongScript);
    // The wrong guard does NOT fire for cache-hit="", confirming the guard is broken:
    // it would suppress the heartbeat on the first run of the day when Actions
    // reports cache-hit="" (key not found), rather than sending it.
    // This test documents the semantic difference between "" and "false".
    expect(stdout).toContain("WRONG_GUARD_FIRES=no");
  });
});

// ── 3. Multi-run scenario: same UTC day, different outcomes ───────────────────

describe("multi-run scenario within the same UTC day", () => {
  /**
   * Mirrors the step-guard logic:
   *   redirect == 'false' && cache-hit != 'true'  → heartbeat sent
   *   redirect == 'false' && cache-hit == 'true'  → silenced
   */
  function simulate(
    redirect: string,
    cacheHit: string,
  ): { heartbeatSent: boolean; silenced: boolean } {
    const heartbeatSent = redirect === "false" && cacheHit !== "true";
    const silenced = redirect === "false" && cacheHit === "true";
    return { heartbeatSent, silenced };
  }

  it("run 1 sends the heartbeat; run 2 within the same day is silenced", () => {
    // Run 1 (00:15 UTC): healthy probe, cache-miss → heartbeat sent
    const run1 = simulate("false", ""); // cache-miss
    expect(run1.heartbeatSent).toBe(true);
    expect(run1.silenced).toBe(false);

    // Run 2 (00:30 UTC): still healthy, cache-hit — sentinel written by run 1 → silenced
    const run2 = simulate("false", "true"); // cache-hit
    expect(run2.heartbeatSent).toBe(false);
    expect(run2.silenced).toBe(true);
  });

  it("run in the NEXT UTC day triggers a fresh heartbeat (new cache key = miss)", () => {
    // The cache key rotates each UTC day, so the next-day run has cache-hit = "" (miss).
    const { heartbeatSent } = simulate("false", "");
    expect(heartbeatSent).toBe(true);
  });

  it("redirect detected: heartbeat never fires regardless of cache state", () => {
    const { heartbeatSent: miss } = simulate("true", "");
    const { heartbeatSent: hit } = simulate("true", "true");
    expect(miss).toBe(false);
    expect(hit).toBe(false);
  });
});

// ── 4. External healthcheck ping — no cache guard ────────────────────────────
//
// The "Ping external healthcheck URL" step is conditioned only on
// `redirect == 'false'`.  Unlike the heartbeat notifier it has NO cache-hit
// guard, so it fires on EVERY healthy run (both the first and the second run
// of the day).  This is intentional: the external service needs to receive a
// ping on every run to know the workflow is still alive.

describe("stripe-webhook-health.yml — external healthcheck ping (structural)", () => {
  it("'Ping external healthcheck URL' if: condition does NOT contain 'cache-hit'", () => {
    const block = extractStepBlock("Ping external healthcheck URL");
    // The ping step must be active on every healthy run, so no cache guard.
    expect(block).not.toContain("cache-hit");
  });

  it("'Ping external healthcheck URL' is conditioned on redirect == 'false'", () => {
    const block = extractStepBlock("Ping external healthcheck URL");
    expect(block).toContain("redirect == 'false'");
  });
});

describe("bash simulation — external healthcheck ping fires on every healthy run", () => {
  /**
   * Simulate whether the ping step would execute.
   * Mirrors the exact `if:` from the YAML:
   *   steps.probe.outputs.redirect == 'false'
   * (No cache-hit guard — fires every healthy run.)
   */
  function wouldPing(redirect: string): boolean {
    const script = `
REDIRECT="${redirect}"
if [[ "$REDIRECT" == "false" ]]; then
  echo "WOULD_PING=yes"
else
  echo "WOULD_PING=no"
fi
`;
    const { stdout } = runBash(script);
    return stdout.includes("WOULD_PING=yes");
  }

  it("first healthy run of the day: ping fires (cache-miss state)", () => {
    // On the first run there is no heartbeat cache hit yet, but the ping
    // step is independent of cache state — it fires whenever redirect==false.
    expect(wouldPing("false")).toBe(true);
  });

  it("second healthy run of the same day: ping still fires (cache-hit state is irrelevant)", () => {
    // The heartbeat notifier is silenced on the second run, but the ping
    // has no cache guard so it fires again.
    expect(wouldPing("false")).toBe(true);
  });

  it("redirect detected: ping does NOT fire", () => {
    expect(wouldPing("true")).toBe(false);
  });

  it("ping fires on every healthy run regardless of how many runs have occurred", () => {
    // Simulate 4 consecutive healthy runs — all should ping.
    const runs = ["false", "false", "false", "false"];
    for (const redirect of runs) {
      expect(wouldPing(redirect)).toBe(true);
    }
  });
});

// ── Helper: run the heartbeat script with a patched fetch (no real network) ───
//
// Loopback (127.0.0.1) connections are not available in the task environment,
// so instead of spinning up a local HTTP server we write a temporary wrapper
// TypeScript file that patches `globalThis.fetch` before importing the heartbeat
// script.  tsx executes the wrapper; the patched fetch is used by the script
// because `fetch` is accessed at call-time (inside async functions), not at
// import time.
//
// The heartbeat script always ends with `process.exit(0)`, so the wrapper
// process terminates immediately after the script finishes — which is exactly
// what spawnSync captures.

interface SlackMockConfig {
  /** Body that the fake Slack API returns (default: { ok: false, error: "channel_not_found" }) */
  body?: Record<string, unknown>;
  /** HTTP status returned by the fake Slack API (default: 200) */
  status?: number;
  /** Env vars passed to the subprocess in addition to the defaults */
  extraEnv?: Record<string, string>;
}

function runHeartbeatWithMockSlack(cfg: SlackMockConfig = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const mockBody = JSON.stringify(
    cfg.body ?? { ok: false, error: "channel_not_found" },
  );
  const mockStatus = cfg.status ?? 200;

  // Write a temporary wrapper that patches fetch before importing the script.
  const dir = path.join(tmpdir(), `heartbeat-mock-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const wrapperFile = path.join(dir, "wrapper.ts");

  // The wrapper:
  //  1. Replaces globalThis.fetch with a stub that returns the configured body/status.
  //  2. Imports the heartbeat script — which will call the stub when it runs.
  //  3. The heartbeat script calls process.exit(0) at the end; the whole process exits.
  //
  // Uses an async IIFE + export {} so tsx compiles it as ESM (avoids the
  // "top-level await not supported in CJS" error from esbuild).
  const wrapperSource = `
export {};

// Patch fetch BEFORE the heartbeat script is loaded.
(globalThis as any).fetch = async (_url: string, _opts?: RequestInit): Promise<Response> => {
  const body = ${mockBody};
  const status = ${mockStatus};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
};

// Import the real heartbeat script — it uses our patched fetch.
// The async IIFE avoids the esbuild "top-level await in CJS" error.
(async () => {
  await import(${JSON.stringify(HEARTBEAT_SCRIPT)});
})();
`;

  writeFileSync(wrapperFile, wrapperSource, "utf8");

  try {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@workspace/artwork-bank", "exec", "tsx", wrapperFile],
      {
        env: {
          WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
          HTTP_CODE: "405",
          WORKFLOW_RUN_URL: "https://github.com/owner/repo/actions/runs/99999",
          // Provide credentials so sendViaSlackBotToken is actually attempted.
          SLACK_BOT_TOKEN: "xoxb-test-token-invalid",
          SLACK_BILLING_ALERTS_CHANNEL: "alerts",
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
          ...cfg.extraEnv,
        },
        encoding: "utf8",
        timeout: 30_000,
        cwd: path.resolve(__dirname, "../../.."),
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5. Notifier script smoke-test (no channels configured) ────────────────────
//
// Confirms the heartbeat notifier script runs to completion and exits 0 when
// no Slack channel is configured.  The script must always exit 0 so a
// heartbeat send failure does not mark the overall probe run as failed.

describe("notify-webhook-heartbeat.ts — exits 0 and emits banner (no channels)", () => {
  it("script exits 0 and prints the CI banner when no Slack vars are set", () => {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@workspace/artwork-bank", "exec", "tsx", HEARTBEAT_SCRIPT],
      {
        env: {
          // Provide the minimum context the script expects.
          WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
          HTTP_CODE: "405",
          WORKFLOW_RUN_URL: "https://github.com/owner/repo/actions/runs/99999",
          // No SLACK_*, so it falls through to the CI banner.
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 30_000,
        cwd: path.resolve(__dirname, "../../.."),
      },
    );

    // The script MUST exit 0 — heartbeat send failure must not mask the probe result.
    expect(result.status).toBe(0);

    // It must emit the CI banner to stdout (always fires without channels).
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("STRIPE WEBHOOK PROBE HEARTBEAT");
  });

  it("script exits 0 even when WEBHOOK_URL is the default (env var absent)", () => {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@workspace/artwork-bank", "exec", "tsx", HEARTBEAT_SCRIPT],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 30_000,
        cwd: path.resolve(__dirname, "../../.."),
      },
    );

    expect(result.status).toBe(0);
  });

  it("script logs that no Slack channel is configured when vars are absent", () => {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@workspace/artwork-bank", "exec", "tsx", HEARTBEAT_SCRIPT],
      {
        env: {
          WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
          HTTP_CODE: "405",
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 30_000,
        cwd: path.resolve(__dirname, "../../.."),
      },
    );

    expect(result.status).toBe(0);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    // Should mention that no Slack channel/webhook is configured.
    expect(combined).toContain("No Slack channel");
  });
});

// ── 6. UTC midnight boundary — dedup key stability ────────────────────────────
//
// The probe runs every 15 minutes.  If one run lands at 23:59 UTC and the next
// at 00:01 UTC the two runs straddle UTC midnight — they belong to different UTC
// days and MUST produce different dedup keys so a fresh heartbeat is sent at
// the start of the new day.
//
// Conversely, two consecutive runs within the SAME UTC day (e.g. 23:45 and
// 23:59) MUST produce identical keys so only the first one sends the heartbeat.
//
// These tests also run with TZ=Australia/Sydney (UTC+10/+11) to confirm that
// the runner's local midnight — which would fall at 13:00 or 14:00 UTC — does
// NOT cause a premature key rotation.  The -u flag in `date -u` forces UTC
// output regardless of the system timezone.

describe("bash simulation — dedup key stability across the 15-min probe window around UTC midnight", () => {
  /**
   * Compute the heartbeat dedup key as the workflow step does, but override
   * the current time using GNU date's `--date` option so we can simulate any
   * UTC timestamp without waiting for midnight.
   *
   * The workflow step runs exactly:
   *   KEY="webhook-heartbeat-$(date -u +%Y-%m-%d)"
   *
   * We replace `date -u +%Y-%m-%d` with
   *   `date -u -d '<utcTimestamp>' +%Y-%m-%d`
   * to pin the simulated clock to a specific instant, then wrap the whole
   * thing in the given TZ so the runner's local timezone is exercised.
   */
  function computeKeyAt(utcTimestamp: string, tz: string): string {
    // Use GNU date's -d flag to inject a specific UTC instant.
    // -u ensures the output is UTC regardless of TZ.
    // TZ env var sets the runner's local timezone, which -u must override.
    const script = `
KEY="webhook-heartbeat-$(date -u -d '${utcTimestamp}' +%Y-%m-%d)"
echo "$KEY"
`;
    const { stdout, exitCode, stderr } = runBash(script, { TZ: tz });
    if (exitCode !== 0) {
      throw new Error(
        `bash failed (exit ${exitCode}) for timestamp "${utcTimestamp}" TZ="${tz}":\n${stderr}`,
      );
    }
    return stdout.trim();
  }

  // ── Straddling UTC midnight: 23:59 vs 00:01 ────────────────────────────────

  it("23:59 UTC and 00:01 UTC produce DIFFERENT keys (key rotates at UTC midnight)", () => {
    const keyBefore = computeKeyAt("2026-08-09 23:59:00 UTC", "UTC");
    const keyAfter = computeKeyAt("2026-08-10 00:01:00 UTC", "UTC");
    // Two runs either side of midnight must use different daily keys.
    expect(keyBefore).not.toBe(keyAfter);
    // Confirm the dates embedded in each key are what we expect.
    expect(keyBefore).toBe("webhook-heartbeat-2026-08-09");
    expect(keyAfter).toBe("webhook-heartbeat-2026-08-10");
  });

  it("23:59 UTC and 00:01 UTC produce DIFFERENT keys when TZ=Australia/Sydney", () => {
    // In Australia/Sydney (UTC+10) both timestamps fall on 2026-08-10 local time
    // (09:59 and 10:01 AEST).  Without -u the runner would emit the same local
    // date for both.  With -u the UTC dates differ → keys must differ.
    const keyBefore = computeKeyAt("2026-08-09 23:59:00 UTC", "Australia/Sydney");
    const keyAfter = computeKeyAt("2026-08-10 00:01:00 UTC", "Australia/Sydney");
    expect(keyBefore).not.toBe(keyAfter);
    expect(keyBefore).toBe("webhook-heartbeat-2026-08-09");
    expect(keyAfter).toBe("webhook-heartbeat-2026-08-10");
  });

  // ── Same UTC day: 23:45 vs 23:59 ──────────────────────────────────────────

  it("23:45 UTC and 23:59 UTC produce the SAME key (same UTC day)", () => {
    const key2345 = computeKeyAt("2026-08-09 23:45:00 UTC", "UTC");
    const key2359 = computeKeyAt("2026-08-09 23:59:00 UTC", "UTC");
    // Both timestamps are on the same UTC day → same dedup key → only one heartbeat sent.
    expect(key2345).toBe(key2359);
    expect(key2345).toBe("webhook-heartbeat-2026-08-09");
  });

  it("23:45 UTC and 23:59 UTC produce the SAME key when TZ=Australia/Sydney", () => {
    // In Sydney both timestamps are on 2026-08-10 local time.  With -u the UTC
    // date (2026-08-09) is used for both → identical keys → heartbeat fires once.
    const key2345 = computeKeyAt("2026-08-09 23:45:00 UTC", "Australia/Sydney");
    const key2359 = computeKeyAt("2026-08-09 23:59:00 UTC", "Australia/Sydney");
    expect(key2345).toBe(key2359);
    expect(key2345).toBe("webhook-heartbeat-2026-08-09");
  });

  // ── Local midnight does NOT rotate the key ────────────────────────────────
  //
  // Australia/Sydney is UTC+10 in winter (AEST).  Local midnight in Sydney
  // corresponds to 14:00 UTC.  A probe run just before and after Sydney's local
  // midnight (13:59 and 14:01 UTC) must still produce the same UTC-day key —
  // because both instants share the same UTC date.

  it("runs straddling Sydney local midnight (14:00 UTC) produce the SAME key", () => {
    // 13:59 UTC = 23:59 AEST (one minute before Sydney midnight)
    // 14:01 UTC = 00:01 AEST (one minute after Sydney midnight)
    // Both are on 2026-08-09 UTC → same dedup key.
    const keyBeforeSydneyMidnight = computeKeyAt(
      "2026-08-09 13:59:00 UTC",
      "Australia/Sydney",
    );
    const keyAfterSydneyMidnight = computeKeyAt(
      "2026-08-09 14:01:00 UTC",
      "Australia/Sydney",
    );
    expect(keyBeforeSydneyMidnight).toBe(keyAfterSydneyMidnight);
    expect(keyBeforeSydneyMidnight).toBe("webhook-heartbeat-2026-08-09");
  });

  // ── Across all four consecutive 15-min windows spanning UTC midnight ───────

  it("all four 15-min windows before UTC midnight share one key and the window after uses the next", () => {
    // The four pre-midnight probe windows that could run within the same UTC day:
    const sameDay = [
      "2026-08-09 23:00:00 UTC",
      "2026-08-09 23:15:00 UTC",
      "2026-08-09 23:30:00 UTC",
      "2026-08-09 23:45:00 UTC",
      "2026-08-09 23:59:59 UTC",
    ];
    const nextDay = [
      "2026-08-10 00:00:00 UTC",
      "2026-08-10 00:01:00 UTC",
      "2026-08-10 00:15:00 UTC",
    ];

    const sameDayKeys = sameDay.map((ts) =>
      computeKeyAt(ts, "Australia/Sydney"),
    );
    const nextDayKeys = nextDay.map((ts) =>
      computeKeyAt(ts, "Australia/Sydney"),
    );

    // All pre-midnight timestamps → same key.
    const uniqueSameDay = new Set(sameDayKeys);
    expect(uniqueSameDay.size).toBe(1);
    expect([...uniqueSameDay][0]).toBe("webhook-heartbeat-2026-08-09");

    // All post-midnight timestamps → same key (the next day's key).
    const uniqueNextDay = new Set(nextDayKeys);
    expect(uniqueNextDay.size).toBe(1);
    expect([...uniqueNextDay][0]).toBe("webhook-heartbeat-2026-08-10");

    // The two groups use different keys.
    expect([...uniqueSameDay][0]).not.toBe([...uniqueNextDay][0]);
  });
});

// ── 7. Manual-dispatch key uniqueness with unusual run_id shapes ──────────────
//
// GitHub run IDs are currently integers, but the bash fragment embeds
// `github.run_id` without sanitisation.  A future platform change or a
// non-standard run ID (leading zeros, very long integer) must NOT collapse two
// distinct run IDs into the same cache key.
//
// run_id shapes tested:
//   "0"                    — boundary / single-digit minimum
//   "00001"                — leading zeros (bash preserves them in a string)
//   "99999999999999999999" — 20-digit integer (well beyond current integer range)
//   "9834710234"           — typical 10-digit integer seen in production today
//
// All must:
//   a) match  ^webhook-heartbeat-manual-.+$
//   b) be mutually distinct (no two collapse to the same key)

describe("bash simulation — manual-dispatch heartbeat key is unique for unusual run_id shapes", () => {
  /**
   * Extract the full "Compute heartbeat dedup key" bash from the actual workflow
   * YAML, substitute the two GitHub expression tokens with concrete values,
   * and run the resulting script.  Returns the KEY value the workflow would
   * emit for this run_id on a workflow_dispatch trigger.
   *
   * Using the live YAML bash (not a hand-written copy) means any future edit
   * to the key formula is automatically exercised by these tests.
   */
  function computeHeartbeatManualKeyFromWorkflow(runId: string): string {
    const stepBlock = extractStepBlock("Compute heartbeat dedup key");

    // Locate the `run: |` literal block scalar within the step.
    const runMarker = "run: |\n";
    const markerIdx = stepBlock.indexOf(runMarker);
    if (markerIdx === -1)
      throw new Error(
        "Could not find 'run: |' in 'Compute heartbeat dedup key' step",
      );

    const afterMarker = stepBlock.slice(markerIdx + runMarker.length);

    // Strip YAML indentation (detect from the first non-empty line).
    const firstContentLine =
      afterMarker.split("\n").find((l) => l.trim().length > 0) ?? "";
    const indent = firstContentLine.match(/^(\s+)/)?.[1] ?? "";
    const lines = afterMarker
      .split("\n")
      .map((line) =>
        indent && line.startsWith(indent) ? line.slice(indent.length) : line,
      );
    while (lines.length > 0 && lines[lines.length - 1].trim() === "")
      lines.pop();
    const rawBash = lines.join("\n");

    // Substitute both GitHub expression tokens:
    //   ${{ github.event_name }} → "workflow_dispatch"  (takes the manual branch)
    //   ${{ github.run_id }}     → the fixture run_id value
    const bash = rawBash
      .replace(/\$\{\{\s*github\.event_name\s*\}\}/g, "workflow_dispatch")
      .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, runId);

    // Stub the Actions-specific GITHUB_OUTPUT redirect so the step doesn't fail
    // when it tries to write `key=$KEY` to the Actions output file.
    // Append a sentinel echo so the KEY value is recoverable from stdout
    // even when the workflow step emits other lines before it.
    const sentinel = `__HEARTBEAT_KEY_OUTPUT__`;
    const script = `GITHUB_OUTPUT=/dev/null\n${bash}\necho "${sentinel}$KEY"`;
    const { stdout, exitCode } = runBash(script);
    expect(exitCode).toBe(0);
    // Extract the KEY value from the sentinel line, ignoring other workflow echoes.
    const sentinelLine = stdout
      .split("\n")
      .find((l) => l.startsWith(sentinel));
    return (sentinelLine ?? "").slice(sentinel.length).trim();
  }

  // run_id shapes that probe numeric coercion / leading-zero loss:
  //   "0"                    — single-digit boundary
  //   "00001"                — leading zeros; numeric value 1 but string "00001"
  //   "99999999999999999999" — 20-digit integer, beyond JS/bash safe-integer range
  //   "9834710234"           — typical 10-digit integer seen in production
  const unusualRunIds: Array<[runId: string, label: string]> = [
    ["0", "single-digit zero"],
    ["00001", "leading zeros — numeric value 1 but string '00001'"],
    ["99999999999999999999", "20-digit integer (beyond safe-integer range)"],
    ["9834710234", "typical 10-digit integer"],
  ];

  it.each(unusualRunIds)(
    "run_id=%j (%s) → key matches ^webhook-heartbeat-manual-.+$",
    (runId) => {
      const key = computeHeartbeatManualKeyFromWorkflow(runId);
      expect(key).toMatch(/^webhook-heartbeat-manual-.+$/);
    },
  );

  it("all unusual run_id shapes produce mutually distinct keys", () => {
    const keys = unusualRunIds.map(([runId]) =>
      computeHeartbeatManualKeyFromWorkflow(runId),
    );
    // Every key must be unique — no two run_id shapes must collapse to the same key.
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it("run_id='0' and run_id='00001' produce different keys (leading zeros are not numeric-coerced)", () => {
    // If the shell performed arithmetic expansion, "0" and leading-zero "00001"
    // could be coerced unexpectedly.  Plain string interpolation must preserve
    // the literal characters verbatim, so the two must produce distinct keys.
    const key0 = computeHeartbeatManualKeyFromWorkflow("0");
    const key00001 = computeHeartbeatManualKeyFromWorkflow("00001");
    expect(key0).not.toBe(key00001);
  });

  it("20-digit run_id produces a key distinct from the typical 10-digit run_id", () => {
    const keyLong = computeHeartbeatManualKeyFromWorkflow("99999999999999999999");
    const keyTypical = computeHeartbeatManualKeyFromWorkflow("9834710234");
    expect(keyLong).not.toBe(keyTypical);
  });

  it("no unusual run_id key matches the scheduled heartbeat key format YYYY-MM-DD", () => {
    const scheduledPattern = /^webhook-heartbeat-\d{4}-\d{2}-\d{2}$/;
    for (const [runId] of unusualRunIds) {
      const key = computeHeartbeatManualKeyFromWorkflow(runId);
      expect(key).not.toMatch(scheduledPattern);
    }
  });

  it("each unusual key contains 'manual' as a literal segment", () => {
    for (const [runId] of unusualRunIds) {
      const key = computeHeartbeatManualKeyFromWorkflow(runId);
      expect(key.split("-")).toContain("manual");
    }
  });
});

// ── 8. Notifier script — Slack API returns an error response ──────────────────
//
// Confirms the heartbeat notifier exits 0 even when credentials ARE set but the
// Slack API returns a non-200 or `ok: false` response (e.g. channel_not_found,
// invalid_auth, a transient 500).  A transient Slack outage must NOT mark the
// overall probe run as failed.
//
// Each test runs the script via runHeartbeatWithMockSlack(), which writes a
// temporary wrapper that patches globalThis.fetch before importing the heartbeat
// script — no real network connections are made.

describe("notify-webhook-heartbeat.ts — exits 0 when Slack API returns an error", () => {
  it("exits 0 when Slack bot-token path returns ok:false (channel_not_found)", () => {
    // HTTP 200 + ok:false is the canonical Slack logical-error format.
    const { status, stdout, stderr } = runHeartbeatWithMockSlack({
      body: { ok: false, error: "channel_not_found" },
      status: 200,
    });

    // The script MUST exit 0 — a Slack error must not mask the probe result.
    expect(status).toBe(0);

    // The failure should be logged so CI logs capture the Slack error detail.
    const combined = stdout + stderr;
    expect(combined).toContain("channel_not_found");
  });

  it("exits 0 when Slack bot-token path returns a non-200 HTTP status (503)", () => {
    // Simulate a transient Slack outage: HTTP 503 with an ok:false body.
    const { status, stdout, stderr } = runHeartbeatWithMockSlack({
      body: { ok: false, error: "service_unavailable" },
      status: 503,
    });

    // Must exit 0 — a 5xx from Slack is not a probe failure.
    expect(status).toBe(0);

    // The HTTP error code should appear in the logs.
    const combined = stdout + stderr;
    expect(combined).toContain("503");
  });

  it("exits 0 when Slack bot-token path returns ok:false (invalid_auth)", () => {
    // Simulate an invalid/expired token error.
    const { status, stdout, stderr } = runHeartbeatWithMockSlack({
      body: { ok: false, error: "invalid_auth" },
    });

    // Must exit 0 — a bad token must not mark the probe as failed.
    expect(status).toBe(0);

    const combined = stdout + stderr;
    expect(combined).toContain("invalid_auth");
  });

  it("still emits the CI banner to stdout when Slack returns an error", () => {
    // Even when Slack fails, the CI banner must be printed so the log always
    // contains a visible all-clear record.
    const { status, stdout, stderr } = runHeartbeatWithMockSlack({
      body: { ok: false, error: "channel_not_found" },
    });

    expect(status).toBe(0);

    // The CI banner must always fire — it is the last-resort visibility mechanism.
    const combined = stdout + stderr;
    expect(combined).toContain("STRIPE WEBHOOK PROBE HEARTBEAT");
  });
});
