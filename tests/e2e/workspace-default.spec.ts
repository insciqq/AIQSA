import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { activeChatId, loginWithPassword, selectFakeModel, sendAndExpect, startNewChat } from "./support/workspace";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("uses Workspace in interactive chats even when the saved default and the chat's stored flag are off", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const users = [0].map(() => {
    const id = randomUUID();
    return { id, email: `workspace-default-${id}@example.test`, password: `Synthetic-${randomUUID()}` };
  });
  const userIds = users.map((user) => user.id);
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" }, select: { enabled: true } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await prisma.workspacePolicy.update({ where: { id: "installation" }, data: { enabled: true } });
    const group = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" }, select: { id: true } });
    for (const user of users) {
      await prisma.user.create({ data: { id: user.id, email: user.email, displayName: "Workspace preference test", status: "active", authIdentities: { create: {
        normalizedEmail: user.email, provider: "password", providerAccountId: user.email,
        passwordHash: await hashPassword(user.password), emailVerifiedAt: new Date()
      } } } });
      await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: user.id, groups: [{ groupId: group.id, role: "member" }] }));
    }
    await loginWithPassword(page, users[0]!);
    // Workspace is ambient (operator, 2026-10-20): a saved default of off no
    // longer decides it, and the composer shows no Workspace chip.
    await prisma.userSettings.update({ where: { userId: users[0]!.id }, data: { defaultWorkspaceEnabled: false } });
    await page.reload();
    await selectFakeModel(page);
    await expect(page.getByRole("button", { name: /^Workspace details/u })).toHaveCount(0);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:browser_missing]", "Workspace browser session absent.");
    const chatId = await activeChatId(page);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).workspaceEnabled).toBe(true);

    // An old chat stored with Workspace off uses it on its next send.
    await prisma.chat.update({ where: { id: chatId }, data: { workspaceEnabled: false } });
    await page.reload();
    await selectFakeModel(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("[AIQSA_WORKSPACE_E2E:browser_missing]");
    await composer.press("Enter");
    const answers = page.locator('article[data-role="assistant"]');
    await expect(answers).toHaveCount(2, { timeout: 45_000 });
    await expect(answers.last()).toContainText("Workspace browser session absent.", { timeout: 45_000 });
    await expect.poll(async () => (await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).workspaceEnabled).toBe(true);
    await startNewChat(page);
    await page.screenshot({ path: testInfo.outputPath("workspace-ambient.png") });
    expect(pageErrors).toEqual([]);
  } finally {
    // Deferred Memory source guards must observe the complete fixture deletion.
    await prisma.$transaction([
      prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } }),
      prisma.chat.updateMany({ where: { userId: { in: userIds } }, data: { activeLeafMessageId: null } }),
      prisma.message.deleteMany({ where: { chat: { userId: { in: userIds } } } }),
      prisma.workspaceSession.deleteMany({ where: { chat: { userId: { in: userIds } } } }),
      prisma.chat.deleteMany({ where: { userId: { in: userIds } } }),
      prisma.user.deleteMany({ where: { id: { in: userIds } } })
    ]);
    await prisma.workspacePolicy.update({ where: { id: "installation" }, data: policy });
  }
});
