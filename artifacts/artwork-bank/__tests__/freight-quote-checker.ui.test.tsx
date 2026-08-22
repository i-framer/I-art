// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { FreightQuoteChecker } from "@/app/t/[slug]/[artworkId]/_components/freight-quote-checker";

const props = {
  artworkId: "artwork-123",
  artworkTitle: "Coastal Light",
  artworkPrice: 125_00,
  slug: "coastal-gallery",
  themeColor: "#1c1917",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FreightQuoteChecker", () => {
  it("requests an Australian guest quote, shows packaging, and carries only the quote ID to purchase", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          quotes: [
            {
              id: "fresh-quote-123",
              provider: "AUSTRALIA_POST",
              providerName: "Australia Post",
              serviceCode: "EXPRESS",
              serviceName: "Express Post",
              source: "LIVE",
              freightCents: 2400,
              packagingCents: 450,
              deliveryCents: 2850,
              expiresAt: "2026-08-22T05:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<FreightQuoteChecker {...props} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Address line 1"), "1 Test Street");
    await user.type(screen.getByLabelText("Suburb"), "Fitzroy");
    await user.type(screen.getByLabelText("State"), "vic");
    await user.type(screen.getByLabelText("Postcode"), "3065");
    await user.click(screen.getByRole("button", { name: "Check freight" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Express Post")).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/freight/quotes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          artworkId: "artwork-123",
          slug: "coastal-gallery",
          address: {
            line1: "1 Test Street",
            line2: "",
            suburb: "Fitzroy",
            state: "VIC",
            postcode: "3065",
            countryCode: "AU",
          },
        }),
      }),
    );
    expect(screen.getByText("Freight $24 + packaging $4.5")).toBeTruthy();
    expect(screen.getByText("$153.5")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Continue to purchase" }).getAttribute(
        "href",
      ),
    ).toBe("/t/coastal-gallery/artwork-123?freightQuoteId=fresh-quote-123");
  });

  it("does not request a quote until the required guest delivery fields are entered", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<FreightQuoteChecker {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Check freight" }));

    expect(
      screen.getByText("Enter your address line 1 to check delivery."),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});