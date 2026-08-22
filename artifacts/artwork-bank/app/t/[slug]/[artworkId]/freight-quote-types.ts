export type FreightQuote = {
  id: string;
  provider: string;
  providerName: string;
  serviceCode: string | null;
  serviceName: string;
  source: "LIVE" | "MANUAL";
  freightCents: number;
  packagingCents: number;
  deliveryCents: number;
  expiresAt: string;
};

export type DeliveryAddress = {
  line1: string;
  line2: string;
  suburb: string;
  state: string;
  postcode: string;
};