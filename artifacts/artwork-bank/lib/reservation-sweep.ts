/**
 * Safety-net sweep for artworks stuck in RESERVED.
 *
 * Checkout normally reserves an artwork and Stripe's
 * checkout.session.expired webhook releases it if the buyer abandons the
 * session (30-minute expiry). If that webhook delivery is ever missed
 * (outage, misconfiguration), the artwork would stay RESERVED forever.
 *
 * This sweep reverts RESERVED artworks back to AVAILABLE when:
 *   - they have been in RESERVED well past the session expiry window
 *     (updatedAt older than RESERVATION_SWEEP_MAX_AGE_MS, default 1 hour —
 *     double Stripe's 30-minute session expiry), and
 *   - no PAID/FULFILLED order exists for the artwork (so a completed
 *     purchase whose SOLD update somehow didn't land is never re-listed).
 *
 * The conditional UPDATE makes the sweep idempotent: rows already released
 * (or since sold) simply don't match, so it is safe to run repeatedly.
 */
import { db, artworksTable, ordersTable, orderItemsTable } from "@workspace/db";
import { and, eq, lt, notExists, inArray, sql } from "drizzle-orm";

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function sweepStaleReservations(): Promise<{
  released: number;
  ids: string[];
}> {
  const maxAgeMs =
    Number(process.env.RESERVATION_SWEEP_MAX_AGE_MS) || DEFAULT_MAX_AGE_MS;
  const cutoff = new Date(Date.now() - maxAgeMs);

  const releasedRows = await db
    .update(artworksTable)
    .set({ status: "AVAILABLE" })
    .where(
      and(
        eq(artworksTable.status, "RESERVED"),
        // updatedAt is bumped when the reservation is taken, so this is
        // "reserved (or last touched) more than maxAgeMs ago".
        lt(artworksTable.updatedAt, cutoff),
        // Never touch artworks with a completed order.
        notExists(
          db
            .select({ one: sql`1` })
            .from(orderItemsTable)
            .innerJoin(ordersTable, eq(orderItemsTable.orderId, ordersTable.id))
            .where(
              and(
                eq(orderItemsTable.artworkId, artworksTable.id),
                inArray(ordersTable.status, ["PAID", "FULFILLED"]),
              ),
            ),
        ),
      ),
    )
    .returning({ id: artworksTable.id });

  return {
    released: releasedRows.length,
    ids: releasedRows.map((r) => r.id),
  };
}
