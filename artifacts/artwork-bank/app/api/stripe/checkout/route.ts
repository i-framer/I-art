import { NextResponse } from "next/server";
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkImagesTable,
  freightQuotesTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";
import { getTenantBySlug } from "@/lib/tenant-cache";
import {
  getStripeClient,
  calcApplicationFeeForTenant,
  StripeNotConfiguredError,
} from "@/lib/stripe";
import { getServeUrl } from "@/lib/object-storage";
import { checkRateLimit } from "@/lib/rate-limit";
import { isStripeAccountMissing } from "@/lib/stripe-errors";

export const dynamic = "force-dynamic";

const VALID_FULFILLMENT_TYPES = ["SHIP", "PICKUP", "FRAMING_JOB"] as const;

export async function POST(request: Request) {
  try {
    // Per-IP rate limit: max 5 checkout attempts per 10 minutes, using the
    // same shared database-backed limiter as the inquiry form so the limit
    // holds across all server instances.
    const forwardedFor = request.headers.get("x-forwarded-for");
    const ip =
      forwardedFor?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const allowed = await checkRateLimit(`checkout:${ip}`, {
      limit: 5,
      windowMs: 10 * 60_000,
    });
    if (!allowed) {
      return NextResponse.json(
        {
          error:
            "You've started several checkouts in a short time. Please wait a few minutes and try again.",
        },
        { status: 429 },
      );
    }

    const body = await request.json();
    const { artworkId, slug, fulfillmentType, freightQuoteId } = body as {
      artworkId: string;
      slug: string;
      fulfillmentType: string;
      freightQuoteId?: string;
    };

    if (!artworkId || !slug || !fulfillmentType) {
      return NextResponse.json(
        { error: "Missing required fields." },
        { status: 400 },
      );
    }
    if (!VALID_FULFILLMENT_TYPES.includes(fulfillmentType as any)) {
      return NextResponse.json(
        { error: "Invalid fulfillment type." },
        { status: 400 },
      );
    }

    const tenant = await getTenantBySlug(slug);
    if (!tenant?.storefrontEnabled) {
      return NextResponse.json(
        { error: "Store not available." },
        { status: 400 },
      );
    }
    if (!tenant.stripeAccountId) {
      return NextResponse.json(
        {
          error:
            "This gallery is not accepting payments yet. Please contact them directly.",
        },
        { status: 400 },
      );
    }

    // Fast-path: if the cached account status from the account.updated webhook
    // explicitly says charges are disabled, reject immediately without making a
    // live Stripe API call or reserving the artwork.
    //
    // stripeChargesEnabled values:
    //   false — webhook confirmed charges are off → reject fast (gallery not ready)
    //   null  — no account.updated webhook received yet (new onboarding, delayed
    //            delivery) → give benefit of the doubt and attempt the Stripe call;
    //            Stripe itself returns account_invalid if the account isn't ready
    //   true  — webhook confirmed charges are on → proceed normally
    if (tenant.stripeChargesEnabled === false) {
      return NextResponse.json(
        {
          error:
            "This gallery is not yet ready to accept payments. They may still be completing account setup. Please contact the gallery directly.",
        },
        { status: 503 },
      );
    }

    // FRAMING_JOB only for FRAMER tenants
    if (fulfillmentType === "FRAMING_JOB" && tenant.type !== "FRAMER") {
      return NextResponse.json(
        { error: "Invalid fulfillment type for this gallery." },
        { status: 400 },
      );
    }

    // Atomically reserve the artwork: the conditional UPDATE only succeeds if
    // the row is still AVAILABLE, so two concurrent buyers can't both pass —
    // the second buyer's update matches zero rows and they get a clear error
    // before any Stripe session is created.
    const [artwork] = await db
      .update(artworksTable)
      .set({ status: "RESERVED" })
      .where(
        and(
          eq(artworksTable.id, artworkId),
          eq(artworksTable.tenantId, tenant.id),
          eq(artworksTable.status, "AVAILABLE"),
          eq(artworksTable.showInGallery, true),
        ),
      )
      .returning();

    if (!artwork) {
      return NextResponse.json(
        { error: "This artwork is not available for purchase." },
        { status: 400 },
      );
    }

    // Helper to release the reservation if we fail before returning a
    // checkout URL — only reverts if the row is still RESERVED.
    const releaseReservation = async () => {
      try {
        await db
          .update(artworksTable)
          .set({ status: "AVAILABLE" })
          .where(
            and(
              eq(artworksTable.id, artworkId),
              eq(artworksTable.tenantId, tenant.id),
              eq(artworksTable.status, "RESERVED"),
            ),
          );
      } catch (revertErr) {
        console.error(
          `Failed to release reservation for artwork ${artworkId}:`,
          (revertErr as any)?.message ?? revertErr,
        );
      }
    };

    // From here on the artwork is RESERVED. Any failure before we return a
    // checkout URL must release the reservation — otherwise the piece would
    // be stuck RESERVED with no Stripe session to expire and no webhook to
    // revert it.
    try {
      if (!artwork.price) {
        await releaseReservation();
        return NextResponse.json(
          { error: "This artwork is not available for purchase." },
          { status: 400 },
        );
      }

      // Freight is always read from a short-lived, server-stored quote. The
      // browser supplies only its opaque ID, so it cannot lower the charge,
      // substitute another gallery's quote, or reuse an expired price.
      let freightCents = 0;
      let freightMethodName: string | null = null;
      let freightClass: "SMALL" | "MEDIUM" | "LARGE" | "TUBE" | null = null;
      let freightProvider = "";
      let freightServiceCode = "";
      let freightQuoteIdForMetadata = "";

      if (fulfillmentType === "SHIP") {
        if (!freightQuoteId) {
          await releaseReservation();
          return NextResponse.json(
            { error: "Enter a delivery address and select a current freight quote." },
            { status: 400 },
          );
        }

        const freightQuote = await db.query.freightQuotesTable.findFirst({
          where: and(
            eq(freightQuotesTable.id, freightQuoteId),
            eq(freightQuotesTable.tenantId, tenant.id),
            eq(freightQuotesTable.artworkId, artwork.id),
            gt(freightQuotesTable.expiresAt, new Date()),
          ),
        });
        if (!freightQuote) {
          await releaseReservation();
          return NextResponse.json(
            { error: "This freight quote has expired. Please request a new delivery quote." },
            { status: 400 },
          );
        }

        freightCents = freightQuote.freightCents;
        freightMethodName = freightQuote.serviceName;
        freightClass = freightQuote.freightClass;
        freightProvider = freightQuote.provider;
        freightServiceCode = freightQuote.serviceCode ?? "";
        freightQuoteIdForMetadata = freightQuote.id;
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
        } catch (err) {
          // Non-fatal — Stripe checkout line-item image is optional
          console.error(
            "[checkout] Failed to resolve image URL for",
            primaryImage.objectPath,
            "—",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      const { feeCents: feeAmount, commissionBasisPoints } = calcApplicationFeeForTenant(
        artwork.price,
        tenant.commissionBasisPoints,
      );

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

      let stripe;
      try {
        stripe = await getStripeClient();
      } catch (err) {
        await releaseReservation();
        if (err instanceof StripeNotConfiguredError) {
          console.error(
            "Checkout unavailable — Stripe not configured:",
            err.message,
          );
          return NextResponse.json(
            {
              error:
                "Payments are not configured for this gallery. Please try again later or contact the gallery directly.",
            },
            { status: 503 },
          );
        }
        throw err;
      }

      let session;
      try {
        session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          // Expire abandoned checkouts after 30 minutes (Stripe's minimum)
          // instead of the 24h default, so the checkout.session.expired webhook
          // releases the RESERVED artwork back to AVAILABLE much sooner.
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
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
            ...(freightMethodName
              ? [
                  {
                    price_data: {
                      currency: "aud" as const,
                      product_data: {
                        name: `Freight — ${freightMethodName}`,
                        description:
                          freightClass === "TUBE"
                            ? "Rolled artwork in a tube"
                            : `${freightClass?.toLowerCase()} parcel delivery`,
                      },
                      unit_amount: freightCents,
                    },
                    quantity: 1,
                  },
                ]
              : []),
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
            freightQuoteId: freightQuoteIdForMetadata,
            freightMethodName: freightMethodName ?? "",
            freightClass: freightClass ?? "",
            freightProvider,
            freightServiceCode,
            freightCents: String(freightCents),
            applicationFeeCents: String(feeAmount),
            // Record the commission rate used so the webhook can persist it
            commissionBasisPoints: String(commissionBasisPoints),
          },
        });
      } catch (err: any) {
        // A saved Connect ID can become stale when a gallery's Stripe platform
        // or API mode changes. Remove only the matching saved ID so Settings
        // shows a reconnect prompt, then return a buyer-safe error instead of
        // exposing Stripe's raw "No such account" response.
        if (isStripeAccountMissing(err)) {
          await releaseReservation();
          try {
            await db
              .update(tenantsTable)
              .set({
                stripeAccountId: null,
                stripeChargesEnabled: false,
                stripePayoutsEnabled: false,
              })
              .where(
                and(
                  eq(tenantsTable.id, tenant.id),
                  eq(tenantsTable.stripeAccountId, tenant.stripeAccountId),
                ),
              );
          } catch (clearErr) {
            console.error(
              `[checkout] Failed to clear stale Connect account ${tenant.stripeAccountId} for tenant ${tenant.id}:`,
              clearErr,
            );
          }

          console.error(
            `[checkout] Stale Connect account ${tenant.stripeAccountId} for tenant ${tenant.id}:`,
            err?.message ?? err,
          );
          return NextResponse.json(
            {
              error:
                "This gallery's payment connection needs to be reconnected. Please try again later or contact the gallery directly.",
            },
            { status: 503 },
          );
        }

        // Stripe rejects session creation when a connected account is not yet
        // enabled for charges (onboarding incomplete, account restricted, or
        // country/compliance requirements outstanding).  Surface a clear 503
        // rather than the raw Stripe error, so buyers and galleries get an
        // actionable message.
        const isAccountNotReady =
          err?.code === "account_invalid" ||
          err?.code === "account_closed" ||
          err?.code === "account_not_found" ||
          (err?.type === "StripeInvalidRequestError" &&
            (err?.message ?? "").toLowerCase().includes("charges")) ||
          (err?.type === "StripeInvalidRequestError" &&
            (err?.message ?? "").toLowerCase().includes("connected account"));
        if (isAccountNotReady) {
          await releaseReservation();
          console.error(
            `[checkout] Connect account ${tenant.stripeAccountId} not ready for charges:`,
            err?.message ?? err,
          );
          return NextResponse.json(
            {
              error:
                "This gallery is not yet ready to accept payments. They may still be completing account setup. Please contact the gallery directly.",
            },
            { status: 503 },
          );
        }
        throw err;
      }

      return NextResponse.json({ url: session.url });
    } catch (err) {
      // Anything failed after the reservation was taken — release it so the
      // artwork doesn't get stuck in RESERVED with no pending checkout.
      await releaseReservation();
      throw err;
    }
  } catch (err: any) {
    console.error("Checkout session error:", err);
    return NextResponse.json(
      { error: err?.message ?? "Failed to create checkout session." },
      { status: 500 },
    );
  }
}
