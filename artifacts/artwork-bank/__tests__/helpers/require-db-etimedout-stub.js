/**
 * Stub helper for require-db-guard tests.
 *
 * Patches child_process.spawnSync so that any call where the first argument is
 * "psql" returns a result whose `.error` property carries an ETIMEDOUT code —
 * exactly what Node's spawnSync sets when the `timeout` option fires.
 *
 * Running this script exercises the timeout branch of require-db.js without
 * waiting 15 seconds for a real network timeout.
 *
 * Usage (from a test):
 *   spawnSync(process.execPath, [STUB], { env: { DATABASE_URL: '...' }, encoding: 'utf8' })
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("module");
const path = require("path");

// Intercept child_process before require-db.js loads it.
const _originalLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  const real = _originalLoad(request, parent, isMain);
  if (request !== "child_process") return real;

  return Object.assign({}, real, {
    spawnSync(cmd, args, opts) {
      if (cmd === "psql") {
        const err = new Error("spawnSync psql ETIMEDOUT");
        err.code = "ETIMEDOUT";
        return {
          pid: 0,
          output: null,
          stdout: "",
          stderr: "",
          status: null,
          signal: null,
          error: err,
        };
      }
      return real.spawnSync(cmd, args, opts);
    },
  });
};

// Provide a dummy DATABASE_URL so the guard's first check passes and it
// proceeds to the psql probe (which our patched spawnSync will intercept).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://user:pass@localhost/testdb";
}

require(path.resolve(__dirname, "../../scripts/require-db.js"));
