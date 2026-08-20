// @vitest-environment happy-dom
/**
 * Browser-level bulk-status regression — real DB + server action.
 *
 * An admin can leave the inquiries page open while another session deletes one
 * of the selected inquiries. The browser must submit its original selection,
 * the real server action must update the surviving inquiry, and the refreshed
 * list must show the partial-success notice rather than misleading the admin.
 */
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  artworksTable,
  db,
  inquiriesTable,
  tenantsTable,
} from "@workspace/db";

const mockSession = {
  userId: "bulk-live-browser-user",
  tenantId: "PLACEHOLDER",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import {
  BulkActionBar,
  BulkSelectionProvider,
  SelectInquiryCheckbox,
} from "@/app/(admin)/(gated)/inquiries/bulk-select";

type VisibleInquiry = {
  id: string;
  buyerName: string;
  status: "NEW" | "HANDLED";
};

function LiveInquiryList({
  initialRows,
  onRefreshReady,
}: {
  initialRows: VisibleInquiry[];
  onRefreshReady: (refresh: (rows: VisibleInquiry[]) => void) => void;
}) {
  const [rows, setRows] = React.useState(initialRows);

  React.useEffect(() => {
    onRefreshReady(setRows);
  }, [onRefreshReady]);

  return React.createElement(
    BulkSelectionProvider,
    null,
    React.createElement(
      "div",
      { "data-testid": "visible-inquiries" },
      rows.map((row) =>
        React.createElement(
          "div",
          { key: row.id, "data-testid": `inquiry-${row.id}` },
          React.createElement(SelectInquiryCheckbox, { id: row.id }),
          React.createElement("span", null, row.buyerName),
          React.createElement(
            "span",
            null,
            row.status === "HANDLED" ? "Handled" : "New",
          ),
        ),
      ),
    ),
    React.createElement(BulkActionBar, {
      pageIds: rows.map((row) => row.id),
      mode: "archive",
    }),
  );
}

type VisibleArchiveInquiry = {
  id: string;
  buyerName: string;
  archived: boolean;
};

function LiveArchiveInquiryList({
  initialRows,
  onRefreshReady,
}: {
  initialRows: VisibleArchiveInquiry[];
  onRefreshReady: (refresh: (rows: VisibleArchiveInquiry[]) => void) => void;
}) {
  const [rows, setRows] = React.useState(initialRows);

  React.useEffect(() => {
    onRefreshReady(setRows);
  }, [onRefreshReady]);

  const visibleRows = rows.filter((row) => !row.archived);

  return React.createElement(
    BulkSelectionProvider,
    null,
    React.createElement(
      "div",
      { "data-testid": "visible-inquiries" },
      visibleRows.map((row) =>
        React.createElement(
          "div",
          { key: row.id, "data-testid": `inquiry-${row.id}` },
          React.createElement(SelectInquiryCheckbox, { id: row.id }),
          React.createElement("span", null, row.buyerName),
        ),
      ),
    ),
    React.createElement(BulkActionBar, {
      pageIds: visibleRows.map((row) => row.id),
      mode: "archive",
    }),
  );
}

const RUN = Date.now();
let sequence = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-live-bulk-${RUN}-${++sequence}`;
}

async function createFixture() {
  const tenantId = uid();
  const artworkId = uid();
  const survivingInquiryId = uid();
  const deletedInquiryId = uid();

  await db.insert(tenantsTable).values({
    id: tenantId,
    slug: tenantId,
    businessName: "Live Bulk Test Gallery",
    type: "ARTIST",
    billingExempt: true,
  } as any);
  createdTenantIds.push(tenantId);

  await db.insert(artworksTable).values({
    id: artworkId,
    tenantId,
    title: "Live Bulk Test Artwork",
    sku: `live-bulk-${artworkId}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(artworkId);

  await db.insert(inquiriesTable).values([
    {
      id: survivingInquiryId,
      tenantId,
      artworkId,
      artworkTitle: "Live Bulk Test Artwork",
      buyerName: "Still available",
      buyerEmail: "available@example.test",
      message: "Please keep this inquiry.",
      status: "NEW",
    },
    {
      id: deletedInquiryId,
      tenantId,
      artworkId,
      artworkTitle: "Live Bulk Test Artwork",
      buyerName: "Deleted elsewhere",
      buyerEmail: "deleted@example.test",
      message: "This inquiry is deleted by another session.",
      status: "NEW",
    },
  ] as any);
  createdInquiryIds.push(survivingInquiryId, deletedInquiryId);

  mockSession.tenantId = tenantId;
  return { tenantId, survivingInquiryId, deletedInquiryId };
}

async function readVisibleInquiries(tenantId: string): Promise<VisibleInquiry[]> {
  return db
    .select({
      id: inquiriesTable.id,
      buyerName: inquiriesTable.buyerName,
      status: inquiriesTable.status,
    })
    .from(inquiriesTable)
    .where(eq(inquiriesTable.tenantId, tenantId))
    .then((rows) => rows as VisibleInquiry[]);
}

async function readVisibleArchiveInquiries(
  tenantId: string,
): Promise<VisibleArchiveInquiry[]> {
  return db
    .select({
      id: inquiriesTable.id,
      buyerName: inquiriesTable.buyerName,
      archivedAt: inquiriesTable.archivedAt,
    })
    .from(inquiriesTable)
    .where(eq(inquiriesTable.tenantId, tenantId))
    .then((rows) =>
      rows.map((row) => ({
        id: row.id,
        buyerName: row.buyerName,
        archived: row.archivedAt !== null,
      })),
    );
}

async function cleanupDatabase() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  mockSession.tenantId = "PLACEHOLDER";
}

afterEach(async () => {
  cleanup();
  await cleanupDatabase();
});
afterAll(cleanupDatabase);

describeIntegration(
  "Bulk status update after a selected inquiry is deleted elsewhere",
  () => {
    it(
      "updates the surviving inquiry and reports the deleted selection after the list refreshes",
      async () => {
        const { tenantId, survivingInquiryId, deletedInquiryId } =
          await createFixture();
        const initialRows = await readVisibleInquiries(tenantId);
        let refreshVisibleRows: ((rows: VisibleInquiry[]) => void) | undefined;

        render(
          React.createElement(LiveInquiryList, {
            initialRows,
            onRefreshReady: (refresh) => {
              refreshVisibleRows = refresh;
            },
          }),
        );

        // The browser selects both rows while they are still visible.
        const checkboxes = screen.getAllByRole("checkbox", {
          name: /Select inquiry/i,
        });
        fireEvent.click(checkboxes[0]!);
        fireEvent.click(checkboxes[1]!);
        expect(
          screen.getByRole("button", { name: /Mark selected as handled \(2\)/i }),
        ).toBeTruthy();

        // A separate database/session step removes one inquiry after selection
        // but before this browser submits the bulk server action.
        await db
          .delete(inquiriesTable)
          .where(
            and(
              eq(inquiriesTable.id, deletedInquiryId),
              eq(inquiriesTable.tenantId, tenantId),
            ),
          );

        fireEvent.click(
          screen.getByRole("button", { name: /Mark selected as handled \(2\)/i }),
        );

        // The real server action sees the stale ID, updates only the survivor,
        // and returns the counts consumed by the browser action bar.
        await waitFor(() => {
          const notice = screen.getByRole("status");
          expect(notice.textContent).toMatch(
            /1 selected inquiry was updated\. 1 selected inquiry was unavailable or outside this gallery and was skipped\. Refresh the list to see the latest inquiries\./i,
          );
        });

        const [survivingInquiry, deletedInquiry] = await Promise.all([
          db.query.inquiriesTable.findFirst({
            where: eq(inquiriesTable.id, survivingInquiryId),
          }),
          db.query.inquiriesTable.findFirst({
            where: eq(inquiriesTable.id, deletedInquiryId),
          }),
        ]);
        expect(survivingInquiry?.status).toBe("HANDLED");
        expect(deletedInquiry).toBeUndefined();

        // Model Next's revalidated server-component response using fresh DB
        // rows. The stale row disappears while the survivor's new status remains.
        const refreshedRows = await readVisibleInquiries(tenantId);
        expect(refreshVisibleRows).toBeDefined();
        await act(async () => {
          refreshVisibleRows!(refreshedRows);
        });

        await waitFor(() => {
          expect(
            screen.getByTestId(`inquiry-${survivingInquiryId}`).textContent,
          ).toContain("Handled");
          expect(screen.queryByTestId(`inquiry-${deletedInquiryId}`)).toBeNull();
          expect(
            (screen.getByRole("checkbox", {
              name: /Select inquiry/i,
            }) as HTMLInputElement).checked,
          ).toBe(false);
        });
      },
    );

    it(
      "archives the surviving inquiry and reports a deleted selection after the list refreshes",
      async () => {
        const { tenantId, survivingInquiryId, deletedInquiryId } =
          await createFixture();
        const initialRows = await readVisibleArchiveInquiries(tenantId);
        let refreshVisibleRows:
          | ((rows: VisibleArchiveInquiry[]) => void)
          | undefined;

        render(
          React.createElement(LiveArchiveInquiryList, {
            initialRows,
            onRefreshReady: (refresh) => {
              refreshVisibleRows = refresh;
            },
          }),
        );

        const checkboxes = screen.getAllByRole("checkbox", {
          name: /Select inquiry/i,
        });
        fireEvent.click(checkboxes[0]!);
        fireEvent.click(checkboxes[1]!);
        expect(
          screen.getByRole("button", { name: /Archive selected \(2\)/i }),
        ).toBeTruthy();

        await db
          .delete(inquiriesTable)
          .where(
            and(
              eq(inquiriesTable.id, deletedInquiryId),
              eq(inquiriesTable.tenantId, tenantId),
            ),
          );

        fireEvent.click(
          screen.getByRole("button", { name: /Archive selected \(2\)/i }),
        );

        await waitFor(() => {
          expect(screen.getByRole("status").textContent).toMatch(
            /1 selected inquiry was updated\. 1 selected inquiry was unavailable or outside this gallery and was skipped\. Refresh the list to see the latest inquiries\./i,
          );
        });

        const [survivingInquiry, deletedInquiry] = await Promise.all([
          db.query.inquiriesTable.findFirst({
            where: eq(inquiriesTable.id, survivingInquiryId),
          }),
          db.query.inquiriesTable.findFirst({
            where: eq(inquiriesTable.id, deletedInquiryId),
          }),
        ]);
        expect(survivingInquiry?.archivedAt).toBeInstanceOf(Date);
        expect(deletedInquiry).toBeUndefined();

        const refreshedRows = await readVisibleArchiveInquiries(tenantId);
        expect(refreshVisibleRows).toBeDefined();
        await act(async () => {
          refreshVisibleRows!(refreshedRows);
        });

        await waitFor(() => {
          expect(
            screen.queryByTestId(`inquiry-${survivingInquiryId}`),
          ).toBeNull();
          expect(screen.queryByTestId(`inquiry-${deletedInquiryId}`)).toBeNull();
          expect(
            screen.queryAllByRole("checkbox", {
              name: /Select inquiry/i,
            }),
          ).toHaveLength(0);
        });
      },
    );
  },
);