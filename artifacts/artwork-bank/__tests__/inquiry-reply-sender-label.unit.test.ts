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
  it("keeps a plus-tagged local-part readable", () => {
    // The word boundary after "+" also capitalises the tag: "jane+gallery" → "Jane+Gallery".
    expect(senderDisplayName("jane+gallery@example.com")).toBe("Jane+Gallery");
  });

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

// ─── Quoted local-part unit tests (Task #1080) ─────────────────────────────────
// Quoted local-parts are valid email syntax and may appear on reply senders.

describe("senderDisplayName quoted local-parts (Task #1080)", () => {
  it("keeps a quoted dotted local-part readable", () => {
    expect(senderDisplayName('"jane.doe"@example.com')).toBe('"Jane Doe"');
  });
});

// ─── Mixed alphanumeric local-part tests (Task #1076) ────────────────────────
// Covers cases where digits are embedded in the local-part.
// A future change to the \b\w word-boundary regex could silently break these.

describe("senderDisplayName mixed alphanumeric local-parts (Task #1076)", () => {
  it("capitalises only the first letter when digits follow it with no separator", () => {
    // "jane2smith" → no separator to split on → \b\w only matches 'j' at start
    // digits inside a word do not create a new word boundary, so '2' is not a boundary char
    expect(senderDisplayName("jane2smith@example.com")).toBe("Jane2smith");
  });

  it("capitalises each word when a digit is embedded before a separator", () => {
    // "j4ne.smith" → dot→space → "j4ne smith" → \b\w hits 'j' and 's'
    expect(senderDisplayName("j4ne.smith@example.com")).toBe("J4ne Smith");
  });

  it("treats a leading digit as the first word boundary with no visual change", () => {
    // "2anna.kim" → dot→space → "2anna kim" → \b\w hits '2' (digit, no case change) and 'k'
    expect(senderDisplayName("2anna.kim@example.com")).toBe("2anna Kim");
  });
});

// ─── Numeric separator local-part tests (Task #1077) ──────────────────────────
// Covers all-digit local-parts split by separators.

describe("senderDisplayName numeric separator local-parts (Task #1077)", () => {
  it("replaces dots between numeric segments with spaces", () => {
    expect(senderDisplayName("123.456@example.com")).toBe("123 456");
  });

  it("replaces underscores between numeric segments with spaces", () => {
    expect(senderDisplayName("12_34@example.com")).toBe("12 34");
  });

  it("replaces hyphens between numeric segments with spaces", () => {
    expect(senderDisplayName("12-34@example.com")).toBe("12 34");
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
