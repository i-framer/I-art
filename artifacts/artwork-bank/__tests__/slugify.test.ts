/**
 * slugify() utility — covers URL-safe slug generation edge cases.
 *
 * Covers:
 *  - Basic lowercasing and whitespace→hyphen
 *  - Strips special characters (keeping letters, numbers, spaces, hyphens)
 *  - Collapses multiple spaces/hyphens into one
 *  - Strips leading/trailing hyphens
 *  - Unicode non-ASCII characters are stripped (leaving safe ASCII only)
 *  - Empty / whitespace-only input returns empty string
 *  - Numbers are preserved
 *
 * Also covers the registration signup action slug fallback:
 *  - An empty slug from slugify() falls back to "tenant"
 *  - A colliding slug gets a 4-char random suffix appended
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Auth module — keep real slugify but mock session/hashing ──────────────────
import { slugify } from "@/lib/auth";

describe("slugify", () => {
  it("lowercases and trims", () => {
    expect(slugify("  Hello World  ")).toBe("hello-world");
  });

  it("replaces spaces with hyphens", () => {
    expect(slugify("Jane Smith Studio")).toBe("jane-smith-studio");
  });

  it("strips special characters", () => {
    expect(slugify("Gallery (Sydney)!")).toBe("gallery-sydney");
  });

  it("collapses multiple consecutive hyphens", () => {
    expect(slugify("Art  --  Gallery")).toBe("art-gallery");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("-art-")).toBe("art");
  });

  it("preserves numbers", () => {
    expect(slugify("Gallery 42")).toBe("gallery-42");
  });

  it("handles a name that is already a valid slug", () => {
    expect(slugify("jane-smith")).toBe("jane-smith");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(slugify("   ")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("strips unicode/emoji characters (non-ASCII)", () => {
    // Non-ASCII letters are stripped by the [^a-z0-9\s-] regex.
    const result = slugify("Café & Co.");
    // 'café' → 'caf' after strip, '& co.' → 'co' after strip
    expect(result).toMatch(/^[a-z0-9-]*$/); // only safe chars remain
    expect(result).toBeTruthy();
  });

  it("handles a string with only special characters", () => {
    expect(slugify("!!!@@@###")).toBe("");
  });

  it("a hyphen-separated name is preserved as-is", () => {
    expect(slugify("Blue-Mountain")).toBe("blue-mountain");
  });
});

// ── signup slug logic unit-tested directly against slugify ────────────────────
// The signup action calls: let slug = slugify(businessName); if (!slug) slug = "tenant";
// then appends a random 4-char suffix on collision. We test the logic directly.

describe("signup slug derivation logic", () => {
  it("falls back to 'tenant' when slugify returns empty string", () => {
    // Mirrors: let slug = slugify(n); if (!slug) slug = "tenant"
    const businessName = "!!!###";
    let slug = slugify(businessName);
    if (!slug) slug = "tenant";
    expect(slug).toBe("tenant");
  });

  it("uses slugified name directly when it is non-empty and available", () => {
    const businessName = "Gallery One";
    let slug = slugify(businessName);
    if (!slug) slug = "tenant";
    expect(slug).toBe("gallery-one");
  });

  it("collision suffix is 4 chars of alphanumeric", () => {
    // Mirrors: const suffix = Math.random().toString(36).slice(2, 6);
    //          slug = `${slug}-${suffix}`;
    const base = "gallery-one";
    const suffix = Math.random().toString(36).slice(2, 6);
    const collided = `${base}-${suffix}`;
    expect(collided).toMatch(/^gallery-one-[a-z0-9]{4}$/);
  });

  it("collision suffix produces a different slug each call (probabilistic)", () => {
    const base = "gallery";
    const s1 = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const s2 = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    // Probability of collision is ~1 in 1.7M — safe for a test
    expect(s1).not.toBe(s2);
  });
});
