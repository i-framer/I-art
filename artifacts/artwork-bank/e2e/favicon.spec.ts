import { expect, test, type Page } from "@playwright/test";
import {
  cleanupBrowserTestFixture,
  createBrowserTestFixture,
  type BrowserTestFixture,
} from "@/lib/browser-test-fixture";

let fixture: BrowserTestFixture | undefined;

async function expectWorkingFavicon(page: Page, pathname: string) {
  const faviconFailures: string[] = [];

  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/favicon.ico") {
      faviconFailures.push(
        `${request.url()} — ${request.failure()?.errorText ?? "request failed"}`,
      );
    }
  });
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/favicon.ico" &&
      !response.ok()
    ) {
      faviconFailures.push(`${response.url()} — HTTP ${response.status()}`);
    }
  });

  const pageResponse = await page.goto(pathname, { waitUntil: "networkidle" });
  expect(pageResponse).not.toBeNull();
  expect(pageResponse?.ok()).toBeTruthy();

  const iconHref = await page
    .locator('link[rel~="icon"]')
    .first()
    .getAttribute("href");
  expect(iconHref).toBeTruthy();

  const iconResponse = await page.request.get(
    new URL(iconHref!, page.url()).toString(),
  );
  expect(iconResponse.status()).toBe(200);
  expect(iconResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(faviconFailures).toEqual([]);
}

test.beforeAll(async () => {
  fixture = await createBrowserTestFixture();
});

test.afterAll(async () => {
  if (fixture) {
    await cleanupBrowserTestFixture(fixture);
    fixture = undefined;
  }
});

test("serves the browser icon on the root entry point", async ({ page }) => {
  await expectWorkingFavicon(page, "/");
});

test("serves the browser icon on the browse entry point", async ({ page }) => {
  await expectWorkingFavicon(page, "/browse");
});

test("serves the browser icon on a tenant storefront entry point", async ({
  page,
}) => {
  expect(fixture).toBeDefined();
  await expectWorkingFavicon(page, `/t/browser-test-${fixture!.runId}`);
});
