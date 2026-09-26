import { expect, test } from "@playwright/test";

/**
 * Phone-width contract: the off-canvas sidebar must actually be operable
 * (the base `.menu-btn { display: none }` once sat AFTER the media override,
 * killing navigation on phones with zero desktop-visible symptom), and no
 * page may overflow horizontally at 360px (segmented strips, dense heads,
 * and unwrapped 620px-min tables were the culprits).
 */
test.use({ viewport: { width: 360, height: 780 } });

test("mobile: hamburger reveals the drawer and navigation works", async ({ page }) => {
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toBeVisible();
  // Closed drawer sits off-canvas (translateX), so check viewport overlap.
  const energyLink = page.getByTestId("nav-energy");
  await expect(energyLink).not.toBeInViewport();

  await menu.click();
  await expect(energyLink).toBeInViewport();
  await energyLink.click();
  await expect(page.getByTestId("energy-nodes")).toBeVisible();
  // selecting a page closes the drawer again
  await expect(energyLink).not.toBeInViewport();
});

test("mobile: no horizontal page overflow on dense pages", async ({ page }) => {
  await page.goto("/");
  for (const [nav, marker] of [
    ["nav-energy", "energy-nodes"],
    ["nav-alerts", "rules-table"],
    ["nav-settings", "backups-table"],
    ["nav-fleet", "fleet-chart-dgx1"],
  ] as const) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByTestId(nav).click();
    await expect(page.getByTestId(marker)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${nav} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});
