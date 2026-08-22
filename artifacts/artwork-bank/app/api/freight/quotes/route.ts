import { NextResponse } from "next/server";
import { db } from "@workspace/db";
import {
  artworksTable,
  freightCarrierAccountsTable,
  freightCarrierAccountAccessTable,
  freightMethodsTable,
  freightQuotesTable,
  freightSettingsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { decryptCarrierCredentials } from "@/lib/carrier-credentials";
import {
  carrierDisplayName,
  deliveryAddressSchema,
  packedParcelSchema,
  requestCarrierQuotes,
} from "@/lib/carrier-quotes";
import { getFreightCents, getFreightClass } from "@/lib/freight";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const QUOTE_TTL_MS = 10 * 60_000;

function originFromSettings(settings: {
  originAddressLine1: string | null;
  originAddressLine2: string | null;
  originSuburb: string | null;
  originState: string | null;
  originPostcode: string | null;
  originCountryCode: string | null;
}) {
  return deliveryAddressSchema.safeParse({
    line1: settings.originAddressLine1,
    line2: settings.originAddressLine2 ?? "",
    suburb: settings.originSuburb,
    state: settings.originState,
    postcode: settings.originPostcode,
    countryCode: settings.originCountryCode ?? "AU",
  });
}

export async function POST(request: Request) {
  try {
    const forwardedFor = request.headers.get("x-forwarded-for");
    const ip =
      forwardedFor?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const allowed = await checkRateLimit(`freight-quote:${ip}`, {
      limit: 12,
      windowMs: 10 * 60_000,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many quote requests. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const body = (await request.json()) as {
      artworkId?: unknown;
      slug?: unknown;
      address?: unknown;
    };
    if (
      typeof body.artworkId !== "string" ||
      !body.artworkId ||
      typeof body.slug !== "string" ||
      !body.slug
    ) {
      return NextResponse.json({ error: "Missing artwork details." }, { status: 400 });
    }

    const destination = deliveryAddressSchema.safeParse(body.address);
    if (!destination.success) {
      return NextResponse.json(
        { error: destination.error.errors[0]?.message ?? "Enter a valid Australian delivery address." },
        { status: 400 },
      );
    }

    const tenant = await getTenantBySlug(body.slug);
    if (!tenant?.storefrontEnabled) {
      return NextResponse.json({ error: "Store not available." }, { status: 404 });
    }

    const [artwork, settings, methods, carrierAccounts] = await Promise.all([
      db.query.artworksTable.findFirst({
        where: and(
          eq(artworksTable.id, body.artworkId),
          eq(artworksTable.tenantId, tenant.id),
          eq(artworksTable.status, "AVAILABLE"),
          eq(artworksTable.showInGallery, true),
        ),
      }),
      db.query.freightSettingsTable.findFirst({
        where: eq(freightSettingsTable.tenantId, tenant.id),
      }),
      db.query.freightMethodsTable.findMany({
        where: eq(freightMethodsTable.tenantId, tenant.id),
      }),
      db
        .select({ account: freightCarrierAccountsTable })
        .from(freightCarrierAccountsTable)
        .innerJoin(
          freightCarrierAccountAccessTable,
          and(
            eq(
              freightCarrierAccountAccessTable.carrierAccountId,
              freightCarrierAccountsTable.id,
            ),
            eq(freightCarrierAccountAccessTable.tenantId, tenant.id),
            eq(freightCarrierAccountAccessTable.enabled, true),
          ),
        )
        .where(
          and(
            eq(freightCarrierAccountsTable.owner, "PLATFORM"),
            eq(freightCarrierAccountsTable.enabled, true),
          ),
        ),
    ]);

    const platformCarrierAccounts = carrierAccounts.map(({ account }) => account);

    if (!artwork) {
      return NextResponse.json(
        { error: "This artwork is no longer available for purchase." },
        { status: 409 },
      );
    }

    const parcel = packedParcelSchema.safeParse({
      lengthMm: artwork.packageLengthMm,
      widthMm: artwork.packageWidthMm,
      heightMm: artwork.packageHeightMm,
      weightGrams: artwork.packedWeightGrams,
    });
    if (!parcel.success) {
      return NextResponse.json(
        {
          error:
            "The gallery has not entered complete packed parcel details for this artwork. Please contact them for delivery options.",
        },
        { status: 400 },
      );
    }

    const expiry = new Date(Date.now() + QUOTE_TTL_MS);
    const rows: Array<typeof freightQuotesTable.$inferInsert> = [];
    const origin = settings ? originFromSettings(settings) : null;

    if (origin?.success) {
      const liveResults = await Promise.allSettled(
        platformCarrierAccounts.map(async (account) => {
          const credentials = decryptCarrierCredentials<unknown>(
            account.credentialsCiphertext,
          );
          const quotes = await requestCarrierQuotes({
            provider: account.provider,
            credentials,
            origin: origin.data,
            destination: destination.data,
            parcel: parcel.data,
          });
          return { account, quotes };
        }),
      );

      for (const result of liveResults) {
        if (result.status !== "fulfilled") {
          // Carrier credentials, network failures, and service outages are not
          // sent to buyers. A manual fallback can still be quoted below.
          console.error(
            "[freight] Live carrier quote unavailable:",
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          );
          continue;
        }
        for (const quote of result.value.quotes) {
          rows.push({
            tenantId: tenant.id,
            artworkId: artwork.id,
            carrierAccountId: result.value.account.id,
            source: "LIVE",
            provider: quote.provider,
            serviceCode: quote.serviceCode,
            serviceName: quote.serviceName,
            freightCents: quote.freightCents,
            packagingCents: artwork.packagingCents,
            deliveryCents: quote.freightCents + artwork.packagingCents,
            destinationLine1: destination.data.line1,
            destinationLine2: destination.data.line2 || null,
            destinationSuburb: destination.data.suburb,
            destinationState: destination.data.state,
            destinationPostcode: destination.data.postcode,
            destinationCountryCode: destination.data.countryCode,
            packageLengthMm: parcel.data.lengthMm,
            packageWidthMm: parcel.data.widthMm,
            packageHeightMm: parcel.data.heightMm,
            packedWeightGrams: parcel.data.weightGrams,
            expiresAt: expiry,
          });
        }
      }
    }

    // Manual methods are a real fallback only: a live service wins whenever a
    // configured carrier quoted successfully. Legacy fixed rates remain useful
    // during a provider outage or while an account is still being connected.
    if (rows.length === 0) {
      const freightClass = getFreightClass(artwork, settings);
      for (const method of methods.filter((candidate) => candidate.enabled)) {
        if (!freightClass) continue;
        rows.push({
          tenantId: tenant.id,
          artworkId: artwork.id,
          freightMethodId: method.id,
          source: "MANUAL",
          provider: "MANUAL",
          serviceCode: null,
          serviceName: `${method.name} (manual rate)`,
          freightClass,
          freightCents: getFreightCents(method, freightClass),
          packagingCents: artwork.packagingCents,
          deliveryCents:
            getFreightCents(method, freightClass) + artwork.packagingCents,
          destinationLine1: destination.data.line1,
          destinationLine2: destination.data.line2 || null,
          destinationSuburb: destination.data.suburb,
          destinationState: destination.data.state,
          destinationPostcode: destination.data.postcode,
          destinationCountryCode: destination.data.countryCode,
          packageLengthMm: parcel.data.lengthMm,
          packageWidthMm: parcel.data.widthMm,
          packageHeightMm: parcel.data.heightMm,
          packedWeightGrams: parcel.data.weightGrams,
          expiresAt: expiry,
        });
      }
    }

    if (rows.length === 0) {
      const detail =
        platformCarrierAccounts.length > 0 && !origin?.success
          ? "The gallery has not completed its dispatch address, so a live delivery quote cannot be calculated."
          : "No delivery service is currently available for this artwork.";
      return NextResponse.json({ error: detail }, { status: 400 });
    }

    const saved = await db.insert(freightQuotesTable).values(rows).returning({
      id: freightQuotesTable.id,
      provider: freightQuotesTable.provider,
      serviceCode: freightQuotesTable.serviceCode,
      serviceName: freightQuotesTable.serviceName,
      source: freightQuotesTable.source,
      freightCents: freightQuotesTable.freightCents,
      packagingCents: freightQuotesTable.packagingCents,
      deliveryCents: freightQuotesTable.deliveryCents,
      expiresAt: freightQuotesTable.expiresAt,
    });

    return NextResponse.json({
      quotes: saved.map((quote) => ({
        ...quote,
        providerName:
          quote.provider === "MANUAL"
            ? "Manual fallback"
            : carrierDisplayName(quote.provider as "AUSTRALIA_POST" | "ARAMEX"),
      })),
      expiresAt: expiry.toISOString(),
    });
  } catch (error) {
    console.error("[freight] Quote request failed:", error);
    return NextResponse.json(
      { error: "We could not calculate delivery right now. Please try again." },
      { status: 500 },
    );
  }
}