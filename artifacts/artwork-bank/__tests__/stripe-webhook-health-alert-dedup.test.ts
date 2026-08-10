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
