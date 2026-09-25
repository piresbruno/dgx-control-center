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

test("Settings page registers a node and lists it (ADR-0009 onboarding)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("registry-row-dgx1")).toBeVisible(); // fake fleet seeds

  await page.getByTestId("node-id").fill("dgxe2e");
  await page.getByTestId("node-name").fill("dgx-e2e");
  await page.getByTestId("node-kind").selectOption("spark");
  await page.getByTestId("node-role").selectOption("worker");
  await page.getByTestId("node-lanip").fill("10.0.99.99");
  await page.getByTestId("node-sshuser").fill("piresbruno");
  await page.getByTestId("node-add").click();

  await expect(page.getByTestId("nodes-message")).toContainText("Node 'dgxe2e' registered");
  await expect(page.getByTestId("registry-row-dgxe2e")).toContainText("10.0.99.99");

  // Registered node is immediately known to the hub and visible via the API.
  const nodes = await page.request.get("http://127.0.0.1:5599/api/nodes");
  const ids = (await nodes.json()).nodes.map((n: { id: string }) => n.id);
  expect(ids).toContain("dgxe2e");
});
