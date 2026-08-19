/**
 * Task #66 — Label older replies sent before sender tracking existed.
 *
 * Pure unit tests for senderDisplayName() — no database required.
 * These run in the default `pnpm test` fast suite.
 *
 * The matching integration checks (real-DB assertions) live in
 * inquiry-reply-sender-label-integration.test.ts.
 */
import { describe, it, expect } from "vitest";

import { senderDisplayName } from "@/lib/sender-display-name";

// ─── Unit tests: senderDisplayName ───────────────────────────────────────────

describe("senderDisplayName (Task #66)", () => {
  it("converts a dotted email local-part to a display name", () => {
    expect(senderDisplayName("jane.smith@example.com")).toBe("Jane Smith");
  });

  it("converts an underscored local-part", () => {
    expect(senderDisplayName("john_doe@gallery.com.au")).toBe("John Doe");
  });

  it("converts a hyphenated local-part", () => {
    expect(senderDisplayName("anna-kim@studio.com")).toBe("Anna Kim");
  });

  it("handles a single-word local-part", () => {
    expect(senderDisplayName("mark@anokah.com.au")).toBe("Mark");
  });

  it("returns empty string for null (triggers the fallback label)", () => {
    expect(senderDisplayName(null)).toBe("");
  });

  it("returns empty string for undefined (triggers the fallback label)", () => {
    expect(senderDisplayName(undefined)).toBe("");
  });

  it("returns empty string for an empty string (triggers the fallback label)", () => {
    expect(senderDisplayName("")).toBe("");
  });
});

// ─── Edge-case unit tests (Task #1075) ───────────────────────────────────────
// These cover inputs that a future regex change could silently mishandle.

describe("senderDisplayName edge cases (Task #1075)", () => {
  it("preserves casing of an all-uppercase local-part (only boundary char is touched)", () => {
    // "JANE.SMITH" → replace dot → "JANE SMITH"
    // \b\w uppercases 'J' (already upper) and 'S' (already upper) — rest stays as-is
    expect(senderDisplayName("JANE.SMITH@example.com")).toBe("JANE SMITH");
  });

  it("returns the raw digits for a numeric-only local-part", () => {
    // digits have no case — no transformation is visible
    expect(senderDisplayName("12345@example.com")).toBe("12345");
  });

  it("collapses consecutive dots into a single space", () => {
    // "anna..kim" → /[._-]+/ with + collapses both dots → "anna kim" → "Anna Kim"
    expect(senderDisplayName("anna..kim@example.com")).toBe("Anna Kim");
  });

  it("collapses a mixed run of separators into a single space", () => {
    // "anna.-kim" → the run .- is collapsed to one space → "Anna Kim"
    expect(senderDisplayName("anna.-kim@example.com")).toBe("Anna Kim");
  });

  it("trims a leading separator so the result starts with a capital letter", () => {
    // ".jane@example.com" → local = ".jane" → " jane" after replace → trim → "jane" → "Jane"
    expect(senderDisplayName(".jane@example.com")).toBe("Jane");
  });

  it("trims a trailing separator so the result ends cleanly", () => {
    // "jane.@example.com" → local = "jane." → "jane " after replace → trim → "jane" → "Jane"
    expect(senderDisplayName("jane.@example.com")).toBe("Jane");
  });
});

// ─── Display-contract test: null senderEmail → fallback label ────────────────
// Verifies the page-rendering contract without importing the React component:
// when senderDisplayName returns "" (null email), the page shows the italic
// fallback. This mirrors the exact branch at page.tsx lines 334-340.

describe("reply display contract — null sender (Task #66)", () => {
  it("senderDisplayName returns falsy for null, triggering the fallback branch", () => {
    // The page renders: senderEmail ? displayName : "staff (sender not recorded)"
    const senderEmail: string | null = null;
    const displayName = senderDisplayName(senderEmail);
    // Falsy value → the page renders the italic fallback label.
    expect(displayName).toBeFalsy();
  });

  it("senderDisplayName returns truthy for a real email, suppressing the fallback", () => {
    const senderEmail = "jane@janesmith.studio";
    const displayName = senderDisplayName(senderEmail);
    expect(displayName).toBeTruthy();
    expect(displayName).toBe("Jane");
  });
});
