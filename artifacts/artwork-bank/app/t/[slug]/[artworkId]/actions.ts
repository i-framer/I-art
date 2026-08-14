"use server";

import { db } from "@workspace/db";
import { artworksTable, inquiriesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { headers } from "next/headers";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { sendArtworkInquiry } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { getTenantUrl } from "@/lib/base-url";
import { sendInquiryEmailFailureSlackNotification } from "@/lib/slack";

export type InquiryState = {
  status: "idle" | "sent" | "error";
  error: string;
};

const inquirySchema = z.object({
  name: z.string().trim().min(1, "Please enter your name.").max(200),
  email: z.string().trim().email("Please enter a valid email address."),
  message: z
    .string()
    .trim()
    .min(1, "Please enter a message.")
    .max(5000, "Message is too long."),
});

export async function submitInquiry(
  slug: string,
  artworkId: string,
  _prev: InquiryState,
  formData: FormData,
): Promise<InquiryState> {
  // Honeypot: real users never fill this hidden field. If a bot does,
  // pretend the submission succeeded but silently drop it.
  const honeypot = formData.get("website");
  if (typeof honeypot === "string" && honeypot.trim() !== "") {
    return { status: "sent", error: "" };
  }

  // Per-IP rate limit: max 5 inquiries per 10 minutes.
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip") ||
    "unknown";
  const allowed = await checkRateLimit(`inquiry:${ip}`, {
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (!allowed) {
    return {
      status: "error",
      error:
        "You've sent several inquiries in a short time. Please wait a few minutes and try again.",
    };
  }

  const parsed = inquirySchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    message: formData.get("message"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      error: parsed.error.issues[0]?.message ?? "Please check your details.",
    };
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return { status: "error", error: "Gallery not found." };
  }
  if (!tenant.contactEmail) {
    return {
      status: "error",
      error: "This gallery is not accepting inquiries right now.",
    };
  }

  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, tenant.id),
      eq(artworksTable.showInGallery, true),
    ),
  });
  if (!artwork) {
    return { status: "error", error: "Artwork not found." };
  }

  // Save the inquiry first so the lead isn't lost even if email fails.
  let inquiryId: string | null;
  try {
    const [row] = await db
      .insert(inquiriesTable)
      .values({
        tenantId: tenant.id,
        artworkId: artwork.id,
        artworkTitle: artwork.title,
        buyerName: parsed.data.name,
        buyerEmail: parsed.data.email,
        message: parsed.data.message,
      })
      .returning({ id: inquiriesTable.id });
    inquiryId = row?.id ?? null;
  } catch (err) {
    console.error("Failed to save inquiry", err);
    return {
      status: "error",
      error: `Your message could not be sent right now. Please email the gallery directly at ${tenant.contactEmail}.`,
    };
  }

  const artworkUrl =
    getTenantUrl(tenant, `/${artworkId}`) ?? `/t/${slug}/${artworkId}`;

  const sent = await sendArtworkInquiry({
    galleryEmail: tenant.contactEmail,
    buyerName: parsed.data.name,
    buyerEmail: parsed.data.email,
    message: parsed.data.message,
    artworkTitle: artwork.title,
    artworkSku: artwork.sku,
    artworkUrl,
    tenantName: tenant.businessName,
  });

  if (!sent) {
    // The inquiry is saved — record the email failure but treat the
    // submission as received so the lead isn't discouraged.
    if (inquiryId) {
      try {
        await db
          .update(inquiriesTable)
          .set({
            emailError: "Email delivery failed",
            emailAttempts: 1,
            emailLastAttemptAt: new Date(),
          })
          .where(eq(inquiriesTable.id, inquiryId));
      } catch (err) {
        console.error("Failed to record inquiry email error", err);
      }
      // Fire-and-forget Slack alert so the operator can notify the gallery
      // owner before they next log in. Never throws — a Slack failure must
      // not affect the buyer's experience.
      sendInquiryEmailFailureSlackNotification({
        tenantName: tenant.businessName,
        tenantSlug: slug,
        buyerName: parsed.data.name,
        buyerEmail: parsed.data.email,
        artworkTitle: artwork.title,
        inquiryId,
      }).catch((err) => {
        console.error("Failed to post inquiry email-failure Slack alert", err);
      });
    }
  }

  return { status: "sent", error: "" };
}
