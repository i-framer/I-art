import { pgTable, text, primaryKey } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenant";
import { usersTable } from "./user";

export const tenantRoleValues = ["owner", "staff"] as const;
export type TenantRole = (typeof tenantRoleValues)[number];

export const tenantUsersTable = pgTable(
  "tenant_user",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export type TenantUser = typeof tenantUsersTable.$inferSelect;
