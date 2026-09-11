import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { decryptWorkspaceSecret } from "../../lib/server/workspace/secrets/store";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { activeChatId, loginWithPassword, selectFakeModel, sendAndExpect, startNewChat, turnWorkspaceOn } from "./support/workspace";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

async function openSecrets(page: Page) {
  if (!(await page.getByRole("button", { name: "Account menu" }).isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Workspace secrets" }).click();
  await expect(page.getByTestId("workspace-secrets-panel").getByRole("button", { name: "Add secret" })).toBeEnabled();
}

for (const viewport of [{ width: 1280, height: 560, theme: "dark" }, { width: 390, height: 844, theme: "light" }] as const) {
  test(`autosaves a personal run, restores a new chat and supports session import and deletion at ${viewport.width}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const userId = randomUUID(), email = `browser-session-${userId}@example.com`, password = `Synthetic-${randomUUID()}`;
    const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" }, select: { enabled: true } });
    await prisma.workspacePolicy.update({ where: { id: "installation" }, data: { enabled: true } });
    await prisma.user.create({ data: { id: userId, email, displayName: "Browser session test", status: "active", authIdentities: { create: {
      normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
    } } } });
    const fullAccess = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" }, select: { id: true } });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId, groups: [{ groupId: fullAccess.id, role: "member" }] }));
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const rows = () => prisma.workspaceSecret.findMany({ where: { userId, browserFileName: { not: null } }, include: { value: true } });
    try {
      await page.setViewportSize(viewport);
      await page.context().addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await loginWithPassword(page, { email, password });
      await selectFakeModel(page);
      await turnWorkspaceOn(page);
      await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:browser_save]", "Workspace browser session saved.");
      const firstChat = await activeChatId(page);
      await expect.poll(async () => (await rows()).length).toBe(1);
      const [saved] = await rows();
      expect(saved!.value.autoSaved).toBe(true);
      const accepted = await prisma.workspaceRunBinding.findFirstOrThrow({ where: { modelRun: { chatId: firstChat } } });
      expect(accepted.browserSessionSave).toEqual({ saved: 1, unchanged: 0, skipped: { browser_session_invalid: 1 } });
      expect(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: accepted.modelRunId } })).toBe(0);
      await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:browser_restore]", "Workspace browser session restored.");
      expect((await rows())[0]!.valueId).toBe(saved!.valueId);

      await openSecrets(page);
      const panel = page.getByTestId("workspace-secrets-panel");
      await expect(panel.getByRole("heading", { name: "shop.example", exact: true })).toBeVisible();
      await expect(panel.getByText(/^Saved by Workspace ·/u)).toBeVisible();
      await expect(panel.getByText("shop.example.json", { exact: true })).toBeVisible();
      await expect(panel.getByText("synthetic-browser-session", { exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`browser-saved-${viewport.width}-${viewport.theme}.png`) });
      await page.getByRole("button", { name: "Close settings" }).click();
      if (!(await page.getByRole("complementary", { name: "Chat navigation" }).isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
      await startNewChat(page);
      await selectFakeModel(page);
      await expect(page.getByRole("button", { name: /^Turn off Workspace/u })).toHaveAttribute("aria-pressed", "true");
      await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:browser_restore]", "Workspace browser session restored.");
      expect(await activeChatId(page)).not.toBe(firstChat);
      await openSecrets(page);
      await panel.getByRole("button", { name: "Delete shop.example", exact: true }).click();
      await panel.getByRole("button", { name: "Delete permanently", exact: true }).click();
      await expect(panel.getByText("No saved Workspace secrets.")).toBeVisible();
      await page.getByRole("button", { name: "Close settings" }).click();
      await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:browser_missing]", "Workspace browser session absent.");
      expect(await rows()).toEqual([]);

      await openSecrets(page);
      await panel.getByRole("button", { name: "Add secret" }).click();
      await panel.getByLabel("Type", { exact: true }).selectOption("browser_session");
      await panel.getByLabel("Name", { exact: true }).fill("Imported shop session");
      const original = Buffer.from('{"cookies":[],"origins":[]}\r\n');
      await panel.getByLabel("Browser session JSON").setInputFiles({ name: "manual.example.json", mimeType: "application/json", buffer: original });
      await expect(panel.getByLabel("Session filename")).toHaveValue("manual.example.json");
      await panel.getByRole("button", { name: "Save secret" }).scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`browser-import-${viewport.width}-${viewport.theme}.png`) });
      await panel.getByRole("button", { name: "Save secret" }).click();
      await expect(panel.getByRole("heading", { name: "Imported shop session" })).toBeFocused();
      await expect(panel.getByText(/^Imported ·/u)).toBeVisible();
      const [imported] = await rows();
      expect(decryptWorkspaceSecret(imported!.value, userId).value).toEqual({ kind: "browser_session", originalName: "manual.example.json", base64: original.toString("base64") });
      await panel.getByRole("button", { name: "Edit Imported shop session" }).click();
      await expect(panel.getByLabel("Browser session JSON")).toHaveCount(0);
      await panel.getByLabel("Name", { exact: true }).fill("Renamed session");
      await panel.getByRole("button", { name: "Save secret" }).click();
      await expect(panel.getByRole("heading", { name: "Renamed session" })).toBeFocused();
      expect(decryptWorkspaceSecret((await rows())[0]!.value, userId).value).toEqual(decryptWorkspaceSecret(imported!.value, userId).value);
      expect(pageErrors).toEqual([]);
    } finally {
      // Deferred Memory source guards must observe the complete fixture deletion.
      await prisma.$transaction([
        prisma.modelRun.deleteMany({ where: { userId } }),
        prisma.chat.updateMany({ where: { userId }, data: { activeLeafMessageId: null } }),
        prisma.message.deleteMany({ where: { chat: { userId } } }),
        prisma.workspaceSession.deleteMany({ where: { chat: { userId } } }),
        prisma.chat.deleteMany({ where: { userId } }),
        prisma.user.deleteMany({ where: { id: userId } })
      ]);
      await prisma.workspacePolicy.update({ where: { id: "installation" }, data: policy });
    }
  });
}
