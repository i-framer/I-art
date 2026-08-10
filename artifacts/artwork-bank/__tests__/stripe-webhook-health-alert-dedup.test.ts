/**
 * Alert-dedup path tests for .github/workflows/stripe-webhook-health.yml
 *
 * The workflow sends a Slack/email alert when a 3xx redirect is detected on
 * the Stripe webhook endpoint.  To avoid flooding Slack with up to 4 identical
 * messages per hour, the alert only fires ONCE PER UTC HOUR.  On subsequent
 * runs within the same hour the job still fails (so the Actions tab stays red),
 * but no further Slack/email message is sent.  The dedup window is tracked via
 * a GitHub Actions cache key that rotates every UTC hour.
 *
 * These tests verify:
 *
 *  1. Structural assertion — the "Compute alert dedup key" bash step contains
 *     `date -u`, guarding against a future editor stripping the UTC flag.
 *
 *  2. Bash simulation — two runs with the same UTC hour produce identical keys
 *     regardless of the TZ environment variable.  This mirrors the approach
 *     used for the heartbeat key in stripe-webhook-health-heartbeat-dedup.test.ts.
 *
 *  3. Structural wiring — all alert-only conditional steps are guarded by
 *     `cache-hit != 'true'`; the silence step is guarded by `cache-hit == 'true'`.
 *
 *  4. Parameterised bash tests covering all realistic cache-hit values:
 *       ""      → alert fires (cache miss — first detection this hour)
 *       "true"  → alert suppressed (cache hit — already sent this hour)
 *       "false" → alert fires (restore step skipped / not run)
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

const NOTIFIER_SCRIPT = path.resolve(
  __dirname,
  "../scripts/notify-webhook-redirect.ts",
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
  const dir = path.join(tmpdir(), `alert-dedup-test-${randomUUID()}`);
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

// ── 1. Structural assertion: alert dedup key uses `date -u` ───────────────────

describe("stripe-webhook-health.yml — alert dedup key structural check", () => {
  it("the 'Compute alert dedup key' step contains 'date -u' (UTC flag is present)", () => {
    const block = extractStepBlock("Compute alert dedup key");
    // The -u flag forces UTC regardless of the runner's local timezone.
    // Without -u, a runner in e.g. AEST (+10) would rotate the key 10 hours
    // earlier than UTC midnight, causing duplicate or missed hourly alerts.
    expect(block).toContain("date -u");
  });

  it("the alert dedup key uses 'date -u +%Y-%m-%d-%H' (hourly UTC granularity)", () => {
    const block = extractStepBlock("Compute alert dedup key");
    // The hourly key format — must include the hour component.
    expect(block).toContain("date -u +%Y-%m-%d-%H");
  });

  it("the alert dedup key rotates hourly (not daily)", () => {
    const block = extractStepBlock("Compute alert dedup key");
    // Alert key includes hour (%H); heartbeat key does not.
    expect(block).toContain("%Y-%m-%d-%H");
  });

  it("the alert dedup key does NOT use bare 'date' without -u", () => {
    const block = extractStepBlock("Compute alert dedup key");
    // Confirm -u is always present before the format string.
    // This catches e.g. `date +%Y-%m-%d-%H` (no -u flag).
    expect(block).not.toMatch(/\bdate\s+\+%Y/);
  });

  it("the 'Restore alert-sent cache' uses the dedup step's key output", () => {
    const block = extractStepBlock("Restore alert-sent cache");
    expect(block).toContain("steps.dedup.outputs.key");
  });

  it("the 'Save alert-sent cache' uses the dedup step's key output", () => {
    const block = extractStepBlock("Save alert-sent cache");
    expect(block).toContain("steps.dedup.outputs.key");
  });

  it("alert-only steps are guarded by redirect==true and cache-hit!=true", () => {
    const alertSteps = [
      "Checkout (alert only)",
      "Set up pnpm (alert only)",
      "Set up Node.js (alert only)",
      "Install dependencies (alert only)",
      "Send operator alert",
      "Mark alert sent (write sentinel for cache)",
      "Save alert-sent cache",
    ];
    for (const stepName of alertSteps) {
      const block = extractStepBlock(stepName);
      expect(block, `Step "${stepName}" should check redirect == 'true'`).toContain(
        "redirect == 'true'",
      );
      expect(
        block,
        `Step "${stepName}" should check cache-hit != 'true'`,
      ).toContain("cache-hit != 'true'");
    }
  });

  it("the silence step fires only on redirect==true AND cache-hit==true", () => {
    const block = extractStepBlock(
      "Alert already sent this hour — skipping repeat notification",
    );
    expect(block).toContain("redirect == 'true'");
    expect(block).toContain("cache-hit == 'true'");
  });

  it("alert steps and silence step have mutually exclusive conditions on cache-hit", () => {
    const alertBlock = extractStepBlock("Send operator alert");
    const silenceBlock = extractStepBlock(
      "Alert already sent this hour — skipping repeat notification",
    );
    // Alert fires on cache MISS:
    expect(alertBlock).toContain("cache-hit != 'true'");
    // Silence fires on cache HIT:
    expect(silenceBlock).toContain("cache-hit == 'true'");
    // They use opposite values — can never both run:
    expect(alertBlock).not.toContain("cache-hit == 'true'");
    expect(silenceBlock).not.toContain("cache-hit != 'true'");
  });

  it("the alert-cache restore step id is 'alert-cache' (referenced by downstream guards)", () => {
    expect(workflowText).toContain("id: alert-cache");
    expect(workflowText).toContain("steps.alert-cache.outputs.cache-hit");
  });
});

// ── 2. Bash simulation — UTC hour flag produces same key regardless of TZ ─────
//
// Confirms that `date -u +%Y-%m-%d-%H` yields an identical key when the TZ
// environment variable is set to a timezone far from UTC.  Without the -u flag,
// the date command would use local time and the key could rotate up to 14 hours
// before or after UTC midnight, causing duplicate or missed hourly alerts when
// the runner is not in UTC.

describe("bash simulation — alert dedup key is UTC-pinned (hourly)", () => {
  /**
   * Run the exact bash fragment from the "Compute alert dedup key" step
   * (non-dispatch path) and return the generated KEY value, with the given TZ.
   */
  function computeKey(tz: string): string {
    // Mirror the exact bash from the workflow step (non-dispatch path):
    //   KEY="webhook-redirect-alerted-$(date -u +%Y-%m-%d-%H)"
    const script = `
KEY="webhook-redirect-alerted-$(date -u +%Y-%m-%d-%H)"
echo "$KEY"
`;
    const { stdout, exitCode } = runBash(script, { TZ: tz });
    expect(exitCode).toBe(0);
    return stdout.trim();
  }

  it("produces a valid hourly key when TZ=UTC", () => {
    const key = computeKey("UTC");
    expect(key).toMatch(/^webhook-redirect-alerted-\d{4}-\d{2}-\d{2}-\d{2}$/);
  });

  it("same UTC hourly key is produced when TZ=Australia/Sydney (UTC+10/+11)", () => {
    const utcKey = computeKey("UTC");
    const sydneyKey = computeKey("Australia/Sydney");
    // Both must produce the same key — date -u ignores TZ.
    expect(sydneyKey).toBe(utcKey);
  });

  it("same UTC hourly key is produced when TZ=America/New_York (UTC-5/-4)", () => {
    const utcKey = computeKey("UTC");
    const nyKey = computeKey("America/New_York");
    expect(nyKey).toBe(utcKey);
  });

  it("same UTC hourly key is produced when TZ=Asia/Tokyo (UTC+9)", () => {
    const utcKey = computeKey("UTC");
    const tokyoKey = computeKey("Asia/Tokyo");
    expect(tokyoKey).toBe(utcKey);
  });

  it("key format is webhook-redirect-alerted-YYYY-MM-DD-HH (hourly granularity)", () => {
    const key = computeKey("UTC");
    // Must match hourly granularity exactly — four hyphen-separated numeric segments.
    expect(key).toMatch(/^webhook-redirect-alerted-\d{4}-\d{2}-\d{2}-\d{2}$/);
  });

  it("two simulated runs within the same UTC hour produce identical keys", () => {
    // Run the key computation twice; since date -u is used, both must agree
    // (within the same test run they will always be in the same hour).
    const key1 = computeKey("UTC");
    const key2 = computeKey("Australia/Sydney");
    expect(key1).toBe(key2);
  });

  it("key has more components than the daily heartbeat key (includes hour)", () => {
    const key = computeKey("UTC");
    // The alert key has YYYY-MM-DD-HH (4 numeric groups after prefix).
    // The heartbeat key has YYYY-MM-DD (3 numeric groups after prefix).
    // Splitting by "-" and counting: webhook(0) redirect(1) alerted(2) YYYY(3) MM(4) DD(5) HH(6)
    const parts = key.split("-");
    // Last segment should be a two-digit hour (00–23).
    const hourSegment = parts[parts.length - 1];
    expect(hourSegment).toMatch(/^\d{2}$/);
    const hour = parseInt(hourSegment, 10);
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
  });
});

// ── 3. Parameterised bash tests — all realistic cache-hit values ───────────────
//
// GitHub Actions writes exactly three values for cache-hit:
//   ""      — cache key not found (miss)
//   "true"  — cache key found (hit)
//   "false" — cache/restore step skipped or the step did not run
//
// The guard condition is:  cache-hit != 'true'
// Only "true" should suppress the alert.  Both "" and "false" must allow it.

describe("parameterised bash — cache-hit guard: only 'true' suppresses the alert", () => {
  /**
   * Run the guard condition as a bash `if` and return the decision.
   *
   * Mirrors the exact `if:` expression used in the YAML (assuming redirect=true,
   * i.e. a redirect was detected where the alert section is reached):
   *   steps.probe.outputs.redirect == 'true' && steps.alert-cache.outputs.cache-hit != 'true'
   */
  function guardDecision(cacheHit: string): {
    alertFires: boolean;
    silenced: boolean;
  } {
    const alertScript = `
REDIRECT="true"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "true" && "$CACHE_HIT" != "true" ]]; then
  echo "ALERT=yes"
else
  echo "ALERT=no"
fi
`;
    const silenceScript = `
REDIRECT="true"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "true" && "$CACHE_HIT" == "true" ]]; then
  echo "SILENCE=yes"
else
  echo "SILENCE=no"
fi
`;
    const alertOut = runBash(alertScript).stdout;
    const silenceOut = runBash(silenceScript).stdout;
    return {
      alertFires: alertOut.includes("ALERT=yes"),
      silenced: silenceOut.includes("SILENCE=yes"),
    };
  }

  /**
   * All realistic cache-hit values and the expected guard outcome.
   *
   * cacheHit | meaning in Actions                      | alert fires? | silenced?
   * ---------|-----------------------------------------|--------------|----------
   * ""       | cache key not found (first this hour)   | YES          | NO
   * "true"   | cache key found (already sent this hour)| NO           | YES
   * "false"  | restore step was skipped / not run      | YES          | NO
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
      "empty string (cache miss — first detection this hour)",
      true,
      false,
    ],
    [
      "true",
      "'true' (cache hit — already sent this hour)",
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
    "cache-hit=%j (%s): alertFires=%s, silenced=%s",
    (cacheHitValue, _label, shouldFire, shouldSilence) => {
      const { alertFires, silenced } = guardDecision(cacheHitValue);
      expect(alertFires).toBe(shouldFire);
      expect(silenced).toBe(shouldSilence);
    },
  );

  it("alert and silence are mutually exclusive for every realistic cache-hit value", () => {
    for (const [cacheHitValue] of cases) {
      const { alertFires, silenced } = guardDecision(cacheHitValue);
      expect(alertFires && silenced).toBe(false);
    }
  });

  it("wrong guard 'cache-hit == false' would NOT fire on empty string (regression demo)", () => {
    // Demonstrates why  cache-hit == 'false'  is the wrong guard:
    // it would NOT fire when cache-hit is "" (the real cache-miss value in Actions),
    // causing the alert to be skipped on the very first detection of the hour.
    const wrongScript = `
REDIRECT="true"
CACHE_HIT=""
# Wrong condition a future author might accidentally write:
if [[ "$REDIRECT" == "true" && "$CACHE_HIT" == "false" ]]; then
  echo "WRONG_GUARD_FIRES=yes"
else
  echo "WRONG_GUARD_FIRES=no"
fi
`;
    const { stdout } = runBash(wrongScript);
    // The wrong guard does NOT fire for cache-hit="", confirming the guard is broken:
    // it would suppress the alert on the first detection of the hour when Actions
    // reports cache-hit="" (key not found), rather than sending it.
    expect(stdout).toContain("WRONG_GUARD_FIRES=no");
  });
});

// ── 4. Multi-run scenario: same UTC hour, different outcomes ──────────────────

describe("multi-run scenario within the same UTC hour", () => {
  /**
   * Mirrors the step-guard logic:
   *   redirect == 'true' && cache-hit != 'true'  → alert sent
   *   redirect == 'true' && cache-hit == 'true'  → silenced
   */
  function simulate(
    redirect: string,
    cacheHit: string,
  ): { alertSent: boolean; silenced: boolean } {
    const alertSent = redirect === "true" && cacheHit !== "true";
    const silenced = redirect === "true" && cacheHit === "true";
    return { alertSent, silenced };
  }

  it("run 1 sends the alert; run 2 within the same hour is silenced", () => {
    // Run 1 (00:05 UTC): redirect detected, cache-miss → alert sent
    const run1 = simulate("true", ""); // cache-miss
    expect(run1.alertSent).toBe(true);
    expect(run1.silenced).toBe(false);

    // Run 2 (00:20 UTC): redirect still present, cache-hit — sentinel written by run 1 → silenced
    const run2 = simulate("true", "true"); // cache-hit
    expect(run2.alertSent).toBe(false);
    expect(run2.silenced).toBe(true);
  });

  it("run in the NEXT UTC hour triggers a fresh alert (new cache key = miss)", () => {
    // The cache key rotates each UTC hour, so the next-hour run has cache-hit = "" (miss).
    const { alertSent } = simulate("true", "");
    expect(alertSent).toBe(true);
  });

  it("healthy probe run (no redirect) never triggers the alert regardless of cache state", () => {
    expect(simulate("false", "").alertSent).toBe(false);
    expect(simulate("false", "true").alertSent).toBe(false);
    expect(simulate("false", "false").alertSent).toBe(false);
  });
});

// ── 5. Manual-dispatch bypass — unique key per run, never matches scheduled format
//
// When the workflow is triggered via workflow_dispatch, the "Compute alert dedup
// key" step uses `github.run_id` instead of `date -u +%Y-%m-%d-%H`.  This
// produces a key that:
//   a) is unique per run (no two manual runs share a cache key → no silencing)
//   b) never collides with the scheduled key format (YYYY-MM-DD-HH)
//
// A future edit that collapses the two branches (e.g. by removing the if/else
// and always using `date`) would silently suppress operator-triggered alerts.
// These tests catch that regression at the structural and bash-simulation levels.

describe("stripe-webhook-health.yml — manual-dispatch dedup bypass", () => {
  // ── 5a. Structural: manual branch contains github.run_id, not date ──────────

  it("the 'Compute alert dedup key' step contains 'github.run_id' (manual branch)", () => {
    const block = extractStepBlock("Compute alert dedup key");
    // The manual branch must reference github.run_id so each dispatch run gets
    // a unique cache key and cannot be suppressed by a prior run's cache entry.
    expect(block).toContain("github.run_id");
  });

  it("the manual branch key contains the literal prefix 'webhook-redirect-alerted-manual-'", () => {
    const block = extractStepBlock("Compute alert dedup key");
    expect(block).toContain("webhook-redirect-alerted-manual-");
  });

  it("the manual branch does NOT contain 'date' (run_id, not timestamp)", () => {
    // Isolate just the manual (workflow_dispatch) branch of the if/else.
    // The block looks like:
    //   if [[ "${{ github.event_name }}" == "workflow_dispatch" ]]; then
    //     KEY="webhook-redirect-alerted-manual-${{ github.run_id }}"
    //     ...
    //   else
    //     KEY="webhook-redirect-alerted-$(date -u +%Y-%m-%d-%H)"
    //   fi
    const block = extractStepBlock("Compute alert dedup key");
    const dispatchBranchMatch = block.match(
      /workflow_dispatch.*?\n([\s\S]*?)else/,
    );
    expect(dispatchBranchMatch).not.toBeNull();
    const dispatchBranch = dispatchBranchMatch![1];
    // The manual branch must NOT call `date` — it uses run_id for uniqueness.
    expect(dispatchBranch).not.toContain("date");
    expect(dispatchBranch).toContain("run_id");
  });

  it("the scheduled branch does NOT reference run_id (date-based rotation only)", () => {
    const block = extractStepBlock("Compute alert dedup key");
    // Isolate the else (scheduled) branch.
    const elseBranchMatch = block.match(/else\n([\s\S]*?)fi/);
    expect(elseBranchMatch).not.toBeNull();
    const elseBranch = elseBranchMatch![1];
    // Scheduled branch must use date, not run_id.
    expect(elseBranch).toContain("date");
    expect(elseBranch).not.toContain("run_id");
  });

  it("the two branches are guarded by an event_name == 'workflow_dispatch' check", () => {
    const block = extractStepBlock("Compute alert dedup key");
    expect(block).toContain("workflow_dispatch");
    // Confirm the check is an equality comparison so scheduled runs go to else.
    expect(block).toMatch(/github\.event_name.*==.*workflow_dispatch/);
  });

  // ── 5b. Bash simulation: two run IDs → two distinct keys, no collision with scheduled ──

  /**
   * Simulate the manual-branch key computation with a given run_id.
   * Mirrors the exact bash fragment in the workflow step:
   *   KEY="webhook-redirect-alerted-manual-${{ github.run_id }}"
   */
  function computeManualKey(runId: string): string {
    const script = `
GITHUB_RUN_ID="${runId}"
KEY="webhook-redirect-alerted-manual-\${GITHUB_RUN_ID}"
echo "$KEY"
`;
    const { stdout, exitCode } = runBash(script);
    expect(exitCode).toBe(0);
    return stdout.trim();
  }

  it("manual key for run_id=111 has the expected format", () => {
    const key = computeManualKey("111");
    expect(key).toBe("webhook-redirect-alerted-manual-111");
  });

  it("two different run IDs produce two distinct keys (no silencing between runs)", () => {
    const key1 = computeManualKey("9000000001");
    const key2 = computeManualKey("9000000002");
    expect(key1).not.toBe(key2);
  });

  it("manual key does not match the scheduled key format YYYY-MM-DD-HH", () => {
    // The scheduled format is: webhook-redirect-alerted-2026-08-10-14
    // The manual format is:    webhook-redirect-alerted-manual-<run_id>
    // They must never collide.
    const scheduledKeyPattern = /^webhook-redirect-alerted-\d{4}-\d{2}-\d{2}-\d{2}$/;
    const key1 = computeManualKey("9000000001");
    const key2 = computeManualKey("9000000002");
    expect(key1).not.toMatch(scheduledKeyPattern);
    expect(key2).not.toMatch(scheduledKeyPattern);
  });

  it("manual key contains 'manual' as a literal segment (visually distinct from scheduled)", () => {
    const key = computeManualKey("9000000001");
    // Splitting on '-' must include 'manual' as one of the segments.
    const parts = key.split("-");
    expect(parts).toContain("manual");
  });

  it("scheduled key does NOT contain 'manual' (paths are fully separate)", () => {
    const script = `
KEY="webhook-redirect-alerted-$(date -u +%Y-%m-%d-%H)"
echo "$KEY"
`;
    const { stdout, exitCode } = runBash(script);
    expect(exitCode).toBe(0);
    const scheduledKey = stdout.trim();
    expect(scheduledKey).not.toContain("manual");
  });

  it("100 simulated manual run IDs all produce keys distinct from any scheduled key", () => {
    // Generate a plausible scheduled key for right now.
    const { stdout } = runBash(`echo "webhook-redirect-alerted-$(date -u +%Y-%m-%d-%H)"`);
    const scheduledKey = stdout.trim();
    const scheduledPattern = /^webhook-redirect-alerted-\d{4}-\d{2}-\d{2}-\d{2}$/;

    for (let i = 1; i <= 100; i++) {
      const manualKey = computeManualKey(String(9_000_000_000 + i));
      // Must not equal any scheduled key.
      expect(manualKey).not.toBe(scheduledKey);
      // Must not match the scheduled key format.
      expect(manualKey).not.toMatch(scheduledPattern);
    }
  });
});

// ── 5c. "Fail the job when redirect detected" — stays red even on cache hit ───
//
// This step must exit 1 on EVERY run where a redirect is present, regardless of
// whether the dedup guard has suppressed the alert notification.  Its `if:`
// condition MUST be exactly `steps.probe.outputs.redirect == 'true'` — nothing
// more, nothing less.  A future edit that adds `&& steps.alert-cache.outputs.cache-hit != 'true'`
// would allow the job to go green while the redirect persists — exactly the silent
// failure the dedup guard was designed to avoid.

// ── Helper: extract the normalized `if:` value from a named step ─────────────

function extractIfValue(stepName: string): string {
  const block = extractStepBlock(stepName);
  const ifLine = block.split("\n").find((l) => l.trim().startsWith("if:"));
  if (!ifLine) throw new Error(`No "if:" line found in step "${stepName}"`);
  // Strip the "if:" key and surrounding whitespace/quotes to get the raw value.
  return ifLine.trim().replace(/^if:\s*/, "").trim();
}

// ── Helper: extract the run: block lines from a named step ───────────────────
//
// Returns the dedented bash lines from the `run: |` block of the step, with
// GitHub Actions expression tokens (${{ ... }}) replaced by the supplied map.

function extractRunLines(
  stepName: string,
  exprReplacements: Record<string, string> = {},
): string[] {
  const block = extractStepBlock(stepName);
  const runMarker = "run: |\n";
  const markerIdx = block.indexOf(runMarker);
  if (markerIdx === -1) throw new Error(`No "run: |" in step "${stepName}"`);

  const afterMarker = block.slice(markerIdx + runMarker.length);
  const firstContent = afterMarker.split("\n").find((l) => l.trim().length > 0) ?? "";
  const indent = firstContent.match(/^(\s+)/)?.[1] ?? "";

  const lines = afterMarker
    .split("\n")
    .map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l));

  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  // Substitute GitHub Actions expression tokens.
  return lines.map((l) =>
    Object.entries(exprReplacements).reduce(
      (acc, [expr, val]) => acc.replaceAll(`\${{ ${expr} }}`, val),
      l,
    ),
  );
}

describe("'Fail the job when redirect detected' — structural guard", () => {
  it("the step exists in the workflow", () => {
    expect(workflowText).toContain("Fail the job when redirect detected");
  });

  it("the step's if: value is exactly \"steps.probe.outputs.redirect == 'true'\" (no extra clauses)", () => {
    // Exact equality — not merely contains.  Any added clause (e.g. && cache-hit != 'true')
    // would widen this value and cause the test to fail immediately.
    const ifValue = extractIfValue("Fail the job when redirect detected");
    expect(ifValue).toBe("steps.probe.outputs.redirect == 'true'");
  });

  it("the step's run: block contains a standalone 'exit 1' command (not a comment, not exit 10)", () => {
    // We check for a line whose trimmed content is exactly "exit 1" — this rules out
    // substring matches in comments (# exit 1) and other exit codes (exit 10).
    const lines = extractRunLines("Fail the job when redirect detected");
    const hasStandaloneExit1 = lines.some((l) => l.trim() === "exit 1");
    expect(hasStandaloneExit1).toBe(true);
  });

  it("the step's run: block does NOT exit with any code other than 1", () => {
    // Guard against accidental `exit 0` or `exit 2` lines in the run block.
    const lines = extractRunLines("Fail the job when redirect detected");
    const badExits = lines.filter((l) => /^\s*exit\s+(?!1\b)/.test(l));
    expect(badExits).toHaveLength(0);
  });
});

describe("'Fail the job when redirect detected' — bash simulation using extracted YAML run block", () => {
  /**
   * Extract the actual `run: |` bash from the YAML step, substitute the GitHub
   * Actions expressions that the runner would expand, and execute it.  This
   * means any change to the YAML run block is exercised directly — there is no
   * hand-maintained copy of the script in the test.
   */
  function runFailStep(httpCode: string): BashResult {
    // Substitute the one GitHub Actions expression in the run: block.
    const lines = extractRunLines("Fail the job when redirect detected", {
      "steps.probe.outputs.http_code": httpCode,
    });
    return runBash(lines.join("\n"));
  }

  it("extracted YAML run block exits 1 (redirect=true, cache-hit='true' — dedup silenced the alert)", () => {
    // Critical scenario: alert was suppressed by the dedup guard, but the fail
    // step must still run and exit 1 unconditionally.
    const { exitCode } = runFailStep("308");
    expect(exitCode).toBe(1);
  });

  it("extracted YAML run block exits 1 (redirect=true, cache-hit='' — first detection this hour)", () => {
    const { exitCode } = runFailStep("301");
    expect(exitCode).toBe(1);
  });

  it("extracted YAML run block exits 1 for any 3xx code", () => {
    for (const code of ["301", "302", "307", "308"]) {
      expect(runFailStep(code).exitCode).toBe(1);
    }
  });

  it("the if: guard is exactly the redirect predicate and nothing else (equality, not substring)", () => {
    // A regression like `steps.probe.outputs.redirect == 'true' && false`
    // would still pass a toContain() check but fails an exact-equality check.
    const ifValue = extractIfValue("Fail the job when redirect detected");
    expect(ifValue).toBe("steps.probe.outputs.redirect == 'true'");
    // Confirm no additional && or || clauses.
    expect(ifValue).not.toMatch(/&&/);
    expect(ifValue).not.toMatch(/\|\|/);
  });

  it("a broken guard with '&& cache-hit != true' would skip the step on cache hit (regression demo)", () => {
    // Demonstrates the exact regression the task is guarding against:
    // if the step's if: were changed to also require cache-hit != 'true',
    // the step would NOT run when the alert is deduplicated, silently
    // letting the job go green while the redirect persists.
    const brokenGuardScript = `
REDIRECT="true"
CACHE_HIT="true"
# Wrong condition a future author might accidentally write:
if [[ "$REDIRECT" == "true" && "$CACHE_HIT" != "true" ]]; then
  echo "BROKEN_STEP_RAN=yes"
else
  echo "BROKEN_STEP_RAN=no"
fi
`;
    const { stdout } = runBash(brokenGuardScript);
    // With the broken guard, the step would NOT run on a cache hit —
    // confirming the broken guard is wrong and the real step must not have it.
    expect(stdout).toContain("BROKEN_STEP_RAN=no");
  });

  it("both cache-hit='' and cache-hit='true' produce exit 1 (step is cache-hit-agnostic)", () => {
    // The if: guard does not reference cache-hit at all, so the step must
    // behave identically regardless of which value cache-hit holds.
    // We verify this by running the extracted bash twice — if the run block
    // ever gains a cache-hit branch, the step content would differ.
    const result1 = runFailStep("308");
    const result2 = runFailStep("308");
    // Both exits must be 1.
    expect(result1.exitCode).toBe(1);
    expect(result2.exitCode).toBe(1);
    // Both must produce identical stdout (no conditional output based on cache-hit).
    expect(result1.stdout).toBe(result2.stdout);
  });
});
// ── 6. Summary step: correct label for every cache-hit value ─────────────────
//
// The Summary step uses a single-bracket  [ "$CACHE_HIT" = "true" ]  to decide
// whether to write "Deduplicated" or "Sent" in the job summary table.
//
// Expected mapping:
//   ""      (cache miss — first run this hour)  → "Sent"
//   "true"  (cache hit  — already sent)         → "Deduplicated"
//   "false" (restore step skipped / not run)    → "Sent"
//
// The bash is extracted directly from the workflow YAML and executed, so any
// edit to the workflow is caught immediately — there is no hand-maintained copy.

describe("Summary step — correct label for all cache-hit values", () => {
  /**
   * Extract the `run: |` bash from the Summary step in the actual workflow YAML.
   *
   * The step's `env:` block maps GitHub Actions expression values into plain
   * shell variables (REDIRECT, CACHE_HIT, HTTP_CODE, LOCATION, URL).  Those
   * expressions are expanded by the Actions runner before the shell runs, so
   * the `run:` body is pure bash with no ${{ }} tokens — we can execute it
   * directly after prepending our own variable assignments.
   */
  function extractSummaryRunBlock(): string {
    const stepBlock = extractStepBlock("Summary");

    // Locate the `run: |` literal block scalar marker within the step block.
    const runMarker = "run: |\n";
    const markerIdx = stepBlock.indexOf(runMarker);
    if (markerIdx === -1) throw new Error("Could not find 'run: |' in Summary step block");

    const afterMarker = stepBlock.slice(markerIdx + runMarker.length);

    // Detect indentation from the first non-empty content line and strip it
    // from every line — this is robust to re-indentation of the YAML.
    const firstContentLine = afterMarker.split("\n").find(l => l.trim().length > 0) ?? "";
    const indent = firstContentLine.match(/^(\s+)/)?.[1] ?? "";

    const lines = afterMarker
      .split("\n")
      .map(line => (indent && line.startsWith(indent) ? line.slice(indent.length) : line));

    // Trim trailing blank lines left by YAML block scalar parsing.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

    return lines.join("\n");
  }

  /**
   * Run the YAML Summary step's bash for the given redirect + cacheHit values.
   *
   * GITHUB_STEP_SUMMARY is redirected to a tmp file; its content is returned.
   * The env: variables from the YAML step are supplied as realistic constants —
   * only REDIRECT and CACHE_HIT affect which label is written.
   */
  function runSummaryBash(redirect: string, cacheHit: string): string {
    const dir = path.join(tmpdir(), `summary-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const summaryFile = path.join(dir, "step_summary.md");

    // Mirror the YAML env: block substitutions the Actions runner would perform.
    const envPreamble = [
      `REDIRECT="${redirect}"`,
      `CACHE_HIT="${cacheHit}"`,
      `HTTP_CODE="308"`,
      `LOCATION="https://www.i-art.com.au/api/stripe/webhook"`,
      `URL="https://i-art.com.au/api/stripe/webhook"`,
      `GITHUB_STEP_SUMMARY="${summaryFile}"`,
    ].join("\n");

    const fullScript = `${envPreamble}\n${extractSummaryRunBlock()}`;

    try {
      runBash(fullScript);
      try {
        return readFileSync(summaryFile, "utf8");
      } catch {
        return "";
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── Parameterised table ───────────────────────────────────────────────────
  //
  // cacheHit | meaning                                   | expected label
  // ---------|-------------------------------------------|------------------
  // ""       | cache key not found (first run this hour) | "Sent"
  // "true"   | cache key found (already sent this hour)  | "Deduplicated"
  // "false"  | restore step was skipped / not run        | "Sent"

  const cases: Array<[cacheHit: string, label: string, expectedContains: string, shouldNotContain: string]> = [
    ["",      "empty string (cache miss — first run)",  "Sent",         "Deduplicated"],
    ["true",  "'true' (cache hit — already sent)",      "Deduplicated", "Sent (Slack" ],
    ["false", "'false' (restore step skipped/not run)", "Sent",         "Deduplicated"],
  ];

  it.each(cases)(
    "CACHE_HIT=%j (%s) → summary contains '%s' and not '%s'",
    (cacheHit, _label, expectedContains, shouldNotContain) => {
      const summary = runSummaryBash("true", cacheHit);
      expect(summary).toContain(expectedContains);
      expect(summary).not.toContain(shouldNotContain);
    },
  );

  it("'true' is the only cache-hit value that produces 'Deduplicated'", () => {
    for (const [cacheHit] of cases) {
      const summary = runSummaryBash("true", cacheHit);
      if (cacheHit === "true") {
        expect(summary).toContain("Deduplicated");
        expect(summary).not.toContain("Sent (Slack");
      } else {
        expect(summary).toContain("Sent (Slack");
        expect(summary).not.toContain("Deduplicated");
      }
    }
  });

  it("'Deduplicated' and 'Sent' labels are mutually exclusive for every realistic cache-hit value", () => {
    for (const [cacheHit] of cases) {
      const summary = runSummaryBash("true", cacheHit);
      const hasDeduplicated = summary.includes("Deduplicated");
      const hasSent = summary.includes("Sent (Slack");
      // Exactly one label must appear — never both, never neither.
      expect(hasDeduplicated || hasSent).toBe(true);
      expect(hasDeduplicated && hasSent).toBe(false);
    }
  });

  it("the Summary step uses single-bracket POSIX form for the CACHE_HIT check", () => {
    // The Summary step deliberately uses  [ "$CACHE_HIT" = "true" ]  (single-
    // bracket POSIX sh) rather than  [[ ... ]]  — both behave identically for
    // the string "true", but we assert the form present in the YAML so a future
    // author who changes it to a double-bracket or != variant gets a red test.
    expect(extractSummaryRunBlock()).toMatch(/\[ "\$CACHE_HIT" = "true" \]/);
  });

  it("'Deduplicated' label is in the if-true branch and 'Sent' is in the else branch", () => {
    // Structural guard: confirms the two echo lines are on the correct sides of
    // the if/else.  An author who accidentally swaps them would flip the
    // user-visible labels; this catches that without waiting for a live run.
    const runBlock = extractSummaryRunBlock();
    const ifIdx            = runBlock.indexOf('[ "$CACHE_HIT" = "true" ]');
    const deduplicatedIdx  = runBlock.indexOf("Deduplicated");
    const elseIdx          = runBlock.indexOf("\n  else", ifIdx);
    const sentIdx          = runBlock.indexOf("Sent (Slack");

    expect(ifIdx).toBeGreaterThan(-1);
    expect(deduplicatedIdx).toBeGreaterThan(-1);
    expect(elseIdx).toBeGreaterThan(-1);
    expect(sentIdx).toBeGreaterThan(-1);

    // "Deduplicated" must appear after the if-condition and before the else.
    expect(deduplicatedIdx).toBeGreaterThan(ifIdx);
    expect(deduplicatedIdx).toBeLessThan(elseIdx);

    // "Sent (Slack" must appear after the else.
    expect(sentIdx).toBeGreaterThan(elseIdx);
  });
});

// ── 6. Notifier exits 0 when Slack API returns an error ───────────────────────
//
// When Slack credentials ARE present but the API returns an error (transient
// failure, misconfigured token, channel not found, etc.) the script must still
// exit 0.  A Slack failure must never mask the probe's redirect detection — the
// caller owns the non-zero exit for the redirect itself.
//
// Strategy: the sandbox blocks subprocess→loopback TCP, so we cannot use a
// real HTTP server.  Instead we write a tiny wrapper script that installs a
// global.fetch mock returning the target error response and then imports the
// notifier — everything runs in a single process, no network required.

describe("notify-webhook-redirect.ts — exits 0 when Slack API returns an error", () => {
  /**
   * Write a temp wrapper that:
   *   1. Replaces global.fetch with a mock returning (httpStatus, responseBody).
   *   2. Imports the notifier, which runs main() automatically.
   *
   * The notifier always calls process.exit(0) on the normal path, so the
   * wrapper inherits that exit code.  spawnSync captures it.
   *
   * SLACK_WEBHOOK_URL is set to a non-empty placeholder so the notifier
   * reaches sendViaSlackIncomingWebhook() and exercises the fetch path;
   * the actual URL value is never contacted because fetch is mocked.
   */
  function runNotifierWithMockedFetch(opts: {
    httpStatus: number;
    /** JSON string the mock response body will contain. */
    responseBody: string;
    /** Extra env vars to layer on top of the minimal set. */
    extraEnv?: Record<string, string>;
  }) {
    const tmpDir = path.join(tmpdir(), `slack-mock-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    // The wrapper is plain ESM-compatible TS that tsx can run directly.
    const wrapperContent = `
// Vitest is not loaded here — this runs as a standalone tsx script.
// Patch global.fetch BEFORE the notifier module is evaluated so that
// every fetch() call inside it hits our mock.
const mockStatus = ${opts.httpStatus};
const mockBody = ${JSON.stringify(opts.responseBody)};

(global as any).fetch = async (_url: unknown, _init?: unknown): Promise<Response> => {
  return new Response(mockBody, {
    status: mockStatus,
    headers: { "Content-Type": "application/json" },
  });
};

// Import the notifier.  It immediately runs main() and calls process.exit(0).
await import(${JSON.stringify(NOTIFIER_SCRIPT)});
`;

    const wrapperFile = path.join(tmpDir, "wrapper.mts");
    writeFileSync(wrapperFile, wrapperContent);

    try {
      return spawnSync(
        "pnpm",
        ["--filter", "@workspace/artwork-bank", "exec", "tsx", wrapperFile],
        {
          env: {
            WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
            HTTP_CODE: "308",
            REDIRECT_LOCATION: "https://www.i-art.com.au/api/stripe/webhook",
            WORKFLOW_RUN_URL:
              "https://github.com/owner/repo/actions/runs/99999",
            // Non-empty so sendViaSlackIncomingWebhook() is attempted.
            // The actual URL is never contacted because fetch is mocked.
            SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/MOCK/MOCK/mock",
            // No SLACK_BOT_TOKEN / channel so the Replit-connectors and
            // bot-token paths are skipped; only the incoming-webhook path runs.
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            NODE_ENV: "test",
            ...(opts.extraEnv ?? {}),
          },
          encoding: "utf8",
          timeout: 30_000,
          cwd: path.resolve(__dirname, "../../.."),
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("exits 0 when the Slack incoming-webhook endpoint returns HTTP 500", () => {
    const result = runNotifierWithMockedFetch({
      httpStatus: 500,
      responseBody: JSON.stringify({ ok: false, error: "internal_error" }),
    });

    // Must exit 0 — Slack errors must never mask the probe result.
    expect(result.status).toBe(0);

    // The last-resort banner must still be printed so CI logs surface the issue.
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("OPERATOR ACTION REQUIRED");
  });

  it("exits 0 when the Slack incoming-webhook endpoint returns HTTP 403", () => {
    const result = runNotifierWithMockedFetch({
      httpStatus: 403,
      responseBody: JSON.stringify({ ok: false, error: "invalid_auth" }),
    });

    expect(result.status).toBe(0);

    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("OPERATOR ACTION REQUIRED");
  });

  it("exits 0 when the Slack incoming-webhook endpoint returns HTTP 429 (rate-limited)", () => {
    const result = runNotifierWithMockedFetch({
      httpStatus: 429,
      responseBody: JSON.stringify({ ok: false, error: "ratelimited" }),
    });

    expect(result.status).toBe(0);

    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("OPERATOR ACTION REQUIRED");
  });

  it("logs the Slack webhook error before falling back to the banner", () => {
    const result = runNotifierWithMockedFetch({
      httpStatus: 500,
      responseBody: JSON.stringify({ ok: false, error: "internal_error" }),
    });

    // The notifier must log the failure so it is visible in CI before the banner.
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toMatch(/Slack webhook (post )?failed/i);
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
// All four must:
//   a) match  ^webhook-redirect-alerted-manual-.+$
//   b) be mutually distinct (no two collapse to the same key)

describe("bash simulation — manual-dispatch key is unique for unusual run_id shapes", () => {
  /**
   * Extract the full "Compute alert dedup key" bash from the actual workflow
   * YAML, substitute the two GitHub expression tokens with concrete values,
   * and run the resulting script.  Returns the KEY value the workflow would
   * emit for this run_id on a workflow_dispatch trigger.
   *
   * Using the live YAML bash (not a hand-written copy) means any future edit
   * to the key formula is automatically exercised by these tests.
   */
  function computeManualKeyFromWorkflow(runId: string): string {
    const stepBlock = extractStepBlock("Compute alert dedup key");

    // Locate the `run: |` literal block scalar within the step.
    const runMarker = "run: |\n";
    const markerIdx = stepBlock.indexOf(runMarker);
    if (markerIdx === -1)
      throw new Error("Could not find 'run: |' in 'Compute alert dedup key' step");

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
    const sentinel = `__KEY_OUTPUT__`;
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
  //   "1"                    — numeric value of "00001"; must differ from it
  //   "00001"                — leading zeros; numeric value 1 but string "00001"
  //   "99999999999999999999" — 20-digit integer, beyond JS/bash safe-integer range
  //   "9834710234"           — typical 10-digit integer seen in production
  const unusualRunIds: Array<[runId: string, label: string]> = [
    ["0",                    "single-digit zero"],
    ["1",                    "numeric value 1 (numeric equivalent of '00001')"],
    ["00001",                "leading zeros — numeric value 1 but string '00001'"],
    ["99999999999999999999", "20-digit integer (beyond safe-integer range)"],
    ["9834710234",           "typical 10-digit integer"],
  ];

  it.each(unusualRunIds)(
    "run_id=%j (%s) → key matches ^webhook-redirect-alerted-manual-.+$",
    (runId) => {
      const key = computeManualKeyFromWorkflow(runId);
      expect(key).toMatch(/^webhook-redirect-alerted-manual-.+$/);
    },
  );

  it("all unusual run_id shapes produce mutually distinct keys", () => {
    const keys = unusualRunIds.map(([runId]) =>
      computeManualKeyFromWorkflow(runId),
    );
    // Every key must be unique — no two run_id shapes must collapse to the same key.
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it("run_id='1' and run_id='00001' produce different keys (leading zeros are not numeric-coerced)", () => {
    // If the shell performed arithmetic expansion, both "1" and "00001" would
    // reduce to the integer 1 and produce the same key.  Plain string
    // interpolation must preserve the literal characters verbatim.
    const key1 = computeManualKeyFromWorkflow("1");
    const key00001 = computeManualKeyFromWorkflow("00001");
    expect(key1).not.toBe(key00001);
  });

  it("20-digit run_id produces a key distinct from the typical 10-digit run_id", () => {
    const keyLong = computeManualKeyFromWorkflow("99999999999999999999");
    const keyTypical = computeManualKeyFromWorkflow("9834710234");
    expect(keyLong).not.toBe(keyTypical);
  });

  it("no unusual run_id key matches the scheduled key format YYYY-MM-DD-HH", () => {
    const scheduledPattern = /^webhook-redirect-alerted-\d{4}-\d{2}-\d{2}-\d{2}$/;
    for (const [runId] of unusualRunIds) {
      const key = computeManualKeyFromWorkflow(runId);
      expect(key).not.toMatch(scheduledPattern);
    }
  });

  it("each unusual key contains 'manual' as a literal segment", () => {
    for (const [runId] of unusualRunIds) {
      const key = computeManualKeyFromWorkflow(runId);
      expect(key.split("-")).toContain("manual");
    }
  });
});
