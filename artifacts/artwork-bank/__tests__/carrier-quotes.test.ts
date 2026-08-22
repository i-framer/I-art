import { afterEach, describe, expect, it, vi } from "vitest";
import { requestCarrierQuotes } from "@/lib/carrier-quotes";

const origin = {
  line1: "10 Studio Road",
  suburb: "Richmond",
  state: "VIC",
  postcode: "3121",
  countryCode: "AU" as const,
};
const destination = {
  line1: "20 Buyer Street",
  suburb: "Newtown",
  state: "NSW",
  postcode: "2042",
  countryCode: "AU" as const,
};
const parcel = {
  lengthMm: 1200,
  widthMm: 800,
  heightMm: 100,
  weightGrams: 4500,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("carrier quote adapters", () => {
  it("uses Australia Post's domestic endpoint with centimetres and kilograms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          services: {
            service: [
              { code: "AUS_PARCEL_EXPRESS", name: "Express Post", price: "24.05" },
            ],
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const quotes = await requestCarrierQuotes({
      provider: "AUSTRALIA_POST",
      credentials: { apiKey: "abc12345" },
      origin,
      destination,
      parcel,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("from_postcode=3121");
    expect(url).toContain("to_postcode=2042");
    expect(url).toContain("length=120");
    expect(url).toContain("weight=4.500");
    expect(options.headers).toMatchObject({ "AUTH-KEY": "abc12345" });
    expect(quotes).toEqual([
      expect.objectContaining({
        provider: "AUSTRALIA_POST",
        serviceName: "Express Post",
        freightCents: 2405,
      }),
    ]);
  });

  it("sends Aramex account, address, and packed shipment data to its rate API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ HasErrors: false, TotalAmount: { Value: 31.4 } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const quotes = await requestCarrierQuotes({
      provider: "ARAMEX",
      credentials: {
        userName: "gallery-user",
        password: "password",
        accountNumber: "123",
        accountPin: "456",
        accountEntity: "SYD",
        accountCountryCode: "AU",
        useTestEndpoint: true,
      },
      origin,
      destination,
      parcel,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("ws.dev.aramex.net");
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({
      ClientInfo: { AccountNumber: "123", AccountEntity: "SYD" },
      OriginAddress: { PostCode: "3121", CountryCode: "AU" },
      DestinationAddress: { PostCode: "2042", CountryCode: "AU" },
      ShipmentDetails: {
        ActualWeight: { Unit: "KG", Value: 4.5 },
        Dimensions: { Length: 120, Width: 80, Height: 10, Unit: "CM" },
      },
    });
    expect(quotes[0]).toMatchObject({
      provider: "ARAMEX",
      serviceName: "Aramex",
      freightCents: 3140,
    });
  });
});