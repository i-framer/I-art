// @vitest-environment happy-dom
/**
 * BuyNowButton — empty-body 503 fallback message
 *
 * When the checkout API returns a 503 with a completely empty body (e.g. a CDN
 * or proxy drops the response), res.json() throws and data.error is undefined.
 * The component must fall back to the generic 503 message so the buyer never
 * sees a blank error box or a lingering spinner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// ── Dependency mocks ─────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// ── Imports (after vi.mock hoisting) ─────────────────────────────────────────

import { BuyNowButton } from "@/app/t/[slug]/_components/buy-now-button";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Response whose body is completely empty so res.json() rejects. */
function emptyBodyResponse(status: number): Response {
  return new Response("", { status, headers: { "Content-Type": "text/plain" } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BuyNowButton — 503 with empty body", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyBodyResponse(503)));
  });

  it("shows the 503 fallback message when the response body is completely empty", async () => {
    render(
      React.createElement(BuyNowButton, {
        artworkId: "art-1",
        slug: "gallery",
        tenantType: "ARTIST",
        price: 10000,
        themeColor: "#1c1917",
      }),
    );

    const button = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(
          /payments are temporarily unavailable for this gallery\. please try again later or contact the gallery directly\./i,
        ),
      ).toBeTruthy();
    });
  });

  it("does not leave the buyer staring at a spinner after the empty-body 503", async () => {
    render(
      React.createElement(BuyNowButton, {
        artworkId: "art-1",
        slug: "gallery",
        tenantType: "ARTIST",
        price: 10000,
        themeColor: "#1c1917",
      }),
    );

    const button = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(button);

    // Once the error message is visible the button must be re-enabled
    // (loading state cleared), meaning the buyer can retry.
    await waitFor(() => {
      expect(
        screen.getByText(/payments are temporarily unavailable/i),
      ).toBeTruthy();
    });

    // Button should no longer be disabled / showing a spinner
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("BuyNowButton — non-JSON body with other 5xx status", () => {
  it("shows the generic fallback message for a 500 with a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(emptyBodyResponse(500)),
    );

    render(
      React.createElement(BuyNowButton, {
        artworkId: "art-1",
        slug: "gallery",
        tenantType: "ARTIST",
        price: 10000,
        themeColor: "#1c1917",
      }),
    );

    const button = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong\. please try again\./i),
      ).toBeTruthy();
    });
  });
});
