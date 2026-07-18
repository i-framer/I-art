"use server";

import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import {
  artworksTable,
  artworkCategoryOnArtworkTable,
  artworkImagesTable,
  artworkCategoriesTable,
} from "@workspace/db";
import { eq, and, inArray, asc } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import type { ArtworkImage } from "@workspace/db";

export type ArtworkFormState = { error: string };

const artworkSchema = z.object({
  title: z.string().min(1, "Title is required"),
  sku: z.string().min(1, "SKU is required"),
  status: z.enum(["AVAILABLE", "SOLD", "RESERVED", "HIDDEN"]),
  showInGallery: z.string().optional(),
  medium: z.string().optional(),
  dimensionsW: z.string().optional(),
  dimensionsH: z.string().optional(),
  dimensionsD: z.string().optional(),
  condition: z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR"]).optional(),
  price: z.string().optional(),
  isEdition: z.string().optional(),
  editionNumber: z.string().optional(),
  totalEditions: z.string().optional(),
  notes: z.string().optional(),
  representedArtistId: z.string().optional(),
  categoryIds: z.array(z.string()).optional(),
});

/**
 * FormData.get() returns null for absent fields (e.g. unchecked checkboxes),
 * but z.string().optional() only accepts undefined. Coerce null/empty → undefined.
 */
function field(formData: FormData, name: string): string | undefined {
  const v = formData.get(name);
  return typeof v === "string" && v !== "" ? v : undefined;
}

function parseArtworkFormData(formData: FormData) {
  const raw = {
    // Required fields: coerce null → "" so their min(1) messages fire instead of a type error
    title: formData.get("title") ?? "",
    sku: formData.get("sku") ?? "",
    status: formData.get("status") ?? "",
    showInGallery: field(formData, "showInGallery"),
    medium: field(formData, "medium"),
    dimensionsW: field(formData, "dimensionsW"),
    dimensionsH: field(formData, "dimensionsH"),
    dimensionsD: field(formData, "dimensionsD"),
    condition: field(formData, "condition"),
    price: field(formData, "price"),
    isEdition: field(formData, "isEdition"),
    editionNumber: field(formData, "editionNumber"),
    totalEditions: field(formData, "totalEditions"),
    notes: field(formData, "notes"),
    representedArtistId: field(formData, "representedArtistId"),
    categoryIds: formData.getAll("categoryIds") as string[],
  };
  return artworkSchema.safeParse(raw);
}

function toInsertValues(data: z.infer<typeof artworkSchema>, tenantId: string) {
  const isEdition = data.isEdition === "on";
  const price = data.price ? Math.round(parseFloat(data.price) * 100) : null;
  return {
    tenantId,
    title: data.title,
    sku: data.sku,
    status: data.status,
    showInGallery: data.showInGallery === "on",
    medium: data.medium || null,
    dimensionsW: data.dimensionsW ? parseInt(data.dimensionsW) : null,
    dimensionsH: data.dimensionsH ? parseInt(data.dimensionsH) : null,
    dimensionsD: data.dimensionsD ? parseInt(data.dimensionsD) : null,
    condition: (data.condition as "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | undefined) || null,
    price,
    isEdition,
    editionNumber: isEdition && data.editionNumber ? parseInt(data.editionNumber) : null,
    totalEditions: isEdition && data.totalEditions ? parseInt(data.totalEditions) : null,
    notes: data.notes || null,
    representedArtistId: data.representedArtistId || null,
  };
}

export async function createArtwork(
  _prevState: ArtworkFormState,
  formData: FormData,
): Promise<ArtworkFormState> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };

  const parsed = parseArtworkFormData(formData);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input." };
  }

  const values = toInsertValues(parsed.data, session.tenantId);
  const [artwork] = await db.insert(artworksTable).values(values).returning();
  if (!artwork) return { error: "Failed to create artwork." };

  const categoryIds = parsed.data.categoryIds ?? [];
  if (categoryIds.length > 0) {
    // Verify categories belong to this tenant
    const validCats = await db.query.artworkCategoriesTable.findMany({
      where: and(
        eq(artworkCategoriesTable.tenantId, session.tenantId),
        inArray(artworkCategoriesTable.id, categoryIds),
      ),
    });
    if (validCats.length > 0) {
      await db
        .insert(artworkCategoryOnArtworkTable)
        .values(validCats.map((c) => ({ artworkId: artwork.id, categoryId: c.id })));
    }
  }

  redirect(`/catalog/${artwork.id}?created=1`);
}

export async function updateArtwork(
  id: string,
  _prevState: ArtworkFormState,
  formData: FormData,
): Promise<ArtworkFormState> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };

  const existing = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, id),
      eq(artworksTable.tenantId, session.tenantId),
    ),
  });
  if (!existing) return { error: "Artwork not found." };

  const parsed = parseArtworkFormData(formData);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input." };
  }

  const values = toInsertValues(parsed.data, session.tenantId);
  await db
    .update(artworksTable)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(artworksTable.id, id));

  // Sync categories
  await db
    .delete(artworkCategoryOnArtworkTable)
    .where(eq(artworkCategoryOnArtworkTable.artworkId, id));

  const categoryIds = parsed.data.categoryIds ?? [];
  if (categoryIds.length > 0) {
    const validCats = await db.query.artworkCategoriesTable.findMany({
      where: and(
        eq(artworkCategoriesTable.tenantId, session.tenantId),
        inArray(artworkCategoriesTable.id, categoryIds),
      ),
    });
    if (validCats.length > 0) {
      await db
        .insert(artworkCategoryOnArtworkTable)
        .values(validCats.map((c) => ({ artworkId: id, categoryId: c.id })));
    }
  }

  redirect(`/catalog/${id}?saved=1`);
}

export async function deleteArtwork(id: string): Promise<void> {
  const session = await getSession();
  if (!session.userId) return;

  await db
    .delete(artworksTable)
    .where(
      and(eq(artworksTable.id, id), eq(artworksTable.tenantId, session.tenantId)),
    );
}

export async function bulkUpdateStatus(
  ids: string[],
  status: "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN",
): Promise<void> {
  const session = await getSession();
  if (!session.userId || ids.length === 0) return;

  await db
    .update(artworksTable)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(artworksTable.tenantId, session.tenantId),
        inArray(artworksTable.id, ids),
      ),
    );
}

// ─── Image management ────────────────────────────────────────────────────────

async function getImagesForArtwork(artworkId: string): Promise<ArtworkImage[]> {
  return db.query.artworkImagesTable.findMany({
    where: eq(artworkImagesTable.artworkId, artworkId),
    orderBy: [asc(artworkImagesTable.sortOrder), asc(artworkImagesTable.createdAt)],
  });
}

export async function addArtworkImage(
  artworkId: string,
  objectPath: string,
  filename: string,
): Promise<ArtworkImage[]> {
  const session = await getSession();
  if (!session.userId) throw new Error("Not authenticated");

  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, session.tenantId),
    ),
  });
  if (!artwork) throw new Error("Artwork not found");

  // Count existing images to set sort order
  const existing = await getImagesForArtwork(artworkId);
  const isPrimary = existing.length === 0;

  await db.insert(artworkImagesTable).values({
    artworkId,
    tenantId: session.tenantId,
    objectPath,
    filename,
    sortOrder: existing.length,
    isPrimary,
  });

  return getImagesForArtwork(artworkId);
}

export async function deleteArtworkImage(imageId: string): Promise<ArtworkImage[]> {
  const session = await getSession();
  if (!session.userId) throw new Error("Not authenticated");

  const image = await db.query.artworkImagesTable.findFirst({
    where: and(
      eq(artworkImagesTable.id, imageId),
      eq(artworkImagesTable.tenantId, session.tenantId),
    ),
  });
  if (!image) throw new Error("Image not found");

  await db
    .delete(artworkImagesTable)
    .where(eq(artworkImagesTable.id, imageId));

  // If deleted image was primary, make the first remaining one primary
  const remaining = await getImagesForArtwork(image.artworkId);
  if (image.isPrimary && remaining.length > 0) {
    await db
      .update(artworkImagesTable)
      .set({ isPrimary: true })
      .where(eq(artworkImagesTable.id, remaining[0]!.id));
    remaining[0]!.isPrimary = true;
  }

  return remaining;
}

export async function setPrimaryImage(
  imageId: string,
  artworkId: string,
): Promise<ArtworkImage[]> {
  const session = await getSession();
  if (!session.userId) throw new Error("Not authenticated");

  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, session.tenantId),
    ),
  });
  if (!artwork) throw new Error("Artwork not found");

  // Clear all primary flags for this artwork
  await db
    .update(artworkImagesTable)
    .set({ isPrimary: false })
    .where(eq(artworkImagesTable.artworkId, artworkId));

  // Set new primary
  await db
    .update(artworkImagesTable)
    .set({ isPrimary: true })
    .where(
      and(
        eq(artworkImagesTable.id, imageId),
        eq(artworkImagesTable.artworkId, artworkId),
      ),
    );

  return getImagesForArtwork(artworkId);
}

export async function reorderImages(
  artworkId: string,
  orderedIds: string[],
): Promise<ArtworkImage[]> {
  const session = await getSession();
  if (!session.userId) throw new Error("Not authenticated");

  const artwork = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.id, artworkId),
      eq(artworksTable.tenantId, session.tenantId),
    ),
  });
  if (!artwork) throw new Error("Artwork not found");

  await Promise.all(
    orderedIds.map((id, idx) =>
      db
        .update(artworkImagesTable)
        .set({ sortOrder: idx })
        .where(
          and(
            eq(artworkImagesTable.id, id),
            eq(artworkImagesTable.artworkId, artworkId),
          ),
        ),
    ),
  );

  return getImagesForArtwork(artworkId);
}
