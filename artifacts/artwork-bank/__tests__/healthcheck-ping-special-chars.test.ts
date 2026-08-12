/**
 * Task #580 — Confirm the external healthcheck ping still works when
 * HEALTHCHECK_URL contains special characters.
 *
 * Context
 * ───────
 * The `.github/workflows/stripe-webhook-health.yml` step "Ping external
 * healthcheck URL" executes:
 *
 *   curl -fsS --retry 3 --max-time 10 "$HEALTHCHECK_URL" -o /dev/null
 *
 * HEALTHCHECK_URL is double-quoted, which prevents shell word-splitting and
 * globbing.  A URL such as `https://hc-ping.com/xxx?foo=bar&baz=qux` must be
 * passed as ONE argument to curl — without the double-quote a bare `&`
 * backgrounds the process and `?` triggers globbing.
 *
 * Tests
 * ─────
 * 1. Structural: the curl invocation double-quotes the variable.
 * 2. Structural: the skip path (empty URL) is guarded with [ -z "$..." ].
 * 3. Runtime: HEALTHCHECK_URL="" exits 0 with the "skipping" message.
 * 4. Runtime: HEALTHCHECK_URL with `&` characters is passed as a single
 *    argument to curl (no word-splitting occurs).
 * 5. Runtime: HEALTHCHECK_URL with `?` is also passed without globbing.
 * 6. Runtime: the step is non-fatal — a curl failure writes a warning but
 *    does not cause the step to exit non-zero.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

// ── Load the workflow once ────────────────────────────────────────────────────

const WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../../.github/workflows/stripe-webhook-health.yml",
);

let workflowText: string;

beforeAll(() => {
  workflowText = readFileSync(WORKFLOW_PATH, "utf8");
});

function extractStepBlock(stepName: string): string {
  const after = workflowText.split(`- name: ${stepName}`)[1];
  if (!after) throw new Error(`Step "${stepName}" not found in ${WORKFLOW_PATH}`);
  return after.split("- name:")[0];
}

function extractStepRunBlock(stepName: string): string {
  const block = extractStepBlock(stepName);
  const marker = "run: |\n";
  const idx = block.indexOf(marker);
  if (idx === -1) throw new Error(`No 'run: |' in step "${stepName}"`);
  const afterMarker = block.slice(idx + marker.length);
  const firstLine = afterMarker.split("\n").find((l) => l.trim().length > 0) ?? "";
  const indent = firstLine.match(/^(\s+)/)?.[1] ?? "";
  const lines = afterMarker
    .split("\n")
    .map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}

// ── Run the ping step bash in an isolated temp dir ────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runPingBash(opts: {
  healthcheckUrl: string;
  curlShim?: string; // optional bash function to override curl
}): RunResult {
  const { healthcheckUrl, curlShim = "" } = opts;
  const bash = extractStepRunBlock("Ping external healthcheck URL");

  const dir = path.join(tmpdir(), `ping-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, "test.sh");

  // If REDIRECT is not 'false' the step's `if:` condition would skip it in CI,
  // but we run the bash body directly — no condition guard needed here.
  const script = [
    "#!/bin/bash",
    `HEALTHCHECK_URL="${healthcheckUrl.replace(/"/g, '\\"')}"`,
    curlShim,
    bash,
  ].join("\n");

  writeFileSync(scriptFile, script, { mode: 0o755 });

  try {
    const result = spawnSync("bash", [scriptFile], { encoding: "utf8" });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("healthcheck ping — special characters in HEALTHCHECK_URL (Task #580)", () => {
  // ── Structural guards ─────────────────────────────────────────────────────

  it('bash double-quotes the HEALTHCHECK_URL variable in the curl invocation', () => {
    const bash = extractStepRunBlock("Ping external healthcheck URL");
    // Must be "$HEALTHCHECK_URL" (double-quoted) not $HEALTHCHECK_URL (bare).
    // Without double-quotes, characters like & and ? cause word-splitting or
    // globbing and the URL is passed incorrectly to curl.
    expect(bash).toMatch(/"\$HEALTHCHECK_URL"/);
  });

  it('bash uses [ -z "$HEALTHCHECK_URL" ] or [ -z "${HEALTHCHECK_URL}" ] for the empty-check', () => {
    const bash = extractStepRunBlock("Ping external healthcheck URL");
    // The empty-URL check must also double-quote the variable to avoid
    // triggering unbound-variable errors in set -u environments.
    expect(bash).toMatch(/\[ -z "\$\{?HEALTHCHECK_URL\}?" \]/);
  });

  // ── Runtime: skip path ────────────────────────────────────────────────────

  it('HEALTHCHECK_URL="" exits 0 (step skips gracefully)', () => {
    const { exitCode } = runPingBash({ healthcheckUrl: "" });
    expect(exitCode).toBe(0);
  });

  it('HEALTHCHECK_URL="" emits the "skipping" message', () => {
    const { stdout, stderr } = runPingBash({ healthcheckUrl: "" });
    const combined = stdout + stderr;
    expect(combined).toMatch(/skip/i);
  });

  // ── Runtime: special characters passed as a single argument ──────────────

  it('URL with & is passed as a single curl argument (no word-splitting)', () => {
    // Override curl with a bash function that records every argument in a
    // temp file.  If & caused splitting we would see two separate args.
    const argsFile = `/tmp/curl-args-${randomUUID()}.txt`;
    const curlShim = [
      `function curl() {`,
      `  printf '%s\\n' "$@" > "${argsFile}"`,
      `  return 0`,
      `}`,
      `export -f curl`,
    ].join("\n");

    const url = "https://hc-ping.io/path?check=ok&source=ci";
    runPingBash({ healthcheckUrl: url, curlShim });

    try {
      const args = readFileSync(argsFile, "utf8");
      // The full URL must appear as one line (one argument); `&source=ci` must
      // NOT be split off as a separate argument.
      const lines = args.split("\n").filter((l) => l.length > 0);
      const urlLine = lines.find((l) => l.includes("hc-ping.io"));
      expect(urlLine).toBe(url);
    } finally {
      try { rmSync(argsFile, { force: true }); } catch { /* ignore */ }
    }
  });

  it('URL with ? is passed as a single curl argument (no glob expansion)', () => {
    const argsFile = `/tmp/curl-args-${randomUUID()}.txt`;
    const curlShim = [
      `function curl() {`,
      `  printf '%s\\n' "$@" > "${argsFile}"`,
      `  return 0`,
      `}`,
      `export -f curl`,
    ].join("\n");

    const url = "https://hc-ping.io/uuid-abc-123?s=1";
    runPingBash({ healthcheckUrl: url, curlShim });

    try {
      const args = readFileSync(argsFile, "utf8");
      const lines = args.split("\n").filter((l) => l.length > 0);
      const urlLine = lines.find((l) => l.includes("hc-ping.io"));
      expect(urlLine).toBe(url);
    } finally {
      try { rmSync(argsFile, { force: true }); } catch { /* ignore */ }
    }
  });

  // ── Runtime: curl failure is non-fatal ───────────────────────────────────

  it('curl failure emits a warning but exits 0 (step is non-fatal)', () => {
    // Override curl to always fail (exit 1).
    const curlShim = [
      `function curl() { return 1; }`,
      `export -f curl`,
    ].join("\n");

    const { exitCode, stdout, stderr } = runPingBash({
      healthcheckUrl: "https://hc-ping.io/abc",
      curlShim,
    });

    expect(exitCode).toBe(0);
    const combined = stdout + stderr;
    expect(combined).toMatch(/fail|warn/i);
  });
});
