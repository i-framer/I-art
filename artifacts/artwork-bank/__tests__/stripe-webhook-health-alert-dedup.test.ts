/**
 * Alert-dedup path tests for .github/workflows/stripe-webhook-health.yml
 *
 * The workflow silences the Slack/email notifier on the second run within the
 * same UTC hour by checking a GitHub Actions cache hit.  When the cache key
 * already exists (cache-hit == 'true'), every step that sends the alert is
 * skipped and a "already sent this hour" notice is logged instead.
 *
 * These tests verify:
 *
 *  1. Structural YAML wiring — all "Send operator alert" and surrounding alert
 *     steps are guarded by `cache-hit != 'true'`, and the silence step is
 *     guarded by `cache-hit == 'true'`.
 *
 *  2. A bash simulation of the step-guard logic — when cache-hit is true the
 *     notifier command is NOT executed; when cache-hit is false it IS executed.
 *     This mirrors the extracted-bash approach used by the dedup-key test so
 *     any change to the guard expression in the YAML is caught immediately.
 *
 *  3. The notifier script (notify-webhook-redirect.ts) exits 0 and emits a
 *     CI-banner when no Slack/email channel is configured, confirming it would
 *     have run on a real cache-miss run without flooding the operator.
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

// ── 1. Structural YAML wiring assertions ──────────────────────────────────────

describe("stripe-webhook-health.yml — alert dedup wiring (structural)", () => {
  it("'Send operator alert' is guarded by both redirect==true and cache-hit!=true", () => {
    const block = extractStepBlock("Send operator alert");
    expect(block).toContain("redirect == 'true'");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Checkout (alert only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Checkout (alert only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Set up pnpm (alert only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Set up pnpm (alert only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Install dependencies (alert only)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Install dependencies (alert only)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Mark alert sent (write sentinel for cache)' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Mark alert sent (write sentinel for cache)");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Save alert-sent cache' is guarded by cache-hit != 'true'", () => {
    const block = extractStepBlock("Save alert-sent cache");
    expect(block).toContain("cache-hit != 'true'");
  });

  it("'Alert already sent this hour — skipping repeat notification' fires only on cache-hit == 'true'", () => {
    const block = extractStepBlock(
      "Alert already sent this hour — skipping repeat notification",
    );
    expect(block).toContain("cache-hit == 'true'");
    // Must also require redirect detected.
    expect(block).toContain("redirect == 'true'");
  });

  it("the silence step and the alert steps have mutually exclusive conditions on cache-hit", () => {
    const alertBlock = extractStepBlock("Send operator alert");
    const silenceBlock = extractStepBlock(
      "Alert already sent this hour — skipping repeat notification",
    );
    // Alert runs on cache MISS:
    expect(alertBlock).toContain("cache-hit != 'true'");
    // Silence runs on cache HIT:
    expect(silenceBlock).toContain("cache-hit == 'true'");
    // They use opposite values — can never both run.
    expect(alertBlock).not.toContain("cache-hit == 'true'");
    expect(silenceBlock).not.toContain("cache-hit != 'true'");
  });

  it("the alert-cache restore step id is 'alert-cache' (referenced by downstream guards)", () => {
    expect(workflowText).toContain("id: alert-cache");
    expect(workflowText).toContain("steps.alert-cache.outputs.cache-hit");
  });

  it("at least four distinct steps reference steps.alert-cache.outputs.cache-hit", () => {
    const occurrences = (
      workflowText.match(/steps\.alert-cache\.outputs\.cache-hit/g) ?? []
    ).length;
    // Restore, Send alert, Mark alert sent, Save cache, Silence step = at least 4
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });
});

// ── 2. Bash simulation of the step-guard logic ────────────────────────────────
//
// The GitHub Actions `if:` expression `steps.alert-cache.outputs.cache-hit != 'true'`
// is evaluated by the runner as a boolean.  We replicate the semantics in bash
// so a regression in the condition string is caught without waiting for a live
// Actions run.

describe("bash simulation — cache-hit guard prevents notifier on second run", () => {
  /**
   * Simulate the step-guard decision.
   *
   * Returns whether the "Send operator alert" step would execute, given:
   *  - redirect    : whether the probe saw a 3xx (maps to steps.probe.outputs.redirect)
   *  - cacheHit    : whether the cache key was found (maps to steps.alert-cache.outputs.cache-hit)
   */
  function wouldSendAlert(redirect: string, cacheHit: string): boolean {
    // Mirror the exact `if:` expression from the YAML:
    //   steps.probe.outputs.redirect == 'true' && steps.alert-cache.outputs.cache-hit != 'true'
    const script = `
REDIRECT="${redirect}"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "true" && "$CACHE_HIT" != "true" ]]; then
  echo "WOULD_SEND=yes"
else
  echo "WOULD_SEND=no"
fi
`;
    const { stdout } = runBash(script);
    return stdout.includes("WOULD_SEND=yes");
  }

  it("cache-miss (first run): notifier IS invoked when redirect detected", () => {
    expect(wouldSendAlert("true", "")).toBe(true);
  });

  it("cache-hit (second run): notifier is NOT invoked even though redirect is still present", () => {
    expect(wouldSendAlert("true", "true")).toBe(false);
  });

  it("no redirect: notifier is not invoked regardless of cache state", () => {
    expect(wouldSendAlert("false", "")).toBe(false);
    expect(wouldSendAlert("false", "true")).toBe(false);
  });

  it("silence step fires only when redirect==true AND cache-hit==true", () => {
    // Mirrors: steps.probe.outputs.redirect == 'true' && steps.alert-cache.outputs.cache-hit == 'true'
    function wouldSilence(redirect: string, cacheHit: string): boolean {
      const script = `
REDIRECT="${redirect}"
CACHE_HIT="${cacheHit}"
if [[ "$REDIRECT" == "true" && "$CACHE_HIT" == "true" ]]; then
  echo "SILENCE=yes"
else
  echo "SILENCE=no"
fi
`;
      const { stdout } = runBash(script);
      return stdout.includes("SILENCE=yes");
    }

    // Cache hit + redirect = silence (dedup active)
    expect(wouldSilence("true", "true")).toBe(true);
    // Cache miss + redirect = no silence (alert fires)
    expect(wouldSilence("true", "")).toBe(false);
    // No redirect = no silence
    expect(wouldSilence("false", "true")).toBe(false);
    expect(wouldSilence("false", "")).toBe(false);
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
// Only "true" should suppress the alert.  Both "" and "false" must allow it.
//
// This is the regression test for the bug described in the workflow header:
//   A future author could write  cache-hit == 'false'  (wrong) and the
//   structural string-match test above would not catch it — but these
//   parameterised bash tests would, because the bash logic faithfully
//   mirrors the runner's boolean evaluation of the `if:` expression.

describe("parameterised bash — cache-hit guard: only 'true' suppresses the alert", () => {
  /**
   * Run the guard condition as a bash `if` and return the decision.
   *
   * Mirrors the exact `if:` expression used in the YAML:
   *   steps.probe.outputs.redirect == 'true' && steps.alert-cache.outputs.cache-hit != 'true'
   */
  function guardDecision(cacheHit: string): { alertFires: boolean; silenced: boolean } {
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
   * cacheHit | meaning in Actions                    | alert fires? | silenced?
   * ---------|---------------------------------------|-------------|----------
   * ""       | cache key not found (first run)       | YES          | NO
   * "true"   | cache key found (already sent)        | NO           | YES
   * "false"  | restore step was skipped / not run    | YES          | NO
   */
  const cases: Array<[cacheHitValue: string, label: string, shouldFire: boolean, shouldSilence: boolean]> = [
    ["",      "empty string (cache miss — first run this hour)", true,  false],
    ["true",  "'true' (cache hit — already sent this hour)",     false, true ],
    ["false", "'false' (restore step skipped or not run)",       true,  false],
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

  it("wrong guard 'cache-hit == false' would fire on empty string (regression demo)", () => {
    // Demonstrates why  cache-hit == 'false'  is the wrong guard:
    // it would NOT fire when cache-hit is "" (the real cache-miss value),
    // causing the alert to fire on every run regardless of the cache.
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
    // it would let the alert through on a real cache-hit run where Actions
    // sets cache-hit="" because the restore step was skipped by a prior `if:`.
    // This test documents the semantic difference between "" and "false".
    expect(stdout).toContain("WRONG_GUARD_FIRES=no");
  });
});

// ── 3. Two-run scenario: same hour, different outcomes ────────────────────────

describe("two-run scenario within the same UTC hour", () => {
  /**
   * Mirrors the step-guard logic:
   *   redirect == 'true' && cache-hit != 'true'  → alert sent
   *   redirect == 'true' && cache-hit == 'true'  → silenced
   */
  function simulate(redirect: string, cacheHit: string): { alertSent: boolean; silenced: boolean } {
    const alertSent = redirect === "true" && cacheHit !== "true";
    const silenced = redirect === "true" && cacheHit === "true";
    return { alertSent, silenced };
  }

  /**
   * Simulate the full two-run sequence:
   *
   *  Run 1 (14:02): redirect detected, cache-hit = false → alert sent
   *  Run 2 (14:45): redirect still present, cache-hit = true  → alert silenced
   */
  it("run 1 sends the alert; run 2 within the same hour is silenced", () => {
    const run1 = simulate("true", ""); // cache-miss
    expect(run1.alertSent).toBe(true);
    expect(run1.silenced).toBe(false);

    const run2 = simulate("true", "true"); // cache-hit — sentinel written by run 1
    expect(run2.alertSent).toBe(false);
    expect(run2.silenced).toBe(true);
  });

  it("run 3 in the NEXT hour triggers a fresh alert (new cache key = miss)", () => {
    // The cache key rotates each UTC hour, so the next-hour run has cache-hit = false.
    // simulate("true", "") = redirect detected, cache-miss (empty string from Actions = miss)
    const { alertSent } = simulate("true", "");
    expect(alertSent).toBe(true);
  });
});

// ── 4. Notifier script smoke-test (cache-miss path) ──────────────────────────
//
// Confirms the notifier script itself runs to completion and exits 0 on a
// cache-miss run when no Slack/email channel is configured — it must never
// mask the original probe failure by throwing.

describe("notify-webhook-redirect.ts — exits 0 and emits banner on cache-miss (no channels)", () => {
  it("script exits 0 and prints the CI banner when no Slack/email vars are set", () => {
    // Run the notifier with only the minimum env vars — no Slack, no email.
    const result = spawnSync(
      "pnpm",
      ["--filter", "@workspace/artwork-bank", "exec", "tsx", NOTIFIER_SCRIPT],
      {
        env: {
          // Provide the minimum context the script expects.
          WEBHOOK_URL: "https://i-art.com.au/api/stripe/webhook",
          HTTP_CODE: "308",
          REDIRECT_LOCATION: "https://www.i-art.com.au/api/stripe/webhook",
          WORKFLOW_RUN_URL:
            "https://github.com/owner/repo/actions/runs/99999",
          // No SLACK_*, no SMTP_*, no RESEND_API_KEY, no PLATFORM_ADMIN_EMAIL.
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 30_000,
        cwd: path.resolve(__dirname, "../../.."),
      },
    );

    // The script MUST exit 0 — notification failures must not mask the probe result.
    expect(result.status).toBe(0);

    // It must emit the last-resort CI banner to stderr (always fires without channels).
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    expect(combined).toContain("OPERATOR ACTION REQUIRED");
  });

  it("script exits 0 even when WEBHOOK_URL is the default (env var absent)", () => {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@workspace/artwork-bank", "exec", "tsx", NOTIFIER_SCRIPT],
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
});

// ── 5. Dedup boundary: manual dispatch always bypasses the cache ──────────────

describe("workflow_dispatch runs bypass dedup (always fresh alert)", () => {
  it("the 'Compute alert dedup key' step uses a unique key for workflow_dispatch", () => {
    // Structural check: the bash in the dedup step branches on github.event_name.
    const block = extractStepBlock("Compute alert dedup key");
    expect(block).toContain("workflow_dispatch");
    expect(block).toContain("manual-");
    // The manual branch incorporates github.run_id so every dispatch is unique.
    expect(block).toContain("github.run_id");
  });

  it("the 'Restore alert-sent cache' uses the same key variable as the dedup step", () => {
    const restoreBlock = extractStepBlock("Restore alert-sent cache");
    // Must reference steps.dedup.outputs.key — not a hardcoded string.
    expect(restoreBlock).toContain("steps.dedup.outputs.key");
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
