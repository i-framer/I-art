import { expect, test, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import {
  artworksTable,
  db,
  inquiriesTable,
  tenantsTable,
  tenantUsersTable,
  usersTable,
} from "@workspace/db";
import {
  cleanupBrowserTestFixture,
  type BrowserTestFixture,
} from "@/lib/browser-test-fixture";

type ActiveFixture = Pick<
  BrowserTestFixture,
  "runId" | "tenantId" | "userId"
>;

let activeFixture: ActiveFixture | undefined;

async function startBrowserTestSession(page: Page) {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "Start isolated browser test session" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start isolated browser test session" })
    .click();
  await expect(page).toHaveURL(/\/inquiries$/);

  const staleBuyerName = await page
    .getByText(/^Browser test stale inquiry /)
    .textContent();
  const survivingBuyerName = await page
    .getByText(/^Browser test inquiry to keep /)
    .textContent();
  expect(staleBuyerName).toBeTruthy();
  expect(survivingBuyerName).toBeTruthy();

  const staleInquiry = await db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.buyerName, staleBuyerName!),
    columns: {
      id: true,
      tenantId: true,
      artworkId: true,
    },
  });
  expect(staleInquiry).toBeDefined();
  if (!staleInquiry) throw new Error("Browser-test stale inquiry was not found.");

  const fixtureUser = await db.query.tenantUsersTable.findFirst({
    where: eq(tenantUsersTable.tenantId, staleInquiry.tenantId),
    columns: { userId: true },
  });
  expect(fixtureUser).toBeDefined();
  if (!fixtureUser) throw new Error("Browser-test fixture owner was not found.");

  const runId = staleInquiry.tenantId.replace("browser-test-tenant-", "");
  activeFixture = {
    runId,
    tenantId: staleInquiry.tenantId,
    userId: fixtureUser.userId,
  };

  return {
    staleBuyerName: staleBuyerName!,
    survivingBuyerName: survivingBuyerName!,
    staleInquiry,
  };
}

test.afterEach(async () => {
  if (!activeFixture) return;

  // If the UI assertion fails before sign-out, remove only the signed fixture
  // so the shared development database remains clean for the next run.
  await cleanupBrowserTestFixture(activeFixture);
  activeFixture = undefined;
});

test("shows partial success when a selected inquiry becomes stale", async ({
  page,
}) => {
  const first = await startBrowserTestSession(page);

  // Repeating the test-login action must remove the first fixture before it
  // replaces the signed session with a new isolated gallery.
  await page.goto("/login");
  const second = await startBrowserTestSession(page);
  await expect
    .poll(async () =>
      db.query.tenantsTable.findFirst({
        where: eq(tenantsTable.id, first.staleInquiry.tenantId),
      }),
    )
    .toBeUndefined();

  const checkboxes = page.getByRole("checkbox", { name: "Select inquiry" });
  await expect(checkboxes).toHaveCount(2);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  const markHandled = page.getByRole("button", {
    name: "Mark selected as handled (2)",
  });
  await expect(markHandled).toBeEnabled();

  const deleted = await db
    .delete(inquiriesTable)
    .where(
      and(
        eq(inquiriesTable.id, second.staleInquiry.id),
        eq(inquiriesTable.tenantId, second.staleInquiry.tenantId),
      ),
    )
    .returning({ id: inquiriesTable.id });
  expect(deleted).toEqual([{ id: second.staleInquiry.id }]);

  await markHandled.click();
  await expect(page.getByRole("status")).toHaveText(
    "1 selected inquiry was updated. 1 selected inquiry was unavailable or outside this gallery and was skipped. Refresh the list to see the latest inquiries.",
  );

  await page.reload();
  const survivingInquiry = await db.query.inquiriesTable.findFirst({
    where: and(
      eq(inquiriesTable.tenantId, activeFixture!.tenantId),
      eq(inquiriesTable.buyerName, second.survivingBuyerName),
    ),
  });
  expect(survivingInquiry?.status).toBe("HANDLED");
  await expect(
    page.getByText(/^Browser test inquiry to keep /),
  ).toBeVisible();
  await expect(page.getByText(second.staleBuyerName)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mark selected as handled" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await expect
    .poll(async () => {
      const [tenant, member, user, artwork, inquiry] = await Promise.all([
        db.query.tenantsTable.findFirst({
          where: eq(tenantsTable.id, activeFixture!.tenantId),
        }),
        db.query.tenantUsersTable.findFirst({
          where: eq(tenantUsersTable.tenantId, activeFixture!.tenantId),
        }),
        db.query.usersTable.findFirst({
          where: eq(usersTable.id, activeFixture!.userId),
        }),
        db.query.artworksTable.findFirst({
          where: eq(artworksTable.tenantId, activeFixture!.tenantId),
        }),
        db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.tenantId, activeFixture!.tenantId),
        }),
      ]);
      return { tenant, member, user, artwork, inquiry };
    })
    .toEqual({
      tenant: undefined,
      member: undefined,
      user: undefined,
      artwork: undefined,
      inquiry: undefined,
    });

  activeFixture = undefined;
});