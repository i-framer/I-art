#!/usr/bin/env tsx
/**
 * probe-nextdev-startup.ts
 *
 * Standalone cold-start probe for `next dev`.
 *
 * Purpose
 * ───────
 * Runs as a dedicated CI step *before* the slow-test suite so that startup
 * regressions are visible at the workflow-step level rather than buried inside
 * Vitest's beforeAll output.
 *
 * What it does
 * ────────────
 *   1. Spawns `pnpm --filter @workspace/artwork-bank dev` on a free port.
 *   2. Polls the server root (/) every 500 ms until it responds.
 *   3. Kills the entire process group (pnpm + next dev children) and prints:
 *        [probe] next-dev cold-start: elapsed=42s  threshold=90s  status=OK
 *   4. Exits with code 1 if startup exceeds NEXTDEV_STARTUP_THRESHOLD_S (default 90 s)
 *      or if the server never becomes ready within the threshold.
 *
 * Process-group teardown
 * ──────────────────────
 * `pnpm` spawns `next dev` as a child process.  Sending SIGTERM only to the
 * `pnpm` wrapper leaves `next dev` alive and the port still bound, which would
 * cause the following slow-test suite to fail on startup.
 *
 * To avoid this the probe spawns `pnpm` with `detached: true`, which makes it
 * the leader of a new process group.  All of its children (next dev and its
 * workers) join that group.  Teardown then signals the *group* by passing a
 * negative PID to `process.kill(-pid, signal)`.
 *
 * Cleanup is guaranteed on all exit paths — the `cleanup` function is called
 * before every `process.exit`, and a `SIGINT`/`SIGTERM` handler on the probe
 * process itself also runs cleanup so that Ctrl-C and CI job cancellation
 * don't leave orphaned processes.
 *
 * Configuration (environment variables)
 * ──────────────────────────────────────
 *   NEXTDEV_STARTUP_THRESHOLD_S   Fail threshold in seconds (default: 90)
 *
 * Usage
 * ─────
 *   pnpm --filter @workspace/artwork-bank exec tsx scripts/probe-nextdev-startup.ts
 *
 * In CI this is run as a separate step before `pnpm test:slow` so that slow
 * startup is caught at the step level rather than silently eating into the
 * 180 s beforeAll budget.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

// ── Configuration ─────────────────────────────────────────────────────────────

const THRESHOLD_S = parseInt(
  process.env.NEXTDEV_STARTUP_THRESHOLD_S ?? "90",
  10,
);
const THRESHOLD_MS = THRESHOLD_S * 1_000;

/**
 * Isolated Next.js build-output directory — distinct from the main workspace
 * .next cache and from the slow-test suite's own .next-slow-test directory so
 * this probe and the test suite can run in sequence without cache collisions.
 */
const PROBE_BUILD_DIR = ".next-probe";

// ── Port helper ───────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ── Process-group teardown ────────────────────────────────────────────────────

/**
 * Kill the entire process group started by `spawn(..., { detached: true })`.
 *
 * Negative PID in `process.kill(-pid, signal)` sends the signal to every
 * process whose process-group ID equals `pid` — i.e. `pnpm` and all of its
 * descendants (next dev, its worker processes, etc.).
 *
 * The function is bounded: it waits at most `hardKillAfterMs` for the group
 * leader to exit before sending SIGKILL to the group, then waits at most
 * another `hardKillAfterMs` for the leader to die completely.  This prevents
 * an infinite hang even if a child ignores SIGTERM.
 */
async function killProcessGroup(
  pid: number,
  hardKillAfterMs = 5_000,
): Promise<void> {
  // Attempt SIGTERM to the whole group.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Group already gone — nothing to do.
    return;
  }

  // Wait up to hardKillAfterMs for the group leader to die.
  const termDeadline = Date.now() + hardKillAfterMs;
  while (Date.now() < termDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(-pid, 0); // probe: throws if group is gone
    } catch {
      return; // all gone
    }
  }

  // Escalate to SIGKILL.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return; // already dead
  }

  // Wait a final bounded window for SIGKILL to land.
  const killDeadline = Date.now() + hardKillAfterMs;
  while (Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
  }
  // If the process is still alive after SIGKILL there is nothing more we can
  // do — fall through and let the OS reap it when the probe exits.
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const artworkBankDir = path.resolve(scriptDir, "..");
  const workspaceRoot = path.resolve(artworkBankDir, "../..");
  const buildOutputPath = path.join(artworkBankDir, PROBE_BUILD_DIR);

  // Clean the isolated probe build directory so we always start cold.
  try {
    fs.rmSync(buildOutputPath, { recursive: true, force: true });
  } catch {
    // Directory may not exist yet — fine.
  }

  const port = await findFreePort();

  console.log(
    `[probe] Starting next-dev on port ${port} (threshold: ${THRESHOLD_S}s) …`,
  );

  // detached: true creates a new process group whose PGID == proc.pid.
  // This is essential so we can send signals to the entire tree (pnpm +
  // next dev + its workers) via process.kill(-pid, signal).
  const proc = spawn(
    "pnpm",
    ["--filter", "@workspace/artwork-bank", "dev"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PORT: String(port),
        BUILD_DIR: PROBE_BUILD_DIR,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Unreference so the probe event loop doesn't stay alive just because the
  // child is running.  We manage the lifecycle explicitly below.
  proc.unref();

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // Guaranteed cleanup: kill the process group and remove the build dir.
  // Called on every exit path including SIGINT/SIGTERM to the probe itself.
  let cleaned = false;
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    const pid = proc.pid;
    if (pid !== undefined) {
      await killProcessGroup(pid);
    }
    try {
      fs.rmSync(buildOutputPath, { recursive: true, force: true });
    } catch {
      // Best-effort — ignore errors.
    }
  }

  // Handle probe-process signals so Ctrl-C / CI job cancellation also cleans up.
  let signalReceived = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (signalReceived) return;
      signalReceived = true;
      cleanup().finally(() => process.exit(1));
    });
  }

  // ── Poll loop ────────────────────────────────────────────────────────────────

  const startMs = Date.now();
  const deadline = startMs + THRESHOLD_MS;
  let lastError: Error | null = null;
  let ready = false;
  let earlyExit = false;
  let earlyExitCode: number | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));

    if (proc.exitCode !== null) {
      earlyExit = true;
      earlyExitCode = proc.exitCode;
      break;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/`,
          { timeout: 1_000 },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("probe timeout"));
        });
      });
      ready = true;
      break;
    } catch (err) {
      lastError = err as Error;
    }
  }

  const elapsedMs = Date.now() - startMs;
  const elapsedS = (elapsedMs / 1_000).toFixed(1);

  // Always tear down the process group before exiting.
  await cleanup();

  // ── Outcome reporting ─────────────────────────────────────────────────────

  if (earlyExit) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
    console.error(
      `[probe] next-dev cold-start: elapsed=${elapsedS}s  threshold=${THRESHOLD_S}s  status=FAIL`,
    );
    console.error(
      `[probe] next-dev exited with code ${earlyExitCode} before becoming ready.\n` +
        `Server stderr (last 2000 chars):\n${stderr}`,
    );
    process.exit(1);
  }

  if (!ready) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
    console.error(
      `[probe] next-dev cold-start: elapsed=${elapsedS}s  threshold=${THRESHOLD_S}s  status=FAIL`,
    );
    console.error(
      `[probe] Server did not become ready within ${THRESHOLD_S}s.\n` +
        `Last probe error: ${lastError?.message ?? "unknown"}\n` +
        `Server stderr (last 2000 chars):\n${stderr}`,
    );
    process.exit(1);
  }

  const ratio = elapsedMs / THRESHOLD_MS;
  const pct = (ratio * 100).toFixed(1);

  if (ratio >= 1) {
    // Startup succeeded but measurement exceeded the threshold — still a failure.
    console.error(
      `[probe] next-dev cold-start: elapsed=${elapsedS}s  threshold=${THRESHOLD_S}s  used=${pct}%  status=FAIL`,
    );
    console.error(
      `[probe] Startup exceeded the ${THRESHOLD_S}s threshold. ` +
        `Investigate next-dev compilation time or increase NEXTDEV_STARTUP_THRESHOLD_S.`,
    );
    process.exit(1);
  }

  if (ratio >= 0.8) {
    console.warn(
      `[probe] next-dev cold-start: elapsed=${elapsedS}s  threshold=${THRESHOLD_S}s  used=${pct}%  status=WARN`,
    );
    console.warn(
      `[probe] WARNING: startup consumed ${pct}% of the ${THRESHOLD_S}s threshold. ` +
        `The slow-test beforeAll budget will be under pressure on cold or slower runners.`,
    );
  } else {
    console.log(
      `[probe] next-dev cold-start: elapsed=${elapsedS}s  threshold=${THRESHOLD_S}s  used=${pct}%  status=OK`,
    );
  }
  // Exit cleanly (code 0).
}

main().catch(async (err: unknown) => {
  console.error("[probe] Unexpected error:", err);
  process.exit(1);
});
