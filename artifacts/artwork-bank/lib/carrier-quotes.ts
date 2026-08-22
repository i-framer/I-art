import { z } from "zod";

export const carrierProviderSchema = z.enum(["AUSTRALIA_POST", "ARAMEX"]);
export type CarrierProvider = z.infer<typeof carrierProviderSchema>;

export const deliveryAddressSchema = z.object({
  line1: z.string().trim().min(2).max(160),
  line2: z.string().trim().max(160).optional().or(z.literal("")),
  suburb: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(3).transform((value) => value.toUpperCase()),
  postcode: z.string().trim().regex(/^\d{4}$/, "Use a four-digit Australian postcode."),
  countryCode: z.literal("AU"),
});
export type DeliveryAddress = z.output<typeof deliveryAddressSchema>;

export const packedParcelSchema = z.object({
  lengthMm: z.number().int().positive().max(10_000),
  widthMm: z.number().int().positive().max(10_000),
  heightMm: z.number().int().positive().max(10_000),
  weightGrams: z.number().int().positive().max(100_000),
});
export type PackedParcel = z.infer<typeof packedParcelSchema>;

const australiaPostCredentialsSchema = z.object({
  apiKey: z.string().trim().min(8).max(500),
});

const aramexCredentialsSchema = z.object({
  userName: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(500),
  accountNumber: z.string().trim().min(1).max(80),
  accountPin: z.string().trim().min(1).max(80),
  accountEntity: z.string().trim().min(1).max(16),
  accountCountryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  useTestEndpoint: z.boolean().optional().default(false),
});

export type AustraliaPostCredentials = z.infer<
  typeof australiaPostCredentialsSchema
>;
export type AramexCredentials = z.infer<typeof aramexCredentialsSchema>;

export type CarrierQuote = {
  provider: CarrierProvider;
  serviceCode: string | null;
  serviceName: string;
  freightCents: number;
  estimatedDays: number | null;
};

function centsFromCarrierAmount(value: unknown): number {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/,/g, ""))
        : value && typeof value === "object" && "Value" in value
          ? Number((value as { Value: unknown }).Value)
          : Number.NaN;

  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Carrier returned an invalid freight price.");
  }

  return Math.round(amount * 100);
}

function australiaPostDimension(mm: number): string {
  // Australia Post's domestic price endpoint accepts centimetres.
  return (mm / 10).toFixed(1).replace(/\.0$/, "");
}

async function quoteAustraliaPost(
  credentialsValue: unknown,
  origin: DeliveryAddress,
  destination: DeliveryAddress,
  parcel: PackedParcel,
): Promise<CarrierQuote[]> {
  const credentials = australiaPostCredentialsSchema.parse(credentialsValue);
  const params = new URLSearchParams({
    from_postcode: origin.postcode,
    to_postcode: destination.postcode,
    length: australiaPostDimension(parcel.lengthMm),
    width: australiaPostDimension(parcel.widthMm),
    height: australiaPostDimension(parcel.heightMm),
    weight: (parcel.weightGrams / 1000).toFixed(3),
  });

  const response = await fetch(
    `https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json?${params.toString()}`,
    {
      headers: {
        "AUTH-KEY": credentials.apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Australia Post quote request failed (${response.status}).`);
  }

  const body = (await response.json()) as {
    services?: {
      service?:
        | {
            code?: unknown;
            name?: unknown;
            price?: unknown;
          }
        | Array<{
            code?: unknown;
            name?: unknown;
            price?: unknown;
          }>;
    };
  };
  const services = body.services?.service;
  const list = Array.isArray(services) ? services : services ? [services] : [];

  return list.flatMap((service) => {
    if (typeof service.name !== "string" || !service.name.trim()) return [];
    try {
      return [
        {
          provider: "AUSTRALIA_POST" as const,
          serviceCode: typeof service.code === "string" ? service.code : null,
          serviceName: service.name.trim(),
          freightCents: centsFromCarrierAmount(service.price),
          estimatedDays: null,
        },
      ];
    } catch {
      return [];
    }
  });
}

async function quoteAramex(
  credentialsValue: unknown,
  origin: DeliveryAddress,
  destination: DeliveryAddress,
  parcel: PackedParcel,
): Promise<CarrierQuote[]> {
  const credentials = aramexCredentialsSchema.parse(credentialsValue);
  const baseUrl = credentials.useTestEndpoint
    ? "https://ws.dev.aramex.net"
    : "https://ws.aramex.net";

  // Aramex's documented Rate Calculator service uses the same ClientInfo
  // account fields as its Shipping API. It returns a total in the account's
  // contracted currency without creating a shipment or label.
  const response = await fetch(
    `${baseUrl}/ShippingAPI.V2/RateCalculator/Service_1_0.svc/json/CalculateRate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ClientInfo: {
          UserName: credentials.userName,
          Password: credentials.password,
          Version: "v1",
          AccountNumber: credentials.accountNumber,
          AccountPin: credentials.accountPin,
          AccountEntity: credentials.accountEntity,
          AccountCountryCode: credentials.accountCountryCode,
        },
        Transaction: { Reference1: "i-art-rate-quote" },
        OriginAddress: {
          City: origin.suburb,
          StateOrProvinceCode: origin.state,
          PostCode: origin.postcode,
          CountryCode: origin.countryCode,
        },
        DestinationAddress: {
          City: destination.suburb,
          StateOrProvinceCode: destination.state,
          PostCode: destination.postcode,
          CountryCode: destination.countryCode,
        },
        ShipmentDetails: {
          PaymentType: "P",
          ProductGroup: "DOM",
          ProductType: "OND",
          ActualWeight: { Unit: "KG", Value: parcel.weightGrams / 1000 },
          ChargeableWeight: { Unit: "KG", Value: parcel.weightGrams / 1000 },
          NumberOfPieces: 1,
          GoodsDescription: "Artwork",
          CountryOfOrigin: "AU",
          Dimensions: {
            Length: parcel.lengthMm / 10,
            Width: parcel.widthMm / 10,
            Height: parcel.heightMm / 10,
            Unit: "CM",
          },
        },
      }),
      signal: AbortSignal.timeout(12_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Aramex quote request failed (${response.status}).`);
  }

  const body = (await response.json()) as {
    HasErrors?: unknown;
    TotalAmount?: unknown;
    TotalAmountCurrency?: unknown;
    Errors?: Array<{ Message?: unknown }>;
  };
  if (body.HasErrors === true) {
    const detail =
      body.Errors?.find((error) => typeof error.Message === "string")?.Message ??
      "Aramex could not rate this shipment.";
    throw new Error(String(detail));
  }

  return [
    {
      provider: "ARAMEX",
      serviceCode: "DOM",
      serviceName: "Aramex",
      freightCents: centsFromCarrierAmount(body.TotalAmount),
      estimatedDays: null,
    },
  ];
}

export async function requestCarrierQuotes(input: {
  provider: CarrierProvider;
  credentials: unknown;
  origin: DeliveryAddress;
  destination: DeliveryAddress;
  parcel: PackedParcel;
}): Promise<CarrierQuote[]> {
  if (input.provider === "AUSTRALIA_POST") {
    return quoteAustraliaPost(
      input.credentials,
      input.origin,
      input.destination,
      input.parcel,
    );
  }

  return quoteAramex(
    input.credentials,
    input.origin,
    input.destination,
    input.parcel,
  );
}

export function carrierDisplayName(provider: CarrierProvider): string {
  return provider === "AUSTRALIA_POST" ? "Australia Post" : "Aramex";
}