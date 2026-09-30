import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/** The raw level is drawn whole inside its chip, never cut or covered. */
async function expectReasoningValueVisible(page: Page, value: string) {
  const chip = page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u });
  await expect(chip).toHaveAccessibleName(`Reasoning effort: ${value}`);
  await expect(chip.locator(".v2-composer-reasoning-value")).toHaveText(value);
  await expect.poll(() => chip.evaluate((element) => {
    const text = element.querySelector(".v2-composer-reasoning-value")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const glyphs = range.getBoundingClientRect(), box = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(glyphs.left + glyphs.width / 2, glyphs.top + glyphs.height / 2);
    return glyphs.width > 0 && glyphs.left >= box.left - 0.5 && glyphs.right <= box.right + 0.5 &&
      glyphs.top >= box.top - 0.5 && glyphs.bottom <= box.bottom + 0.5 && Boolean(topmost && element.contains(topmost));
  })).toBe(true);
}

async function expectContainedControls(page: Page, expectedChips = 6, allowWrapping = false) {
  const composer = page.getByTestId("composer-v2");
  const chips = composer.locator(".v2-composer-indicator");
  await expect(chips).toHaveCount(expectedChips);
  // Sample all rectangles together while container changes settle. Comparing
  // measurements from separate frames can report a spurious overlap.
  await expect.poll(() => composer.evaluate((root, allowWrapping) => {
    const outer = root.getBoundingClientRect();
    const chips = [...root.querySelectorAll(".v2-composer-indicator")].map(element => element.getBoundingClientRect());
    const buttons = [...root.querySelectorAll("button")].filter(element => element.checkVisibility()).map(element => ({
      rect: element.getBoundingClientRect(), name: element.getAttribute("aria-label")
    }));
    const violations: string[] = [];
    if (!allowWrapping && Math.max(...chips.map(box => box.y)) - Math.min(...chips.map(box => box.y)) >= 1) violations.push("chips wrapped");
    for (let i = 0; i < buttons.length; i++) {
      const { rect: a, name } = buttons[i];
      if (a.left < outer.left - 0.5 || a.right > outer.right + 0.5 ||
        a.top < outer.top - 0.5 || a.bottom > outer.bottom + 0.5) violations.push(`${name} outside composer`);
      for (let j = i + 1; j < buttons.length; j++) {
        const b = buttons[j].rect;
        if (a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top) {
          violations.push(`${name} overlaps ${buttons[j].name}`);
        }
      }
    }
    return violations;
  }, allowWrapping)).toEqual([]);
  await expectNoHorizontalOverflow(page);
}

for (const viewport of [
  { width: 1440, height: 900, touch: false },
  { width: 820, height: 1180, touch: true },
  { width: 1180, height: 820, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 360, height: 800, touch: true },
  { width: 844, height: 390, touch: true }
]) {
  test.describe(`chip geometry ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.touch });
    for (const theme of ["light", "dark"] as const) {
      test(`keeps six capabilities and the reasoning level reachable in ${theme}`, async ({ context, page }, testInfo) => {
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        await page.goto("/ui-v2-fixture?fixture=composer&state=chips-wide");
        await page.evaluate(() => document.fonts.ready);
        // A phone's narrow chip row may move the level whole to a second row.
        const phone = viewport.width <= 390;
        await expectContainedControls(page, 7, phone);
        const composer = page.getByTestId("composer-v2");
        // The level is the seventh chip: every width shows the capabilities as
        // icons and the raw level as text, on one row from tablet widths up.
        for (const label of await composer.locator(".v2-composer-indicator-label").all()) await expect(label).toBeHidden();
        await expectReasoningValueVisible(page, "xhigh");
        await expect(composer.locator(".v2-composer-indicator").last()).toHaveAccessibleName("Reasoning effort: xhigh");
        await expect(composer.locator(".v2-composer-indicator-count")).toHaveText(["2", "3", "32"]);
        if (viewport.touch) {
          for (const button of await composer.locator("button:visible").all()) await expectTouchSafe(button);
        }
        if (viewport.width <= 390) {
          const [add, input, send, chips] = await Promise.all([
            composer.getByRole("button", { name: "Add", exact: true }).boundingBox(),
            composer.getByRole("textbox", { name: "Message" }).boundingBox(),
            composer.getByRole("button", { name: "Send message", exact: true }).boundingBox(),
            composer.locator(".v2-composer-indicators").boundingBox()
          ]);
          expect(add!.x + add!.width).toBeLessThanOrEqual(input!.x);
          expect(input!.x + input!.width).toBeLessThanOrEqual(send!.x);
          expect(Math.abs(add!.y + add!.height / 2 - input!.y - input!.height / 2)).toBeLessThan(2);
          expect(chips!.y).toBeGreaterThanOrEqual(send!.y + send!.height);
        }
        await page.screenshot({ path: testInfo.outputPath("chips-wide.png") });
        const agent = composer.getByRole("button", { name: "Agent", exact: true });
        await expect(agent).toHaveAttribute("aria-disabled", "true");
        await expect(agent).toHaveAccessibleDescription(/Turn off Knowledge to use Agent/);
        if (viewport.touch) {
          const box = (await agent.boundingBox())!;
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await agent.focus();
          await page.keyboard.press("Enter");
        }
        await expect(composer.getByRole("status")).toHaveText("Turn off Knowledge to use Agent.");
        await expect(agent).toHaveAttribute("aria-pressed", "false");
        await expectContainedControls(page, 7, phone);
        await page.screenshot({ path: testInfo.outputPath("agent-blocked.png") });
        await page.goto("/ui-v2-fixture?fixture=composer&state=chips-off-pinned");
        await expectContainedControls(page);
        // Six capabilities without a reasoning level keep their labels near the full measure.
        const width = (await composer.boundingBox())!.width;
        for (const label of await composer.locator(".v2-composer-indicator-label").all()) {
          if (width > 736) await expect(label).toBeVisible();
          else await expect(label).toBeHidden();
        }
        await expect(composer.getByRole("button", { name: "Change Skills mode" }))
          .toHaveAccessibleDescription("Skills: Auto off · 32 pinned (always loaded)");
        if (!viewport.touch) {
          const workspace = composer.getByRole("button", { name: /^Workspace details/ });
          const face = workspace.locator(".v2-composer-indicator-face");
          const failureColor = await face.evaluate(element => getComputedStyle(element).borderColor);
          await workspace.hover();
          await expect.poll(() => face.evaluate(element => getComputedStyle(element).borderColor)).toBe(failureColor);
          await page.mouse.move(0, 0);
        }
        await page.screenshot({ path: testInfo.outputPath("chips-off-pinned.png") });
      });
    }
  });
}

for (const width of [1920, 1366, 1280]) {
  test(`pending comments and six capability chips fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/ui-v2-fixture?fixture=composer&state=chips-wide-comments");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("button", { name: "3 comments", exact: true })).toBeVisible();
    // Comments must stay contained. Existing capability chips may wrap whole
    // instead of hiding controls or overflowing the reading column.
    await expectContainedControls(page, 8, true);
    await expectReasoningValueVisible(page, "xhigh");
    await page.screenshot({ path: testInfo.outputPath("comments-all-capabilities.png") });
  });
}

/*
 * Composer widths measured on the running application in the worst case (six
 * capability chips with counts, three pending comments, sidebar open, artifact
 * panel docked): 674px at 1920×1080, 430px at 1366×768 and 392px at 1280×720,
 * where the composer already uses its narrow layout. The gallery sets those
 * widths. The first two keep one chip row for every raw level; at 1280×720 the
 * level may move whole to a second chip row (operator, 2026-09-30).
 */
for (const { composerWidth, mayWrap, viewport } of [
  { composerWidth: 674, mayWrap: false, viewport: { width: 1920, height: 1080 } },
  { composerWidth: 430, mayWrap: false, viewport: { width: 1366, height: 768 } },
  { composerWidth: 392, mayWrap: true, viewport: { width: 1280, height: 720 } }
]) {
  test(`every raw reasoning level fits the worst-case row at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/ui-v2-fixture?fixture=composer&state=chips-wide-comments");
    await page.evaluate(() => document.fonts.ready);
    const composer = page.getByTestId("composer-v2");
    await composer.evaluate((element, width) => { element.style.width = `${width}px`; }, composerWidth);
    await expect.poll(async () => Math.round((await composer.boundingBox())!.width)).toBe(composerWidth);
    const chip = composer.getByRole("button", { name: /^Reasoning effort:/u });
    for (const level of REASONING_LEVELS) {
      await chip.click();
      const menu = page.getByRole("menu", { name: "Reasoning effort" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitemradio")).toHaveText([...REASONING_LEVELS]);
      await expect(menu).toContainText("Applies to your next message.");
      // A desktop popover beside its chip, not a sheet: no sheet header, narrow, inside the viewport.
      await expect(menu.getByRole("button", { name: "Close", exact: true })).toBeHidden();
      const [menuBox, chipBox] = await Promise.all([menu.boundingBox(), chip.boundingBox()]);
      expect(menuBox!.width).toBeLessThanOrEqual(241);
      expect(menuBox!.y + menuBox!.height <= chipBox!.y + 1 || menuBox!.y >= chipBox!.y + chipBox!.height - 1).toBe(true);
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
      await menu.getByRole("menuitemradio", { name: level, exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expectReasoningValueVisible(page, level);
      await expectContainedControls(page, 8, true);
      // The capabilities are icons; the level keeps its text.
      for (const label of await composer.locator(".v2-composer-indicator-label").all()) await expect(label).toBeHidden();
      const rows = await composer.evaluate((root) => {
        const reasoning = root.querySelector(".v2-composer-reasoning")!.getBoundingClientRect();
        const others = [...root.querySelectorAll(".v2-composer-indicator:not(.v2-composer-reasoning)")]
          .map((element) => element.getBoundingClientRect());
        return {
          othersOneRow: Math.max(...others.map((box) => box.top)) - Math.min(...others.map((box) => box.top)) < 1,
          sameRow: Math.abs(reasoning.top - others[0]!.top) < 1,
          wholeBelow: reasoning.top >= Math.max(...others.map((box) => box.bottom)) - 0.5
        };
      });
      expect(rows.othersOneRow, `${level}: capabilities stay on one row`).toBe(true);
      if (mayWrap) expect(rows.sameRow || rows.wholeBelow, `${level}: the level wraps whole`).toBe(true);
      else expect(rows.sameRow, `${level}: the level stays on the chip row`).toBe(true);
      // The send control keeps its place in the composer with or without the
      // level. A wrapped level adds a chip row and the bottom-anchored composer
      // grows upward, so the place is measured from the composer's corner.
      const send = composer.getByRole("button", { name: "Send message", exact: true });
      const sendPlace = async () => {
        const [sendBox, composerBox] = await Promise.all([send.boundingBox(), composer.boundingBox()]);
        return { x: sendBox!.x - composerBox!.x, y: sendBox!.y - composerBox!.y };
      };
      const withLevel = await sendPlace();
      if (mayWrap) {
        // Nothing overlaps the send control, whichever row the level takes.
        const overlapping = await send.evaluate((button) => {
          const own = button.getBoundingClientRect();
          return [...button.closest("[data-testid='composer-v2']")!.querySelectorAll(".v2-composer-indicator")]
            .map((element) => element.getBoundingClientRect())
            .filter((box) => box.left < own.right - 0.5 && box.right > own.left + 0.5 &&
              box.top < own.bottom - 0.5 && box.bottom > own.top + 0.5).length;
        });
        expect(overlapping, `${level}: chips overlapping send`).toBe(0);
      }
      // A hidden chip leaves the accessibility tree, so its role locator no
      // longer resolves; hide and restore it through its class instead.
      const chipElement = composer.locator(".v2-composer-reasoning");
      await chipElement.evaluate((element) => { element.style.display = "none"; });
      const withoutLevel = await sendPlace();
      await chipElement.evaluate((element) => { element.style.display = ""; });
      await expect(chip).toBeVisible();
      expect(Math.abs(withLevel.x - withoutLevel.x), `${level}: send x`).toBeLessThan(0.5);
      expect(Math.abs(withLevel.y - withoutLevel.y), `${level}: send y`).toBeLessThan(0.5);
    }
    await page.screenshot({ path: testInfo.outputPath(`reasoning-worst-case-${viewport.width}x${viewport.height}.png`) });
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`reasoning chip on a phone ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test("is a 44px chip in the chip row and opens its levels as a sheet", async ({ page }, testInfo) => {
      await page.goto("/ui-v2-fixture?fixture=composer&state=reasoning");
      await page.evaluate(() => document.fonts.ready);
      const composer = page.getByTestId("composer-v2");
      const chip = composer.getByRole("button", { name: /^Reasoning effort:/u });
      await expect(composer.getByLabel("Active capabilities").getByRole("button", { name: /^Reasoning effort:/u })).toBeVisible();
      await expectTouchSafe(chip);
      await expectReasoningValueVisible(page, "high");
      await expectContainedControls(page, 5, true);
      const box = (await chip.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      const sheet = page.getByRole("menu", { name: "Reasoning effort" });
      await expect(sheet).toBeVisible();
      // The sheet: full width at the bottom with its title and Close.
      const sheetBox = (await sheet.boundingBox())!;
      expect(sheetBox.x).toBeLessThanOrEqual(1);
      expect(sheetBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(Math.abs(sheetBox.y + sheetBox.height - viewport.height)).toBeLessThanOrEqual(1);
      await expect(sheet.locator(".v2-composer-layer-header").getByText("Reasoning effort", { exact: true })).toBeVisible();
      await expectTouchSafe(sheet.getByRole("button", { name: "Close", exact: true }));
      for (const row of await sheet.getByRole("menuitemradio").all()) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(43);
      }
      await page.screenshot({ path: testInfo.outputPath(`reasoning-sheet-${viewport.width}x${viewport.height}.png`) });
      const low = (await sheet.getByRole("menuitemradio", { name: "low", exact: true }).boundingBox())!;
      await page.touchscreen.tap(low.x + low.width / 2, low.y + low.height / 2);
      await expect(sheet).toHaveCount(0);
      await expectReasoningValueVisible(page, "low");
      await expectNoHorizontalOverflow(page);
    });
  });
}

test("gallery states show the level locked, during a run, and not at all", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const composer = page.getByTestId("composer-v2");
  const chip = composer.getByRole("button", { name: /^Reasoning effort:/u });

  await page.goto("/ui-v2-fixture?fixture=composer&state=reasoning-locked");
  await expectReasoningValueVisible(page, "high");
  await expect(chip).toHaveAttribute("data-locked", "true");
  await expect(chip).toHaveAttribute("data-provenance", "assistant");
  await expect(chip).toHaveAccessibleDescription("Fixed by Research editor");
  // The Assistant's dot sits on the chip's face, outside the value text.
  const dot = await chip.locator(".v2-composer-indicator-face").evaluate((face) => getComputedStyle(face, "::after").content);
  expect(dot).not.toBe("none");
  await chip.click();
  const menu = page.getByRole("menu", { name: "Reasoning effort" });
  await expect(menu.getByTestId("assistant-row-provenance")).toHaveText("Fixed by Research editor");
  await expect(menu.getByRole("menuitemradio", { name: "high", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByRole("menuitemradio", { name: "low", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("reasoning-locked.png") });
  await page.keyboard.press("Escape");
  await expect(chip).toBeFocused();

  await page.goto("/ui-v2-fixture?fixture=composer&state=reasoning-running");
  await expectReasoningValueVisible(page, "high");
  await expect(chip).toBeDisabled();
  await expect(composer.getByRole("button", { name: "Stop answer" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reasoning-running.png") });

  await page.goto("/ui-v2-fixture?fixture=composer&state=reasoning-hidden");
  await expect(composer.getByRole("button", { name: "Change Skills mode" })).toBeVisible();
  await expect(composer.getByRole("button", { name: /^Reasoning effort/u })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("reasoning-hidden.png") });
});

test("container resizing and zoom preserve the row, draft, and bounded keyboard help", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=composer&state=chips-wide");
  const composer = page.getByTestId("composer-v2");
  const input = composer.getByRole("textbox", { name: "Message" });
  await input.fill("Keep this draft while opening a side panel.");
  for (const width of [740, 736, 700, 450, 340]) {
    // A side panel changes the available reading column without changing the viewport.
    await composer.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
    await expectContainedControls(page, 7, width <= 416);
    await expectReasoningValueVisible(page, "xhigh");
    await expect(input).toHaveValue("Keep this draft while opening a side panel.");
    const agent = composer.getByRole("button", { name: "Agent", exact: true });
    await agent.focus();
    await expect.poll(() => agent.evaluate(element => getComputedStyle(element, "::after").visibility)).toBe("visible");
    const help = await agent.evaluate(element => {
      const css = getComputedStyle(element, "::after");
      const row = element.parentElement!.getBoundingClientRect();
      const width = parseFloat(css.width), height = parseFloat(css.height);
      return { left: row.left + parseFloat(css.left) - width / 2,
        right: row.left + parseFloat(css.left) + width / 2,
        top: row.bottom - parseFloat(css.bottom) - height, wrap: css.whiteSpace };
    });
    expect(help.left).toBeGreaterThanOrEqual(0);
    expect(help.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(help.top).toBeGreaterThanOrEqual(0);
    expect(help.wrap).toBe("normal");
  }
  await page.screenshot({ path: testInfo.outputPath("narrow-desktop-help.png") });
  await composer.evaluate(element => { element.style.width = ""; });
  // Browser zoom reduces the CSS viewport; enlarged text also exercises rem breakpoints.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
  await expectContainedControls(page, 7, true);
  await expectReasoningValueVisible(page, "xhigh");
  await expect(input).toHaveValue("Keep this draft while opening a side panel.");
  await page.screenshot({ path: testInfo.outputPath("zoomed.png") });
});
