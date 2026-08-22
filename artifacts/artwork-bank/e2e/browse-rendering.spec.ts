import { expect, test } from "@playwright/test";

test("renders the public browse page without client/server rendering errors", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const response = await page.goto("/browse?q=art", {
    waitUntil: "networkidle",
  });
  expect(response).not.toBeNull();
  expect(response?.ok()).toBeTruthy();

  await expect(
    page.getByRole("heading", { name: "Browse artwork" }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Search title or artist…")).toHaveValue(
    "art",
  );
  await expect(
    page.getByRole("combobox", { name: "Seller type" }),
  ).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});