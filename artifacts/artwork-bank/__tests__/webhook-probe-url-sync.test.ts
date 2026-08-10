/**
 * Webhook probe URL sync check
 *
 * Verifies that the URL hardcoded in the stripe-webhook-health.yml probe
 * workflow matches an actual route handler in this Next.js application.
 *
 * If the webhook route is ever moved or renamed, both the workflow AND the
 * route file must be updated together.  This test fails loudly when they
 * drift, preventing a silent situation where the health probe keeps checking
 * a path that no longer exists.
 *
 * How it works:
 *   1. Parse the workflow YAML with a regex to extract the default probe URL.
 *   2. Derive the URL path (everything after the hostname).
 *   3. Derive the expected Next.js App Router file path:
 *        /api/stripe/webhook  →  app/api/stripe/webhook/route.ts
 *   4. Assert the file exists on disk relative to this package root.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Root of the monorepo (two levels up from artifacts/artwork-bank) */
const MONOREPO_ROOT = resolve(__dirname, "../../../");

/** Path to the health-probe workflow, relative to the monorepo root. */
const WORKFLOW_REL = ".github/workflows/stripe-webhook-health.yml";
const WORKFLOW_PATH = join(MONOREPO_ROOT, WORKFLOW_REL);

/**
 * Extract the default probe URL from the workflow YAML.
 *
 * The relevant line looks like:
 *   URL="${INPUT_URL:-https://i-art.com.au/api/stripe/webhook}"
 *
 * We parse it with a regex rather than a full YAML parser to keep the test
 * dependency-free and to target the exact shell default value that is used
 * at runtime.
 */
function extractProbeUrl(yaml: string): string {
  // Match the Bash parameter expansion default:  ${INPUT_URL:-<url>}
  const match = yaml.match(/\$\{INPUT_URL:-([^}]+)\}/);
  if (!match || !match[1]) {
    throw new Error(
      `Could not find the default probe URL in ${WORKFLOW_REL}.\n` +
        `Expected a line like: URL="\${INPUT_URL:-https://...}"\n` +
        `If the probe URL was moved or reformatted, update this test too.`,
    );
  }
  return match[1].trim();
}

/**
 * Convert a URL path such as /api/stripe/webhook into the expected Next.js
 * App Router file path: app/api/stripe/webhook/route.ts
 */
function urlPathToRouteFile(urlPath: string): string {
  // Strip leading slash, prepend "app/", append "/route.ts"
  const stripped = urlPath.replace(/^\//, "");
  return `app/${stripped}/route.ts`;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("stripe-webhook-health.yml probe URL vs route handler", () => {
  it("workflow file is readable", () => {
    expect(
      existsSync(WORKFLOW_PATH),
      `Workflow file not found: ${WORKFLOW_REL}\nMonorepo root: ${MONOREPO_ROOT}`,
    ).toBe(true);
  });

  it("probe URL uses https scheme", () => {
    const yaml = readFileSync(WORKFLOW_PATH, "utf8");
    const url = extractProbeUrl(yaml);
    expect(
      url.startsWith("https://"),
      `Probe URL must begin with https:// — got: ${url}`,
    ).toBe(true);
  });

  it("probed path matches an existing route handler in this Next.js app", () => {
    const yaml = readFileSync(WORKFLOW_PATH, "utf8");
    const probeUrl = extractProbeUrl(yaml);

    // Derive the URL path from the full URL.
    let urlPath: string;
    try {
      urlPath = new URL(probeUrl).pathname;
    } catch {
      throw new Error(`Probe URL is not a valid URL: ${probeUrl}`);
    }

    const routeFile = urlPathToRouteFile(urlPath);

    // Resolve relative to the artwork-bank package root (one level up from __tests__)
    const packageRoot = resolve(__dirname, "..");
    const absoluteRouteFile = join(packageRoot, routeFile);

    expect(
      existsSync(absoluteRouteFile),
      [
        `Probe URL mismatch: the workflow probes "${probeUrl}"`,
        `but no matching Next.js route handler was found at:`,
        `  ${routeFile}  (relative to artifacts/artwork-bank)`,
        ``,
        `Either:`,
        `  (a) Update the workflow's default URL to match the new route path, or`,
        `  (b) Restore the route handler at the path the workflow already probes.`,
        ``,
        `Workflow: ${WORKFLOW_REL}`,
        `Expected route file: ${absoluteRouteFile}`,
      ].join("\n"),
    ).toBe(true);
  });

  it("route handler exports a POST function (confirming it is the Stripe webhook handler)", () => {
    const yaml = readFileSync(WORKFLOW_PATH, "utf8");
    const probeUrl = extractProbeUrl(yaml);
    const urlPath = new URL(probeUrl).pathname;
    const routeFile = urlPathToRouteFile(urlPath);

    const packageRoot = resolve(__dirname, "..");
    const absoluteRouteFile = join(packageRoot, routeFile);

    if (!existsSync(absoluteRouteFile)) {
      // Previous test already reports the missing file — skip the content check.
      return;
    }

    const contents = readFileSync(absoluteRouteFile, "utf8");

    expect(
      contents.includes("export async function POST") ||
        contents.includes("export function POST"),
      [
        `Route handler at "${routeFile}" does not export a POST function.`,
        `Stripe webhooks are delivered via POST — the probed endpoint must`,
        `export a POST handler to be a valid webhook receiver.`,
      ].join("\n"),
    ).toBe(true);
  });
});
