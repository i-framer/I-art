"use server";

/**
 * Exhibition & Show Planner — server actions  (Task #81)
 */

import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import {
  tenantsTable,
  artworksTable,
  exhibitionShowsTable,
  exhibitionRoomsTable,
  exhibitionWallsTable,
  exhibitionPlacementsTable,
  exhibitionGuestsTable,
  exhibitionMilestonesTable,
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

// ── Show CRUD ─────────────────────────────────────────────────────────────────

const showSchema = z.object({
  title: z.string().min(1).max(200),
  venue: z.string().max(200).optional(),
  openingDate: z.string().optional(),
  closingDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

export async function createShow(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = showSchema.safeParse({
    title: formData.get("title"),
    venue: formData.get("venue") || undefined,
    openingDate: formData.get("openingDate") || undefined,
    closingDate: formData.get("closingDate") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) redirect("/exhibitions/new?error=invalid");

  const [row] = await db
    .insert(exhibitionShowsTable)
    .values({
      tenantId: session.tenantId,
      title: parsed.data.title,
      venue: parsed.data.venue ?? null,
      openingDate: parsed.data.openingDate ?? null,
      closingDate: parsed.data.closingDate ?? null,
      notes: parsed.data.notes ?? null,
    })
    .returning({ id: exhibitionShowsTable.id });

  redirect(`/exhibitions/${row!.id}`);
}

export async function updateShowStatus(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const status = formData.get("status") as "UPCOMING" | "ACTIVE" | "ARCHIVED";
  if (!id || !status) redirect("/exhibitions");

  await db
    .update(exhibitionShowsTable)
    .set({ status })
    .where(
      and(
        eq(exhibitionShowsTable.id, id),
        eq(exhibitionShowsTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${id}`);
}

// ── Room CRUD ─────────────────────────────────────────────────────────────────

const roomSchema = z.object({
  showId: z.string().min(1),
  name: z.string().min(1).max(100),
  widthCm: z.coerce.number().int().min(0).optional(),
  heightCm: z.coerce.number().int().min(0).optional(),
  depthCm: z.coerce.number().int().min(0).optional(),
});

export async function createRoom(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = roomSchema.safeParse({
    showId: formData.get("showId"),
    name: formData.get("name"),
    widthCm: formData.get("widthCm") || undefined,
    heightCm: formData.get("heightCm") || undefined,
    depthCm: formData.get("depthCm") || undefined,
  });
  if (!parsed.success) redirect("/exhibitions?error=invalid");

  // Verify the show belongs to this tenant
  const show = await db.query.exhibitionShowsTable.findFirst({
    where: and(
      eq(exhibitionShowsTable.id, parsed.data.showId),
      eq(exhibitionShowsTable.tenantId, session.tenantId),
    ),
  });
  if (!show) redirect("/exhibitions");

  await db.insert(exhibitionRoomsTable).values({
    showId: parsed.data.showId,
    tenantId: session.tenantId,
    name: parsed.data.name,
    widthCm: parsed.data.widthCm ?? null,
    heightCm: parsed.data.heightCm ?? null,
    depthCm: parsed.data.depthCm ?? null,
  });

  redirect(`/exhibitions/${parsed.data.showId}?tab=floor-plan`);
}

export async function deleteRoom(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const showId = formData.get("showId") as string;
  if (!id) redirect("/exhibitions");

  await db
    .delete(exhibitionRoomsTable)
    .where(
      and(
        eq(exhibitionRoomsTable.id, id),
        eq(exhibitionRoomsTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${showId}?tab=floor-plan`);
}

// ── Wall CRUD ─────────────────────────────────────────────────────────────────

const wallSchema = z.object({
  roomId: z.string().min(1),
  showId: z.string().min(1),
  name: z.string().min(1).max(100),
  widthCm: z.coerce.number().int().min(0).optional(),
  heightCm: z.coerce.number().int().min(0).optional(),
  orientation: z.enum(["NORTH", "SOUTH", "EAST", "WEST", "OTHER"]).default("OTHER"),
});

export async function createWall(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = wallSchema.safeParse({
    roomId: formData.get("roomId"),
    showId: formData.get("showId"),
    name: formData.get("name"),
    widthCm: formData.get("widthCm") || undefined,
    heightCm: formData.get("heightCm") || undefined,
    orientation: formData.get("orientation") || "OTHER",
  });
  if (!parsed.success) redirect("/exhibitions?error=invalid");

  // Verify the room belongs to this tenant
  const room = await db.query.exhibitionRoomsTable.findFirst({
    where: and(
      eq(exhibitionRoomsTable.id, parsed.data.roomId),
      eq(exhibitionRoomsTable.tenantId, session.tenantId),
    ),
  });
  if (!room) redirect("/exhibitions");

  await db.insert(exhibitionWallsTable).values({
    roomId: parsed.data.roomId,
    tenantId: session.tenantId,
    name: parsed.data.name,
    widthCm: parsed.data.widthCm ?? null,
    heightCm: parsed.data.heightCm ?? null,
    orientation: parsed.data.orientation,
  });

  redirect(`/exhibitions/${parsed.data.showId}?tab=floor-plan`);
}

// ── Placement CRUD ────────────────────────────────────────────────────────────

const placementSchema = z.object({
  wallId: z.string().min(1),
  showId: z.string().min(1),
  artworkId: z.string().min(1),
  xCm: z.coerce.number().int().min(0).optional(),
  hangHeightCm: z.coerce.number().int().min(0).default(150),
  notes: z.string().max(500).optional(),
});

export async function addPlacement(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = placementSchema.safeParse({
    wallId: formData.get("wallId"),
    showId: formData.get("showId"),
    artworkId: formData.get("artworkId"),
    xCm: formData.get("xCm") || undefined,
    hangHeightCm: formData.get("hangHeightCm") || 150,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) redirect("/exhibitions?error=invalid");

  // Verify wall and artwork belong to this tenant
  const [wall, artwork] = await Promise.all([
    db.query.exhibitionWallsTable.findFirst({
      where: and(
        eq(exhibitionWallsTable.id, parsed.data.wallId),
        eq(exhibitionWallsTable.tenantId, session.tenantId),
      ),
    }),
    db.query.artworksTable.findFirst({
      where: and(
        eq(artworksTable.id, parsed.data.artworkId),
        eq(artworksTable.tenantId, session.tenantId),
      ),
    }),
  ]);
  if (!wall || !artwork) redirect("/exhibitions");

  await db.insert(exhibitionPlacementsTable).values({
    wallId: parsed.data.wallId,
    tenantId: session.tenantId,
    artworkId: parsed.data.artworkId,
    xCm: parsed.data.xCm ?? null,
    hangHeightCm: parsed.data.hangHeightCm,
    notes: parsed.data.notes ?? null,
  });

  redirect(`/exhibitions/${parsed.data.showId}?tab=floor-plan`);
}

export async function removePlacement(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const showId = formData.get("showId") as string;
  if (!id) redirect("/exhibitions");

  await db
    .delete(exhibitionPlacementsTable)
    .where(
      and(
        eq(exhibitionPlacementsTable.id, id),
        eq(exhibitionPlacementsTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${showId}?tab=floor-plan`);
}

// ── Guest CRUD ────────────────────────────────────────────────────────────────

const guestSchema = z.object({
  showId: z.string().min(1),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
});

export async function addGuest(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = guestSchema.safeParse({
    showId: formData.get("showId"),
    name: formData.get("name"),
    email: formData.get("email") || undefined,
  });
  if (!parsed.success) redirect("/exhibitions?error=invalid");

  const show = await db.query.exhibitionShowsTable.findFirst({
    where: and(
      eq(exhibitionShowsTable.id, parsed.data.showId),
      eq(exhibitionShowsTable.tenantId, session.tenantId),
    ),
  });
  if (!show) redirect("/exhibitions");

  await db.insert(exhibitionGuestsTable).values({
    showId: parsed.data.showId,
    tenantId: session.tenantId,
    name: parsed.data.name,
    email: parsed.data.email ?? null,
  });

  redirect(`/exhibitions/${parsed.data.showId}?tab=guests`);
}

export async function updateGuestRsvp(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const showId = formData.get("showId") as string;
  const rsvpStatus = formData.get("rsvpStatus") as "PENDING" | "YES" | "NO";
  if (!id || !rsvpStatus) redirect("/exhibitions");

  await db
    .update(exhibitionGuestsTable)
    .set({ rsvpStatus })
    .where(
      and(
        eq(exhibitionGuestsTable.id, id),
        eq(exhibitionGuestsTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${showId}?tab=guests`);
}

export async function removeGuest(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const showId = formData.get("showId") as string;
  if (!id) redirect("/exhibitions");

  await db
    .delete(exhibitionGuestsTable)
    .where(
      and(
        eq(exhibitionGuestsTable.id, id),
        eq(exhibitionGuestsTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${showId}?tab=guests`);
}

// ── Milestone CRUD ────────────────────────────────────────────────────────────

const milestoneSchema = z.object({
  showId: z.string().min(1),
  title: z.string().min(1).max(200),
  dueDate: z.string().optional(),
});

export async function addMilestone(formData: FormData) {
  const { session } = await getSessionAndTenant();

  const parsed = milestoneSchema.safeParse({
    showId: formData.get("showId"),
    title: formData.get("title"),
    dueDate: formData.get("dueDate") || undefined,
  });
  if (!parsed.success) redirect("/exhibitions?error=invalid");

  const show = await db.query.exhibitionShowsTable.findFirst({
    where: and(
      eq(exhibitionShowsTable.id, parsed.data.showId),
      eq(exhibitionShowsTable.tenantId, session.tenantId),
    ),
  });
  if (!show) redirect("/exhibitions");

  await db.insert(exhibitionMilestonesTable).values({
    showId: parsed.data.showId,
    tenantId: session.tenantId,
    title: parsed.data.title,
    dueDate: parsed.data.dueDate ?? null,
  });

  redirect(`/exhibitions/${parsed.data.showId}?tab=timeline`);
}

export async function toggleMilestone(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const showId = formData.get("showId") as string;
  const completed = formData.get("completed") === "true";
  if (!id) redirect("/exhibitions");

  await db
    .update(exhibitionMilestonesTable)
    .set({ completedAt: completed ? new Date() : null })
    .where(
      and(
        eq(exhibitionMilestonesTable.id, id),
        eq(exhibitionMilestonesTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${showId}?tab=timeline`);
}

export async function removeMilestone(formData: FormData) {
  const { session } = await getSessionAndTenant();
  const id = formData.get("id") as string;
  const showId = formData.get("showId") as string;
  if (!id) redirect("/exhibitions");

  await db
    .delete(exhibitionMilestonesTable)
    .where(
      and(
        eq(exhibitionMilestonesTable.id, id),
        eq(exhibitionMilestonesTable.tenantId, session.tenantId),
      ),
    );

  redirect(`/exhibitions/${showId}?tab=timeline`);
}
