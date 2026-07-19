import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * One row per rate-limited action (e.g. an inquiry submission), keyed by an
 * arbitrary string such as `inquiry:<ip>`. Counting recent rows per key gives
 * a sliding-window rate limit that is shared across all server instances.
 */
export const rateLimitEventsTable = pgTable(
  "rate_limit_event",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("rate_limit_event_key_created_at_idx").on(table.key, table.createdAt)],
);
