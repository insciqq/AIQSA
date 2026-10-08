import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

/*
 * The composer's `/` palette: keyboard flow on desktop, touch flow with the
 * field focused on phones and a tablet, and the real shell's Skill pin. The
 * fixture page needs no server state; the shell test creates and deletes its
 * own Skill and never sends a message.
 */

const FIXTURE = "/ui-v2-fixture?fixture=composer&state=commands";

function field(page: Page): Locator {
  return page.getByTestId("composer-v2").getByLabel("Message", { exact: true });
}

function palette(page: Page): Locator {
  return page.getByRole("listbox", { name: "Commands" });
}

function skillsChip(page: Page): Locator {
  return page.getByTestId("composer-v2").getByRole("button", { name: "Change Skills mode" });
}

/** The palette stays inside the viewport and never covers the message field. */
async function expectPaletteBesideField(page: Page) {
  const layer = page.locator('.v2-composer-layer[data-kind="commands"]');
  await expectWithinViewport(page, layer);
  const [layerBox, fieldBox] = await Promise.all([layer.boundingBox(), field(page).boundingBox()]);
  const overlaps = layerBox!.y < fieldBox!.y + fieldBox!.height && fieldBox!.y < layerBox!.y + layerBox!.height;
  expect(overlaps).toBe(false);
  await expectNoHorizontalOverflow(page);
}

test.describe("composer / palette on desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("pins a Skill and opens Knowledge with the keyboard only", async ({ page }, testInfo) => {
    await page.goto(FIXTURE);
    await field(page).focus();
    await page.keyboard.type("/");
    await expect(palette(page)).toBeVisible();
    await expect(field(page)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.type("sum");
    const active = async () => page.locator(`[id="${await field(page).getAttribute("aria-activedescendant")}"]`);
    await expect(await active()).toContainText("Summarize sources");
    await expectPaletteBesideField(page);
    await page.screenshot({ path: testInfo.outputPath("palette-desktop.png") });
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expect(field(page)).toHaveValue("");
    await expect(field(page)).toBeFocused();
    await expect(skillsChip(page)).toHaveAccessibleDescription(/1 pinned \(always loaded\)/u);

    await page.keyboard.type("/sum");
    await expect(palette(page).getByRole("option", { name: /Summarize sources/u })).toContainText("Pinned · Always use");
    await page.keyboard.press("Escape");
    await expect(palette(page)).toBeHidden();
    await expect(field(page)).toHaveValue("/sum");
    await field(page).fill("");
    await page.keyboard.type("/ ");
    await expect(palette(page)).toBeHidden();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    await page.keyboard.type("/know");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await expect(await active()).toContainText("Choose Knowledge");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu", { name: "Knowledge" })).toBeVisible();
    await expect(field(page)).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Knowledge" })).toBeHidden();
  });
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 820, height: 1180 }
]) {
  test.describe(`composer / palette by touch ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true });

    test("taps a Skill with the field focused and keeps the layout contained", async ({ page }, testInfo) => {
      await page.goto(FIXTURE);
      const box = (await field(page).boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(field(page)).toBeFocused();
      await page.keyboard.type("/");
      await expect(palette(page)).toBeVisible();
      await expectPaletteBesideField(page);
      const row = palette(page).getByRole("option", { name: /Fact check/u });
      await row.scrollIntoViewIfNeeded();
      await expectTouchSafe(row);
      await page.screenshot({ path: testInfo.outputPath(`palette-touch-${viewport.width}x${viewport.height}.png`) });
      const rowBox = (await row.boundingBox())!;
      await page.touchscreen.tap(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
      await expect(palette(page)).toBeHidden();
      await expect(field(page)).toHaveValue("");
      await expect(field(page)).toBeFocused();
      await expect(skillsChip(page)).toHaveAccessibleDescription(/1 pinned \(always loaded\)/u);
      await expectNoHorizontalOverflow(page);
    });
  });
}

test("the shell pins a library Skill from the palette without sending", async ({ page }) => {
  test.setTimeout(90_000);
  await authenticateWithLocalToken(page.request);
  const name = `Palette ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/me/skills", { data: {
    description: "Summarize a short answer into three bullet points.",
    instructions: "Answer in three short bullet points.",
    name
  } });
  expect(created.status()).toBe(201);
  const skillId: string = (await created.json()).skill.id;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const pinnedCount = async () => {
      const description = await skillsChip(page).evaluate((element) =>
        document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
      return Number(/(\d+) pinned/u.exec(description)?.[1] ?? 0);
    };
    const before = await pinnedCount();
    await field(page).focus();
    await page.keyboard.type(`/${name}`);
    const option = palette(page).getByRole("option", { name: new RegExp(name, "u") });
    await expect(option).toBeVisible();
    await expect(option).toContainText("Always use · Summarize a short answer");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expect(field(page)).toHaveValue("");
    await expect.poll(pinnedCount).toBe(before + 1);
    await page.getByRole("button", { name: "Change Skills mode" }).click();
    await page.getByRole("menuitem", { name: /^Skills…/u }).click();
    const library = page.getByRole("dialog", { name: "Skills", exact: true });
    await library.getByRole("searchbox", { name: "Search Skills" }).fill(name);
    await expect(library.getByRole("button", { name: `Stop always using ${name}`, exact: true })).toBeVisible();
    await library.getByRole("button", { name: `Stop always using ${name}`, exact: true }).click();
    await library.getByRole("button", { name: "Close Skills", exact: true }).click();
    await expect.poll(pinnedCount).toBe(before);
  } finally {
    expect((await page.request.delete(`/api/me/skills/${skillId}`)).ok()).toBe(true);
  }
});
