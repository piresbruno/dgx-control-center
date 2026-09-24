import { expect, test } from "@playwright/test";

test("health + fake fleet is up", async ({ request }) => {
  const health = await request.get("http://127.0.0.1:5599/api/health");
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).name).toBe("controlcenter");
  const nodes = await request.get("http://127.0.0.1:5599/api/nodes");
  const ids = (await nodes.json()).nodes.map((n: { id: string }) => n.id);
  expect(ids).toEqual(expect.arrayContaining(["dgx1", "dgx2", "nas1"]));
});

test("Overview renders the fake fleet node cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  // Fake fleet nodes appear on the Overview page.
  await expect(page.getByText("dgx1").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("dgx2").first()).toBeVisible();
});

test("Alerts page shows seeded rules and the rules table", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-alerts").click();
  await expect(page.getByTestId("rules-table")).toBeVisible();
  await expect(page.getByTestId("rule-seed-node-down")).toBeVisible(); // seeded rule
});

test("Energy page renders rollup tables", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-energy").click();
  await expect(page.getByTestId("energy-nodes")).toBeVisible();
});

test("Settings page exposes retention and backups", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("backups-table")).toBeVisible();
  await expect(page.getByText("Trace retention")).toBeVisible();
});
