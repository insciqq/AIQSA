import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { loginWithPassword } from "./support/workspace";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { runAccountMenuAction } from "./shell/page";
import { assistantContentWithText } from "./shell/thread";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());
async function openInstructions(page: Page) {
  await runAccountMenuAction(page, "Settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Chat defaults" }).click();
  await expect(page.getByRole("button", { name: "Active instructions" })).toBeEnabled();
  await page.getByRole("button", { name: "Manage presets…" }).click();
}
for (const viewport of [{ width: 1280, height: 800, theme: "dark" }, { width: 390, height: 844, theme: "light" }] as const) {
  test(`instruction editor, conflict, selection and containment at ${viewport.width}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000); page.setDefaultTimeout(15_000);
    const userId = randomUUID(), email = `instructions-${userId}@example.com`, password = `Synthetic-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, email, displayName: "Instructions test", status: "active", authIdentities: { create: {
      normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
    } } } });
    await prisma.$transaction(tx => provisionActiveUser(tx, { userId }));
    await prisma.accessGrant.create({ data: { userId, providerModelId: providerTemplateIds.fakeModel } });
    await prisma.userMemorySettings.update({ where: { userId }, data: { useMemoryFacts: false, referenceChatHistory: false, learnAutomatically: false } });
    let pageErrors = 0; page.on("pageerror", () => pageErrors++);
    try {
      await page.setViewportSize(viewport);
      await page.context().addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await loginWithPassword(page, { email, password }); await openInstructions(page);
      const panel = page.getByTestId("settings-instructions");
      await panel.getByRole("button", { name: "New preset" }).click();
      await expect(panel.getByLabel("Name", { exact: true })).toBeFocused();
      await panel.getByLabel("Name", { exact: true }).fill("Writing");
      const longText = "# Writing instructions\n" + ("Кратко🙂 ".repeat(100) + "\n").repeat(35);
      const reminderText = "Напоминание".repeat(350);
      expect(Buffer.byteLength(JSON.stringify({ systemInstructions: longText, responseReminder: reminderText }), "utf8")).toBeGreaterThan(65_536);
      await panel.getByLabel("System instructions", { exact: true }).fill(longText);
      const textarea = panel.getByLabel("System instructions", { exact: true });
      expect(await textarea.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await expectNoHorizontalOverflow(page);
      await panel.getByText("Response reminder (optional)", { exact: true }).click();
      await panel.getByLabel("Response reminder", { exact: true }).fill(reminderText);
      await panel.getByRole("button", { name: "Preview", exact: true }).click();
      await expect(panel.getByRole("heading", { name: "Writing instructions" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await panel.getByRole("button", { name: "Write", exact: true }).click();
      await textarea.scrollIntoViewIfNeeded();
      await textarea.focus();
      await expect.poll(() => textarea.evaluate(node => ({
        innerOutlineColor: getComputedStyle(node).outlineColor,
        innerShadow: getComputedStyle(node).boxShadow,
        outerOutline: getComputedStyle(node.parentElement!).outlineWidth,
        outerRadius: getComputedStyle(node.parentElement!).borderTopLeftRadius
      }))).toEqual({ innerOutlineColor: "rgba(0, 0, 0, 0)", innerShadow: "none", outerOutline: "2px", outerRadius: "12px" });
      await page.screenshot({ path: testInfo.outputPath("instruction-editor.png") });
      await textarea.focus(); await textarea.press("Control+s");
      await expect(panel.getByText(/Preset saved/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "New preset" })).toBeFocused();
      expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).activeInstructionPresetId).toBeNull();
      await panel.getByRole("button", { name: "Make active: Writing", exact: true }).click();
      await expect(panel.getByText(/Instructions updated for your next reply/)).toBeVisible();
      const saved = await prisma.instructionPreset.findFirstOrThrow({ where: { userId } });
      expect(saved.systemInstructions).toBe(longText);
      expect(saved.responseReminder).toBe(reminderText);
      expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).activeInstructionPresetId).toBe(saved.id);
      await expect(panel.getByRole("button", { name: "Active instructions" })).toContainText("Writing");
      await expect(panel.getByLabel("Active instructions: Writing", { exact: true })).toBeFocused();
      await panel.getByRole("button", { name: "Make active: AIQSA default instructions", exact: true }).click();
      await expect(panel.getByLabel("Active instructions: AIQSA default instructions", { exact: true })).toBeFocused();
      expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).activeInstructionPresetId).toBeNull();
      await panel.getByRole("button", { name: "Make active: Writing", exact: true }).click();
      await expect(panel.getByLabel("Active instructions: Writing", { exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("instruction-preset-activation.png") });

      // Exercise the Assistant field and a real accepted fake-provider run while
      // the personal preset is active: only the Assistant instructions apply.
      await page.goto("/");
      const catalog = await (await page.request.get("/api/me/catalog")).json();
      const model = catalog.catalog.models.find((entry: { providerFamily: string; upstreamModelId: string }) =>
        entry.providerFamily === "fake" && entry.upstreamModelId === "fake-qsa");
      expect(model).toBeTruthy();
      await runAccountMenuAction(page, "Assistants");
      const library = page.getByTestId("library-v2");
      await library.getByRole("button", { name: "New assistant", exact: true }).first().click();
      const assistant = library.getByTestId("assistant-editor");
      await assistant.getByLabel("Name Required", { exact: true }).fill("Reminder assistant");
      await assistant.getByLabel("Model", { exact: true }).selectOption(model.modelId);
      await assistant.getByLabel("Assistant instructions").fill("Use the Assistant style.");
      await assistant.getByText("Response reminder (optional)", { exact: true }).click();
      await assistant.getByLabel("Response reminder", { exact: true }).fill("End with the Assistant next step.");
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath("assistant-reminder.png") });
      await assistant.getByText("Starter prompts", { exact: true }).click();
      await assistant.getByRole("button", { name: "Add starter" }).click();
      await assistant.getByLabel("Starter prompt 1", { exact: true }).fill("Say hello");
      await assistant.getByTestId("assistant-editor-save").click();
      await expect(assistant.getByRole("status")).toContainText("Assistant created");
      const definition = await prisma.assistantDefinition.findFirstOrThrow({ where: { ownerUserId: userId } });
      const copied = await page.request.post(`/api/me/assistants/${definition.id}/duplicate`);
      expect(copied.status()).toBe(201);
      expect(await copied.json()).toMatchObject({ assistant: { content: { responseReminder: "End with the Assistant next step." } } });
      await assistant.getByRole("button", { name: "Use in chat", exact: true }).click();
      await page.getByTestId("assistant-starter-prompts").getByRole("button", { name: "Say hello" }).click();
      await expect(assistantContentWithText(page, "Fake answer: Say hello")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);
      const run = await prisma.modelRun.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
      expect(run.normalizedRequest).toMatchObject({ prompt: {
        system: expect.stringMatching(/^Use the Assistant style\./u),
        responseReminder: "End with the Assistant next step."
      } });
      expect(run.normalizedRequest).not.toHaveProperty("instructionPreset");
      expect(JSON.stringify(run.normalizedRequest)).not.toContain(longText);
      expect(await prisma.message.count({ where: { chatId: run.chatId } })).toBe(2);
      await page.reload(); await openInstructions(page);

      await panel.getByRole("button", { name: "Edit Writing" }).click();
      await panel.getByLabel("System instructions", { exact: true }).fill("Unsaved local text");
      const update = await page.request.post("/api/me/instructions", { data: { action: "update", id: saved.id, revision: saved.revision,
        value: { name: "Writing", systemInstructions: "Changed in another tab", responseReminder: saved.responseReminder } } });
      expect(update.status()).toBe(200);
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("changed elsewhere");
      await expect(panel.getByLabel("System instructions", { exact: true })).toHaveValue("Unsaved local text");
      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "General", exact: true }).click();
      const discard = page.getByRole("alertdialog", { name: "Unsaved instructions" });
      await expect(discard).toBeVisible(); await discard.getByRole("button", { name: "Keep editing" }).click();
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await panel.getByRole("button", { name: "Discard changes" }).click();
      await panel.getByRole("button", { name: "Edit Writing" }).click();
      await expect(panel.getByLabel("System instructions", { exact: true })).toHaveValue("Changed in another tab");
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      // Refresh metadata after the concurrent edit before deleting by revision.
      await page.reload(); await openInstructions(page);
      await panel.getByRole("button", { name: "Delete Writing" }).click();
      await expect(panel.getByText(/Your chats will use the AIQSA default instructions/)).toBeVisible();
      const remove = panel.getByRole("button", { name: "Delete preset", exact: true });
      await remove.scrollIntoViewIfNeeded(); await expectWithinViewport(page, remove); await remove.click();
      await expect(panel.getByRole("button", { name: "Edit Writing" })).toHaveCount(0);
      expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).activeInstructionPresetId).toBeNull();
      await expectNoHorizontalOverflow(page); expect(pageErrors).toBe(0);
    } finally {
      await prisma.$transaction([
        prisma.modelRun.deleteMany({ where: { userId } }),
        prisma.chat.updateMany({ where: { userId }, data: { activeLeafMessageId: null } }),
        prisma.message.deleteMany({ where: { chat: { userId } } }),
        prisma.workspaceSession.deleteMany({ where: { chat: { userId } } }),
        prisma.chat.deleteMany({ where: { userId } }),
        prisma.assistantDefinition.deleteMany({ where: { ownerUserId: userId } }),
        prisma.user.deleteMany({ where: { id: userId } })
      ]);
    }
  });
}
