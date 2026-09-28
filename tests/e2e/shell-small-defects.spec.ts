import { expect, test, type Locator, type Page } from "@playwright/test";

// Shell small defects (task 20260928115819927), component fixtures only: the
// model row's "Set as default" star never covers the last capability glyph
// or the current check, on fine pointers and on touch, and a Skills chip
// with pinned Skills is not struck through while Auto is off.

type Box = Readonly<{ height: number; width: number; x: number; y: number }>;

const touchRule = "(hover: none), (pointer: coarse)";

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  return box!;
}

async function expectStarsClearOfGlyphs(page: Page, touch: boolean): Promise<void> {
  await page.goto("/ui-v2-fixture?fixture=composer&state=model");
  expect(await page.evaluate((rule) => matchMedia(rule).matches, touchRule)).toBe(touch);
  const layer = page.getByRole("dialog", { name: "Choose model" });
  await expect(layer).toBeVisible();
  // No row is hovered: the glyphs show at rest on both pointers.
  if (!touch) await page.mouse.move(0, 0);

  const rows = layer.locator(".v2-composer-model-row");
  const count = await rows.count();
  let checked = 0;
  let filledStarCentre: number | null = null;
  const outlineStarCentres: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const name = `row ${index} ${(await row.locator(".v2-composer-model-name").innerText()).trim()}`;
    const filled = row.locator(".v2-composer-model-star");
    if (await filled.count()) {
      const box = await boxOf(filled, `${name} default star`);
      filledStarCentre = box.x + box.width / 2;
    }
    const star = row.locator(".v2-composer-model-default");
    if (!(await star.count())) continue;
    const starBox = await boxOf(star, `${name} star`);
    const icon = await boxOf(star.locator(".v2-icon"), `${name} star glyph`);
    outlineStarCentres.push(icon.x + icon.width / 2);
    if (touch) expect(starBox.width, `${name} star is a 44px target`).toBeGreaterThanOrEqual(43.99);

    const glyphs = row.locator(".v2-composer-model-glyphs > .v2-icon");
    const glyphCount = await glyphs.count();
    if (glyphCount > 0) {
      await expect(row.locator(".v2-composer-model-glyphs")).toHaveCSS("visibility", "visible");
      const last = await boxOf(glyphs.nth(glyphCount - 1), `${name} last glyph`);
      expect(starBox.x, `${name}: the star starts after the last glyph`).toBeGreaterThanOrEqual(last.x + last.width - 0.5);
      checked += 1;
    }
    const check = row.locator(".v2-composer-model-check");
    if (await check.count()) {
      const checkBox = await boxOf(check, `${name} check`);
      expect(starBox.x + starBox.width, `${name}: the star ends before the check`).toBeLessThanOrEqual(checkBox.x + 0.5);
    }
  }
  expect(checked, "rows with a star and capability glyphs").toBeGreaterThan(0);
  // The outline star sits in the default star's column.
  if (filledStarCentre !== null) {
    for (const centre of outlineStarCentres) {
      expect(Math.abs(centre - filledStarCentre), "outline star column").toBeLessThanOrEqual(1);
    }
  }
}

test.describe("model row star · desktop 1440×900", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  test("the outline star keeps clear of the capability glyphs and the check · desktop 1440×900", async ({ page }) => {
    await expectStarsClearOfGlyphs(page, false);
  });
});

test.describe("model row star · phone portrait 390×844 touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });

  test("the 44px star keeps clear of the capability glyphs and the check · phone portrait 390×844", async ({ page }) => {
    await expectStarsClearOfGlyphs(page, true);
  });
});

test("a Skills chip with pinned Skills is not struck through while Auto is off", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/ui-v2-fixture?fixture=composer&state=chips-off-pinned");
  const chip = page.getByTestId("composer-v2").getByRole("button", { name: "Change Skills mode" });
  await expect(chip).toHaveAccessibleDescription("Skills: Auto off · 32 pinned (always loaded)");
  await expect(chip).not.toHaveAttribute("data-off");
  const label = chip.locator(".v2-composer-indicator-label");
  if (await label.count()) {
    expect(await label.evaluate((element) => getComputedStyle(element).textDecorationLine)).not.toContain("line-through");
  }
});
