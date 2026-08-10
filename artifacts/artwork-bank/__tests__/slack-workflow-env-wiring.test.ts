/**
 * Workflow YAML structural checks — Slack env-var wiring
 *
 * Verifies that every step that posts (or enables) Slack alerts in the following
 * GitHub Actions workflows wires its Slack-related env vars from the correct
 * repository-secret names:
 *
 *   - .github/workflows/slack-reconnect-smoke.yml
 *       "Run Slack smoke probe" step:
 *         SLACK_SMOKE_SECRET  → secrets.SLACK_SMOKE_SECRET
 *       "Resolve target URL" step:
 *         SECRET_URL          → secrets.ARTWORK_BANK_URL
 *
 *   - .github/workflows/scheduled-drift-check.yml
 *       "Run schema drift check against production database" step:
 *         SLACK_BILLING_ALERTS_CHANNEL → secrets.SLACK_BILLING_ALERTS_CHANNEL
 *         SLACK_BOT_TOKEN              → secrets.SLACK_BOT_TOKEN
 *         SLACK_WEBHOOK_URL            → secrets.SLACK_WEBHOOK_URL
 *
 *   - .github/workflows/schema-drift-guard.yml
 *       Build-pipeline guard (no Slack) — structural integrity checks:
 *         Assert all four named guard steps are still present.
 *         Assert the missing-URL test step sets DATABASE_URL to "" on the
 *         same line (so a real URL leaking in from the runner can't make the
 *         test vacuous).
 *
 * A secret rename (e.g. SLACK_BOT_TOKEN → SLACK_API_TOKEN) would silently
 * disable alerts — alerts stop arriving but no CI step fails.  These tests
 * catch that drift the moment the YAML is edited, before a deployment.
 *
 * Pattern (matches notify-webhook-heartbeat.test.ts):
 *   Each test locates the env-var key on its own YAML line, then asserts that
 *   the *same* line contains the expected `secrets.<NAME>` reference.  This
 *   means a cross-wired mapping (e.g.
 *     SLACK_BOT_TOKEN: ${{ secrets.SLACK_WEBHOOK_URL }})
 *   is caught even though both strings appear elsewhere in the block.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Read a GitHub Actions workflow YAML as plain text and return the env-block
 * lines that belong to the named step.
 *
 * Strategy:
 *   1. Split on lines.
 *   2. Find the line that contains `name: <stepName>`.
 *   3. From there, find the `env:` line that opens the step's env block.
 *   4. Collect all indented key lines until indentation drops back to the step
 *      level (or EOF), which marks the end of the env block.
 */
function extractStepEnvLines(workflowPath: string, stepName: string): string[] {
  const lines = readFileSync(workflowPath, "utf8").split("\n");

  const stepNameIdx = lines.findIndex((l) => l.includes(`name: ${stepName}`));
  if (stepNameIdx === -1) {
    throw new Error(
      `Could not find "name: ${stepName}" in ${workflowPath}`,
    );
  }

  const stepIndent = lines[stepNameIdx].match(/^(\s*)-\s/)?.[1]?.length ?? 0;

  let envIdx = -1;
  for (let i = stepNameIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^(\s*)\S/)?.[1]?.length ?? 0;
    if (indent <= stepIndent && line.trimStart().startsWith("- ")) break;
    if (line.trimStart().startsWith("env:")) {
      envIdx = i;
      break;
    }
  }
  if (envIdx === -1) {
    throw new Error(
      `"${stepName}" step has no env: block in ${workflowPath}`,
    );
  }

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
 * Assert that the env block for `stepName` wires `envVarName` from
 * `secrets.<secretName>` on the *same* YAML line.
 */
function assertStepEnvMapsToSecret(
  workflowPath: string,
  stepName: string,
  envVarName: string,
  secretName: string,
): void {
  const envLines = extractStepEnvLines(workflowPath, stepName);
  const declarationLine = envLines.find((l) =>
    new RegExp(`\\b${envVarName}\\s*:`).test(l),
  );
  expect(
    declarationLine,
    `Expected env block of step "${stepName}" in ${workflowPath} to contain a line declaring ${envVarName}`,
  ).toBeDefined();
  expect(
    declarationLine,
    `Expected ${envVarName} to be mapped to secrets.${secretName} on the same line in step "${stepName}" of ${workflowPath}`,
  ).toMatch(new RegExp(`secrets\\.${secretName}\\b`));
}

/**
 * Assert that the named step is present in the workflow YAML.
 */
function assertStepExists(workflowPath: string, stepName: string): void {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const found = lines.some((l) => l.includes(`name: ${stepName}`));
  expect(
    found,
    `Expected to find "name: ${stepName}" in ${workflowPath}`,
  ).toBe(true);
}

// ── slack-reconnect-smoke.yml ─────────────────────────────────────────────────
//
// This workflow hits the deployed app's /api/slack-smoke endpoint to verify
// that all Slack alert paths are reachable.  Two env vars carry secrets:
//   SLACK_SMOKE_SECRET — authenticates the request to the probe endpoint
//   SECRET_URL / ARTWORK_BANK_URL — tells the job where the app is deployed
//
// A mis-wired secret name in either step would silently send the smoke test
// to the wrong host or omit the auth header, causing a spurious 401/404 that
// looks like a Slack failure rather than a misconfigured workflow.

describe("slack-reconnect-smoke.yml — Run Slack smoke probe step env wiring", () => {
  const workflowPath = resolve(
    __dirname,
    "../../../.github/workflows/slack-reconnect-smoke.yml",
  );

  it("maps SLACK_SMOKE_SECRET to secrets.SLACK_SMOKE_SECRET on the same line", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      "Run Slack smoke probe",
      "SLACK_SMOKE_SECRET",
      "SLACK_SMOKE_SECRET",
    );
  });

  it("maps SECRET_URL to secrets.ARTWORK_BANK_URL on the same line in the Resolve target URL step", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      "Resolve target URL",
      "SECRET_URL",
      "ARTWORK_BANK_URL",
    );
  });
});

// ── scheduled-drift-check.yml ─────────────────────────────────────────────────
//
// This is the workflow that actually posts Slack alerts when the production
// schema is out of sync.  Its "Run schema drift check against production
// database" step wires all three Slack env vars.  A secret rename here would
// silently drop the drift alert — the job would succeed but the operator would
// never be notified.

describe("scheduled-drift-check.yml — schema-drift Slack alert env wiring", () => {
  const workflowPath = resolve(
    __dirname,
    "../../../.github/workflows/scheduled-drift-check.yml",
  );
  const stepName = "Run schema drift check against production database";

  it("maps SLACK_BILLING_ALERTS_CHANNEL to secrets.SLACK_BILLING_ALERTS_CHANNEL on the same line", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      stepName,
      "SLACK_BILLING_ALERTS_CHANNEL",
      "SLACK_BILLING_ALERTS_CHANNEL",
    );
  });

  it("maps SLACK_BOT_TOKEN to secrets.SLACK_BOT_TOKEN on the same line", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      stepName,
      "SLACK_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
    );
  });

  it("maps SLACK_WEBHOOK_URL to secrets.SLACK_WEBHOOK_URL on the same line", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      stepName,
      "SLACK_WEBHOOK_URL",
      "SLACK_WEBHOOK_URL",
    );
  });
});

// ── slack-reconnect-smoke.yml — "Send failure email alert" step ───────────────
//
// When the smoke probe fails, Slack itself may be unreachable, so this step
// sends a fallback email via SMTP (or a second Resend attempt).  The env block
// wires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, PLATFORM_ADMIN_EMAIL, and
// RESEND_API_KEY from repository secrets.  A secret rename here would silently
// prevent the operator from receiving the failure notification.

describe("slack-reconnect-smoke.yml — Send failure email alert step env wiring", () => {
  const workflowPath = resolve(
    __dirname,
    "../../../.github/workflows/slack-reconnect-smoke.yml",
  );
  const stepName = "Send failure email alert";

  it("maps SMTP_HOST to secrets.SMTP_HOST on the same line", () => {
    assertStepEnvMapsToSecret(workflowPath, stepName, "SMTP_HOST", "SMTP_HOST");
  });

  it("maps SMTP_PORT to secrets.SMTP_PORT on the same line", () => {
    assertStepEnvMapsToSecret(workflowPath, stepName, "SMTP_PORT", "SMTP_PORT");
  });

  it("maps SMTP_USER to secrets.SMTP_USER on the same line", () => {
    assertStepEnvMapsToSecret(workflowPath, stepName, "SMTP_USER", "SMTP_USER");
  });

  it("maps SMTP_PASS to secrets.SMTP_PASS on the same line", () => {
    assertStepEnvMapsToSecret(workflowPath, stepName, "SMTP_PASS", "SMTP_PASS");
  });

  it("maps PLATFORM_ADMIN_EMAIL to secrets.PLATFORM_ADMIN_EMAIL on the same line", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      stepName,
      "PLATFORM_ADMIN_EMAIL",
      "PLATFORM_ADMIN_EMAIL",
    );
  });

  it("maps RESEND_API_KEY to secrets.RESEND_API_KEY on the same line", () => {
    assertStepEnvMapsToSecret(
      workflowPath,
      stepName,
      "RESEND_API_KEY",
      "RESEND_API_KEY",
    );
  });
});

// ── schema-drift-guard.yml ────────────────────────────────────────────────────
//
// This workflow guards the *build pipeline* — it exits 1 when the schema is
// out of sync so Vercel can block a bad deploy.  It does not post Slack alerts
// (that is handled by scheduled-drift-check.yml above).
//
// Two classes of drift are caught here:
//   1. Step-name drift — a step is silently removed or renamed, bypassing the
//      guard.
//   2. DATABASE_URL value drift — the controlled-empty-string value that makes
//      the "exits 1 without DATABASE_URL" test deterministic is changed to
//      something else, letting a real URL leak in from the runner and making
//      the test vacuous.
//
// TODO: If a Slack notification step is ever added to schema-drift-guard.yml
// (e.g. to alert the operator when the build is blocked by schema drift),
// add a corresponding assertStepEnvMapsToSecret call here for each Slack-related
// env var in that step.  For example:
//
//   it("maps SLACK_WEBHOOK_URL to secrets.SLACK_WEBHOOK_URL on the same line", () => {
//     assertStepEnvMapsToSecret(
//       workflowPath,
//       "Notify Slack on schema drift",   // ← use the exact step name from the YAML
//       "SLACK_WEBHOOK_URL",
//       "SLACK_WEBHOOK_URL",
//     );
//   });
//
// Without this, a mis-wired secret name in the new step would silently drop the
// alert — the job succeeds but the operator is never notified.  See the
// scheduled-drift-check.yml tests above for the full pattern.

describe("schema-drift-guard.yml — build-pipeline guard structural integrity", () => {
  const workflowPath = resolve(
    __dirname,
    "../../../.github/workflows/schema-drift-guard.yml",
  );

  it('has a "Verify build script includes check-drift" step', () => {
    assertStepExists(workflowPath, "Verify build script includes check-drift");
  });

  it('has an "Assert check-drift exits 1 without DATABASE_URL" step', () => {
    assertStepExists(
      workflowPath,
      "Assert check-drift exits 1 without DATABASE_URL",
    );
  });

  it('has an "Assert check-drift exits 1 quickly with a bad DATABASE_URL" step', () => {
    assertStepExists(
      workflowPath,
      "Assert check-drift exits 1 quickly with a bad DATABASE_URL",
    );
  });

  it('has an "Assert connectionTimeoutMillis fires correctly (vitest smoke tests)" step', () => {
    assertStepExists(
      workflowPath,
      "Assert connectionTimeoutMillis fires correctly (vitest smoke tests)",
    );
  });

  it('sets DATABASE_URL to an explicit empty string "" in the "exits 1 without DATABASE_URL" step so no real URL can leak in from the runner', () => {
    // This step must set DATABASE_URL: "" (empty) — not just declare the key.
    // If the value is removed or changed to a real URL, the test becomes vacuous
    // (check-drift would connect to the database and exit 0, passing falsely).
    const envLines = extractStepEnvLines(
      workflowPath,
      "Assert check-drift exits 1 without DATABASE_URL",
    );
    const declarationLine = envLines.find((l) =>
      /\bDATABASE_URL\s*:/.test(l),
    );
    expect(
      declarationLine,
      `Expected the "Assert check-drift exits 1 without DATABASE_URL" step env block to contain a DATABASE_URL line`,
    ).toBeDefined();
    // The value must be an explicit empty string.
    expect(
      declarationLine,
      `Expected DATABASE_URL to be set to "" (empty string) so no real URL can leak in from the runner environment`,
    ).toMatch(/DATABASE_URL\s*:\s*""/);
  });
});
