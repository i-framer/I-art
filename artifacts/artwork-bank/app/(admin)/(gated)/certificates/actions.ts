"use server";

/**
 * Certificate of Authenticity actions — Task #83
 */

import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import {
  certificatesTable,
  artworksTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and, max } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { hasActiveAccess } from "@/lib/billing";

// ── Schema ────────────────────────────────────────────────────────────────────

const issueCertSchema = z.object({
  artworkId: z.string().min(1),
  buyerName: z.string().max(200).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

import { formatCertificateNumber } from "./utils";

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Issue a new Certificate of Authenticity for an artwork.
 * Requires an active subscription (billing guard applied).
 * Redirects to the new certificate's detail page on success.
 */
export async function issueCertificate(formData: FormData) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  // Billing guard
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");
  if (!hasActiveAccess(tenant)) redirect("/settings/billing");

  const parsed = issueCertSchema.safeParse({
    artworkId: formData.get("artworkId"),
    buyerName: formData.get("buyerName") ?? undefined,
  });
  if (!parsed.success) redirect("/certificates/new?error=invalid");

  // Verify the artwork belongs to this tenant
  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, parsed.data.artworkId),
      eq(artworksTable.tenantId, session.tenantId),
    ),
  });
  if (!artwork) redirect("/certificates/new?error=notfound");

  // Assign the next sequential number inside a transaction to prevent races
  const certId = await db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ maxSeq: max(certificatesTable.certificateSeq) })
      .from(certificatesTable)
      .where(eq(certificatesTable.tenantId, session.tenantId));

    const nextSeq = (maxRow?.maxSeq ?? 0) + 1;
    const year = new Date().getFullYear();
    const certificateNumber = formatCertificateNumber(nextSeq, year);

    const [inserted] = await tx
      .insert(certificatesTable)
      .values({
        tenantId: session.tenantId,
        artworkId: parsed.data.artworkId,
        certificateNumber,
        certificateSeq: nextSeq,
        buyerName: parsed.data.buyerName?.trim() || null,
      })
      .returning({ id: certificatesTable.id });

    return inserted!.id;
  });

  redirect(`/certificates/${certId}`);
}
