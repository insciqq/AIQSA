import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { loginWithPassword } from "./support/workspace";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { runAccountMenuAction } from "./shell/page";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

async function openInstructions(page: Page) {
  await runAccountMenuAction(page, "Instructions");
  await expect(page.getByRole("button", { name: "New preset" })).toBeEnabled({ timeout: 30_000 });
}
const viewports = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "tablet-portrait", width: 768, height: 1024, theme: "light" },
  { name: "tablet-landscape", width: 1024, height: 768, theme: "dark" },
  { name: "phone-portrait", width: 390, height: 844, theme: "dark" },
  { name: "phone-landscape", width: 844, height: 390, theme: "light" },
  { name: "phone-small", width: 320, height: 568, theme: "light" }
] as const;

for (const viewport of viewports) {
  test(`instruction list, editor and read-only preview: ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    page.setDefaultTimeout(15_000);
    const userId = randomUUID(), email = `instructions-layout-${userId}@example.com`, password = `Synthetic-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, email, displayName: "Instructions reader", status: "active", authIdentities: { create: {
      normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
    } } } });
    await prisma.$transaction(tx => provisionActiveUser(tx, { userId }));
    await prisma.accessGrant.create({ data: { userId, providerModelId: providerTemplateIds.fakeModel } });
    let pageErrors = 0;
    page.on("pageerror", () => pageErrors++);
    const selection = () => prisma.userSettings.findUniqueOrThrow({ where: { userId }, select: { activeInstructionPresetId: true, instructionSelectionVersion: true } });
    try {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.context().addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await loginWithPassword(page, { email, password });
      await openInstructions(page);
      const library = page.getByTestId("library-v2");
      const panel = page.getByTestId("settings-instructions");
      const back = library.getByRole("button", { name: "Back to Instructions", exact: true });
      const discard = page.getByRole("dialog", { name: "Unsaved instructions" });
      await expect(panel.getByRole("radiogroup", { name: "Active instructions" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Manage presets…" })).toHaveCount(0);

      const before = await selection();
      await panel.getByRole("button", { name: "View", exact: true }).click();
      const preview = panel.getByRole("region", { name: "AIQSA default instructions preview" });
      await expect(preview.getByRole("heading", { name: "AIQSA default instructions", exact: true })).toBeFocused();
      await expect(preview.getByText("System baseline", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(preview.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/u);
      expect(await preview.textContent()).not.toMatch(/\{\{(?:date|time)\}\}/u);
      await expect(preview.locator("a, img, iframe, object, embed")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-preview.png`) });
      await preview.locator("pre").last().scrollIntoViewIfNeeded();
      await expect(preview.locator("pre").last()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await back.click();
      await expect(panel.getByRole("button", { name: "View", exact: true })).toBeFocused();
      expect(await selection()).toEqual(before);

      await panel.getByRole("button", { name: "New preset" }).click();
      const name = panel.getByLabel("Name", { exact: true });
      const source = panel.getByLabel("System instructions", { exact: true });
      await expect(name).toBeFocused();
      await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await name.fill("My writing");
      await source.fill("# Writing style\n\nUse precise examples.\n\n- State the conclusion first.\n- Explain assumptions.\n\n[Inert link](https://example.com) ![Inert image](https://example.com/image.png)");
      const editor = panel.locator(".v2-markdown-editor");
      const width = await editor.evaluate(node => node.getBoundingClientRect().width);
      await expect(editor).toHaveAttribute("data-mode", width >= 880 ? "split" : "write");
      if (viewport.width === 1440) {
        expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(480);
        if (viewport.name === "desktop-light") {
          const content = library.locator(".v2-library-content");
          for (const boundary of [879, 880]) {
            await content.evaluate((node, size) => { (node as HTMLElement).style.width = `${size}px`; }, boundary);
            await expect.poll(() => editor.evaluate(node => node.getBoundingClientRect().width)).toBe(boundary);
            await expect(panel.getByRole("radio", { name: "Split", exact: true })).toHaveCount(boundary === 880 ? 1 : 0);
          }
          await content.evaluate(node => { (node as HTMLElement).style.removeProperty("width"); });
          await expect.poll(() => editor.evaluate(node => node.getBoundingClientRect().width)).toBe(width);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-editor.png`) });
      await expectNoHorizontalOverflow(page);
      await panel.getByRole("radio", { name: "Preview", exact: true }).click();
      await expect(panel.getByRole("heading", { name: "Writing style", exact: true })).toBeVisible();
      await expect(editor.locator("a, img, iframe, object, embed")).toHaveCount(0);
      await panel.getByRole("radio", { name: "Write", exact: true }).click();
      await back.click();
      await expect(discard.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await expect(name).toHaveValue("My writing");
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await source.focus();
      await source.press(viewport.name === "desktop-dark" ? "Meta+s" : "Control+s");
      await expect(panel.getByText(/Preset saved/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "New preset" })).toBeFocused();
      const defaultChoice = panel.getByRole("radio", { name: "AIQSA default instructions", exact: true });
      await defaultChoice.focus();
      await defaultChoice.press("ArrowDown");
      const choice = panel.getByRole("radio", { name: "My writing", exact: true });
      await expect(choice).toBeChecked();
      await expect(choice).toBeFocused();
      const customSelection = await selection();
      await choice.press("Space");
      expect(await selection()).toEqual(customSelection);
      const saved = await prisma.instructionPreset.findFirstOrThrow({ where: { userId } });
      const viewBounds = (await panel.getByRole("button", { name: "View", exact: true }).boundingBox())!;
      const editBounds = (await panel.getByRole("button", { name: "Edit My writing" }).boundingBox())!;
      expect(Math.abs(viewBounds.x - editBounds.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(viewBounds.width - editBounds.width)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-list.png`) });

      let previewUnavailable = true;
      if (viewport.name === "desktop-light") await page.route(/\/api\/me\/instructions\/preview(?:\?|$)/u, route =>
        previewUnavailable ? route.fulfill({ status: 503, json: { error: "instruction_preview_unavailable" } }) : route.continue());
      await panel.getByRole("button", { name: "View", exact: true }).click();
      if (viewport.name === "desktop-light") {
        await expect(preview.getByRole("alert")).toContainText("built-in instructions are unavailable");
        previewUnavailable = false;
        await preview.getByRole("button", { name: "Retry", exact: true }).click();
      }
      await expect(preview.getByText("System baseline", { exact: true })).toBeVisible();
      await expect(preview).not.toContainText(saved.systemInstructions);
      expect(await selection()).toEqual(customSelection);
      expect(await prisma.instructionPreset.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(saved);
      await back.click();
      await panel.getByRole("button", { name: "Edit My writing" }).click();
      await expect(name).toBeFocused();
      await source.fill("Discard this change");
      await back.click();
      await discard.getByRole("button", { name: /Confirm discard/ }).click();
      await expect(panel.getByRole("button", { name: "Edit My writing" })).toBeFocused();
      await panel.getByRole("button", { name: "More actions for My writing" }).click();
      await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
      await expect(name).toHaveValue("My writing copy");
      const save = panel.getByRole("button", { name: "Save", exact: true });
      await save.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, save);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-editor-footer.png`) });
      await save.click();
      await expect(panel.getByRole("button", { name: "Edit My writing copy" })).toBeVisible();
      await panel.getByRole("button", { name: "More actions for My writing copy" }).click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      await expect(panel.getByText("This preset will be removed.", { exact: false })).toBeVisible();
      await panel.getByRole("button", { name: "Delete preset", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Edit My writing copy" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      expect(await prisma.modelRun.count({ where: { userId } })).toBe(0);
      await library.getByRole("button", { name: "Back to chat", exact: true }).click();
      await expect(library).toHaveCount(0);
      expect(pageErrors).toBe(0);
    } finally { await prisma.user.delete({ where: { id: userId } }); }
  });
}
