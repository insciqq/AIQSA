import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { activeChatId, lastAnswer, loginWithPassword, selectFakeModel, sendAndExpect } from "./support/workspace";

/**
 * Real background sub-agents end to end on a disposable stand with the fake
 * provider and the deterministic Workspace runtime (`AIQSA_TEST_MODE=1`,
 * `AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=1`): the fake main agent's scripted
 * `call_subagent` (`[AIQSA_SUBAGENT_E2E:...]`, `lib/server/providers/fakeProvider.ts`)
 * starts background runs through the real control, engine runner, store,
 * shared Workspace attachments, callbacks and wake-up turn; the chat list's
 * tree, the thread view's Stop, Stop all and the wake-up answer are the real
 * routes. The live panel's agent switch and handoff queue need a real guest
 * browser, which the deterministic runtime has not: they are covered by the
 * scripted `browser-live-agents.spec.ts` and the combined real-KVM run.
 */

const prisma = new PrismaClient();
let fixture: { userId: string; policy: { enabled: boolean } } | null = null;
const STEP_TIMEOUT = 30_000;

test.describe.configure({ mode: "serial", timeout: 300_000 });

test.afterEach(async ({ page }) => {
  const current = fixture;
  fixture = null;
  if (!current) return;
  const { userId, policy } = current;
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<unknown>) => { try { await step(); } catch (error) { failures.push(error); } };
  // Stop whatever still runs first, as the owner, so no background run writes into rows the cleanup deletes.
  await attempt(async () => {
    for (const chat of await prisma.chat.findMany({ select: { id: true }, where: { userId } })) {
      await page.request.post(`/api/chats/${chat.id}/subagents/stop-all`).catch(() => undefined);
    }
  });
  await attempt(() => prisma.$transaction([
    prisma.attachment.deleteMany({ where: { userId } }),
    prisma.subagentThread.deleteMany({ where: { userId } }),
    prisma.modelRun.deleteMany({ where: { userId } }),
    prisma.chat.updateMany({ where: { userId }, data: { activeLeafMessageId: null } }),
    prisma.message.deleteMany({ where: { chat: { userId } } }),
    prisma.workspaceSession.deleteMany({ where: { chat: { userId } } }),
    prisma.chat.deleteMany({ where: { userId } }),
    prisma.user.deleteMany({ where: { id: userId } })
  ]));
  await attempt(() => prisma.workspacePolicy.update({ where: { id: "installation" }, data: policy }));
  if (failures.length) throw failures[0];
});
test.afterAll(() => prisma.$disconnect());

async function navigation(page: Page) {
  const list = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await list.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(list).toBeVisible();
  return list;
}

async function signedInOwner(page: Page) {
  const userId = randomUUID(), email = `subagents-bg-${userId}@example.com`, password = `Synthetic-${randomUUID()}`;
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" }, select: { enabled: true } });
  fixture = { userId, policy };
  await prisma.workspacePolicy.update({ where: { id: "installation" }, data: { enabled: true } });
  await prisma.user.create({ data: { id: userId, email, displayName: "Sub-agents background test", status: "active", authIdentities: { create: {
    normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
  } } } });
  const fullAccess = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" }, select: { id: true } });
  await prisma.$transaction((tx) => provisionActiveUser(tx, { userId, groups: [{ groupId: fullAccess.id, role: "member" }] }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginWithPassword(page, { email, password });
  await selectFakeModel(page);
  return userId;
}

test("background sub-agents run, stop, wake the main agent and share the chat's Workspace", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const userId = await signedInOwner(page);

  await test.step("three background sub-agents start in one answer and the tree shows them live", async () => {
    await sendAndExpect(page, "Compare three laptop shops. [AIQSA_SUBAGENT_E2E:bg:alpha,beta,gamma:write,wait15000]",
      "Sub-agents started: alpha started; beta started; gamma started.", 90_000);
    const list = await navigation(page);
    for (const name of ["alpha", "beta", "gamma"]) {
      await expect(list.getByRole("treeitem", { name: `${name}, Running` })).toBeVisible({ timeout: STEP_TIMEOUT });
    }
    await expect(page.getByTestId("subagent-chat-status")).toContainText("3 sub-agents working", { timeout: STEP_TIMEOUT });
    await page.screenshot({ path: testInfo.outputPath("subagents-background-running.png") });
  });

  const chatId = await activeChatId(page);
  await test.step("each runs as its own run on the chat's one Workspace, its file in its own folder", async () => {
    await expect.poll(async () => prisma.modelRunToolCall.count({ where: { modelRun: { chatId, subagentTurnId: { not: null } },
      state: "complete", toolName: { contains: "sandbox_fs_write" } } }), { timeout: STEP_TIMEOUT }).toBe(3);
    const runs = await prisma.modelRun.findMany({ select: { workspaceRunBinding: { select: { workspaceSessionId: true } } },
      where: { chatId, subagentTurnId: { not: null } } });
    expect(new Set(runs.map((run) => run.workspaceRunBinding?.workspaceSessionId)).size).toBe(1);
  });

  await test.step("Stop in the thread view ends only that sub-agent", async () => {
    const list = await navigation(page);
    await list.getByRole("treeitem", { name: "beta, Running" }).click();
    const view = page.getByTestId("subagent-thread-view");
    await expect(view.getByRole("heading", { name: "beta" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(/\?agent=/u);
    await view.getByRole("button", { name: "Stop" }).click();
    await expect(list.getByRole("treeitem", { name: "beta, Stopped" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(list.getByRole("treeitem", { name: "alpha, Running" })).toBeVisible();
    await view.getByRole("link", { name: "Back to chat" }).click();
    await expect(page.getByTestId("subagent-thread-view")).toHaveCount(0);
  });

  await test.step("the others finish and the idle main agent answers their callbacks in the open chat", async () => {
    const list = await navigation(page);
    for (const name of ["alpha", "gamma"]) {
      await expect(list.getByRole("treeitem", { name: `${name}, Done` })).toBeVisible({ timeout: 60_000 });
    }
    // The wake-up turn the server started streams into the open chat without a reload.
    await expect(page.locator("[data-system-turn='subagent_callback']").last()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Wake-up answer: .*alpha done/u).last()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Wake-up answer: .*gamma done/u).last()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 60_000 });
    // Every background turn's callback reached a run of the main agent; sub-agent usage is the user's.
    await expect.poll(async () => prisma.subagentTurn.count({ where: { callbackRunId: null, chatId, mode: "background" } }),
      { timeout: STEP_TIMEOUT }).toBe(0);
    expect(await prisma.usageEvent.count({ where: { purpose: "subagent", userId } })).toBeGreaterThan(0);
    expect(await prisma.workspaceRunAttachment.count({ where: { chatId } })).toBe(0);
  });

  await test.step("Stop all ends every running sub-agent of the chat", async () => {
    await sendAndExpect(page, "Watch two more shops. [AIQSA_SUBAGENT_E2E:bg:delta,epsilon:wait90000]",
      "Sub-agents started: delta started; epsilon started.", 90_000);
    const list = await navigation(page);
    await expect(list.getByRole("treeitem", { name: "delta, Running" })).toBeVisible({ timeout: STEP_TIMEOUT });
    const status = page.getByTestId("subagent-chat-status");
    await expect(status).toContainText("2 sub-agents working", { timeout: STEP_TIMEOUT });
    await status.getByRole("button", { name: "Stop all" }).click();
    await expect(status).toHaveCount(0, { timeout: STEP_TIMEOUT });
    const shown = await navigation(page);
    if (await shown.getByRole("treeitem", { name: "delta, Stopped" }).count() === 0) {
      await shown.getByRole("button", { name: /Show sub-agents of/u }).first().click();
    }
    await expect(shown.getByRole("treeitem", { name: "delta, Stopped" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(shown.getByRole("treeitem", { name: "epsilon, Stopped" })).toBeVisible();
    await expect(lastAnswer(page)).toContainText(/Wake-up answer: .*(delta|epsilon) stopped/u, { timeout: 60_000 });
    expect(await prisma.modelRun.count({ where: { chatId, status: { in: ["preparing", "queued", "streaming", "in_progress"] },
      subagentTurnId: { not: null } } })).toBe(0);
  });

  await test.step("the tree fits a phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await navigation(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("subagents-background-phone.png") });
  });
  expect(pageErrors).toEqual([]);
});
