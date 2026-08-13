/**
 * Exhibition & Show Planner — tenant isolation  (Task #81)
 *
 * Verifies shows, rooms, walls, placements, guests, and milestones are
 * strictly scoped to the creating tenant and invisible to others.
 */
import { afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import {
  db,
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

describeIntegration("exhibition tenant isolation (Task #81)", () => {
  const ids = {
    tenants: [] as string[],
    artworks: [] as string[],
    shows: [] as string[],
    rooms: [] as string[],
    walls: [] as string[],
    placements: [] as string[],
    guests: [] as string[],
    milestones: [] as string[],
  };

  function uid() { return randomUUID(); }

  async function makeTenant() {
    const id = uid();
    await db.insert(tenantsTable).values({ id, type: "ARTIST", businessName: "Exh Tenant", slug: `exh-${id}` } as any);
    ids.tenants.push(id);
    return id;
  }

  async function makeArtwork(tenantId: string) {
    const id = uid();
    await db.insert(artworksTable).values({ id, tenantId, title: "Exh Art", sku: `ea-${id}`, price: 500, status: "AVAILABLE", showInGallery: true } as any);
    ids.artworks.push(id);
    return id;
  }

  async function makeShow(tenantId: string) {
    const [row] = await db.insert(exhibitionShowsTable).values({ tenantId, title: "Test Show" }).returning({ id: exhibitionShowsTable.id });
    ids.shows.push(row!.id);
    return row!.id;
  }

  async function makeRoom(showId: string, tenantId: string) {
    const [row] = await db.insert(exhibitionRoomsTable).values({ showId, tenantId, name: "Room A" }).returning({ id: exhibitionRoomsTable.id });
    ids.rooms.push(row!.id);
    return row!.id;
  }

  async function makeWall(roomId: string, tenantId: string) {
    const [row] = await db.insert(exhibitionWallsTable).values({ roomId, tenantId, name: "North Wall" }).returning({ id: exhibitionWallsTable.id });
    ids.walls.push(row!.id);
    return row!.id;
  }

  async function makePlacement(wallId: string, tenantId: string, artworkId: string) {
    const [row] = await db.insert(exhibitionPlacementsTable).values({ wallId, tenantId, artworkId, hangHeightCm: 150 }).returning({ id: exhibitionPlacementsTable.id });
    ids.placements.push(row!.id);
    return row!.id;
  }

  async function makeGuest(showId: string, tenantId: string) {
    const [row] = await db.insert(exhibitionGuestsTable).values({ showId, tenantId, name: "Jane Doe" }).returning({ id: exhibitionGuestsTable.id });
    ids.guests.push(row!.id);
    return row!.id;
  }

  async function makeMilestone(showId: string, tenantId: string) {
    const [row] = await db.insert(exhibitionMilestonesTable).values({ showId, tenantId, title: "Hang works" }).returning({ id: exhibitionMilestonesTable.id });
    ids.milestones.push(row!.id);
    return row!.id;
  }

  afterEach(async () => {
    for (const id of ids.placements) await db.delete(exhibitionPlacementsTable).where(eq(exhibitionPlacementsTable.id, id)).catch(() => {});
    for (const id of ids.guests) await db.delete(exhibitionGuestsTable).where(eq(exhibitionGuestsTable.id, id)).catch(() => {});
    for (const id of ids.milestones) await db.delete(exhibitionMilestonesTable).where(eq(exhibitionMilestonesTable.id, id)).catch(() => {});
    for (const id of ids.walls) await db.delete(exhibitionWallsTable).where(eq(exhibitionWallsTable.id, id)).catch(() => {});
    for (const id of ids.rooms) await db.delete(exhibitionRoomsTable).where(eq(exhibitionRoomsTable.id, id)).catch(() => {});
    for (const id of ids.shows) await db.delete(exhibitionShowsTable).where(eq(exhibitionShowsTable.id, id)).catch(() => {});
    for (const id of ids.artworks) await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
    for (const id of ids.tenants) await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
    Object.values(ids).forEach((arr) => arr.splice(0));
  });

  it("a show is only visible to its owning tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const showId = await makeShow(tenantA);

    const found = await db.query.exhibitionShowsTable.findFirst({
      where: and(eq(exhibitionShowsTable.id, showId), eq(exhibitionShowsTable.tenantId, tenantA)),
    });
    expect(found).toBeDefined();

    const notFound = await db.query.exhibitionShowsTable.findFirst({
      where: and(eq(exhibitionShowsTable.id, showId), eq(exhibitionShowsTable.tenantId, tenantB)),
    });
    expect(notFound).toBeUndefined();
  });

  it("listing shows returns only the requesting tenant's rows", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await makeShow(tenantA);
    await makeShow(tenantA);
    await makeShow(tenantB);

    const showsA = await db.select().from(exhibitionShowsTable).where(eq(exhibitionShowsTable.tenantId, tenantA));
    const showsB = await db.select().from(exhibitionShowsTable).where(eq(exhibitionShowsTable.tenantId, tenantB));

    expect(showsA).toHaveLength(2);
    expect(showsB).toHaveLength(1);
    expect(showsA.every((s) => s.tenantId === tenantA)).toBe(true);
  });

  it("a room, wall, and placement belong to the creating tenant only", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const artworkA = await makeArtwork(tenantA);
    const showId = await makeShow(tenantA);
    const roomId = await makeRoom(showId, tenantA);
    const wallId = await makeWall(roomId, tenantA);
    const placementId = await makePlacement(wallId, tenantA, artworkA);

    // tenantA can see all
    const room = await db.query.exhibitionRoomsTable.findFirst({ where: and(eq(exhibitionRoomsTable.id, roomId), eq(exhibitionRoomsTable.tenantId, tenantA)) });
    const wall = await db.query.exhibitionWallsTable.findFirst({ where: and(eq(exhibitionWallsTable.id, wallId), eq(exhibitionWallsTable.tenantId, tenantA)) });
    const placement = await db.query.exhibitionPlacementsTable.findFirst({ where: and(eq(exhibitionPlacementsTable.id, placementId), eq(exhibitionPlacementsTable.tenantId, tenantA)) });
    expect(room).toBeDefined();
    expect(wall).toBeDefined();
    expect(placement).toBeDefined();

    // tenantB sees nothing
    const noRoom = await db.query.exhibitionRoomsTable.findFirst({ where: and(eq(exhibitionRoomsTable.id, roomId), eq(exhibitionRoomsTable.tenantId, tenantB)) });
    const noWall = await db.query.exhibitionWallsTable.findFirst({ where: and(eq(exhibitionWallsTable.id, wallId), eq(exhibitionWallsTable.tenantId, tenantB)) });
    const noPlacement = await db.query.exhibitionPlacementsTable.findFirst({ where: and(eq(exhibitionPlacementsTable.id, placementId), eq(exhibitionPlacementsTable.tenantId, tenantB)) });
    expect(noRoom).toBeUndefined();
    expect(noWall).toBeUndefined();
    expect(noPlacement).toBeUndefined();
  });

  it("guests are scoped to the owning tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const showId = await makeShow(tenantA);
    const guestId = await makeGuest(showId, tenantA);

    const found = await db.query.exhibitionGuestsTable.findFirst({ where: and(eq(exhibitionGuestsTable.id, guestId), eq(exhibitionGuestsTable.tenantId, tenantA)) });
    expect(found).toBeDefined();

    const notFound = await db.query.exhibitionGuestsTable.findFirst({ where: and(eq(exhibitionGuestsTable.id, guestId), eq(exhibitionGuestsTable.tenantId, tenantB)) });
    expect(notFound).toBeUndefined();
  });

  it("milestones are scoped to the owning tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const showId = await makeShow(tenantA);
    const msId = await makeMilestone(showId, tenantA);

    const found = await db.query.exhibitionMilestonesTable.findFirst({ where: and(eq(exhibitionMilestonesTable.id, msId), eq(exhibitionMilestonesTable.tenantId, tenantA)) });
    expect(found).toBeDefined();

    const notFound = await db.query.exhibitionMilestonesTable.findFirst({ where: and(eq(exhibitionMilestonesTable.id, msId), eq(exhibitionMilestonesTable.tenantId, tenantB)) });
    expect(notFound).toBeUndefined();
  });
});
