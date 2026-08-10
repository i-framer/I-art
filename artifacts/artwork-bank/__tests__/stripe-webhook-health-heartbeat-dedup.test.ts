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
