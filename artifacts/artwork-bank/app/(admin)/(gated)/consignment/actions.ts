"use server";

/**
 * Consignment & Commission Tracker — server actions  (Task #82)
 */

import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import {
  tenantsTable,
  representedArtistsTable,
  artworksTable,
  consignmentAgreementsTable,
  consignmentItemsTable,
  consignmentSalesTable,
  artistPaymentsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { hasActiveAccess } from "@/lib/billing";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSessionAndTenant() {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");
  if (!hasActiveAccess(tenant)) redirect("/settings/billing");
  return { session, tenant };
}

import { calculateSplit } from "./utils";

// ── Agreement actions ─────────────────────────────────────────────────────────

const agreementSchema = z.object({
  artistId: z.string().min(1),
  artistPct: z.coerce.number().int().min(0).max(100),
  minPriceCents: z.coerce.number().int().min(0).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export async function createAgreement(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = agreementSchema.safeParse({
    artistId: formData.get("artistId"),
    artistPct: formData.get("artistPct"),
    minPriceCents: formData.get("minPriceCents") || undefined,
    startDate: formData.get("startDate") || undefined,
    endDate: formData.get("endDate") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) redirect("/consignment/agreements/new?error=invalid");

  // Verify the artist belongs to this tenant
  const artist = await db.query.representedArtistsTable.findFirst({
    where: and(
      eq(representedArtistsTable.id, parsed.data.artistId),
      eq(representedArtistsTable.tenantId, session.tenantId),
    ),
  });
  if (!artist) redirect("/consignment/agreements/new?error=notfound");

  const [row] = await db
    .insert(consignmentAgreementsTable)
    .values({
      tenantId: session.tenantId,
      artistId: parsed.data.artistId,
      artistPct: parsed.data.artistPct,
      minPriceCents: parsed.data.minPriceCents ?? null,
      startDate: parsed.data.startDate ?? null,
      endDate: parsed.data.endDate ?? null,
      notes: parsed.data.notes ?? null,
    })
    .returning({ id: consignmentAgreementsTable.id });

  redirect(`/consignment/agreements/${row!.id}`);
}

export async function archiveAgreement(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  if (!id) redirect("/consignment");

  await db
    .update(consignmentAgreementsTable)
    .set({ status: "CANCELLED" })
    .where(
      and(
        eq(consignmentAgreementsTable.id, id),
        eq(consignmentAgreementsTable.tenantId, session.tenantId),
      ),
    );

  redirect("/consignment");
}

// ── Consignment item actions ──────────────────────────────────────────────────

const intakeSchema = z.object({
  agreementId: z.string().min(1),
  artworkId: z.string().min(1),
  intakeDate: z.string().min(1),
});

export async function intakeArtwork(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = intakeSchema.safeParse({
    agreementId: formData.get("agreementId"),
    artworkId: formData.get("artworkId"),
    intakeDate: formData.get("intakeDate"),
  });
  if (!parsed.success) redirect("/consignment?error=invalid");

  // Verify the agreement and artwork belong to this tenant
  const [agreement, artwork] = await Promise.all([
    db.query.consignmentAgreementsTable.findFirst({
      where: and(
        eq(consignmentAgreementsTable.id, parsed.data.agreementId),
        eq(consignmentAgreementsTable.tenantId, session.tenantId),
      ),
    }),
    db.query.artworksTable.findFirst({
      where: and(
        eq(artworksTable.id, parsed.data.artworkId),
        eq(artworksTable.tenantId, session.tenantId),
      ),
    }),
  ]);
  if (!agreement || !artwork) redirect("/consignment?error=notfound");

  await db.insert(consignmentItemsTable).values({
    tenantId: session.tenantId,
    agreementId: parsed.data.agreementId,
    artworkId: parsed.data.artworkId,
    intakeDate: parsed.data.intakeDate,
  });

  redirect(`/consignment/agreements/${parsed.data.agreementId}`);
}

export async function returnArtwork(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const itemId = formData.get("itemId") as string;
  const returnDate = formData.get("returnDate") as string;
  const agreementId = formData.get("agreementId") as string;
  if (!itemId || !returnDate) redirect("/consignment");

  await db
    .update(consignmentItemsTable)
    .set({ status: "RETURNED", returnDate })
    .where(
      and(
        eq(consignmentItemsTable.id, itemId),
        eq(consignmentItemsTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/consignment/agreements/${agreementId}`);
}

// ── Sale recording ────────────────────────────────────────────────────────────

const saleSchema = z.object({
  itemId: z.string().min(1),
  agreementId: z.string().min(1),
  salePriceCents: z.coerce.number().int().min(1),
  saleDate: z.string().min(1),
  orderId: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export async function recordSale(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = saleSchema.safeParse({
    itemId: formData.get("itemId"),
    agreementId: formData.get("agreementId"),
    salePriceCents: formData.get("salePriceCents"),
    saleDate: formData.get("saleDate"),
    orderId: formData.get("orderId") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) redirect("/consignment?error=invalid");

  // Get the item + agreement (including artistPct) in one query
  const item = await db.query.consignmentItemsTable.findFirst({
    where: and(
      eq(consignmentItemsTable.id, parsed.data.itemId),
      eq(consignmentItemsTable.tenantId, session.tenantId),
    ),
  });
  if (!item) redirect("/consignment?error=notfound");

  const agreement = await db.query.consignmentAgreementsTable.findFirst({
    where: and(
      eq(consignmentAgreementsTable.id, item.agreementId),
      eq(consignmentAgreementsTable.tenantId, session.tenantId),
    ),
  });
  if (!agreement) redirect("/consignment?error=notfound");

  const { artistAmountCents, galleryAmountCents } = calculateSplit(
    parsed.data.salePriceCents,
    agreement.artistPct,
  );

  await db.transaction(async (tx) => {
    await tx.insert(consignmentSalesTable).values({
      tenantId: session.tenantId,
      itemId: parsed.data.itemId,
      salePriceCents: parsed.data.salePriceCents,
      artistAmountCents,
      galleryAmountCents,
      orderId: parsed.data.orderId ?? null,
      saleDate: parsed.data.saleDate,
      notes: parsed.data.notes ?? null,
    });
    // Mark the item as SOLD
    await tx
      .update(consignmentItemsTable)
      .set({ status: "SOLD" })
      .where(eq(consignmentItemsTable.id, parsed.data.itemId));
  });

  redirect(`/consignment/agreements/${parsed.data.agreementId}`);
}

// ── Artist payment actions ────────────────────────────────────────────────────

const paymentSchema = z.object({
  artistId: z.string().min(1),
  amountCents: z.coerce.number().int().min(1),
  paymentDate: z.string().min(1),
  reference: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});

export async function recordArtistPayment(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = paymentSchema.safeParse({
    artistId: formData.get("artistId"),
    amountCents: formData.get("amountCents"),
    paymentDate: formData.get("paymentDate"),
    reference: formData.get("reference") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) redirect("/consignment/payments?error=invalid");

  await db.insert(artistPaymentsTable).values({
    tenantId: session.tenantId,
    artistId: parsed.data.artistId,
    amountCents: parsed.data.amountCents,
    paymentDate: parsed.data.paymentDate,
    reference: parsed.data.reference ?? null,
    notes: parsed.data.notes ?? null,
  });

  redirect("/consignment/payments?saved=1");
}
