// @vitest-environment happy-dom
/**
 * Confirms the gallery-not-ready 503 error body reaches the buyer's screen
 * rather than being swallowed by a generic fallback.
 *
 * BuyNowButton.handleCheckout reads `data.error` from the JSON body and renders
 * it directly.  A future UI refactor could accidentally ignore the body and
 * show only a generic message, leaving buyers with no actionable information.
 *
 * These tests render the real BuyNowButton component in a happy-dom
 * environment, mock `fetch`, and assert the buyer-visible text after clicking
 * the buy button.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { BuyNowButton } from "@/app/t/[slug]/_components/buy-now-button";

// The exact error text the checkout route returns when Stripe Connect setup is
// incomplete (stripeChargesEnabled cached false or account_invalid at runtime).
// Source: artifacts/artwork-bank/app/api/stripe/checkout/route.ts
const NOT_READY_MSG =
  "This gallery is not yet ready to accept payments. They may still be completing account setup. Please contact the gallery directly.";

const GENERIC_503_MSG =
  "Payments are temporarily unavailable for this gallery. Please try again later or contact the gallery directly.";

const defaultProps = {
  artworkId: "art-123",
  slug: "test-gallery",
  tenantType: "ARTIST" as const,
  price: 150_00, // $150.00
  themeColor: "#1a1a1a",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── 503 with error body ───────────────────────────────────────────────────────

describe("BuyNowButton — 503 with 'not yet ready' body", () => {
  it("renders the exact API error text, not the generic 503 fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: NOT_READY_MSG }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BuyNowButton {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /buy now/i }));

    await waitFor(() => {
      expect(screen.getByText(NOT_READY_MSG)).toBeTruthy();
    });
  });

  it("does NOT show the generic 503 fallback when the body contains an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: NOT_READY_MSG }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BuyNowButton {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /buy now/i }));

    await waitFor(() => {
      expect(screen.queryByText(GENERIC_503_MSG)).toBeNull();
    });
  });

  it("does NOT show a generic 'something went wrong' message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: NOT_READY_MSG }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BuyNowButton {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /buy now/i }));

    await waitFor(() => {
      expect(
        screen.queryByText("Something went wrong. Please try again."),
      ).toBeNull();
    });
  });
});

// ── 503 with no body — falls back to generic ─────────────────────────────────

describe("BuyNowButton — 503 with empty JSON body", () => {
  it("falls back to the generic 503 message when the body has no error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BuyNowButton {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /buy now/i }));

    await waitFor(() => {
      expect(screen.getByText(GENERIC_503_MSG)).toBeTruthy();
    });
  });
});

// ── 503 with non-JSON body — falls back to generic ───────────────────────────

describe("BuyNowButton — 503 with non-JSON body", () => {
  it("falls back to the generic 503 message when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Service Unavailable", {
          status: 503,
        }),
      ),
    );

    render(<BuyNowButton {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /buy now/i }));

    await waitFor(() => {
      expect(screen.getByText(GENERIC_503_MSG)).toBeTruthy();
    });
  });
});

// ── Successful checkout — no error shown ─────────────────────────────────────

describe("BuyNowButton — successful 200 checkout", () => {
  it("shows no error when checkout returns a redirect URL", async () => {
    const checkoutUrl = "https://checkout.stripe.com/pay/cs_test_123";

    // Prevent actual navigation in happy-dom
    const locationSpy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      href: "",
    } as Location);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ url: checkoutUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<BuyNowButton {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /buy now/i }));

    // After a successful response no error paragraph should appear
    await waitFor(() => {
      expect(screen.queryByText(NOT_READY_MSG)).toBeNull();
      expect(screen.queryByText(GENERIC_503_MSG)).toBeNull();
      expect(
        screen.queryByText("Something went wrong. Please try again."),
      ).toBeNull();
    });

    locationSpy.mockRestore();
  });
});
