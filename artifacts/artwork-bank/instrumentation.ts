/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * IMPORTANT: this file is compiled for BOTH the Node.js and Edge runtimes.
 * All Node-only work lives in instrumentation-node.ts and is loaded via a
 * dynamic import guarded by an explicit NEXT_RUNTIME === "nodejs" check —
 * Next.js replaces NEXT_RUNTIME with a literal at build time, so webpack
 * dead-code-eliminates the import (and nodemailer etc.) from the Edge bundle.
 * Do NOT add static imports of server-only modules here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const mod = await import("./instrumentation-node");
    await mod.register();
  }
}
