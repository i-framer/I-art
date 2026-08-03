/**
 * Node-only startup checks — loaded from instrumentation.ts ONLY when
 * NEXT_RUNTIME === "nodejs".  This file (and its transitive imports, incl.
 * nodemailer via lib/email) must never be statically imported from
 * instrumentation.ts, or webpack bundles it for the Edge runtime and the
 * build fails on Node builtins (stream/fs/crypto).
 *
 * Surfaces clear startup errors for missing/misconfigured critical env vars
 * so operators see problems in Vercel logs immediately rather than discovering
 * them via user-facing 500 errors.
 */
export async function register() {
  const isProd = process.env.NODE_ENV === "production";

  // ── Critical env-var check (production only) ──────────────────────────────
  if (isProd) {
    const required: { key: string; hint: string }[] = [
      {
        key: "DATABASE_URL",
        hint: "Set DATABASE_URL to your Postgres connection string (see DEPLOY.md §2).",
      },
      {
        key: "SESSION_SECRET",
        hint: "Generate with: openssl rand -base64 32",
      },
      {
        key: "NEXT_PUBLIC_SITE_URL",
        hint: "Set to your canonical apex URL, e.g. https://i-art.com.au",
      },
      {
        key: "CRON_SECRET",
        hint: "Generate with: openssl rand -hex 32  (Vercel cron and sweep endpoints use this)",
      },
    ];
    const missing = required.filter((r) => !process.env[r.key]);
    if (missing.length > 0) {
      console.error("━".repeat(72));
      console.error("⚠️  ARTWORK BANK — MISSING REQUIRED ENVIRONMENT VARIABLES");
      for (const { key, hint } of missing) {
        console.error(`   • ${key} is not set. ${hint}`);
      }
      console.error("   The app will fail to serve pages until these are set.");
      console.error("   See DEPLOY.md §2 for the complete variable reference.");
      console.error("━".repeat(72));
    }

    // Warn if STRIPE_WEBHOOK_DEV_BYPASS is set in production — dangerous.
    if (process.env.STRIPE_WEBHOOK_DEV_BYPASS) {
      console.error("━".repeat(72));
      console.error("⚠️  ARTWORK BANK — SECURITY RISK: STRIPE_WEBHOOK_DEV_BYPASS is set in production");
      console.error(
        "   This disables webhook signature verification. Remove it immediately.",
      );
      console.error("━".repeat(72));
    }

    // Warn if the site URL starts with www but CNAME_TARGET isn't set —
    // tenant custom-domain verification will silently fail.
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
    if (siteUrl.includes("://www.") && !process.env.CNAME_TARGET) {
      console.warn(
        "[artwork-bank] NEXT_PUBLIC_SITE_URL uses www but CNAME_TARGET is not set. " +
          "Custom domain verification may not work correctly. " +
          "Set CNAME_TARGET=cname.vercel-dns.com (see DEPLOY.md §5).",
      );
    }
  }

  // ── Storage backend check ──────────────────────────────────────────────────
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

  // ── Email transport check ─────────────────────────────────────────────────
  try {
    const { isEmailTransportConfigured } = await import("./lib/email");
    if (!isEmailTransportConfigured()) {
      console.warn(
        "[artwork-bank] Email transport is NOT configured. " +
          "Transactional emails (order confirmations, inquiry replies) will not be sent. " +
          "Set SMTP_HOST + SMTP_USER + SMTP_PASS, or RESEND_API_KEY. See DEPLOY.md §2.",
      );
    } else {
      console.log("[artwork-bank] Email transport configured.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[artwork-bank] Email transport check failed:", message);
  }
}
