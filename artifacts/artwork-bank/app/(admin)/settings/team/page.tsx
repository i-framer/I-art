import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { tenantUsersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import TeamPageClient from "./_client";

export const metadata: Metadata = { title: "Team — Settings" };

export default async function TeamPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  // Get all team members with their emails
  const memberships = await db.query.tenantUsersTable.findMany({
    where: eq(tenantUsersTable.tenantId, session.tenantId),
  });

  // Load user details for each member
  const memberDetails = await Promise.all(
    memberships.map(async (m) => {
      const user = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, m.userId),
      });
      return {
        userId: m.userId,
        role: m.role,
        email: user?.email ?? m.userId,
      };
    }),
  );

  return (
    <TeamPageClient
      members={memberDetails}
      currentUserId={session.userId}
      isOwner={session.role === "owner"}
    />
  );
}
