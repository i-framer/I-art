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
