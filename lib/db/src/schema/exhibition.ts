import {
  pgTable,
  pgEnum,
  text,
  integer,
  timestamp,
  date,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenant";
import { artworksTable } from "./artwork";

/**
 * Exhibition & Show Planner — Task #81
 *
 * Tables:
 *  exhibition_show        — a show/exhibition (title, venue, dates)
 *  exhibition_room        — a room inside a show (dimensions)
 *  exhibition_wall        — a wall inside a room (name, orientation, dimensions)
 *  exhibition_placement   — an artwork placed on a wall with position and hang height
 *  exhibition_guest       — a guest invited to a show
 *  exhibition_milestone   — a planning milestone/task for a show
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export const showStatusEnum = pgEnum("show_status", [
  "UPCOMING",
  "ACTIVE",
  "ARCHIVED",
]);

export const rsvpStatusEnum = pgEnum("rsvp_status", [
  "PENDING",
  "YES",
  "NO",
]);

export const wallOrientationEnum = pgEnum("wall_orientation", [
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
  "OTHER",
]);

// ── Tables ────────────────────────────────────────────────────────────────────

/** A gallery show/exhibition managed by a tenant. */
export const exhibitionShowsTable = pgTable("exhibition_show", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  venue: text("venue"),
  openingDate: date("opening_date"),
  closingDate: date("closing_date"),
  status: showStatusEnum("status").notNull().default("UPCOMING"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * A physical room inside a show venue.
 * Dimensions in centimetres.
 */
export const exhibitionRoomsTable = pgTable("exhibition_room", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  showId: text("show_id")
    .notNull()
    .references(() => exhibitionShowsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  widthCm: integer("width_cm"),
  heightCm: integer("height_cm"),
  depthCm: integer("depth_cm"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A wall within a room.  `widthCm` and `heightCm` describe its surface.
 */
export const exhibitionWallsTable = pgTable("exhibition_wall", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  roomId: text("room_id")
    .notNull()
    .references(() => exhibitionRoomsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  widthCm: integer("width_cm"),
  heightCm: integer("height_cm"),
  orientation: wallOrientationEnum("orientation").notNull().default("OTHER"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * An artwork placed on a wall.
 * xCm is the horizontal position from the left edge of the wall (centre of work).
 * hangHeightCm is the height to the centre of the artwork from the floor.
 * Standard hang height is 145–157 cm (eye level) — stored explicitly so the
 * hang list can surface it without re-deriving it.
 */
export const exhibitionPlacementsTable = pgTable("exhibition_placement", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  wallId: text("wall_id")
    .notNull()
    .references(() => exhibitionWallsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  artworkId: text("artwork_id")
    .notNull()
    .references(() => artworksTable.id, { onDelete: "restrict" }),
  /** Horizontal position in cm from the left edge of the wall (centre of artwork). */
  xCm: integer("x_cm"),
  /** Height in cm from the floor to the centre of the artwork. Default 150 (eye level). */
  hangHeightCm: integer("hang_height_cm").notNull().default(150),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A guest invited to an exhibition. */
export const exhibitionGuestsTable = pgTable("exhibition_guest", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  showId: text("show_id")
    .notNull()
    .references(() => exhibitionShowsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  rsvpStatus: rsvpStatusEnum("rsvp_status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A planning milestone for a show. */
export const exhibitionMilestonesTable = pgTable("exhibition_milestone", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  showId: text("show_id")
    .notNull()
    .references(() => exhibitionShowsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ExhibitionShow = typeof exhibitionShowsTable.$inferSelect;
export type InsertExhibitionShow = typeof exhibitionShowsTable.$inferInsert;
export type ExhibitionRoom = typeof exhibitionRoomsTable.$inferSelect;
export type ExhibitionWall = typeof exhibitionWallsTable.$inferSelect;
export type ExhibitionPlacement = typeof exhibitionPlacementsTable.$inferSelect;
export type ExhibitionGuest = typeof exhibitionGuestsTable.$inferSelect;
export type ExhibitionMilestone = typeof exhibitionMilestonesTable.$inferSelect;
