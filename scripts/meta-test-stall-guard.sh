#!/usr/bin/env bash
# meta-test-stall-guard.sh
#
# Verifies that the slow CI job (`pnpm test:slow`) still catches a stall-guard
# regression after a Next.js version bump.
#
# How it works
# ────────────
# The stall test file (`upload-stall-timeout-nextdev.test.ts`) hardcodes the
# constant UPLOAD_READ_TIMEOUT_MS = 1_500 for its timing assertions, but reads
# the same name as an environment variable (via SERVER_TIMEOUT_MS) to inject
# into the spawned child servers (next dev + the helper stall-server).
#
# When we export UPLOAD_READ_TIMEOUT_MS=1:
#   • The helper server's per-chunk timer fires in ≈1 ms and returns 408.
#   • The test assertion `expect(elapsed).toBeGreaterThanOrEqual(1500)` fails
#     because elapsed ≈ 1 ms < 1500 ms.
#   • `pnpm test:slow` exits with a non-zero code.
#
# This script asserts that non-zero exit AND that the output contains the
# expected timing assertion failure for the stall scenario.  Checking for the
# specific assertion message prevents an unrelated test error (compile failure,
# server crash, etc.) from masquerading as a successful meta-test.
#
# Usage
# ─────
#   bash scripts/meta-test-stall-guard.sh
#
# Exit codes
#   0  — meta-test passed: the slow suite correctly detected the injected
#          timing regression and exited non-zero.
#   1  — meta-test failed: either the slow suite exited zero (guard broken),
#          or it failed for an unrelated reason (wrong kind of failure).

set -euo pipefail

echo "=== Stall-guard meta-test ==="

# ── Step 1: probe cold-start and retain the cache ─────────────────────────────
# Mirror the same two-step pattern used in the main slow-tests CI job:
# run the probe first with PROBE_RETAIN_CACHE=1 so that it keeps its
# .next-probe build directory and writes a sentinel file.  The subsequent
# test:slow invocation detects the sentinel and reuses the warm cache,
# avoiding a second cold start (~90 s saved).
echo "Probing next-dev cold-start time (PROBE_RETAIN_CACHE=1) …"
PROBE_RETAIN_CACHE=1 \
  pnpm --filter @workspace/artwork-bank run probe:nextdev-startup
echo ""

echo "Injecting UPLOAD_READ_TIMEOUT_MS=1 to simulate a stall regression …"
echo ""

# Capture both stdout and stderr; preserve the exit code without triggering
# set -e (the || true keeps bash happy while we inspect the code manually).
OUTPUT_FILE="$(mktemp)"
UPLOAD_READ_TIMEOUT_MS=1 \
  pnpm --filter @workspace/artwork-bank run test:slow \
  >"${OUTPUT_FILE}" 2>&1 \
  && SLOW_EXIT=0 || SLOW_EXIT=$?

# Echo the captured output so CI logs show the full suite run.
cat "${OUTPUT_FILE}"
echo ""
echo "pnpm test:slow exited with code: ${SLOW_EXIT}"

# ── Guard 1: suite must fail ──────────────────────────────────────────────────
if [[ "${SLOW_EXIT}" -eq 0 ]]; then
  echo ""
  echo "✗ Meta-test FAILED: slow suite exited 0 despite the injected"
  echo "  regression. The stall guard no longer catches timing regressions."
  echo "  Check SERVER_TIMEOUT_MS / UPLOAD_READ_TIMEOUT_MS usage in:"
  echo "    artifacts/artwork-bank/__tests__/slow/upload-stall-timeout-nextdev.test.ts"
  rm -f "${OUTPUT_FILE}"
  exit 1
fi

# ── Guard 2: failure must be the targeted timing assertion ────────────────────
# The injected regression causes `expect(elapsed).toBeGreaterThanOrEqual(1500)`
# to fail in the authenticated-stall scenario.  Vitest prints the matcher name
# when an assertion fails.  We check for that string in the captured output to
# confirm the stall guard is what tripped — not an unrelated crash or compile
# error that would make the meta-test a false positive.
EXPECTED_PATTERN="toBeGreaterThanOrEqual"
if ! grep -qF "${EXPECTED_PATTERN}" "${OUTPUT_FILE}"; then
  echo ""
  echo "✗ Meta-test FAILED: slow suite exited non-zero (exit ${SLOW_EXIT}) but"
  echo "  the output does not contain '${EXPECTED_PATTERN}'."
  echo "  The failure appears to be unrelated to the injected timing regression."
  echo "  Fix the underlying slow-test failure first, then re-run this script."
  rm -f "${OUTPUT_FILE}"
  exit 1
fi

rm -f "${OUTPUT_FILE}"
echo ""
echo "✓ Meta-test PASSED: slow suite correctly rejected the injected"
echo "  regression (exit ${SLOW_EXIT} ≠ 0, '${EXPECTED_PATTERN}' found in output)."
echo "  The stall guard is effective."
exit 0
