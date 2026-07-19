"use server";

import { db } from "@workspace/db";
import {
  artworkCategoriesTable,
  artworkCategoryOnArtworkTable,
} from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import type { ArtworkCategory } from "@workspace/db";

export type CategoryState = { error: string; success?: boolean };

export async function createCategory(
  _prevState: CategoryState,
  formData: FormData,
): Promise<CategoryState> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };

  const name = (formData.get("name") as string)?.trim();
  if (!name || name.length < 1) return { error: "Category name is required." };
  if (name.length > 80) return { error: "Name must be 80 characters or fewer." };

  await db.insert(artworkCategoriesTable).values({
    tenantId: session.tenantId,
    name,
  });

  return { error: "", success: true };
}

export async function renameCategory(
  id: string,
  _prevState: CategoryState,
  formData: FormData,
): Promise<CategoryState> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };

  const name = (formData.get("name") as string)?.trim();
  if (!name || name.length < 1) return { error: "Category name is required." };

  await db
    .update(artworkCategoriesTable)
    .set({ name })
    .where(
      and(
        eq(artworkCategoriesTable.id, id),
        eq(artworkCategoriesTable.tenantId, session.tenantId),
      ),
    );

  return { error: "", success: true };
}

export async function deleteCategory(id: string): Promise<{ error: string }> {
  const session = await getSession();
  if (!session.userId) return { error: "Not authenticated." };

  // Check if any artworks are assigned to this category
  const [usage] = await db
    .select({ count: count() })
    .from(artworkCategoryOnArtworkTable)
    .where(eq(artworkCategoryOnArtworkTable.categoryId, id));

  if ((usage?.count ?? 0) > 0) {
    return {
      error: `This category is assigned to ${usage!.count} artwork(s). Unassign them first.`,
    };
  }

  await db
    .delete(artworkCategoriesTable)
    .where(
      and(
        eq(artworkCategoriesTable.id, id),
        eq(artworkCategoriesTable.tenantId, session.tenantId),
      ),
    );

  return { error: "" };
}

export async function getCategories(): Promise<
  (ArtworkCategory & { artworkCount: number })[]
> {
  const session = await getSession();
  if (!session.userId) return [];

  const cats = await db.query.artworkCategoriesTable.findMany({
    where: eq(artworkCategoriesTable.tenantId, session.tenantId),
    orderBy: (t, { asc }) => [asc(t.name)],
  });

  // Get artwork counts
  const counts = await db
    .select({
      categoryId: artworkCategoryOnArtworkTable.categoryId,
      count: count(),
    })
    .from(artworkCategoryOnArtworkTable)
    .groupBy(artworkCategoryOnArtworkTable.categoryId);

  const countMap = Object.fromEntries(counts.map((c) => [c.categoryId, c.count]));

  return cats.map((cat) => ({ ...cat, artworkCount: countMap[cat.id] ?? 0 }));
}
