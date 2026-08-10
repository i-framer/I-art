/**
 * Dedup key rotation tests for .github/workflows/stripe-webhook-health.yml
 *
 * Every test that exercises key derivation extracts the actual `run:` block
 * from the "Compute alert dedup key" step and executes it via bash, so any
 * change to the workflow's key formula, branching logic, or output variable
 * name is caught immediately.
 *
 * Structural assertions verify the wiring between the dedup step and the
 * cache restore / save steps by checking the YAML source directly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── Load the workflow file once ───────────────────────────────────────────────

const WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../../.github/workflows/stripe-webhook-health.yml",
);

let workflowText: string;
/** The raw `run:` block of the "Compute alert dedup key" step. */
let dedupRunBlock: string;

beforeAll(() => {
  workflowText = readFileSync(WORKFLOW_PATH, "utf8");

  // Extract the run block between "Compute alert dedup key" and the next step.
  const after = workflowText.split("- name: Compute alert dedup key")[1];
  if (!after) throw new Error("Could not find 'Compute alert dedup key' step in workflow YAML");
  const raw = after.split("- name:")[0];
  // The run block starts after `run: |`
  const runMatch = raw.match(/run:\s*\|\n([\s\S]+)/);
  if (!runMatch) throw new Error("Could not extract run: block from dedup step");
  // Strip the leading indentation (8 spaces in the YAML).
  dedupRunBlock = runMatch[1]
    .split("\n")
    .map((line) => line.replace(/^ {8}/, ""))
    .join("\n");
});

// ── Helper: run the extracted dedup bash under controlled inputs ──────────────

interface RunResult {
  /** Value written to $GITHUB_OUTPUT as `key=<value>`. */
  key: string;
  /** Full stdout of the script. */
  stdout: string;
}

/**
 * Execute the exact `run:` block from the "Compute alert dedup key" step with:
 *  - `eventName`  substituted for `${{ github.event_name }}`
 *  - `runId`      substituted for `${{ github.run_id }}`
 *  - A `date` wrapper prepended to PATH so `date -u +%Y-%m-%d-%H` returns the
 *    UTC hour of `spoofedUtcIso` (only used for scheduled runs).
 *
 * The GITHUB_OUTPUT variable is pointed at a temp file so we can read the
 * `key=…` assignment back without side effects.
 */
function runDedupStep(opts: {
  eventName: "schedule" | "workflow_dispatch";
  runId?: string;
  spoofedUtcIso?: string; // e.g. "2025-03-15T14:10:00Z"
}): RunResult {
  const { eventName, runId = "0", spoofedUtcIso = "2025-01-01T00:00:00Z" } = opts;

  // 1. Materialise a temporary directory for this invocation.
  const dir = path.join(tmpdir(), `dedup-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  // 2. Write a `date` wrapper that ignores wall-clock time and always answers
  //    as if it is `spoofedUtcIso`.  The workflow calls `date -u +%Y-%m-%d-%H`
  //    so we forward all arguments to the real date binary with -d injected.
  const dateBin = path.join(dir, "date");
  writeFileSync(
    dateBin,
    `#!/bin/bash\nexec /usr/bin/date -u -d '${spoofedUtcIso}' "$@"\n`,
    { mode: 0o755 },
  );

  // 3. Point GITHUB_OUTPUT at a temp file.
  const ghOutput = path.join(dir, "github_output.txt");
  writeFileSync(ghOutput, "");

  // 4. Substitute GitHub Actions expression syntax in the extracted script.
  const script = dedupRunBlock
    .replace(/\$\{\{ github\.event_name \}\}/g, eventName)
    .replace(/\$\{\{ github\.run_id \}\}/g, runId);

  // 5. Execute the script with the wrapper date on PATH.
  const stdout = execSync(`bash -euo pipefail << 'DEDUP_EOF'\n${script}\nDEDUP_EOF`, {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: ghOutput,
    },
  })
    .toString()
    .trim();

  // 6. Parse `key=<value>` from GITHUB_OUTPUT.
  const outputContent = readFileSync(ghOutput, "utf8");
  const keyMatch = outputContent.match(/^key=(.+)$/m);

  // 7. Clean up the temp directory regardless of outcome.
  rmSync(dir, { recursive: true, force: true });

  if (!keyMatch) {
    throw new Error(
      `Script did not write 'key=…' to GITHUB_OUTPUT.\nStdout:\n${stdout}\nGITHUB_OUTPUT:\n${outputContent}`,
    );
  }

  return { key: keyMatch[1].trim(), stdout };
}

// ── 1. Structural wiring assertions (YAML source) ─────────────────────────────

describe("stripe-webhook-health.yml — dedup step wiring", () => {
  it("dedup step only runs when a redirect is detected", () => {
    const dedupSection = workflowText
      .split("- name: Compute alert dedup key")[1]
      ?.split("- name:")[0] ?? "";
    expect(dedupSection).toContain("redirect == 'true'");
  });

  it("cache restore step references steps.dedup.outputs.key", () => {
    expect(workflowText).toContain("steps.dedup.outputs.key");
  });

  it("both restore and save cache steps reference steps.dedup.outputs.key", () => {
    const occurrences = (
      workflowText.match(/steps\.dedup\.outputs\.key/g) ?? []
    ).length;
    // At minimum: one in the restore step key, one in the save step key.
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("alert-sent cache save step only runs on cache miss", () => {
    const saveBlock = workflowText
      .split("- name: Save alert-sent cache")[1]
      ?.split("- name:")[0] ?? "";
    expect(saveBlock).toContain("cache-hit != 'true'");
  });
});

// ── 2. Scheduled run: key derivation from the extracted workflow bash ─────────

describe("scheduled run — extracted workflow bash produces YYYY-MM-DD-HH keys", () => {
  it("produces the correct hourly key for a known timestamp", () => {
    const { key } = runDedupStep({
      eventName: "schedule",
      spoofedUtcIso: "2025-03-15T09:47:00Z",
    });
    expect(key).toBe("webhook-redirect-alerted-2025-03-15-09");
  });

  it("pads single-digit month, day, and hour with leading zeros", () => {
    const { key } = runDedupStep({
      eventName: "schedule",
      spoofedUtcIso: "2025-01-05T03:00:00Z",
    });
    expect(key).toBe("webhook-redirect-alerted-2025-01-05-03");
  });

  it("two runs within the same UTC hour produce the same key (dedup fires)", () => {
    const k1 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T14:02:00Z" }).key;
    const k2 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T14:58:59Z" }).key;
    expect(k1).toBe(k2);
  });

  it("consecutive UTC hours produce different keys (dedup resets)", () => {
    const k1 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T14:00:00Z" }).key;
    const k2 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T15:00:00Z" }).key;
    expect(k1).not.toBe(k2);
  });

  it("midnight UTC boundary: 23:59 and 00:00 next day are different keys", () => {
    const k1 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T23:59:00Z" }).key;
    const k2 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-16T00:00:00Z" }).key;
    expect(k1).toBe("webhook-redirect-alerted-2025-03-15-23");
    expect(k2).toBe("webhook-redirect-alerted-2025-03-16-00");
  });

  it("year rollover: Dec 31 23:xx and Jan 1 00:xx keys are distinct", () => {
    const k1 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-12-31T23:55:00Z" }).key;
    const k2 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2026-01-01T00:05:00Z" }).key;
    expect(k1).toBe("webhook-redirect-alerted-2025-12-31-23");
    expect(k2).toBe("webhook-redirect-alerted-2026-01-01-00");
  });
});

// ── 3. workflow_dispatch: extracted workflow bash always bypasses dedup ────────

describe("workflow_dispatch — extracted workflow bash produces unique per-run keys", () => {
  it("produces a key containing 'manual-' and the run ID", () => {
    const { key } = runDedupStep({
      eventName: "workflow_dispatch",
      runId: "12345678",
    });
    expect(key).toBe("webhook-redirect-alerted-manual-12345678");
  });

  it("two different run IDs produce two different keys", () => {
    const k1 = runDedupStep({ eventName: "workflow_dispatch", runId: "99001" }).key;
    const k2 = runDedupStep({ eventName: "workflow_dispatch", runId: "99002" }).key;
    expect(k1).not.toBe(k2);
  });

  it("dispatch key is disjoint from any scheduled key format", () => {
    const { key: dispatchKey } = runDedupStep({
      eventName: "workflow_dispatch",
      runId: "12345678",
      spoofedUtcIso: "2025-03-15T14:10:00Z", // irrelevant for dispatch but provided
    });
    const { key: scheduledKey } = runDedupStep({
      eventName: "schedule",
      spoofedUtcIso: "2025-03-15T14:10:00Z",
    });
    expect(dispatchKey).toContain("manual-");
    expect(scheduledKey).not.toContain("manual-");
    expect(dispatchKey).not.toBe(scheduledKey);
  });
});

// ── 4. Fix → break scenario via extracted workflow bash ───────────────────────

describe("dedup reset: redirect fixed mid-hour, then re-broken in the next hour", () => {
  /**
   * Scenario:
   *
   *  14:10  Redirect detected → alert sent → sentinel saved under hour-14 key.
   *  14:25  Redirect still present → hour-14 key matches → alert silenced.
   *  14:40  Operator fixes redirect → probe returns non-3xx → dedup step is
   *         SKIPPED (guarded by redirect == 'true') → no new key written.
   *  15:05  New redirect introduced → hour-15 key → cache miss → fresh alert.
   */

  it("14:10 and 14:25 within hour 14 share the same key (dedup fires)", () => {
    const k1 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T14:10:00Z" }).key;
    const k2 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T14:25:00Z" }).key;
    expect(k1).toBe(k2);
  });

  it("14:40 redirect fixed — dedup step is guarded by redirect==true so no key is written", () => {
    // Structural assertion: the step's `if:` condition prevents it running
    // when redirect is absent, so no sentinel is written for that run.
    const dedupSection = workflowText
      .split("- name: Compute alert dedup key")[1]
      ?.split("- name:")[0] ?? "";
    expect(dedupSection).toContain("redirect == 'true'");
  });

  it("15:05 re-broken produces a different key from hour 14 — cache miss — fresh alert", () => {
    const k14 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T14:10:00Z" }).key;
    const k15 = runDedupStep({ eventName: "schedule", spoofedUtcIso: "2025-03-15T15:05:00Z" }).key;
    expect(k14).toBe("webhook-redirect-alerted-2025-03-15-14");
    expect(k15).toBe("webhook-redirect-alerted-2025-03-15-15");
    expect(k14).not.toBe(k15);
  });
});
