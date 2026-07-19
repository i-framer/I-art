"use server";

import { db } from "@workspace/db";
import { artworksTable, inquiriesTable } from "@workspace/db";
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

  // Save the inquiry first so the lead isn't lost even if email fails.
  let inquiryId: string | null = null;
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
    // The inquiry is saved — record the email failure but treat the
    // submission as received so the lead isn't discouraged.
    if (inquiryId) {
      try {
        await db
          .update(inquiriesTable)
          .set({ emailError: "Email delivery failed" })
          .where(eq(inquiriesTable.id, inquiryId));
      } catch (err) {
        console.error("Failed to record inquiry email error", err);
      }
    }
  }

  return { status: "sent", error: "" };
}
