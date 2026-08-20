const runtimeDatabaseUrl = process.env.DATABASE_URL;
const browserTestDatabaseUrl = process.env.BROWSER_TEST_DATABASE_URL;

if (!runtimeDatabaseUrl || !browserTestDatabaseUrl) {
  console.error(
    "BROWSER_TEST_DATABASE_URL and DATABASE_URL are both required for browser tests.",
  );
  process.exit(1);
}

if (runtimeDatabaseUrl !== browserTestDatabaseUrl) {
  console.error(
    "BROWSER_TEST_DATABASE_URL must match DATABASE_URL so the browser server and test process use the explicitly designated test database.",
  );
  process.exit(1);
}

console.log("✓ Explicit browser-test database confirmed.");