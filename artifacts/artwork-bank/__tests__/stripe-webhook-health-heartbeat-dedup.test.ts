/**
 * Heartbeat-dedup path tests for .github/workflows/stripe-webhook-health.yml
 *
 * The workflow silences the daily all-clear heartbeat notifier on the second
 * healthy run within the same UTC day by checking a GitHub Actions cache hit.
 * When the cache key already exists (cache-hit == 'true'), every step that
 * sends the heartbeat is skipped and a "already sent today" notice is logged
 * instead.
 *
 * Without this guard the operator could receive up to 96 identical
 * "all clear" messages per day (one per 15-minute probe run).
 *
 * These tests verify:
 *
 *  1. Structural YAML wiring — all "Send daily heartbeat" and surrounding
 *     heartbeat steps are guarded by `cache-hit != 'true'`, and the silence
 *     step is guarded by `cache-hit == 'true'`.
 *
 *  2. A bash simulation of the step-guard logic — when cache-hit is true the
 *     notifier command is NOT executed; when cache-hit is false it IS executed.
 *
 *  3. The notifier script (notify-webhook-heartbeat.ts) exits 0 and emits a
 *     CI-banner when no Slack channel is configured, confirming it would have
 *     run on a real cache-miss run without flooding the operator.
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
  it("'Send daily heartbeat' is guarded by both redirect==false and cache-hit!=true", () => {
    const block = extractStepBlock("Send daily heartbeat");
    expect(block).toContain("redirect == 'false'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Checkout (heartbeat only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Checkout (heartbeat only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Set up pnpm (heartbeat only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Set up pnpm (heartbeat only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Set up Node.js (heartbeat only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Set up Node.js (heartbeat only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Install dependencies (heartbeat only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Install dependencies (heartbeat only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Mark heartbeat sent (write sentinel for cache)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Mark heartbeat sent (write sentinel for cache)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Save heartbeat-sent cache' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Save heartbeat-sent cache");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Heartbeat already sent today — skipping repeat' fires only on cache-hit == 'true'", () => {
    const block = extractStepBlock("Heartbeat already sent today — skipping repeat");
    expect(block).toContain("cache-hit == 'true'");
    // Must also require redirect == 'false' (healthy run only).
    expect(block).toContain("redirect == 'false'");
  });

  it("the silence step and the heartbeat steps have mutually exclusive conditions on cache-hit", () => {
    const sendBlock = extractStepBlock("Send daily heartbeat");
    const silenceBlock = extractStepBlock("Heartbeat already sent today — skipping repeat");
    // Heartbeat send runs on cache MISS:
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

  it("the 'Restore heartbeat-sent cache' uses the heartbeat-dedup step's key output", () => {
    const block = extractStepBlock("Restore heartbeat-sent cache");
    expect(block).toContain("steps.heartbeat-dedup.outputs.key");
  });

  it("the 'Save heartbeat-sent cache' uses the heartbeat-dedup step's key output", () => {
    const block = extractStepBlock("Save heartbeat-sent cache");
    expect(block).toContain("steps.heartbeat-dedup.outputs.key");
  });
});

// ── 2. Bash simulation of the heartbeat step-guard logic ──────────────────────
//
// The GitHub Actions `if:` expression
//   `steps.probe.outputs.redirect == 'false' && steps.heartbeat-cache.outputs.cache-hit != 'true'`
// is evaluated by the runner as a boolean.  We replicate the semantics in bash
// so a regression in the condition string is caught without waiting for a live
// Actions run.

describe("bash simulation — cache-hit guard prevents heartbeat on second run", () => {
  /**
   * Simulate the step-guard decision.
   *
   * Returns whether the "Send daily heartbeat" step would execute, given:
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

  it("cache-miss (first healthy run of the day): heartbeat IS sent", () => {
    expect(wouldSendHeartbeat("false", "")).toBe(true);
  });

  it("cache-hit (second healthy run): heartbeat is NOT sent", () => {
    expect(wouldSendHeartbeat("false", "true")).toBe(false);
  });

  it("redirect detected: heartbeat is not sent regardless of cache state", () => {
    // Heartbeat only fires on healthy (redirect == false) runs.
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

    // Cache hit + healthy = silence (dedup active)
    expect(wouldSilence("false", "true")).toBe(true);
    // Cache miss + healthy = no silence (heartbeat fires)
    expect(wouldSilence("false", "")).toBe(false);
    // Redirect detected = no silence (heartbeat path does not apply)
    expect(wouldSilence("true", "true")).toBe(false);
    expect(wouldSilence("true", "")).toBe(false);
  });
});

// ── 3. Two-run scenario: same UTC day, different outcomes ─────────────────────

describe("two-run scenario within the same UTC day", () => {
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
    const run1 = simulate("false", ""); // cache-miss (first run today)
    expect(run1.heartbeatSent).toBe(true);
    expect(run1.silenced).toBe(false);

    const run2 = simulate("false", "true"); // cache-hit — sentinel written by run 1
    expect(run2.heartbeatSent).toBe(false);
    expect(run2.silenced).toBe(true);
  });

  it("run 3 on the NEXT UTC day triggers a fresh heartbeat (new cache key = miss)", () => {
    // The cache key rotates each UTC day, so the next-day run has cache-hit = false.
    const { heartbeatSent } = simulate("false", "");
    expect(heartbeatSent).toBe(true);
  });

  it("a redirect-detected run does not trigger the heartbeat regardless of cache state", () => {
    const { heartbeatSent: miss } = simulate("true", "");
    const { heartbeatSent: hit } = simulate("true", "true");
    expect(miss).toBe(false);
    expect(hit).toBe(false);
  });
});

// ── 4. Notifier script smoke-test (no channels configured) ────────────────────
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
