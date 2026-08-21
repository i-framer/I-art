"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@workspace/db";
import { freightSettingsTable, freightMethodsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  smallMaxMm: z.coerce
    .number()
    .int()
    .min(1, "Small threshold must be at least 1 mm")
    .max(9999, "Small threshold must be at most 9999 mm"),
  mediumMaxMm: z.coerce
    .number()
    .int()
    .min(1, "Medium threshold must be at least 1 mm")
    .max(9999, "Medium threshold must be at most 9999 mm"),
});

const methodSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  smallCents: z.coerce.number().int().min(0).max(9999999),
  mediumCents: z.coerce.number().int().min(0).max(9999999),
  largeCents: z.coerce.number().int().min(0).max(9999999),
  tubeCents: z.coerce.number().int().min(0).max(9999999),
  enabled: z.coerce.boolean().default(true),
});

/** Convert an AUD dollar string (e.g. "12.50") to integer cents. */
function audToCents(value: string | null | undefined): number {
  const normalized = (value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
}

// ---------------------------------------------------------------------------
// Save dimension thresholds
// ---------------------------------------------------------------------------

export type FreightSettingsState = { error: string | null; success: boolean };

export async function saveFreightSettings(
  _prev: FreightSettingsState,
  formData: FormData,
): Promise<FreightSettingsState> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (session.role !== "owner") {
    return { error: "Only gallery owners can change freight settings.", success: false };
  }

  const parsed = settingsSchema.safeParse({
    smallMaxMm: formData.get("smallMaxMm"),
    mediumMaxMm: formData.get("mediumMaxMm"),
  });
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Invalid input";
    return { error: msg, success: false };
  }

  const { smallMaxMm, mediumMaxMm } = parsed.data;
  if (smallMaxMm >= mediumMaxMm) {
    return {
      error: "Small threshold must be less than the medium threshold.",
      success: false,
    };
  }

  await db
    .insert(freightSettingsTable)
    .values({ tenantId: session.tenantId, smallMaxMm, mediumMaxMm })
    .onConflictDoUpdate({
      target: freightSettingsTable.tenantId,
      set: { smallMaxMm, mediumMaxMm, updatedAt: new Date() },
    });

  revalidatePath("/settings/freight");
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// Add a new freight method
// ---------------------------------------------------------------------------

export type FreightMethodState = { error: string | null; success: boolean };

export async function addFreightMethod(
  _prev: FreightMethodState,
  formData: FormData,
): Promise<FreightMethodState> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (session.role !== "owner") {
    return { error: "Only gallery owners can add freight methods.", success: false };
  }

  const parsed = methodSchema.safeParse({
    name: formData.get("name"),
    smallCents: audToCents(formData.get("smallAud") as string | null),
    mediumCents: audToCents(formData.get("mediumAud") as string | null),
    largeCents: audToCents(formData.get("largeAud") as string | null),
    tubeCents: audToCents(formData.get("tubeAud") as string | null),
    enabled: formData.get("enabled") === "on" ? "true" : "false",
  });
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Invalid input";
    return { error: msg, success: false };
  }

  await db.insert(freightMethodsTable).values({
    tenantId: session.tenantId,
    ...parsed.data,
  });

  revalidatePath("/settings/freight");
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// Update an existing freight method
// ---------------------------------------------------------------------------

export type UpdateFreightMethodState = { error: string | null; success: boolean };

export async function updateFreightMethod(
  _prev: UpdateFreightMethodState,
  formData: FormData,
): Promise<UpdateFreightMethodState> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (session.role !== "owner") {
    return { error: "Only gallery owners can update freight methods.", success: false };
  }

  const id = formData.get("id") as string | null;
  if (!id) return { error: "Missing method ID.", success: false };

  const parsed = methodSchema.safeParse({
    name: formData.get("name"),
    smallCents: audToCents(formData.get("smallAud") as string | null),
    mediumCents: audToCents(formData.get("mediumAud") as string | null),
    largeCents: audToCents(formData.get("largeAud") as string | null),
    tubeCents: audToCents(formData.get("tubeAud") as string | null),
    enabled: formData.get("enabled") === "on" ? "true" : "false",
  });
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Invalid input";
    return { error: msg, success: false };
  }

  // Tenant-scoped update — only touches rows belonging to the session tenant
  await db
    .update(freightMethodsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(
      and(
        eq(freightMethodsTable.id, id),
        eq(freightMethodsTable.tenantId, session.tenantId),
      ),
    );

  revalidatePath("/settings/freight");
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// Delete a freight method
// ---------------------------------------------------------------------------

export async function deleteFreightMethod(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (session.role !== "owner") redirect("/settings/freight?error=unauthorized");

  const id = formData.get("id") as string | null;
  if (!id) redirect("/settings/freight");

  // Tenant-scoped delete
  await db
    .delete(freightMethodsTable)
    .where(
      and(
        eq(freightMethodsTable.id, id),
        eq(freightMethodsTable.tenantId, session.tenantId),
      ),
    );

  revalidatePath("/settings/freight");
  redirect("/settings/freight?saved=1");
}
