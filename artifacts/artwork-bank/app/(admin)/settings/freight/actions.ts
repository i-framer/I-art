"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@workspace/db";
import {
  freightSettingsTable,
  freightMethodsTable,
  freightCarrierAccountsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { encryptCarrierCredentials } from "@/lib/carrier-credentials";
import { carrierProviderSchema } from "@/lib/carrier-quotes";

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
  originAddressLine1: z.string().trim().min(2, "Dispatch address is required.").max(160),
  originAddressLine2: z.string().trim().max(160).optional(),
  originSuburb: z.string().trim().min(2, "Dispatch suburb is required.").max(80),
  originState: z.string().trim().regex(/^(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$/i, "Use an Australian state or territory."),
  originPostcode: z.string().trim().regex(/^\d{4}$/, "Use a four-digit dispatch postcode."),
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
    originAddressLine1: formData.get("originAddressLine1"),
    originAddressLine2: formData.get("originAddressLine2") || undefined,
    originSuburb: formData.get("originSuburb"),
    originState: formData.get("originState"),
    originPostcode: formData.get("originPostcode"),
  });
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? "Invalid input";
    return { error: msg, success: false };
  }

  const {
    smallMaxMm,
    mediumMaxMm,
    originAddressLine1,
    originAddressLine2,
    originSuburb,
    originState,
    originPostcode,
  } = parsed.data;
  if (smallMaxMm >= mediumMaxMm) {
    return {
      error: "Small threshold must be less than the medium threshold.",
      success: false,
    };
  }

  await db
    .insert(freightSettingsTable)
    .values({
      tenantId: session.tenantId,
      smallMaxMm,
      mediumMaxMm,
      originAddressLine1,
      originAddressLine2: originAddressLine2 || null,
      originSuburb,
      originState: originState.toUpperCase(),
      originPostcode,
      originCountryCode: "AU",
    })
    .onConflictDoUpdate({
      target: freightSettingsTable.tenantId,
      set: {
        smallMaxMm,
        mediumMaxMm,
        originAddressLine1,
        originAddressLine2: originAddressLine2 || null,
        originSuburb,
        originState: originState.toUpperCase(),
        originPostcode,
        originCountryCode: "AU",
        updatedAt: new Date(),
      },
    });

  revalidatePath("/settings/freight");
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// Carrier account connections
// ---------------------------------------------------------------------------

export type CarrierAccountState = { error: string | null; success: boolean };

const carrierAccountBaseSchema = z.object({
  provider: carrierProviderSchema,
  label: z.string().trim().min(2, "Account label is required.").max(80),
  enabled: z.coerce.boolean().default(true),
});

const australiaPostAccountSchema = carrierAccountBaseSchema.extend({
  provider: z.literal("AUSTRALIA_POST"),
  apiKey: z.string().trim().min(8, "Australia Post API key is required.").max(500),
});

const aramexAccountSchema = carrierAccountBaseSchema.extend({
  provider: z.literal("ARAMEX"),
  userName: z.string().trim().min(1, "Aramex user name is required.").max(120),
  password: z.string().min(1, "Aramex password is required.").max(500),
  accountNumber: z.string().trim().min(1, "Aramex account number is required.").max(80),
  accountPin: z.string().trim().min(1, "Aramex account PIN is required.").max(80),
  accountEntity: z.string().trim().min(1, "Aramex account entity is required.").max(16),
  accountCountryCode: z.string().trim().length(2, "Use a two-letter country code."),
  useTestEndpoint: z.coerce.boolean().default(false),
});

export async function addCarrierAccount(
  _prev: CarrierAccountState,
  formData: FormData,
): Promise<CarrierAccountState> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (session.role !== "owner") {
    return { error: "Only gallery owners can connect carrier accounts.", success: false };
  }

  const provider = carrierProviderSchema.safeParse(formData.get("provider"));
  if (!provider.success) {
    return { error: "Choose a supported carrier.", success: false };
  }

  const raw = {
    provider: provider.data,
    label: formData.get("label"),
    enabled: formData.get("enabled") === "on" ? "true" : "false",
    apiKey: formData.get("apiKey"),
    userName: formData.get("userName"),
    password: formData.get("password"),
    accountNumber: formData.get("accountNumber"),
    accountPin: formData.get("accountPin"),
    accountEntity: formData.get("accountEntity"),
    accountCountryCode: formData.get("accountCountryCode"),
    useTestEndpoint: formData.get("useTestEndpoint") === "on" ? "true" : "false",
  };
  const parsed =
    provider.data === "AUSTRALIA_POST"
      ? australiaPostAccountSchema.safeParse(raw)
      : aramexAccountSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.errors[0]?.message ?? "Invalid carrier account details.",
      success: false,
    };
  }

  try {
    const credentials =
      parsed.data.provider === "AUSTRALIA_POST"
        ? { apiKey: parsed.data.apiKey }
        : {
            userName: parsed.data.userName,
            password: parsed.data.password,
            accountNumber: parsed.data.accountNumber,
            accountPin: parsed.data.accountPin,
            accountEntity: parsed.data.accountEntity,
            accountCountryCode: parsed.data.accountCountryCode.toUpperCase(),
            useTestEndpoint: parsed.data.useTestEndpoint,
          };
    await db.insert(freightCarrierAccountsTable).values({
      tenantId: session.tenantId,
      owner: "GALLERY",
      provider: parsed.data.provider,
      label: parsed.data.label,
      enabled: parsed.data.enabled,
      credentialsCiphertext: encryptCarrierCredentials(credentials),
    });
  } catch (error) {
    console.error("[freight] Failed to store carrier account:", error);
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not securely save this carrier account.",
      success: false,
    };
  }

  revalidatePath("/settings/freight");
  return { error: null, success: true };
}

export async function deleteCarrierAccount(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (session.role !== "owner") redirect("/settings/freight?error=unauthorized");

  const id = formData.get("id");
  if (typeof id !== "string" || !id) redirect("/settings/freight");

  await db
    .delete(freightCarrierAccountsTable)
    .where(
      and(
        eq(freightCarrierAccountsTable.id, id),
        eq(freightCarrierAccountsTable.tenantId, session.tenantId),
        eq(freightCarrierAccountsTable.owner, "GALLERY"),
      ),
    );

  revalidatePath("/settings/freight");
  redirect("/settings/freight?saved=1");
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
