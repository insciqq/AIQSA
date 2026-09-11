import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { activeChatId, loginWithPassword, selectFakeModel, sendAndExpect, startNewChat } from "./support/workspace";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("remembers explicit Workspace choices across chats and login, with account isolation and save retry", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const users = [0, 1].map(() => {
    const id = randomUUID();
    return { id, email: `workspace-default-${id}@example.test`, password: `Synthetic-${randomUUID()}` };
  });
  const userIds = users.map((user) => user.id);
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" }, select: { enabled: true } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const savedChoice = async (userId = users[0]!.id) => (await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).defaultWorkspaceEnabled;
  const on = page.getByRole("button", { name: /^Turn off Workspace/u });
  const off = page.getByRole("button", { name: /^Turn on Workspace/u });
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
    await selectFakeModel(page);
    await expect(off).toHaveAttribute("aria-pressed", "false");
    await sendAndExpect(page, "Workspace default fixture", "Fake answer: Workspace default fixture");
    const originalChat = await activeChatId(page);
    await startNewChat(page);
    await selectFakeModel(page);
    let failSave = true;
    await page.route("**/api/me/settings", async (route) => {
      if (failSave && route.request().postDataJSON()?.defaultWorkspaceEnabled === true) {
        failSave = false;
        await route.fulfill({ status: 503, json: { error: "settings_update_failed_503" } });
      } else await route.continue();
    });
    await off.click();
    await expect(on).toBeEnabled();
    await expect(page.getByRole("alert").filter({ hasText: "settings_update_failed_503" })).toBeVisible();
    expect(await savedChoice()).toBe(false);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(savedChoice).toBe(true);
    await startNewChat(page);
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await selectFakeModel(page);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:browser_missing]", "Workspace browser session absent.");
    const enabledChat = await activeChatId(page);
    expect(enabledChat).not.toBe(originalChat);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: enabledChat } })).workspaceEnabled).toBe(true);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: originalChat } })).workspaceEnabled).toBe(false);
    await startNewChat(page);
    await page.reload();
    await selectFakeModel(page);
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: testInfo.outputPath("workspace-default-enabled.png") });

    await page.request.post("/api/auth/logout", { data: {} });
    await loginWithPassword(page, users[1]!);
    await startNewChat(page);
    await selectFakeModel(page);
    await expect(off).toHaveAttribute("aria-pressed", "false");
    expect(await savedChoice(users[1]!.id)).toBe(false);
    await page.request.post("/api/auth/logout", { data: {} });
    await loginWithPassword(page, users[0]!);
    await startNewChat(page);
    await selectFakeModel(page);
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await on.click();
    await expect.poll(savedChoice).toBe(false);
    await startNewChat(page);
    await page.reload();
    await selectFakeModel(page);
    await expect(off).toHaveAttribute("aria-pressed", "false");
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: enabledChat } })).workspaceEnabled).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace-default-disabled.png") });
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
