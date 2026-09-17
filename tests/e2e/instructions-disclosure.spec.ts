import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { loginWithPassword } from "./support/workspace";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { runAccountMenuAction } from "./shell/page";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

async function openInstructions(page: Page) {
  await runAccountMenuAction(page, "Settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Chat defaults" }).click();
  await expect(page.getByRole("button", { name: "Active instructions" })).toBeEnabled();
  await page.getByRole("button", { name: "Manage presets…" }).click();
}

const viewports = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1280, height: 720, theme: "dark" },
  { name: "tablet-portrait", width: 768, height: 1024, theme: "light" },
  { name: "tablet-landscape", width: 1024, height: 768, theme: "dark" },
  { name: "phone-portrait", width: 390, height: 844, theme: "dark" },
  { name: "phone-landscape", width: 844, height: 390, theme: "light" },
  { name: "phone-small", width: 320, height: 568, theme: "light" }
] as const;

for (const viewport of viewports) {
  test(`default preview and preset disclosure: ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const userId = randomUUID(), email = `disclosure-${userId}@example.com`, password = `Synthetic-${randomUUID()}`;
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
      await page.context().addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await loginWithPassword(page, { email, password });
      await openInstructions(page);
      const panel = page.getByTestId("settings-instructions");
      const manage = panel.getByRole("button", { name: "Manage presets…" });
      const panelId = await manage.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      await manage.focus();
      await manage.press("Space");
      await expect(manage).toHaveAttribute("aria-expanded", "false");
      await expect(manage).toBeFocused();
      await manage.press("Enter");
      await expect(manage).toHaveAttribute("aria-expanded", "true");
      await expect(manage).toHaveAttribute("aria-controls", panelId!);
      await panel.getByRole("button", { name: "Done", exact: true }).press("Enter");
      await expect(manage).toBeFocused();
      await expect(manage).toHaveAttribute("aria-expanded", "false");
      await manage.press("Enter");

      const before = await selection();
      await panel.getByRole("button", { name: "View instructions" }).click();
      const preview = panel.getByRole("region", { name: "AIQSA default instructions preview" });
      await expect(preview.getByRole("heading", { name: "AIQSA default instructions", exact: true })).toBeFocused();
      await expect(preview.getByText("System baseline", { exact: true })).toBeVisible();
      await expect(preview.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/u);
      expect(await preview.textContent()).not.toMatch(/\{\{(?:date|time)\}\}/u);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-preview-top.png`) });
      await preview.locator("pre").last().scrollIntoViewIfNeeded();
      await expect(preview.locator("pre").last()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-preview-contract.png`) });
      await preview.getByRole("button", { name: "Close preview" }).click();
      await expect(panel.getByRole("button", { name: "View instructions" })).toBeFocused();
      expect(await selection()).toEqual(before);

      await panel.getByRole("button", { name: "New preset" }).click();
      await panel.getByLabel("Name", { exact: true }).fill("My writing");
      await panel.getByLabel("System instructions", { exact: true }).fill("Private synthetic writing preference");
      await manage.click();
      await expect(panel.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await panel.getByRole("button", { name: "Keep editing" }).press("Enter");
      await expect(panel.getByLabel("Name", { exact: true })).toBeFocused();
      await expect(panel.getByLabel("System instructions", { exact: true })).toHaveValue("Private synthetic writing preference");
      await page.keyboard.press("Escape");
      const discard = page.getByRole("alertdialog", { name: "Unsaved instructions" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Keep editing" }).click();
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      await expect(panel.getByText(/Preset saved/)).toBeVisible();
      await panel.getByRole("button", { name: "Make active: My writing" }).click();
      await expect(panel.getByLabel("Active instructions: My writing", { exact: true })).toBeFocused();
      const customSelection = await selection();
      const saved = await prisma.instructionPreset.findFirstOrThrow({ where: { userId } });

      let previewUnavailable = true;
      if (viewport.name === "desktop-light") {
        await page.route(/\/api\/me\/instructions\/preview(?:\?|$)/u, route => {
          if (!previewUnavailable) return route.continue();
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "instruction_preview_unavailable" }) });
        });
      }
      await panel.getByRole("button", { name: "View instructions" }).click();
      if (viewport.name === "desktop-light") {
        await expect(preview.getByRole("alert")).toContainText("built-in instructions are unavailable");
        previewUnavailable = false;
        await preview.getByRole("button", { name: "Retry", exact: true }).click();
      }
      await expect(preview.getByText("System baseline", { exact: true })).toBeVisible();
      await expect(preview).not.toContainText(saved.systemInstructions);
      expect(await selection()).toEqual(customSelection);
      expect(await prisma.instructionPreset.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(saved);
      expect(await prisma.modelRun.count({ where: { userId } })).toBe(0);
      await manage.click();
      await expect(manage).toBeFocused();
      await expect(manage).toHaveAttribute("aria-expanded", "false");
      await manage.press("Enter");
      await panel.getByRole("button", { name: "Edit My writing" }).click();
      await panel.getByLabel("System instructions", { exact: true }).fill("Discard this change");
      await manage.click();
      await panel.getByRole("button", { name: "Discard changes" }).click();
      await expect(manage).toHaveAttribute("aria-expanded", "false");
      await expect(manage).toBeFocused();
      await manage.press("Enter");
      await expect(panel.getByRole("heading", { name: "Instruction presets" })).toBeVisible();
      await expect(panel.getByLabel("System instructions", { exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
      expect(pageErrors).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });
}
