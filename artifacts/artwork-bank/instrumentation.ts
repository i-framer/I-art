/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * We use it to surface a clear startup error when image storage is not
 * configured, so operators see the problem immediately in Vercel logs rather
 * than discovering it when the first gallery tries to upload a photo.
 */
export async function register() {
  // Only run in the Node.js runtime (not the Edge runtime or build time).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ── Storage backend check ─────────────────────────────────────────────────
  try {
    const { getStorageProvider } = await import("./lib/object-storage");
    const provider = getStorageProvider();
    console.log(`[artwork-bank] Storage backend active: ${provider}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("━".repeat(72));
    console.error("⚠️  ARTWORK BANK — IMAGE STORAGE NOT CONFIGURED");
    console.error(message);
    console.error(
      "Galleries will NOT be able to upload photos until storage is set up.",
    );
    console.error(
      "Fix: set BLOB_READ_WRITE_TOKEN (Vercel Blob) in your environment,",
    );
    console.error(
      "     or PRIVATE_OBJECT_DIR (Replit App Storage) for local dev.",
    );
    console.error("     See DEPLOY.md §3 for full instructions.");
    console.error("━".repeat(72));
  }

  // ── Platform fee check ────────────────────────────────────────────────────
  try {
    // Importing lib/stripe triggers parsePlatformFeePercent() — if the env
    // var is invalid the import throws and we surface a clear startup error.
    const { PLATFORM_FEE_PERCENT } = await import("./lib/stripe");
    console.log(`[artwork-bank] Platform fee: ${PLATFORM_FEE_PERCENT}%`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("━".repeat(72));
    console.error("⚠️  ARTWORK BANK — PLATFORM FEE MISCONFIGURED");
    console.error(message);
    console.error(
      "Checkout will be unavailable until PLATFORM_FEE_PERCENT is corrected.",
    );
    console.error("     See DEPLOY.md for full instructions.");
    console.error("━".repeat(72));
  }
}
