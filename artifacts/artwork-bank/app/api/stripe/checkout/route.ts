import { NextResponse } from "next/server";
import { db } from "@workspace/db";
import { artworksTable, artworkImagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { getStripeClient, calcApplicationFee } from "@/lib/stripe";
import { getServeUrl } from "@/lib/object-storage";

export const dynamic = "force-dynamic";

const VALID_FULFILLMENT_TYPES = ["SHIP", "PICKUP", "FRAMING_JOB"] as const;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { artworkId, slug, fulfillmentType } = body as {
      artworkId: string;
      slug: string;
      fulfillmentType: string;
    };

    if (!artworkId || !slug || !fulfillmentType) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
    }
    if (!VALID_FULFILLMENT_TYPES.includes(fulfillmentType as any)) {
      return NextResponse.json({ error: "Invalid fulfillment type." }, { status: 400 });
    }

    const tenant = await getTenantBySlug(slug);
    if (!tenant?.storefrontEnabled) {
      return NextResponse.json({ error: "Store not available." }, { status: 400 });
    }
    if (!tenant.stripeAccountId) {
      return NextResponse.json(
        { error: "This gallery is not accepting payments yet. Please contact them directly." },
        { status: 400 },
      );
    }

    // Artwork must be AVAILABLE and showInGallery
    const artwork = await db.query.artworksTable.findFirst({
      where: and(
        eq(artworksTable.id, artworkId),
        eq(artworksTable.tenantId, tenant.id),
        eq(artworksTable.status, "AVAILABLE"),
        eq(artworksTable.showInGallery, true),
      ),
    });

    if (!artwork?.price) {
      return NextResponse.json(
        { error: "This artwork is not available for purchase." },
        { status: 400 },
      );
    }

    // FRAMING_JOB only for FRAMER tenants
    if (fulfillmentType === "FRAMING_JOB" && tenant.type !== "FRAMER") {
      return NextResponse.json({ error: "Invalid fulfillment type for this gallery." }, { status: 400 });
    }

    // Fetch primary image for Stripe display
    const primaryImage = await db.query.artworkImagesTable.findFirst({
      where: and(
        eq(artworkImagesTable.artworkId, artworkId),
        eq(artworkImagesTable.isPrimary, true),
      ),
    });

    let imageUrl: string | undefined;
    if (primaryImage) {
      try {
        imageUrl = await getServeUrl(primaryImage.objectPath, 3600);
      } catch {
        // Non-fatal
      }
    }

    const feeAmount = calcApplicationFee(artwork.price);

    // Build the base URL for Stripe success/cancel redirects.
    // The Origin header is ONLY used if it exactly matches a verified allowed host.
    // Using an unvalidated Origin would allow open-redirect phishing attacks.
    const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0];
    const platformBaseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
      (replitDomain ? `https://${replitDomain}` : "http://localhost:3000");

    // Allowlist: platform URL + tenant's verified custom domain
    const allowedOrigins = new Set<string>([platformBaseUrl]);
    if (process.env.NODE_ENV !== "production") {
      allowedOrigins.add("http://localhost:3000");
    }
    if (tenant.customDomain && tenant.customDomainVerified) {
      allowedOrigins.add(`https://${tenant.customDomain}`);
    }

    const requestOrigin = request.headers.get("origin");
    const baseUrl =
      requestOrigin && allowedOrigins.has(requestOrigin)
        ? requestOrigin
        : platformBaseUrl;

    const stripe = await getStripeClient();

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "aud",
            product_data: {
              name: artwork.title,
              ...(artwork.medium ? { description: artwork.medium } : {}),
              ...(imageUrl ? { images: [imageUrl] } : {}),
              metadata: { artworkId, sku: artwork.sku ?? "" },
            },
            unit_amount: artwork.price,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${baseUrl}/t/${slug}/order/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/t/${slug}/${artworkId}?cancelled=1`,
      payment_intent_data: {
        application_fee_amount: feeAmount,
        transfer_data: {
          destination: tenant.stripeAccountId,
        },
      },
      metadata: {
        artworkId,
        tenantId: tenant.id,
        slug,
        fulfillmentType,
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error("Checkout session error:", err);
    return NextResponse.json(
      { error: err?.message ?? "Failed to create checkout session." },
      { status: 500 },
    );
  }
}
