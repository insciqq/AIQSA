import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";

async function expectOneRowWithoutOverlap(page: Page) {
  const composer = page.getByTestId("composer-v2");
  const chips = composer.locator(".v2-composer-indicator");
  await expect(chips).toHaveCount(6);
  // Sample all rectangles together while container changes settle. Comparing
  // measurements from separate frames can report a spurious overlap.
  await expect.poll(() => composer.evaluate(root => {
    const outer = root.getBoundingClientRect();
    const chips = [...root.querySelectorAll(".v2-composer-indicator")].map(element => element.getBoundingClientRect());
    const buttons = [...root.querySelectorAll("button")].filter(element => element.checkVisibility()).map(element => ({
      rect: element.getBoundingClientRect(), name: element.getAttribute("aria-label")
    }));
    const violations: string[] = [];
    if (Math.max(...chips.map(box => box.y)) - Math.min(...chips.map(box => box.y)) >= 1) violations.push("chips wrapped");
    for (let i = 0; i < buttons.length; i++) {
      const { rect: a, name } = buttons[i];
      if (a.left < outer.left - 0.5 || a.right > outer.right + 0.5) violations.push(`${name} outside composer`);
      for (let j = i + 1; j < buttons.length; j++) {
        const b = buttons[j].rect;
        if (a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top) {
          violations.push(`${name} overlaps ${buttons[j].name}`);
        }
      }
    }
    return violations;
  })).toEqual([]);
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
      test(`keeps six capabilities reachable in ${theme}`, async ({ context, page }, testInfo) => {
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        await page.goto("/ui-v2-fixture?fixture=composer&state=chips-wide");
        await page.evaluate(() => document.fonts.ready);
        await expectOneRowWithoutOverlap(page);
        const composer = page.getByTestId("composer-v2");
        const width = (await composer.boundingBox())!.width;
        const labels = composer.locator(".v2-composer-indicator-label");
        for (const label of await labels.all()) {
          if (width > 736) await expect(label).toBeVisible();
          else await expect(label).toBeHidden();
        }
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
        await expectOneRowWithoutOverlap(page);
        await page.screenshot({ path: testInfo.outputPath("agent-blocked.png") });
        await page.goto("/ui-v2-fixture?fixture=composer&state=chips-off-pinned");
        await expectOneRowWithoutOverlap(page);
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

test("container resizing and zoom preserve the row, draft, and bounded keyboard help", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=composer&state=chips-wide");
  const composer = page.getByTestId("composer-v2");
  const input = composer.getByRole("textbox", { name: "Message" });
  await input.fill("Keep this draft while opening a side panel.");
  for (const width of [740, 736, 700, 450, 340]) {
    // A side panel changes the available reading column without changing the viewport.
    await composer.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
    await expectOneRowWithoutOverlap(page);
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
  await expectOneRowWithoutOverlap(page);
  await expect(input).toHaveValue("Keep this draft while opening a side panel.");
  await page.screenshot({ path: testInfo.outputPath("zoomed.png") });
});
