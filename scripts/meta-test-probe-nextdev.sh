#!/usr/bin/env bash
# meta-test-probe-nextdev.sh
#
# Verifies that probe-nextdev-startup.ts behaves correctly under three
# scenarios so that regressions in the probe itself are caught before they
# matter.
#
# All scenarios use a fake `pnpm` shim prepended to PATH so the probe's
# inner spawn("pnpm", ...) is intercepted without spawning real next-dev.
# This makes all tests fast and fully deterministic.
#
#   Scenario 1 (timeout)     — fake pnpm sleeps indefinitely (no HTTP server).
#                              NEXTDEV_STARTUP_THRESHOLD_S=2 causes the probe
#                              to give up after 2 s.  Exercises the
#                              "did not become ready within Ns" exit path.
#
#   Scenario 2 (early crash) — fake pnpm exits 1 immediately.  Exercises the
#                              "next-dev exited with code N before becoming
#                              ready" exit path.
#
#   Scenario 3 (WARN path)   — fake pnpm serves real HTTP on $PORT after a
#                              delay that puts startup at ≥ 80% of the
#                              threshold (NEXTDEV_STARTUP_THRESHOLD_S=4,
#                              HTTP ready at ~3.1 s → ~87%).  Confirms the
#                              probe exits 0, emits status=WARN, and writes
#                              the warm-cache sentinel when PROBE_RETAIN_CACHE=1.
#                              Without this check, a future change that skips
#                              the sentinel write on the WARN path would
#                              silently break the warm-cache hand-off.
#
# The probe is invoked via tsx directly (not through pnpm) so that the fake
# pnpm shim only intercepts the inner spawn("pnpm", ...) call inside the probe
# — not the outer runner used to launch the probe itself.
#
# Usage
# ─────
#   bash scripts/meta-test-probe-nextdev.sh   (from workspace root)
#
# Exit codes
#   0  — all scenarios produced the expected result.
#   1  — at least one scenario failed (probe exited 0 on a failure path,
#         exited non-zero on the WARN success path, or sentinel was missing).

set -euo pipefail

echo "=== Probe cold-start meta-test ==="
echo ""

# This script lives at <workspace-root>/scripts/; the workspace root is one
# level up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# tsx binary shipped with the artwork-bank package.
TSX="${WORKSPACE_ROOT}/artifacts/artwork-bank/node_modules/.bin/tsx"
PROBE_SCRIPT="${WORKSPACE_ROOT}/artifacts/artwork-bank/scripts/probe-nextdev-startup.ts"

if [[ ! -x "${TSX}" ]]; then
  echo "ERROR: tsx not found at ${TSX}"
  echo "  Run 'pnpm install --frozen-lockfile' first."
  exit 1
fi

# ── Shared: create a temporary fake-bin directory ────────────────────────────
# Both scenarios prepend this directory to PATH so the probe's internal
#   spawn("pnpm", ["--filter", "@workspace/artwork-bank", "dev"])
# resolves to the shim instead of the real pnpm.
FAKE_BIN="$(mktemp -d)"
cleanup() {
  rm -rf "${FAKE_BIN}"
}
trap cleanup EXIT

# ── Scenario 1: timeout (deterministic) ─────────────────────────────────────
echo "Scenario 1: probe must exit non-zero when next-dev never becomes HTTP-ready"
echo "(fake pnpm sleeps forever — probe gives up after 2 s)"
echo ""

# Shim: starts but never binds a port → probe polls, gets ECONNREFUSED every
# 500 ms, exhausts the 2 s threshold, and prints "did not become ready".
cat >"${FAKE_BIN}/pnpm" <<'SHIM'
#!/usr/bin/env bash
# Fake pnpm: stay alive but never serve HTTP — simulates a hung next-dev.
sleep 300
SHIM
chmod +x "${FAKE_BIN}/pnpm"

OUTPUT_FILE_1="$(mktemp)"
PROBE_EXIT_1=0
PATH="${FAKE_BIN}:${PATH}" \
  NEXTDEV_STARTUP_THRESHOLD_S=2 \
  "${TSX}" "${PROBE_SCRIPT}" \
  >"${OUTPUT_FILE_1}" 2>&1 \
  && PROBE_EXIT_1=0 || PROBE_EXIT_1=$?

cat "${OUTPUT_FILE_1}"
echo ""
echo "Scenario 1: probe exited with code: ${PROBE_EXIT_1}"

if [[ "${PROBE_EXIT_1}" -eq 0 ]]; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 1): probe exited 0 despite the fake pnpm"
  echo "  never serving HTTP.  The timeout path is broken — the probe is"
  echo "  declaring success without a valid HTTP response."
  rm -f "${OUTPUT_FILE_1}"
  exit 1
fi

EXPECTED_TIMEOUT_PATTERN="did not become ready"
if ! grep -qF "${EXPECTED_TIMEOUT_PATTERN}" "${OUTPUT_FILE_1}"; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 1): probe exited non-zero (${PROBE_EXIT_1})"
  echo "  but output does not contain '${EXPECTED_TIMEOUT_PATTERN}'."
  echo "  The failure appears to be unrelated to the injected timeout."
  echo "  Fix any underlying probe error first, then re-run this script."
  rm -f "${OUTPUT_FILE_1}"
  exit 1
fi

rm -f "${OUTPUT_FILE_1}"
echo "✓ Scenario 1 PASSED: probe correctly exited ${PROBE_EXIT_1} on timeout."
echo ""

# ── Scenario 2: early crash (deterministic) ──────────────────────────────────
echo "Scenario 2: probe must exit non-zero when pnpm/next-dev crashes immediately"
echo "(fake pnpm exits 1 immediately — probe detects the early process exit)"
echo ""

# Overwrite the shim with one that exits immediately.
cat >"${FAKE_BIN}/pnpm" <<'SHIM'
#!/usr/bin/env bash
# Fake pnpm: exits 1 immediately — simulates next-dev crashing on startup.
exit 1
SHIM
chmod +x "${FAKE_BIN}/pnpm"

OUTPUT_FILE_2="$(mktemp)"
PROBE_EXIT_2=0
PATH="${FAKE_BIN}:${PATH}" \
  NEXTDEV_STARTUP_THRESHOLD_S=30 \
  "${TSX}" "${PROBE_SCRIPT}" \
  >"${OUTPUT_FILE_2}" 2>&1 \
  && PROBE_EXIT_2=0 || PROBE_EXIT_2=$?

cat "${OUTPUT_FILE_2}"
echo ""
echo "Scenario 2: probe exited with code: ${PROBE_EXIT_2}"

if [[ "${PROBE_EXIT_2}" -eq 0 ]]; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 2): probe exited 0 despite pnpm crashing"
  echo "  immediately.  The early-exit detection path is broken — the probe is"
  echo "  not checking proc.exitCode between polls."
  rm -f "${OUTPUT_FILE_2}"
  exit 1
fi

EXPECTED_CRASH_PATTERN="exited with code"
if ! grep -qF "${EXPECTED_CRASH_PATTERN}" "${OUTPUT_FILE_2}"; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 2): probe exited non-zero (${PROBE_EXIT_2})"
  echo "  but output does not contain '${EXPECTED_CRASH_PATTERN}'."
  echo "  The failure appears to be unrelated to the pnpm shim crash."
  echo "  Fix any underlying probe error first, then re-run this script."
  rm -f "${OUTPUT_FILE_2}"
  exit 1
fi

rm -f "${OUTPUT_FILE_2}"
echo "✓ Scenario 2 PASSED: probe correctly exited ${PROBE_EXIT_2} on early crash."
echo ""

# ── Scenario 3: WARN path — sentinel must be written at 80–99% threshold ─────
echo "Scenario 3: probe must exit 0, emit status=WARN, and write the warm-cache"
echo "sentinel when startup uses ≥ 80% of the threshold"
echo "(fake pnpm serves HTTP after 3.1 s; threshold is 4 s → ~87% ≥ 80%)"
echo ""

# Shim: opens a real HTTP server on \$PORT after a 3.1 s delay.
# With NEXTDEV_STARTUP_THRESHOLD_S=4 the probe will poll and succeed at the
# first opportunity after t=3.1 s (i.e. at t≈3.5 s), giving ratio≈0.875
# which is ≥ 0.8 — the WARN window.  The probe must still exit 0 and write
# the sentinel in this case.
cat >"${FAKE_BIN}/pnpm" <<'SHIM'
#!/usr/bin/env bash
# Fake pnpm: wait 3.1 s, then open an HTTP server on $PORT.
# Simulates a slow-but-successful next-dev startup that lands in the WARN band.
node -e "
const http = require('http');
const port = parseInt(process.env.PORT, 10);
setTimeout(function() {
  const server = http.createServer(function(req, res) {
    res.writeHead(200);
    res.end('ok');
  });
  server.listen(port, '127.0.0.1');
}, 3100);
" &
# Keep the shell alive so the probe's killProcessGroup finds a running leader.
wait
SHIM
chmod +x "${FAKE_BIN}/pnpm"

# The sentinel is written relative to the artwork-bank package directory.
SENTINEL_PATH="${WORKSPACE_ROOT}/artifacts/artwork-bank/.next-probe-cache-ready"
# Remove any sentinel left by an earlier invocation.
rm -f "${SENTINEL_PATH}"

OUTPUT_FILE_3="$(mktemp)"
PROBE_EXIT_3=0
PATH="${FAKE_BIN}:${PATH}" \
  NEXTDEV_STARTUP_THRESHOLD_S=4 \
  PROBE_RETAIN_CACHE=1 \
  "${TSX}" "${PROBE_SCRIPT}" \
  >"${OUTPUT_FILE_3}" 2>&1 \
  && PROBE_EXIT_3=0 || PROBE_EXIT_3=$?

cat "${OUTPUT_FILE_3}"
echo ""
echo "Scenario 3: probe exited with code: ${PROBE_EXIT_3}"

if [[ "${PROBE_EXIT_3}" -ne 0 ]]; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 3): probe exited ${PROBE_EXIT_3} on the WARN"
  echo "  path.  The probe must exit 0 when startup succeeds within the threshold"
  echo "  even if it used ≥ 80% of the allowed time."
  rm -f "${OUTPUT_FILE_3}"
  exit 1
fi

EXPECTED_WARN_PATTERN="status=WARN"
if ! grep -qF "${EXPECTED_WARN_PATTERN}" "${OUTPUT_FILE_3}"; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 3): probe exited 0 but output does not"
  echo "  contain '${EXPECTED_WARN_PATTERN}'."
  echo "  The fake pnpm delay may not have pushed the ratio past 0.8 —"
  echo "  check that NEXTDEV_STARTUP_THRESHOLD_S and the node delay are"
  echo "  still calibrated to produce ratio ≥ 0.8."
  rm -f "${OUTPUT_FILE_3}"
  exit 1
fi

if [[ ! -f "${SENTINEL_PATH}" ]]; then
  echo ""
  echo "✗ Meta-test FAILED (scenario 3): probe exited 0 with WARN status but"
  echo "  did not write the warm-cache sentinel at '${SENTINEL_PATH}'."
  echo "  The sentinel write must execute on the WARN path (80–99%), not only"
  echo "  on the OK path — otherwise the warm-cache hand-off is silently lost"
  echo "  whenever startup happens to land in the warning band."
  rm -f "${OUTPUT_FILE_3}"
  exit 1
fi

rm -f "${OUTPUT_FILE_3}"
echo "✓ Scenario 3 PASSED: probe exited 0 (WARN), warm-cache sentinel written."
echo ""

echo "✓ Probe cold-start meta-test PASSED: timeout, early-crash, and WARN-path"
echo "  scenarios all produced the expected outcome."
exit 0
