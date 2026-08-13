/**
 * Exhibition show detail — tabbed view: Floor Plan · Hang List · Guests · Timeline
 * (Task #81)
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  exhibitionShowsTable,
  exhibitionRoomsTable,
  exhibitionWallsTable,
  exhibitionPlacementsTable,
  exhibitionGuestsTable,
  exhibitionMilestonesTable,
  artworksTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { ChevronLeft, Plus, Trash2, CheckCircle, Circle } from "lucide-react";
import {
  createRoom,
  deleteRoom,
  createWall,
  addPlacement,
  removePlacement,
  addGuest,
  updateGuestRsvp,
  removeGuest,
  addMilestone,
  toggleMilestone,
  removeMilestone,
  updateShowStatus,
} from "../actions";

export const metadata: Metadata = { title: "Exhibition" };

type Tab = "floor-plan" | "hang-list" | "guests" | "timeline";

export default async function ExhibitionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const activeTab: Tab = (["floor-plan", "hang-list", "guests", "timeline"].includes(rawTab ?? "")
    ? rawTab
    : "floor-plan") as Tab;

  const session = await getSession();
  if (!session.userId) redirect("/login");

  const show = await db.query.exhibitionShowsTable.findFirst({
    where: and(
      eq(exhibitionShowsTable.id, id),
      eq(exhibitionShowsTable.tenantId, session.tenantId),
    ),
  });
  if (!show) notFound();

  // Fetch all related data
  const [rooms, guests, milestones, artworks] = await Promise.all([
    db
      .select()
      .from(exhibitionRoomsTable)
      .where(eq(exhibitionRoomsTable.showId, id))
      .orderBy(asc(exhibitionRoomsTable.createdAt)),
    db
      .select()
      .from(exhibitionGuestsTable)
      .where(eq(exhibitionGuestsTable.showId, id))
      .orderBy(asc(exhibitionGuestsTable.name)),
    db
      .select()
      .from(exhibitionMilestonesTable)
      .where(eq(exhibitionMilestonesTable.showId, id))
      .orderBy(asc(exhibitionMilestonesTable.dueDate)),
    db
      .select({ id: artworksTable.id, title: artworksTable.title, sku: artworksTable.sku, heightCm: artworksTable.dimensionsH, widthCm: artworksTable.dimensionsW })
      .from(artworksTable)
      .where(eq(artworksTable.tenantId, session.tenantId))
      .orderBy(asc(artworksTable.title)),
  ]);

  // Fetch walls + placements per room
  const wallsWithPlacements = await Promise.all(
    rooms.map(async (room) => {
      const walls = await db
        .select()
        .from(exhibitionWallsTable)
        .where(eq(exhibitionWallsTable.roomId, room.id))
        .orderBy(asc(exhibitionWallsTable.createdAt));

      const wallsWithData = await Promise.all(
        walls.map(async (wall) => {
          const placements = await db
            .select({
              placement: exhibitionPlacementsTable,
              artworkTitle: artworksTable.title,
              artworkSku: artworksTable.sku,
              artworkHeightCm: artworksTable.dimensionsH,
              artworkWidthCm: artworksTable.dimensionsW,
            })
            .from(exhibitionPlacementsTable)
            .innerJoin(artworksTable, eq(exhibitionPlacementsTable.artworkId, artworksTable.id))
            .where(eq(exhibitionPlacementsTable.wallId, wall.id))
            .orderBy(asc(exhibitionPlacementsTable.xCm));
          return { wall, placements };
        }),
      );
      return { room, walls: wallsWithData };
    }),
  );

  const STATUS_OPTIONS = ["UPCOMING", "ACTIVE", "ARCHIVED"] as const;
  const RSVP_OPTIONS = ["PENDING", "YES", "NO"] as const;

  function tabHref(t: Tab) { return `/exhibitions/${id}?tab=${t}`; }

  const guestYes = guests.filter((g) => g.rsvpStatus === "YES").length;
  const guestPending = guests.filter((g) => g.rsvpStatus === "PENDING").length;
  const milestoneDone = milestones.filter((m) => m.completedAt).length;
  const totalPlacements = wallsWithPlacements.flatMap((r) => r.walls.flatMap((w) => w.placements)).length;

  return (
    <div className="px-8 py-8 max-w-4xl">
      {/* Back + header */}
      <Link href="/exhibitions" className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900">
        <ChevronLeft className="h-4 w-4" /> Exhibitions
      </Link>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">{show.title}</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            {show.venue && <span>{show.venue} · </span>}
            {show.openingDate ? `${show.openingDate}${show.closingDate ? ` → ${show.closingDate}` : ""}` : "Dates TBA"}
          </p>
        </div>
        <form action={updateShowStatus} className="flex items-center gap-2">
          <input type="hidden" name="id" value={id} />
          <select
            name="status"
            defaultValue={show.status}
            className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-700"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
          </select>
          <button type="submit" className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50">
            Update
          </button>
        </form>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-stone-200 mb-6 mt-4">
        {(["floor-plan", "hang-list", "guests", "timeline"] as Tab[]).map((t) => {
          const labels: Record<Tab, string> = {
            "floor-plan": `Floor Plan (${totalPlacements})`,
            "hang-list": "Hang List",
            guests: `Guests (${guests.length})`,
            timeline: `Timeline (${milestoneDone}/${milestones.length})`,
          };
          return (
            <Link
              key={t}
              href={tabHref(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === t
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-700"
              }`}
            >
              {labels[t]}
            </Link>
          );
        })}
      </div>

      {/* ── FLOOR PLAN TAB ──────────────────────────────────────────────────── */}
      {activeTab === "floor-plan" && (
        <div className="space-y-6">
          {/* Add room form */}
          <details className="rounded-xl border border-stone-200 bg-white overflow-hidden">
            <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer text-sm font-medium text-stone-700 hover:bg-stone-50">
              <Plus className="h-4 w-4" /> Add room
            </summary>
            <div className="px-4 pb-4 border-t border-stone-100">
              <form action={createRoom} className="flex flex-wrap items-end gap-3 mt-3">
                <input type="hidden" name="showId" value={id} />
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Room name *</label>
                  <input name="name" type="text" required maxLength={100} placeholder="e.g. Main Gallery" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-40" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Width (cm)</label>
                  <input name="widthCm" type="number" min={0} placeholder="e.g. 1200" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-28" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Depth (cm)</label>
                  <input name="depthCm" type="number" min={0} placeholder="e.g. 800" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-28" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1">Height (cm)</label>
                  <input name="heightCm" type="number" min={0} placeholder="e.g. 300" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-28" />
                </div>
                <button type="submit" className="rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800">Add room</button>
              </form>
            </div>
          </details>

          {/* Rooms */}
          {wallsWithPlacements.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white py-10 text-center">
              <p className="text-sm text-stone-400">Add your first room to begin laying out the floor plan.</p>
            </div>
          ) : (
            wallsWithPlacements.map(({ room, walls }) => (
              <div key={room.id} className="rounded-xl border border-stone-200 bg-white overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
                  <div>
                    <span className="font-medium text-stone-800">{room.name}</span>
                    {room.widthCm && <span className="text-xs text-stone-400 ml-2">{room.widthCm}×{room.depthCm}×{room.heightCm} cm</span>}
                  </div>
                  <form action={deleteRoom} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={room.id} />
                    <input type="hidden" name="showId" value={id} />
                    <button type="submit" className="text-stone-300 hover:text-red-500 transition-colors">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </form>
                </div>
                <div className="p-4 space-y-4">
                  {/* Add wall form */}
                  <details className="border border-stone-100 rounded-lg overflow-hidden">
                    <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer text-xs font-medium text-stone-500 hover:bg-stone-50">
                      <Plus className="h-3 w-3" /> Add wall
                    </summary>
                    <div className="px-3 pb-3 border-t border-stone-100">
                      <form action={createWall} className="flex flex-wrap items-end gap-3 mt-3">
                        <input type="hidden" name="roomId" value={room.id} />
                        <input type="hidden" name="showId" value={id} />
                        <div>
                          <label className="block text-xs font-medium text-stone-600 mb-1">Wall name *</label>
                          <input name="name" type="text" required maxLength={100} placeholder="e.g. North wall" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-36" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-stone-600 mb-1">Width (cm)</label>
                          <input name="widthCm" type="number" min={0} placeholder="400" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-24" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-stone-600 mb-1">Height (cm)</label>
                          <input name="heightCm" type="number" min={0} placeholder="300" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-24" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-stone-600 mb-1">Orientation</label>
                          <select name="orientation" defaultValue="OTHER" className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm">
                            {["NORTH", "SOUTH", "EAST", "WEST", "OTHER"].map((o) => <option key={o} value={o}>{o.charAt(0) + o.slice(1).toLowerCase()}</option>)}
                          </select>
                        </div>
                        <button type="submit" className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700">Add wall</button>
                      </form>
                    </div>
                  </details>

                  {/* Walls */}
                  {walls.map(({ wall, placements }) => (
                    <div key={wall.id} className="border border-stone-100 rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-100">
                        <span className="text-sm font-medium text-stone-700">
                          {wall.name}
                          {wall.widthCm && <span className="text-xs text-stone-400 ml-1.5">{wall.widthCm}×{wall.heightCm} cm · {wall.orientation.toLowerCase()}</span>}
                        </span>
                        <span className="text-xs text-stone-400">{placements.length} work{placements.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="p-3 space-y-2">
                        {placements.map(({ placement, artworkTitle, artworkSku, artworkHeightCm, artworkWidthCm }) => (
                          <div key={placement.id} className="flex items-center justify-between text-xs bg-white border border-stone-100 rounded-lg px-3 py-2">
                            <div>
                              <span className="font-medium text-stone-800">{artworkTitle}</span>
                              <span className="text-stone-400 ml-1.5">{artworkSku}</span>
                              {artworkWidthCm && artworkHeightCm && (
                                <span className="text-stone-400 ml-1.5">{artworkWidthCm}×{artworkHeightCm} cm</span>
                              )}
                              <span className="ml-2 text-stone-500">hang height: <strong>{placement.hangHeightCm} cm</strong></span>
                              {placement.xCm != null && <span className="ml-2 text-stone-400">@ {placement.xCm} cm from left</span>}
                            </div>
                            <form action={removePlacement}>
                              <input type="hidden" name="id" value={placement.id} />
                              <input type="hidden" name="showId" value={id} />
                              <button type="submit" className="text-stone-300 hover:text-red-500">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </form>
                          </div>
                        ))}
                        {/* Add placement */}
                        <details className="mt-1">
                          <summary className="text-xs font-medium text-stone-400 cursor-pointer hover:text-stone-700 flex items-center gap-1">
                            <Plus className="h-3 w-3" /> Place artwork
                          </summary>
                          <form action={addPlacement} className="flex flex-wrap items-end gap-2 mt-2">
                            <input type="hidden" name="wallId" value={wall.id} />
                            <input type="hidden" name="showId" value={id} />
                            <div>
                              <label className="block text-xs text-stone-500 mb-0.5">Artwork</label>
                              <select name="artworkId" required defaultValue="" className="rounded border border-stone-300 bg-white px-2 py-1 text-xs">
                                <option value="" disabled>Select…</option>
                                {artworks.map((a) => (
                                  <option key={a.id} value={a.id}>{a.title} ({a.sku})</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-stone-500 mb-0.5">Hang height (cm)</label>
                              <input name="hangHeightCm" type="number" defaultValue={150} min={0} className="rounded border border-stone-300 px-2 py-1 text-xs w-20" />
                            </div>
                            <div>
                              <label className="block text-xs text-stone-500 mb-0.5">Position from left (cm)</label>
                              <input name="xCm" type="number" min={0} placeholder="optional" className="rounded border border-stone-300 px-2 py-1 text-xs w-24" />
                            </div>
                            <button type="submit" className="rounded bg-stone-800 px-2 py-1 text-xs font-medium text-white hover:bg-stone-700">Place</button>
                          </form>
                        </details>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── HANG LIST TAB ───────────────────────────────────────────────────── */}
      {activeTab === "hang-list" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-stone-500">{totalPlacements} work{totalPlacements !== 1 ? "s" : ""} placed</p>
            <Link
              href={`/exhibitions/${id}/hang-list`}
              target="_blank"
              className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
            >
              🖨 Print hang list
            </Link>
          </div>
          {totalPlacements === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white py-10 text-center text-sm text-stone-400">
              No artworks placed yet. Add rooms, walls, and placements in the Floor Plan tab.
            </div>
          ) : (
            <div className="space-y-4">
              {wallsWithPlacements.map(({ room, walls }) =>
                walls.flatMap(({ wall, placements }) =>
                  placements.length > 0 ? [
                    <div key={wall.id} className="rounded-xl border border-stone-200 bg-white overflow-hidden">
                      <div className="px-4 py-3 bg-stone-50 border-b border-stone-100">
                        <p className="text-sm font-medium text-stone-700">{room.name} — {wall.name}</p>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-stone-100">
                            <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase tracking-wide">Artwork</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase tracking-wide">Dimensions</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase tracking-wide">Hang height</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase tracking-wide">Position</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100">
                          {placements.map(({ placement, artworkTitle, artworkSku, artworkHeightCm, artworkWidthCm }) => (
                            <tr key={placement.id}>
                              <td className="px-4 py-3">
                                <p className="font-medium text-stone-900">{artworkTitle}</p>
                                <p className="text-xs text-stone-400">{artworkSku}</p>
                              </td>
                              <td className="px-4 py-3 text-stone-500">
                                {artworkWidthCm && artworkHeightCm ? `${artworkWidthCm} × ${artworkHeightCm} cm` : "—"}
                              </td>
                              <td className="px-4 py-3 font-medium text-stone-900">{placement.hangHeightCm} cm</td>
                              <td className="px-4 py-3 text-stone-500">{placement.xCm != null ? `${placement.xCm} cm` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ] : []
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* ── GUESTS TAB ──────────────────────────────────────────────────────── */}
      {activeTab === "guests" && (
        <div>
          <div className="flex items-center gap-3 text-sm text-stone-500 mb-4">
            <span className="rounded-full bg-emerald-100 text-emerald-700 px-2.5 py-0.5 text-xs font-medium">{guestYes} attending</span>
            <span className="rounded-full bg-stone-100 text-stone-600 px-2.5 py-0.5 text-xs font-medium">{guestPending} pending</span>
          </div>
          {/* Add guest form */}
          <div className="rounded-xl border border-stone-200 bg-white p-4 mb-4">
            <form action={addGuest} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="showId" value={id} />
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">Name *</label>
                <input name="name" type="text" required maxLength={200} placeholder="Guest name" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-44" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">Email (optional)</label>
                <input name="email" type="email" placeholder="guest@email.com" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm w-52" />
              </div>
              <button type="submit" className="rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800">Add guest</button>
            </form>
          </div>
          {guests.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white py-10 text-center text-sm text-stone-400">
              No guests added yet.
            </div>
          ) : (
            <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50">
                    <th className="px-4 py-3 text-left font-medium text-stone-500">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-stone-500">Email</th>
                    <th className="px-4 py-3 text-left font-medium text-stone-500">RSVP</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {guests.map((g) => (
                    <tr key={g.id} className="hover:bg-stone-50">
                      <td className="px-4 py-3 font-medium text-stone-900">{g.name}</td>
                      <td className="px-4 py-3 text-stone-500">{g.email ?? <span className="italic text-stone-300">—</span>}</td>
                      <td className="px-4 py-3">
                        <form action={updateGuestRsvp} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={g.id} />
                          <input type="hidden" name="showId" value={id} />
                          <select name="rsvpStatus" defaultValue={g.rsvpStatus} className="rounded border border-stone-200 bg-white px-2 py-1 text-xs">
                            {RSVP_OPTIONS.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
                          </select>
                          <button type="submit" className="text-xs text-stone-500 hover:text-stone-800 underline">Save</button>
                        </form>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <form action={removeGuest}>
                          <input type="hidden" name="id" value={g.id} />
                          <input type="hidden" name="showId" value={id} />
                          <button type="submit" className="text-stone-300 hover:text-red-500">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TIMELINE TAB ────────────────────────────────────────────────────── */}
      {activeTab === "timeline" && (
        <div>
          {/* Add milestone form */}
          <div className="rounded-xl border border-stone-200 bg-white p-4 mb-4">
            <form action={addMilestone} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="showId" value={id} />
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs font-medium text-stone-600 mb-1">Milestone *</label>
                <input name="title" type="text" required maxLength={200} placeholder="e.g. Finalize artwork selection" className="w-full rounded-lg border border-stone-300 px-3 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-600 mb-1">Due date</label>
                <input name="dueDate" type="date" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm" />
              </div>
              <button type="submit" className="rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800">Add</button>
            </form>
          </div>
          {milestones.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white py-10 text-center text-sm text-stone-400">
              No milestones yet. Add planning tasks to keep the show on track.
            </div>
          ) : (
            <div className="space-y-2">
              {milestones.map((m) => {
                const done = !!m.completedAt;
                return (
                  <div key={m.id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${done ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-white"}`}>
                    <form action={toggleMilestone}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="showId" value={id} />
                      <input type="hidden" name="completed" value={done ? "false" : "true"} />
                      <button type="submit" className={`${done ? "text-emerald-500" : "text-stone-300 hover:text-stone-500"}`}>
                        {done ? <CheckCircle className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                      </button>
                    </form>
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${done ? "line-through text-stone-400" : "text-stone-900"}`}>{m.title}</p>
                      {m.dueDate && <p className="text-xs text-stone-400">Due {m.dueDate}</p>}
                    </div>
                    <form action={removeMilestone}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="showId" value={id} />
                      <button type="submit" className="text-stone-300 hover:text-red-500">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
