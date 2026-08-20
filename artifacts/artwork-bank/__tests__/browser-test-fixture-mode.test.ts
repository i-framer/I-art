import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleanupState = vi.hoisted(() => ({
  tenants: [] as Array<{ id: string; slug: string; createdAt: Date }>,
  deletedTables: [] as string[],
  deleteConditions: [] as unknown[],
  findMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ operator: "and", conditions }),
  eq: (column: string, value: unknown) => ({ operator: "eq", column, value }),
  like: (column: string, value: unknown) => ({
    operator: "like",
    column,
    value,
  }),
  lt: (column: string, value: unknown) => ({ operator: "lt", column, value }),
}));

vi.mock("@workspace/db", () => {
  const tables = {
    artworksTable: { __table: "artworks", tenantId: "artworks.tenantId" },
    inquiriesTable: { __table: "inquiries", tenantId: "inquiries.tenantId" },
    tenantsTable: {
      __table: "tenants",
      id: "tenants.id",
      slug: "tenants.slug",
      createdAt: "tenants.createdAt",
    },
    tenantUsersTable: {
      __table: "tenantUsers",
      tenantId: "tenantUsers.tenantId",
      userId: "tenantUsers.userId",
    },
    usersTable: { __table: "users", id: "users.id" },
  };

  return {
    ...tables,
    db: {
      query: {
        tenantsTable: {
          findMany: cleanupState.findMany,
        },
      },
      transaction: cleanupState.transaction,
    },
  };
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  cleanupState.tenants = [];
  cleanupState.deletedTables = [];
  cleanupState.deleteConditions = [];
  cleanupState.findMany.mockImplementation(async () => cleanupState.tenants);
  cleanupState.transaction.mockImplementation(async (callback) => {
    const tx = {
      delete: (table: { __table: string }) => ({
        where: async (condition: unknown) => {
          cleanupState.deletedTables.push(table.__table);
          cleanupState.deleteConditions.push(condition);
        },
      }),
    };
    return callback(tx);
  });
});

async function readEnabled() {
  const { isBrowserTestModeEnabled } =
    await import("@/lib/browser-test-fixture");
  return isBrowserTestModeEnabled();
}

async function readFixtureIdentity(
  runId: string,
  tenantId: string,
  userId: string,
) {
  const { isBrowserTestFixtureIdentity } =
    await import("@/lib/browser-test-fixture");
  return isBrowserTestFixtureIdentity({ runId, tenantId, userId });
}

async function cleanupAbandonedFixtures() {
  const { cleanupAbandonedBrowserTestFixtures } =
    await import("@/lib/browser-test-fixture");
  return cleanupAbandonedBrowserTestFixtures();
}

async function runCleanupCommand() {
  const { main } = await import("../scripts/cleanup-browser-test-fixtures");
  return main();
}

function enableBrowserTestMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BROWSER_TEST_MODE", "enabled");
  vi.stubEnv("DATABASE_URL", "postgresql://test.example/browser-test");
  vi.stubEnv(
    "BROWSER_TEST_DATABASE_URL",
    "postgresql://test.example/browser-test",
  );
}

describe("browser test fixture mode", () => {
  it("requires the explicit local opt-in", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BROWSER_TEST_MODE", "");
    vi.stubEnv("DATABASE_URL", "postgresql://test.example/browser-test");
    vi.stubEnv(
      "BROWSER_TEST_DATABASE_URL",
      "postgresql://test.example/browser-test",
    );

    expect(await readEnabled()).toBe(false);
  });

  it("enables the fixture only with the expected development flag and explicit test database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BROWSER_TEST_MODE", "enabled");
    vi.stubEnv("DATABASE_URL", "postgresql://test.example/browser-test");
    vi.stubEnv(
      "BROWSER_TEST_DATABASE_URL",
      "postgresql://test.example/browser-test",
    );

    expect(await readEnabled()).toBe(true);
  });

  it("refuses an enabled flag when the runtime database was not explicitly designated", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BROWSER_TEST_MODE", "enabled");
    vi.stubEnv("DATABASE_URL", "postgresql://production.example/artwork-bank");
    vi.stubEnv(
      "BROWSER_TEST_DATABASE_URL",
      "postgresql://test.example/browser-test",
    );

    expect(await readEnabled()).toBe(false);
  });

  it("always refuses the fixture in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BROWSER_TEST_MODE", "enabled");
    vi.stubEnv("DATABASE_URL", "postgresql://test.example/browser-test");
    vi.stubEnv(
      "BROWSER_TEST_DATABASE_URL",
      "postgresql://test.example/browser-test",
    );

    expect(await readEnabled()).toBe(false);
  });

  it("refuses the on-demand cleanup command in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BROWSER_TEST_MODE", "enabled");
    vi.stubEnv("DATABASE_URL", "postgresql://test.example/browser-test");
    vi.stubEnv(
      "BROWSER_TEST_DATABASE_URL",
      "postgresql://test.example/browser-test",
    );

    await expect(runCleanupCommand()).rejects.toThrow(
      "Browser test mode requires an explicit matching BROWSER_TEST_DATABASE_URL.",
    );
    expect(cleanupState.findMany).not.toHaveBeenCalled();
  });

  it("refuses the on-demand cleanup command for an undesignated database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BROWSER_TEST_MODE", "enabled");
    vi.stubEnv("DATABASE_URL", "postgresql://production.example/artwork-bank");
    vi.stubEnv(
      "BROWSER_TEST_DATABASE_URL",
      "postgresql://test.example/browser-test",
    );

    await expect(runCleanupCommand()).rejects.toThrow(
      "Browser test mode requires an explicit matching BROWSER_TEST_DATABASE_URL.",
    );
    expect(cleanupState.findMany).not.toHaveBeenCalled();
  });

  it("accepts cleanup only for the exact fixture IDs generated by its run", async () => {
    const runId = "run-a";

    expect(
      await readFixtureIdentity(
        runId,
        `browser-test-tenant-${runId}`,
        `browser-test-user-${runId}`,
      ),
    ).toBe(true);
    expect(
      await readFixtureIdentity(
        runId,
        "browser-test-tenant-run-b",
        `browser-test-user-${runId}`,
      ),
    ).toBe(false);
  });

  it("removes an interrupted old fixture without touching fresh or lookalike tenants", async () => {
    enableBrowserTestMode();
    const staleRunId = "7b9c83e9-5777-4f4b-8d25-28a2e88a0e0b";
    const freshRunId = "e942bca4-542b-4ab1-8e02-30d7dd3aa5e0";
    const now = Date.now();

    cleanupState.tenants = [
      {
        id: `browser-test-tenant-${staleRunId}`,
        slug: `browser-test-${staleRunId}`,
        createdAt: new Date(now - 25 * 60 * 60 * 1000),
      },
      {
        id: `browser-test-tenant-${freshRunId}`,
        slug: `browser-test-${freshRunId}`,
        createdAt: new Date(now - 5 * 60 * 1000),
      },
      {
        id: "browser-test-tenant-not-a-generated-run-id",
        slug: "browser-test-not-a-generated-run-id",
        createdAt: new Date(now - 25 * 60 * 60 * 1000),
      },
      {
        id: `browser-test-tenant-${staleRunId}`,
        slug: "ordinary-gallery",
        createdAt: new Date(now - 25 * 60 * 60 * 1000),
      },
    ];

    await expect(cleanupAbandonedFixtures()).resolves.toBe(1);
    expect(cleanupState.deletedTables).toEqual([
      "inquiries",
      "artworks",
      "tenantUsers",
      "users",
      "tenants",
    ]);
    expect(cleanupState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          operator: "and",
          conditions: [
            {
              operator: "like",
              column: "tenants.id",
              value: "browser-test-tenant-%",
            },
            expect.objectContaining({
              operator: "lt",
              column: "tenants.createdAt",
            }),
          ],
        },
      }),
    );
    expect(cleanupState.deleteConditions).toContainEqual({
      operator: "eq",
      column: "tenants.id",
      value: `browser-test-tenant-${staleRunId}`,
    });
    expect(cleanupState.deleteConditions).toContainEqual({
      operator: "eq",
      column: "users.id",
      value: `browser-test-user-${staleRunId}`,
    });
  });

  it("reports the number of stale fixtures removed by the on-demand command", async () => {
    enableBrowserTestMode();
    const staleRunId = "7b9c83e9-5777-4f4b-8d25-28a2e88a0e0b";
    cleanupState.tenants = [
      {
        id: `browser-test-tenant-${staleRunId}`,
        slug: `browser-test-${staleRunId}`,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCleanupCommand();

    expect(log).toHaveBeenCalledWith(
      "Removed 1 stale browser-test fixture.",
    );
  });
});