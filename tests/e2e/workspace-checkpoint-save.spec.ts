import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { runAccountMenuAction } from "./shell/page";
import { expectCenterUnobscured } from "./support/layoutAssertions";
import {
  activeChatId, bytesFromDownload, lastAnswer, loginWithPassword, selectFakeModel, sendAndExpect, turnWorkspaceOn
} from "./support/workspace";

// Deterministic Workspace runtime and fake model: the scenario writes this
// synthetic draft and publishes it through the builtin checkpoint tool.
const DRAFT = Buffer.from("Synthetic checkpoint draft\n", "utf8");
// Every wait that could hang names its step well inside the test timeout.
const STEP_TIMEOUT = 20_000;
const prisma = new PrismaClient();
let fixture: { userId: string; policy: { enabled: boolean } } | null = null;

test.afterEach(async () => {
  // A hook, not a finally block: it gets its own budget after a test timeout
  // and needs no page. Each step runs even when an earlier one fails.
  const current = fixture;
  fixture = null;
  if (!current) return;
  const { userId, policy } = current;
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<unknown>) => { try { await step(); } catch (error) { failures.push(error); } };
  // Attachments first: their producer reference restricts run deletion, and
  // the capture cascade then stages its object cleanup.
  await attempt(() => prisma.$transaction([
    prisma.attachment.deleteMany({ where: { userId } }),
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

/** Brings a control to the middle of the conversation scroller, clear of the
 * header and composer, and proves nothing covers it before it is used. */
async function reachable(control: Locator): Promise<Locator> {
  await expect(control).toBeVisible({ timeout: STEP_TIMEOUT });
  await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await expectCenterUnobscured(control);
  return control;
}

test("saves, reuses and downloads a Workspace checkpoint draft", async ({ page }) => {
  test.setTimeout(240_000);
  const userId = randomUUID(), email = `checkpoint-save-${userId}@example.com`, password = `Synthetic-${randomUUID()}`;
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" }, select: { enabled: true } });
  fixture = { userId, policy };
  await prisma.workspacePolicy.update({ where: { id: "installation" }, data: { enabled: true } });
  await prisma.user.create({ data: { id: userId, email, displayName: "Checkpoint save test", status: "active", authIdentities: { create: {
    normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
  } } } });
  const fullAccess = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" }, select: { id: true } });
  await prisma.$transaction((tx) => provisionActiveUser(tx, { userId, groups: [{ groupId: fullAccess.id, role: "member" }] }));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });

  const { files, storageKey } = await test.step("publish a Saved draft", async () => {
    await loginWithPassword(page, { email, password });
    await selectFakeModel(page);
    await turnWorkspaceOn(page);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:checkpoint_save]", "Workspace checkpoint saved.", 90_000);
    const chatId = await activeChatId(page);
    const files = lastAnswer(page).getByRole("region", { name: "Generated files" });
    await expect(files).toContainText("Saved draft", { timeout: STEP_TIMEOUT });
    await expect(files).toContainText("draft.txt");
    const checkpoint = await prisma.workspaceOutputCheckpoint.findFirstOrThrow({
      where: { binding: { modelRun: { chatId } } }, include: { files: { include: { attachment: true } } }
    });
    expect(checkpoint.state).toBe("SETTLED");
    const storageKey = checkpoint.files[0]!.attachment.storageKey;
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(0);
    return { files, storageKey };
  });

  await test.step("download the draft bytes", async () => {
    const link = await reachable(files.getByRole("link", { name: "Download", exact: true }));
    const download = page.waitForEvent("download", { timeout: STEP_TIMEOUT });
    await link.click({ timeout: STEP_TIMEOUT });
    expect(await bytesFromDownload(await download)).toEqual(DRAFT);
  });

  await test.step("save the draft to Files", async () => {
    await (await reachable(files.getByRole("button", { name: "More actions for draft.txt", exact: true }))).click({ timeout: STEP_TIMEOUT });
    await page.getByRole("menuitem", { name: "Save to Files", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(files.getByText("Saved", { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(files.getByText("Could not save")).toHaveCount(0);
    await expect.poll(() => prisma.attachment.count({ where: { userId, storageKey, savedAt: { not: null } } }),
      { timeout: STEP_TIMEOUT }).toBe(1);
  });

  const attachments = page.getByRole("region", { name: "Attachments", exact: true }).getByRole("listitem");
  await test.step("use the draft from Export history", async () => {
    await page.getByRole("button", { name: "Chat actions", exact: true }).click({ timeout: STEP_TIMEOUT });
    await page.getByRole("menuitem", { name: "Export history", exact: true }).click({ timeout: STEP_TIMEOUT });
    const history = page.getByRole("dialog", { name: "Export history", exact: true });
    await expect(history).toContainText("draft.txt", { timeout: STEP_TIMEOUT });
    const use = history.getByRole("button", { name: "Use file", exact: true });
    await use.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT });
    await expectCenterUnobscured(use);
    await use.click({ timeout: STEP_TIMEOUT });
    await expect(history).toHaveCount(0, { timeout: STEP_TIMEOUT });
    await expect(page.getByText("This file could not be attached.")).toHaveCount(0);
    await expect(attachments).toHaveCount(1, { timeout: STEP_TIMEOUT });
  });

  await test.step("use the saved copy from the Files panel", async () => {
    await runAccountMenuAction(page, "Files");
    const saved = page.getByTestId("library-files-panel").getByRole("region", { name: "Saved files", exact: true });
    await expect(saved.getByRole("heading", { name: "draft.txt", exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(saved).toContainText("Saved");
    const use = saved.getByRole("button", { name: "Use in chat", exact: true });
    await use.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT });
    await expectCenterUnobscured(use);
    await use.click({ timeout: STEP_TIMEOUT });
    await expect(page.getByTestId("library-v2")).toHaveCount(0, { timeout: STEP_TIMEOUT });
    await expect(page.getByText("The file action failed. Try again.")).toHaveCount(0);
    await expect(attachments).toHaveCount(2, { timeout: STEP_TIMEOUT });
  });

  expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(0);
  expect(pageErrors).toEqual([]);
});
