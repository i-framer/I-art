"use server";
import { requireActiveBillingAccess } from "@/lib/billing";

import { db } from "@workspace/db";
import { representedArtistsTable, artworksTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";

export type ArtistState = { error: string; success?: boolean };

const artistSchema = z.object({
  name: z.string().min(1, "Name is required"),
  bio: z.string().optional(),
  commissionPct: z.coerce.number().int().min(0).max(100).default(0),
});

export async function createRepresentedArtist(
  _prevState: ArtistState,
  formData: FormData,
): Promise<ArtistState> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };
  await requireActiveBillingAccess(session.tenantId);

  const parsed = artistSchema.safeParse({
    name: formData.get("name"),
    bio: formData.get("bio") || undefined,
    commissionPct: formData.get("commissionPct") || 0,
  });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input." };
  }

  await db.insert(representedArtistsTable).values({
    tenantId: session.tenantId,
    name: parsed.data.name,
    bio: parsed.data.bio ?? null,
    commissionPct: parsed.data.commissionPct,
  });

  return { error: "", success: true };
}

export async function updateRepresentedArtist(
  id: string,
  _prevState: ArtistState,
  formData: FormData,
): Promise<ArtistState> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };
  await requireActiveBillingAccess(session.tenantId);

  const parsed = artistSchema.safeParse({
    name: formData.get("name"),
    bio: formData.get("bio") || undefined,
    commissionPct: formData.get("commissionPct") || 0,
  });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input." };
  }

  await db
    .update(representedArtistsTable)
    .set({
      name: parsed.data.name,
      bio: parsed.data.bio ?? null,
      commissionPct: parsed.data.commissionPct,
    })
    .where(
      and(
        eq(representedArtistsTable.id, id),
        eq(representedArtistsTable.tenantId, session.tenantId),
      ),
    );

  return { error: "", success: true };
}

export async function deleteRepresentedArtist(
  id: string,
): Promise<{ error: string }> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };
  await requireActiveBillingAccess(session.tenantId);

  // Check if artworks are linked to this artist
  const [usage] = await db
    .select({ count: count() })
    .from(artworksTable)
    .where(eq(artworksTable.representedArtistId, id));

  if ((usage?.count ?? 0) > 0) {
    return {
      error: `${usage!.count} artwork(s) are linked to this artist. Unlink them first.`,
    };
  }

  await db
    .delete(representedArtistsTable)
    .where(
      and(
        eq(representedArtistsTable.id, id),
        eq(representedArtistsTable.tenantId, session.tenantId),
      ),
    );

  return { error: "" };
}
