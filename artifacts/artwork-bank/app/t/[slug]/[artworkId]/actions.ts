"use server";

import { db } from "@workspace/db";
import { artworksTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { sendArtworkInquiry } from "@/lib/email";

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

  const domain = process.env.REPLIT_DEV_DOMAIN;
  const artworkUrl = domain
    ? `https://${domain}/t/${slug}/${artworkId}`
    : `/t/${slug}/${artworkId}`;

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
    return {
      status: "error",
      error: `Your message could not be sent right now. Please email the gallery directly at ${tenant.contactEmail}.`,
    };
  }

  return { status: "sent", error: "" };
}
