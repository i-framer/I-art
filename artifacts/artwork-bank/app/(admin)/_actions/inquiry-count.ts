"use server";

import { getSession } from "@/lib/auth";
import { db, inquiriesTable } from "@workspace/db";
import { eq, and, count, isNull } from "drizzle-orm";

/**
 * Returns the number of NEW (unhandled, non-archived) inquiries for the
 * caller's tenant.  Called by the real-time InquiryBadge client component.
 */
export async function getNewInquiryCount(): Promise<number> {
  const session = await getSession();
  if (!session.userId) return 0;

  const [row] = await db
    .select({ count: count() })
    .from(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.tenantId, session.tenantId),
        eq(inquiriesTable.status, "NEW"),
        isNull(inquiriesTable.archivedAt),
      ),
    );

  return row?.count ?? 0;
}
