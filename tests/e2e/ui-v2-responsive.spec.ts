import { expect, test, type Page } from "@playwright/test";

const responsiveMatrix = [
  { height: 844, name: "portrait-384", width: 384 },
  { height: 844, name: "portrait-390", width: 390 },
  { height: 390, name: "landscape-844", width: 844 },
  { height: 430, name: "landscape-932", width: 932 },
  { height: 1024, name: "tablet-768", width: 768 },
  { height: 1180, name: "compact-820", width: 820 },
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
        viewport.width < 768 ? "mobile" : viewport.width < 1024 ? "compact" : "desktop"
      );
      const navigation = page.getByRole("complementary", { name: "Chat navigation" });
      const opener = page.getByRole("button", { name: "Open sidebar" });
      const rail = page.getByTestId("workspace-rail");
      if (viewport.width < 768) await expect(rail).toHaveCount(0);
      else await expect(rail).toBeVisible();
      if (viewport.width < 1024) {
        await expect(navigation).toBeHidden();
        await expect(opener).toBeVisible();
      } else {
        await expect(navigation).toBeVisible();
        await expect(page.locator(".v2-sidebar-floats")).toHaveCSS("opacity", "0");
        await expect(page.locator(".v2-sidebar-floats")).toHaveCSS("pointer-events", "none");
      }

      const modelLayer = page.getByRole("dialog", { name: "Choose model" });
      await expect(modelLayer).toBeVisible();
      const layerBox = await modelLayer.boundingBox();
      expect(layerBox).not.toBeNull();
      if (viewport.width <= 840 || viewport.height <= 512) {
        expect(layerBox!.x).toBe(0);
        expect(layerBox!.width).toBe(viewport.width);
      } else {
        const triggerBox = await page.getByTestId("header-model-trigger").boundingBox();
        expect(triggerBox).not.toBeNull();
        expect(layerBox!.width).toBeLessThanOrEqual(385);
        expect(layerBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
      }
      expect(layerBox!.y).toBeGreaterThanOrEqual(-1);
      expect(layerBox!.y + layerBox!.height).toBeLessThanOrEqual(viewport.height + 1);

      const headerBox = await page.locator(".v2-composer-gallery-main > .v2-live-header").boundingBox();
      const conversationBox = await page.locator(".v2-composer-gallery-main > .v2-conversation").boundingBox();
      const dockBox = await page.locator(".v2-composer-gallery-main > .v2-composer-gallery-dock").boundingBox();
      expect(headerBox).not.toBeNull();
      expect(conversationBox).not.toBeNull();
      expect(dockBox).not.toBeNull();
      if (viewport.width >= 768) {
        expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(conversationBox!.y + 1);
      }
      expect(conversationBox!.y + conversationBox!.height).toBeLessThanOrEqual(dockBox!.y + 1);
      await expectInsideViewport(page, "[data-testid='composer-v2']");
      await expectNoPageOverflow(page);
      expect(pageErrors).toEqual([]);
    });
  }
}

test("v2 Branches become full-screen below 768px", async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 767 });
  await page.goto("/ui-v2-fixture?fixture=branches&state=drawer");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())?.width).toBe(767);
  await expectNoPageOverflow(page);
});

test("v2 sidebar transfers focus across desktop, compact, and mobile composition", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1281 });
  await page.goto("/ui-v2-fixture?fixture=navigation");
  const source = page.getByRole("treeitem", { name: "Quarterly product brief", exact: true });
  await source.focus();

  await page.setViewportSize({ height: 720, width: 767 });
  const opener = page.getByRole("button", { name: "Open sidebar" });
  await expect(page.locator(".v2-workspace-shell"))
    .toHaveAttribute("data-sidebar-composition", "mobile");
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole("button", { name: "Close sidebar" })).toBeFocused();

  await page.setViewportSize({ height: 390, width: 844 });
  await expect(page.locator(".v2-workspace-shell"))
    .toHaveAttribute("data-sidebar-composition", "compact");
  await expect(opener).toBeFocused();

  await page.setViewportSize({ height: 800, width: 1281 });
  await expect(source).toBeFocused();
});

test("v2 desktop chat tree uses one Tab stop and an anchored Shift+F10 menu", async ({ page }) => {
  await page.setViewportSize({ height: 560, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=navigation");
  const tree = page.getByRole("tree", { name: "Personal chats" });
  const selected = tree.getByRole("treeitem", { name: "Quarterly product brief" });
  await expect(selected).toHaveAttribute("tabindex", "0");

  await page.getByRole("searchbox", { name: "Filter chats" }).focus();
  await page.keyboard.press("Tab");
  await expect(selected).toBeFocused();
  await page.keyboard.press("End");
  await expect(tree.getByRole("treeitem", { name: "Source review notes" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(selected).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const folder = tree.getByRole("treeitem", { name: "Исследования" });
  await expect(folder).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const running = tree.getByRole("treeitem", { name: "Research plan for multilingual recall" });
  await expect(running).toBeFocused();

  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", {
    name: "Chat actions: Research plan for multilingual recall"
  });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("dialog", {
    name: "Chat actions: Research plan for multilingual recall sheet"
  })).toHaveCount(0);
  await expect(menu).toHaveAttribute("data-side", /^(bottom|top)$/u);
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await expectInsideViewport(
    page,
    '[role="menu"][aria-label="Chat actions: Research plan for multilingual recall"]'
  );

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", {
    name: "Actions: Research plan for multilingual recall"
  })).toBeFocused();
});

test.describe("v2 mobile row-action menu", () => {
  test.use({ hasTouch: true });

  test("keeps the 320/360/390px sheets local, touch-sized, and focus-restoring", async ({ page }) => {
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ height: 844, width });
      await page.goto("/ui-v2-fixture?fixture=navigation");
      await page.getByRole("button", { name: "Open sidebar" }).tap();
      const navigation = page.getByRole("complementary", { name: "Chat navigation" });
      const tree = page.getByRole("tree", { name: "Personal chats" });
      const selected = tree.getByRole("treeitem", { name: "Quarterly product brief" });
      await expect(selected).toHaveAttribute("tabindex", "0");
      await selected.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(tree.getByRole("treeitem", { name: "Исследования" })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      const running = tree.getByRole("treeitem", { name: "Research plan for multilingual recall" });
      await expect(running).toBeFocused();
      const scroll = page.locator(".v2-navigation .v2-navigation-scroll");
      const scrollTop = await scroll.evaluate((element) => element.scrollTop);

      await page.keyboard.press("Shift+F10");
      const dialog = page.getByRole("dialog", {
        name: "Chat actions: Research plan for multilingual recall sheet"
      });
      const menu = page.getByRole("menu", {
        name: "Chat actions: Research plan for multilingual recall"
      });
      await expect(dialog).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
      await expectInsideViewport(page, ".v2-responsive-menu-sheet");
      for (const item of await menu.getByRole("menuitem").all()) {
        const box = await item.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      expect(await scroll.evaluate((element) => element.scrollTop)).toBe(scrollTop);

      await page.locator(".v2-responsive-menu-scrim").dispatchEvent("click");
      await expect(dialog).toHaveCount(0);
      await expect(running).toBeFocused();
      await expect(navigation).toBeVisible();
    }
  });
});

test("v2 compact drawer isolates content, contains focus, and closes on Escape", async ({ page }) => {
  await page.setViewportSize({ height: 390, width: 844 });
  await page.goto("/ui-v2-fixture?fixture=navigation");
  const opener = page.getByRole("button", { name: "Open sidebar" });
  await opener.click();
  const shell = page.locator(".v2-workspace-shell");
  await expect(shell).toHaveAttribute("data-sidebar-compact-expanded", "true");
  await expect(page.locator(".v2-workspace-content")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Close sidebar" })).toBeFocused();

  const firstRailDestination = page.getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Chats", exact: true });
  await firstRailDestination.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".v2-navigation"))))
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded", "true");
  await expect(page.locator(".v2-workspace-content")).not.toHaveAttribute("inert", "");
  await expect(opener).toBeFocused();

  await opener.click();
  await page.getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Library" }).click();
  await expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded", "true");
  await expect(page.locator(".v2-navigation-scrim")).toHaveCSS("display", "none");
});

test("v2 mobile drawer fits all three destinations on one row", async ({ page }) => {
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ height: 844, width });
    await page.goto("/ui-v2-fixture?fixture=navigation&state=destinations");
    await page.getByRole("button", { name: "Open sidebar" }).click();
    const destinations = page.locator(".v2-navigation-destinations > .v2-navigation-destination");
    await expect(destinations).toHaveCount(3);
    await expect(destinations).toHaveText(["Projects", "Library", "Settings"]);
    const boxes = await destinations.evaluateAll((items) => items.map((item) => {
      const box = item.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top };
    }));
    expect(new Set(boxes.map(({ top }) => Math.round(top))).size).toBe(1);
    expect(boxes.every(({ left, right }) => left >= 0 && right <= width)).toBe(true);
  }
});

for (const state of ["error", "unavailable"] as const) {
  test(`v2 ${state} conversation state is centred`, async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`/ui-v2-fixture?fixture=conversation&state=${state}`);
    const stateSurface = page.getByTestId(`conversation-${state}`);
    await expect(stateSurface).toHaveCSS("text-align", "center");
    const [surfaceBox, headingBox] = await Promise.all([
      stateSurface.boundingBox(),
      stateSurface.getByRole("heading").boundingBox()
    ]);
    expect(surfaceBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    const surfaceCenter = surfaceBox!.x + surfaceBox!.width / 2;
    const headingCenter = headingBox!.x + headingBox!.width / 2;
    expect(Math.abs(surfaceCenter - headingCenter)).toBeLessThan(2);
  });
}

test.describe("v2 jump-to-latest geometry", () => {
  test.use({ hasTouch: true });

  test("keeps a 44px control outside a saturated user bubble", async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ height: 844, width });
      await page.goto("/ui-v2-fixture?fixture=conversation&state=jump");
      const bubble = page.locator('.v2-conversation-turn[data-role="user"] .v2-conversation-turn-content').last();
      const jump = page.getByRole("button", { name: "Jump to latest message" });
      await page.getByTestId("conversation-scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const [bubbleBox, jumpBox] = await Promise.all([bubble.boundingBox(), jump.boundingBox()]);
      expect(bubbleBox).not.toBeNull();
      expect(jumpBox).not.toBeNull();
      const overlapsHorizontally = Math.max(bubbleBox!.x, jumpBox!.x) <
        Math.min(bubbleBox!.x + bubbleBox!.width, jumpBox!.x + jumpBox!.width);
      const overlapsVertically = Math.max(bubbleBox!.y, jumpBox!.y) <
        Math.min(bubbleBox!.y + bubbleBox!.height, jumpBox!.y + jumpBox!.height);
      expect(overlapsHorizontally).toBe(false);
      expect(overlapsHorizontally && overlapsVertically).toBe(false);
      expect(jumpBox!.width).toBeGreaterThanOrEqual(44);
      expect(bubbleBox!.width).toBeGreaterThanOrEqual(width - 72.5);
    }
  });
});

test("v2 sidebar leaves Ctrl/Cmd+K unassigned", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=navigation");
  const opener = page.getByRole("button", { name: "Open sidebar" });
  await opener.click();
  const drawer = page.getByRole("complementary", { name: "Chat navigation" });
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
  const input = page.getByRole("textbox", { name: "Message" });
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
    await page.goto("/ui-v2-fixture?fixture=composer&state=add");
    await page.addStyleTag({ content: "html { font-size: 20px !important; }" });
    const sheet = page.getByRole("menu", { name: "Add" });
    await expect(sheet).toBeVisible();
    await expectInsideViewport(page, "[role='menu'][aria-label='Add']");
    await expectInsideViewport(page, "[data-testid='composer-v2']");
    await expectNoPageOverflow(page);
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

    await page.setViewportSize({ height: 1024, width: 768 });
    await page.goto("/ui-v2-fixture?fixture=composer&state=default");
    expect((await page.locator(".v2-live-model").boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/ui-v2-fixture?fixture=conversation&state=basic");
    const answer = page.getByRole("article", { name: "Answer" }).first();
    await answer.tap();
    const actions = answer.getByRole("toolbar", { name: "Answer actions" });
    await expect(actions).toBeVisible();
    for (const button of await actions.getByRole("button").all()) {
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }

    await page.goto("/ui-v2-fixture?fixture=navigation");
    await page.getByRole("button", { name: "Open sidebar" }).tap();
    const navigation = page.getByRole("complementary", { name: "Chat navigation" });
    for (const button of await navigation.getByRole("button").all()) {
      if (!await button.isVisible()) continue;
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }
  });
});
