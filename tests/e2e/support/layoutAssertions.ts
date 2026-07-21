import { expect, type Locator, type Page } from "@playwright/test";

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        body: document.body.scrollWidth <= document.body.clientWidth,
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
      }))
    )
    .toEqual({ body: true, document: true });
}

export async function expectWithinViewport(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const [box, viewport] = await Promise.all([locator.boundingBox(), page.viewportSize()]);

  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

export async function expectTouchSafe(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const [box, label] = await Promise.all([
    locator.boundingBox(),
    locator.getAttribute("aria-label").then((value) => value ?? "touch target")
  ]);
  expect(box).toBeTruthy();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(43);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(43);
}

export async function expectCenterUnobscured(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return topmost === element || element.contains(topmost);
      })
    )
    .toBe(true);
}

export const expectTouchTarget = expectTouchSafe;
