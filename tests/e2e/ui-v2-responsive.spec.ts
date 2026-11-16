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

/** Retried: a sheet opened on load or a style injected after it settles over the next frames. */
async function expectInsideViewport(page: Page, selector: string) {
  await expect(async () => {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  }).toPass({ timeout: 5_000 });
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
      // No icon rail at any width: the shell is `chat list | content`.
      await expect(page.locator("[data-testid='workspace-rail'], .v2-rail")).toHaveCount(0);
      const content = page.locator(".v2-workspace-shell > .v2-workspace-content");
      if (viewport.width < 1024) {
        await expect(navigation).toBeHidden();
        await expect(opener).toBeVisible();
        // Below 1024px the list is a closed drawer: the content takes the whole width.
        const contentBox = (await content.boundingBox())!;
        expect(Math.abs(contentBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(contentBox.width - viewport.width)).toBeLessThanOrEqual(1);
      } else {
        await expect(navigation).toBeVisible();
        await expect(page.locator(".v2-sidebar-floats")).toHaveCSS("opacity", "0");
        await expect(page.locator(".v2-sidebar-floats")).toHaveCSS("pointer-events", "none");
        // The 16.25rem list starts at the left edge and the content follows it.
        const listBox = (await navigation.boundingBox())!;
        const contentBox = (await content.boundingBox())!;
        expect(Math.abs(listBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(listBox.width - 260)).toBeLessThanOrEqual(1);
        expect(Math.abs(contentBox.x - 260)).toBeLessThanOrEqual(1);
        expect(Math.abs(contentBox.width - (viewport.width - 260))).toBeLessThanOrEqual(1);
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
  // The tree makes its selected row the Tab stop once it has hydrated; a focus
  // placed before that is unknown to the shell, which then has nothing to move
  // when the width changes.
  await expect(source).toHaveAttribute("tabindex", "0");
  await source.focus();

  await page.setViewportSize({ height: 720, width: 767 });
  const opener = page.getByRole("button", { name: "Open sidebar" });
  await expect(page.locator(".v2-workspace-shell"))
    .toHaveAttribute("data-sidebar-composition", "mobile");
  await expect(opener).toBeFocused();
  await opener.click();
  // A pointer open focuses the drawer itself, so no keyboard ring lands on ✕.
  await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeFocused();

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
  // The full footer row (account entry, Announcements, Settings) ends the drawer.
  await page.goto("/ui-v2-fixture?fixture=navigation&state=destinations");
  const opener = page.getByRole("button", { name: "Open sidebar" });
  await opener.click();
  const shell = page.locator(".v2-workspace-shell");
  await expect(shell).toHaveAttribute("data-sidebar-compact-expanded", "true");
  await expect(page.locator(".v2-workspace-content")).toHaveAttribute("inert", "");
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation).toBeFocused();

  // 768–1023px: the same overlay drawer as on a phone, from the left edge and
  // 17.5rem wide, over a content column that keeps the whole width.
  const drawerBox = (await navigation.boundingBox())!;
  expect(Math.abs(drawerBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(drawerBox.width - 280)).toBeLessThanOrEqual(1);
  const contentBox = (await page.locator(".v2-workspace-content").boundingBox())!;
  expect(Math.abs(contentBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(contentBox.width - 844)).toBeLessThanOrEqual(1);
  await expect(page.locator(".v2-navigation-scrim")).toHaveCSS("display", "block");

  // Shift+Tab from the drawer's first control wraps to its last, the footer's
  // gear, instead of leaving the drawer.
  const first = navigation.getByRole("button", { name: "Skip to message composer" });
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(navigation.getByTestId("navigation-footer").getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded", "true");
  await expect(page.locator(".v2-workspace-content")).not.toHaveAttribute("inert", "");
  await expect(opener).toBeFocused();

  // A keyboard open keeps the visible landing on ✕.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close sidebar" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();

  // The scrim closes the drawer and stops covering the content.
  await opener.click();
  await page.locator(".v2-navigation-scrim").click({ position: { x: 600, y: 200 } });
  await expect(shell).not.toHaveAttribute("data-sidebar-compact-expanded", "true");
  await expect(page.locator(".v2-navigation-scrim")).toHaveCSS("display", "none");
  await expect(opener).toBeFocused();
});

test("v2 drawer footer fits the account entry, Announcements and Settings on one row", async ({ page }) => {
  await page.route("**/api/announcements/unread-count", (route) => route.fulfill({ json: { unreadCount: 2 } }));
  for (const width of [320, 360, 390, 768]) {
    await page.setViewportSize({ height: 844, width });
    await page.goto("/ui-v2-fixture?fixture=navigation&state=destinations");
    // The bell hides with the drawer, so its unread hint sits on "Open sidebar".
    const opener = page.getByRole("button", { name: "Open sidebar" });
    await expect(opener).toHaveAttribute("data-announcements-unread", "true");
    await opener.click();
    const navigation = page.getByRole("complementary", { name: "Chat navigation" });
    await expect(navigation).toBeVisible();
    const footer = navigation.getByTestId("navigation-footer");
    const controls = [
      footer.getByRole("button", { name: "Account menu", exact: true }),
      footer.getByRole("button", { name: "Announcements, 2 unread", exact: true }),
      footer.getByRole("button", { name: "Settings", exact: true })
    ];
    const boxes: { height: number; width: number; x: number; y: number }[] = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      boxes.push((await control.boundingBox())!);
    }
    const drawer = (await navigation.boundingBox())!;
    expect(Math.abs(drawer.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(drawer.width - Math.min(280, width - 48))).toBeLessThanOrEqual(1);
    const middle = (box: { height: number; y: number }) => box.y + box.height / 2;
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(drawer.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(drawer.x + drawer.width + 0.5);
      expect(Math.abs(middle(box) - middle(boxes[0]!))).toBeLessThanOrEqual(1);
    }
    expect(boxes[1]!.x).toBeGreaterThanOrEqual(boxes[0]!.x + boxes[0]!.width - 0.5);
    expect(boxes[2]!.x).toBeGreaterThanOrEqual(boxes[1]!.x + boxes[1]!.width - 0.5);
    // The account label truncates rather than pushing the icons out: the row is as wide as the drawer lets it be
    // (its scroll width is no measure, because it counts the controls' tooltips).
    const row = (await footer.locator(".v2-navigation-footer-bar").boundingBox())!;
    expect(row.x + row.width).toBeLessThanOrEqual(drawer.x + drawer.width + 0.5);
    expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
    await expectNoPageOverflow(page);
  }
});

test("v2 desktop collapsed list keeps the unread hint on Open sidebar", async ({ page }) => {
  await page.route("**/api/announcements/unread-count", (route) => route.fulfill({ json: { unreadCount: 1 } }));
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=navigation&state=destinations");
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation.getByRole("button", { name: "Announcements, 1 unread", exact: true })).toBeVisible();
  const opener = page.getByRole("button", { name: "Open sidebar" });
  // The list shows the bell, so the hidden opener carries no hint.
  await expect(opener).not.toHaveAttribute("data-announcements-unread");
  await navigation.getByRole("button", { name: "Close sidebar" }).click();
  await expect(navigation).toBeHidden();
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute("data-announcements-unread", "true");
  await expect(opener).toHaveAccessibleDescription("Unread announcements");
  const dot = await opener.evaluate((button) => {
    const style = getComputedStyle(button, "::before");
    return { height: parseFloat(style.height), opacity: style.opacity, width: parseFloat(style.width) };
  });
  expect(dot.opacity).toBe("1");
  expect(dot.width).toBeGreaterThan(0);
  expect(dot.width).toBe(dot.height);
  await opener.click();
  await expect(navigation).toBeVisible();
  await expect(opener).not.toHaveAttribute("data-announcements-unread");
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

  // A phone floats the control centred over the thread, as on chatgpt.com (operator decision 2026-10-29).
  test("centres a round 44px control over the thread and keeps a saturated bubble's measure", async ({ page }) => {
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
      const placement = await jump.evaluate((element) => {
        const thread = ((element as HTMLElement).offsetParent ?? document.body).getBoundingClientRect();
        return { center: thread.left + thread.width / 2, radius: parseFloat(getComputedStyle(element).borderTopLeftRadius) };
      });
      expect(Math.abs(jumpBox!.x + jumpBox!.width / 2 - placement.center)).toBeLessThanOrEqual(1);
      expect(placement.radius).toBeGreaterThanOrEqual(jumpBox!.height / 2 - 0.5);
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
  // Confirm the prefilled fixture is interactive before replacing its draft.
  await page.getByTestId("header-model-trigger").click();
  const modelPicker = page.getByRole("dialog", { name: "Choose model" });
  await expect(modelPicker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modelPicker).toBeHidden();
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toHaveValue("Подготовь краткое резюме");
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

    // The footer's Announcements and Settings are part of the list's controls.
    await page.goto("/ui-v2-fixture?fixture=navigation&state=destinations");
    await page.getByRole("button", { name: "Open sidebar" }).tap();
    const navigation = page.getByRole("complementary", { name: "Chat navigation" });
    await expect(navigation.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    for (const button of await navigation.getByRole("button").all()) {
      if (!await button.isVisible()) continue;
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }
  });
});
