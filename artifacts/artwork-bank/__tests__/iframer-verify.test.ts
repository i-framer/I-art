/**
 * i-Framer Premium verification service  (Task #217)
 *
 * Unit tests for normaliseIFramerUrl and the pure logic layer.
 * Integration tests for verifyIFramerPremium are skipped when
 * IFRAMER_VERIFY_DB_URL is not set.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  normaliseIFramerUrl,
  isIFramerVerifyConfigured,
} from "@/lib/iframer-verify";

// ── normaliseIFramerUrl ───────────────────────────────────────────────────────

describe("normaliseIFramerUrl (Task #217)", () => {
  it("extracts slug from a full portal URL", () => {
    expect(normaliseIFramerUrl("https://portal.iframer.com.au/accounts/my-gallery"))
      .toBe("my-gallery");
  });

  it("extracts slug from a URL without protocol", () => {
    expect(normaliseIFramerUrl("portal.iframer.com.au/accounts/abc-studio")).toBe("abc-studio");
  });

  it("accepts a bare slug", () => {
    expect(normaliseIFramerUrl("my-gallery")).toBe("my-gallery");
  });

  it("accepts underscores and digits in slug", () => {
    expect(normaliseIFramerUrl("my_gallery_123")).toBe("my_gallery_123");
  });

  it("accepts mixed-case slug", () => {
    expect(normaliseIFramerUrl("MyGallery")).toBe("MyGallery");
  });

  it("returns null for empty string", () => {
    expect(normaliseIFramerUrl("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normaliseIFramerUrl("   ")).toBeNull();
  });

  it("returns null for a slug with dangerous characters", () => {
    expect(normaliseIFramerUrl("'; DROP TABLE accounts; --")).toBeNull();
  });

  it("returns null for a slug that is too long (>100 chars)", () => {
    expect(normaliseIFramerUrl("a".repeat(101))).toBeNull();
  });

  it("returns null for a URL with no meaningful path segment", () => {
    // URL like https://example.com/ — last segment is empty after split
    expect(normaliseIFramerUrl("https://example.com/")).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(normaliseIFramerUrl("  my-gallery  ")).toBe("my-gallery");
  });

  it("uses the last non-empty URL path segment", () => {
    // /accounts/sub-accounts/gallery-slug → gallery-slug
    expect(normaliseIFramerUrl("https://portal.iframer.com.au/accounts/sub/gallery-slug"))
      .toBe("gallery-slug");
  });
});

// ── isIFramerVerifyConfigured ─────────────────────────────────────────────────

describe("isIFramerVerifyConfigured (Task #217)", () => {
  const originalEnv = process.env.IFRAMER_VERIFY_DB_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IFRAMER_VERIFY_DB_URL;
    } else {
      process.env.IFRAMER_VERIFY_DB_URL = originalEnv;
    }
  });

  it("returns false when IFRAMER_VERIFY_DB_URL is absent", () => {
    delete process.env.IFRAMER_VERIFY_DB_URL;
    expect(isIFramerVerifyConfigured()).toBe(false);
  });

  it("returns true when IFRAMER_VERIFY_DB_URL is set", () => {
    process.env.IFRAMER_VERIFY_DB_URL = "postgres://ro:pw@host/db";
    expect(isIFramerVerifyConfigured()).toBe(true);
  });
});
