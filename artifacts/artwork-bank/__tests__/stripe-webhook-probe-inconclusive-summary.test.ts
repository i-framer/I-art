/**
 * Task #583 — Confirm the Summary step shows the correct label when the probe
 * step is inconclusive (no redirect output).
 *
 * Context
 * ───────
 * The `.github/workflows/stripe-webhook-health.yml` Summary step runs on
 * every job execution (`if: always()`).  Its bash has three branches:
 *
 *   REDIRECT=true   → "### 🚨 Stripe webhook redirect detected"
 *   REDIRECT=false  → "### ✅ Stripe webhook health: OK"
 *   anything else   → "### ⚠️ Stripe webhook health: inconclusive"
 *                      "The probe step did not complete — see job log for details."
 *
 * The inconclusive branch fires when the probe job itself fails before writing
 * the REDIRECT output — e.g. the runner is out of disk space, a network error
 * occurs in the curl step, or the YAML environment has a syntax error.  In
 * these cases REDIRECT is unset (empty string).
 *
 * `stripe-webhook-health-alert-dedup.test.ts` already exercises REDIRECT=true
 * extensively.  This file adds dedicated tests for the inconclusive branch,
 * extracted from the real YAML to catch any future edits that accidentally
 * remove or rename that label.
 *
 * Implementation note
 * ───────────────────
 * The step block is extracted with the same text-splitting pattern used by
 * stripe-webhook-health-alert-dedup.test.ts — no yaml library required.
 *
 * What this test verifies
 * ───────────────────────
 *  1. REDIRECT="" (unset) → heading contains "inconclusive".
 *  2. REDIRECT="" → heading uses the ⚠️ emoji.
 *  3. REDIRECT="" → body text says "probe step did not complete".
 *  4. REDIRECT="error" (unexpected value) → "inconclusive" heading.
 *  5. REDIRECT="1" (unexpected value) → "inconclusive" (not the redirect heading).
 *  6. REDIRECT="" → does NOT write the OK heading.
 *  7. REDIRECT="" → does NOT write the redirect-detected heading.
 *  8. REDIRECT=false → "OK" heading still works (regression guard).
 *  9. REDIRECT=true  → "redirect detected" heading still works (regression guard).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

// ── Load the workflow file once ───────────────────────────────────────────────

const WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../../.github/workflows/stripe-webhook-health.yml",
);

let workflowText: string;

beforeAll(() => {
  workflowText = readFileSync(WORKFLOW_PATH, "utf8");
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the YAML block that follows the named step, up to the next step. */
function extractStepBlock(stepName: string): string {
  const after = workflowText.split(`- name: ${stepName}`)[1];
  if (!after) throw new Error(`Step "${stepName}" not found in ${WORKFLOW_PATH}`);
  return after.split("- name:")[0];
}

/** Extract the `run: |` bash body from the Summary step. */
function extractSummaryRunBlock(): string {
  const stepBlock = extractStepBlock("Summary");
  const runMarker = "run: |\n";
  const markerIdx = stepBlock.indexOf(runMarker);
  if (markerIdx === -1) throw new Error("Could not find 'run: |' in Summary step block");

  const afterMarker = stepBlock.slice(markerIdx + runMarker.length);

  // Strip YAML indentation from every line.
  const firstContentLine =
    afterMarker.split("\n").find((l) => l.trim().length > 0) ?? "";
  const indent = firstContentLine.match(/^(\s+)/)?.[1] ?? "";

  const lines = afterMarker
    .split("\n")
    .map((line) =>
      indent && line.startsWith(indent) ? line.slice(indent.length) : line,
    );

  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  return lines.join("\n");
}

/**
 * Execute the Summary step's bash with the given variable values and return
 * the content written to GITHUB_STEP_SUMMARY.
 */
function runSummaryBash(opts: {
  redirect: string;
  cacheHit?: string;
  httpCode?: string;
  location?: string;
  url?: string;
}): string {
  const {
    redirect,
    cacheHit = "",
    httpCode = "",
    location = "",
    url = "https://www.i-art.com.au/api/stripe/webhook",
  } = opts;

  const dir = path.join(tmpdir(), `inconclusive-summary-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const summaryFile = path.join(dir, "step_summary.md");
  const scriptFile = path.join(dir, "test.sh");

  const envPreamble = [
    `REDIRECT="${redirect}"`,
    `CACHE_HIT="${cacheHit}"`,
    `HTTP_CODE="${httpCode}"`,
    `LOCATION="${location}"`,
    `URL="${url}"`,
    `GITHUB_STEP_SUMMARY="${summaryFile}"`,
  ].join("\n");

  const fullScript = `#!/bin/bash\nset -euo pipefail\n${envPreamble}\n${extractSummaryRunBlock()}\n`;
  writeFileSync(scriptFile, fullScript, { mode: 0o755 });

  try {
    spawnSync("bash", [scriptFile], { encoding: "utf8" });
    try {
      return readFileSync(summaryFile, "utf8");
    } catch {
      return "";
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Summary step — inconclusive label when probe did not complete (Task #583)', () => {
  it('REDIRECT="" (unset) → heading contains "inconclusive"', () => {
    const summary = runSummaryBash({ redirect: "" });
    expect(summary).toContain("inconclusive");
  });

  it('REDIRECT="" → heading uses the ⚠️ emoji', () => {
    const summary = runSummaryBash({ redirect: "" });
    expect(summary).toContain("⚠️");
  });

  it('REDIRECT="" → body text says "probe step did not complete"', () => {
    const summary = runSummaryBash({ redirect: "" });
    expect(summary).toMatch(/probe step did not complete/i);
  });

  it('REDIRECT="error" (unexpected value) → "inconclusive" heading', () => {
    const summary = runSummaryBash({ redirect: "error" });
    expect(summary).toContain("inconclusive");
  });

  it('REDIRECT="1" → "inconclusive" heading, not redirect-detected heading', () => {
    const summary = runSummaryBash({ redirect: "1" });
    expect(summary).toContain("inconclusive");
    expect(summary).not.toContain("redirect detected");
  });

  it('REDIRECT="" → does NOT write the OK heading', () => {
    const summary = runSummaryBash({ redirect: "" });
    expect(summary).not.toContain("webhook health: OK");
  });

  it('REDIRECT="" → does NOT write the redirect-detected heading', () => {
    const summary = runSummaryBash({ redirect: "" });
    expect(summary).not.toContain("redirect detected");
  });

  // ── Regression guards — neighbouring branches must still work ────────────────

  it('REDIRECT=false → "OK" heading still renders (regression guard)', () => {
    const summary = runSummaryBash({ redirect: "false", httpCode: "200" });
    expect(summary).toContain("webhook health: OK");
    expect(summary).not.toContain("inconclusive");
  });

  it('REDIRECT=true → "redirect detected" heading still renders (regression guard)', () => {
    const summary = runSummaryBash({
      redirect: "true",
      httpCode: "308",
      location: "https://www.i-art.com.au/api/stripe/webhook",
      url: "https://i-art.com.au/api/stripe/webhook",
    });
    expect(summary).toContain("redirect detected");
    expect(summary).not.toContain("inconclusive");
  });
});
