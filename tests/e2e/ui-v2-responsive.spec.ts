import { expect, test, type Page } from "@playwright/test";

const responsiveMatrix = [
  { height: 844, name: "portrait-384", width: 384 },
  { height: 844, name: "portrait-390", width: 390 },
  { height: 390, name: "landscape-844", width: 844 },
  { height: 1024, name: "tablet-768", width: 768 },
  { height: 768, name: "compact-1023", width: 1023 },
  { height: 768, name: "desktop-1024", width: 1024 },
  { height: 800, name: "desktop-1280", width: 1280 },
  { height: 800, name: "desktop-1281", width: 1281 },
  { height: 900, name: "wide-1440", width: 1440 }
] as const;

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }))).toMatchObject({
    body: expect.any(Number),
    document: expect.any(Number),
    viewport: expect.any(Number)
  });
  expect(await page.evaluate(() =>
    document.body.scrollWidth <= window.innerWidth &&
    document.documentElement.scrollWidth <= window.innerWidth
  )).toBe(true);
}

async function expectInsideViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

for (const theme of ["dark", "light"] as const) {
  for (const viewport of responsiveMatrix) {
    test(`v2 responsive composition · ${theme} · ${viewport.name}`, async ({ context, page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await context.addCookies([{
        name: "aiqsa.theme",
        value: theme,
        url: "http://127.0.0.1:3000"
      }]);
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await page.goto("/ui-v2-fixture?fixture=composer&state=model");

      await expect(page.getByTestId("ui-v2-composer-gallery")).toBeVisible();
      await expect(page.locator(".v2-workspace-shell")).toHaveAttribute(
        "data-sidebar-composition",
        viewport.width < 900 ? "mobile" : viewport.width < 1024 ? "compact" : "desktop"
      );
      const navigation = page.getByRole("complementary", { name: "Навигация по чатам" });
      const opener = page.getByRole("button", { name: "Открыть панель" });
      if (viewport.width < 1024) {
        await expect(navigation).toBeHidden();
        await expect(opener).toBeVisible();
      } else {
        await expect(navigation).toBeVisible();
        await expect(page.locator(".v2-sidebar-floats")).toHaveCSS("opacity", "0");
        await expect(page.locator(".v2-sidebar-floats")).toHaveCSS("pointer-events", "none");
      }

      const modelLayer = page.getByRole("dialog", { name: "Выбор модели" });
      await expect(modelLayer).toBeVisible();
      const layerBox = await modelLayer.boundingBox();
      expect(layerBox).not.toBeNull();
      if (viewport.width < 900 || viewport.height <= 512) {
        expect(layerBox!.x).toBe(0);
        expect(layerBox!.width).toBe(viewport.width);
      } else {
        expect(layerBox!.width).toBeLessThanOrEqual(385);
      }
      await expectInsideViewport(page, "[data-testid='composer-v2']");
      await expectNoPageOverflow(page);
      expect(pageErrors).toEqual([]);
      await expect(page).toHaveScreenshot(`responsive-${viewport.name}-${theme}.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true
      });
    });
  }
}

test("v2 drawers become full-screen below 900px and stay temporary above it", async ({ page }) => {
  for (const viewport of [
    { height: 390, width: 844 },
    { height: 768, width: 899 },
    { height: 768, width: 900 },
    { height: 800, width: 1281 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/ui-v2-fixture?fixture=run-details&state=complete");
    const runDetails = page.getByRole("dialog", { name: /Детали run/ });
    await expect(runDetails).toBeVisible();
    const runBox = await runDetails.boundingBox();
    expect(runBox).not.toBeNull();
    if (viewport.width < 900) expect(runBox!.width).toBe(viewport.width);
    else expect(runBox!.width).toBeLessThanOrEqual(441);
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ height: 390, width: 844 });
  for (const destination of [
    "/ui-v2-fixture?fixture=branches&state=drawer",
    "/ui-v2-fixture?fixture=artifacts&state=drawer"
  ]) {
    await page.goto(destination);
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())?.width).toBe(844);
    await expectNoPageOverflow(page);
  }
});

test("v2 sidebar transfers focus across desktop, compact, and mobile composition", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1281 });
  await page.goto("/ui-v2-fixture?fixture=navigation");
  const source = page.getByRole("button", { name: "Quarterly product brief", exact: true });
  await source.focus();

  await page.setViewportSize({ height: 390, width: 844 });
  const opener = page.getByRole("button", { name: "Открыть панель" });
  await expect(page.locator(".v2-workspace-shell"))
    .toHaveAttribute("data-sidebar-composition", "mobile");
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole("button", { name: "Закрыть панель" })).toBeFocused();

  await page.setViewportSize({ height: 768, width: 1023 });
  await expect(page.locator(".v2-workspace-shell"))
    .toHaveAttribute("data-sidebar-composition", "compact");
  await expect(opener).toBeFocused();

  await page.setViewportSize({ height: 800, width: 1281 });
  await expect(source).toBeFocused();
});

test("v2 sidebar leaves Ctrl/Cmd+K to the single shell command-palette owner", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=navigation");
  const opener = page.getByRole("button", { name: "Открыть панель" });
  await opener.click();
  const drawer = page.getByRole("complementary", { name: "Навигация по чатам" });
  await expect(drawer).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});

test("v2 composer preserves its draft above a reduced mobile content viewport", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=composer&state=default");
  const input = page.getByRole("textbox", { name: "Сообщение" });
  const draft = Array.from({ length: 24 }, (_, index) => `Строка ${index + 1}`).join("\n");
  await input.fill(draft);

  await page.setViewportSize({ height: 420, width: 390 });
  await expect(input).toHaveValue(draft);
  const inputBox = await input.boundingBox();
  const dockBox = await page.locator(".v2-composer-gallery-dock").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  expect(inputBox!.height).toBeLessThanOrEqual(169);
  expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(421);

  const scroller = page.getByTestId("conversation-scroll");
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const lastAnswer = page.getByRole("article", { name: "Answer" }).last();
  const answerBox = await lastAnswer.boundingBox();
  expect(answerBox).not.toBeNull();
  expect(answerBox!.y + answerBox!.height).toBeLessThanOrEqual(dockBox!.y + 1);
  await expectNoPageOverflow(page);
});

for (const theme of ["dark", "light"] as const) {
  test(`v2 enlarged text keeps the ${theme} mobile sheet and composer contained`, async ({ context, page }) => {
    await context.addCookies([{
      name: "aiqsa.theme",
      value: theme,
      url: "http://127.0.0.1:3000"
    }]);
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/ui-v2-fixture?fixture=composer&state=capabilities");
    await page.addStyleTag({ content: "html { font-size: 20px !important; }" });
    const sheet = page.getByRole("menu", { name: "Возможности запроса" });
    await expect(sheet).toBeVisible();
    await expectInsideViewport(page, "[role='menu'][aria-label='Возможности запроса']");
    await expectInsideViewport(page, "[data-testid='composer-v2']");
    await expectNoPageOverflow(page);
    await expect(page).toHaveScreenshot(`responsive-enlarged-text-${theme}-mobile.png`, {
      animations: "disabled",
      caret: "hide"
    });
  });
}

test.describe("v2 coarse-pointer controls", () => {
  test.use({ hasTouch: true });

  test("keeps navigation, composer, and touch-opened message actions at least 40px", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/ui-v2-fixture?fixture=composer&state=default");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const button of await page.locator("[data-testid='composer-v2'] button:visible").all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }

    await page.goto("/ui-v2-fixture?fixture=conversation&state=basic");
    const answer = page.getByRole("article", { name: "Answer" }).first();
    await answer.tap();
    const actions = answer.getByRole("toolbar", { name: "Answer actions" });
    await expect(actions).toBeVisible();
    for (const button of await actions.getByRole("button").all()) {
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }

    await page.goto("/ui-v2-fixture?fixture=navigation");
    await page.getByRole("button", { name: "Открыть панель" }).tap();
    const navigation = page.getByRole("complementary", { name: "Навигация по чатам" });
    for (const button of await navigation.getByRole("button").all()) {
      if (!await button.isVisible()) continue;
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }
  });
});
