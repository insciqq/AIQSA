import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, lastAnswer, sendAndExpect, startNewChat } from "./support/workspace";

/**
 * "Report a problem…" on the fake-provider stand: the bootstrap administrator
 * reports a problem on their own answer, updates it, and finds it in Control
 * Center Health with its model, run reference and comment. The phone cases
 * check the dialog's containment and touch targets. Refusals (invisible
 * answers, former Project members, limits) are proven by the route and
 * repository suites.
 */

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const userId = DEFAULT_BOOTSTRAP_USER_ID;
const COMMENT = `It quoted a policy that does not exist (${Date.now()}).`;
const NOTICE = "Administrators will see this report. Your question and the answer are not attached.";
const chatIds = new Set<string>();
let chatId: string | null = null;
let restoreDefaults: (() => Promise<void>) | null = null;

test.beforeAll(() => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
});

test.afterAll(async () => {
  const ids = [...chatIds];
  if (ids.length > 0) {
    // Removing the chats removes their reports with their messages.
    await prisma.$transaction(async (tx) => {
      await tx.modelRun.deleteMany({ where: { chatId: { in: ids } } });
      await tx.memoryJob.deleteMany({ where: { chatId: { in: ids }, userId } });
      await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: ids }, userId } });
      await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: ids }, userId } });
      await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId: { in: ids } } });
      await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId: { in: ids } } });
      await tx.chat.deleteMany({ where: { id: { in: ids }, userId } });
    });
    expect(await prisma.answerProblemReport.count({ where: { chatId: { in: ids } } })).toBe(0);
  }
  await restoreDefaults?.();
  await prisma.$disconnect();
});

async function openReportDialog(page: Page, answer: Locator, input: "click" | "tap" = "click"): Promise<Locator> {
  const more = answer.getByRole("button", { name: "More answer actions" });
  if (input === "tap") {
    await more.scrollIntoViewIfNeeded();
    await more.tap();
  } else {
    await answer.hover();
    await more.click();
  }
  const menu = page.getByRole("menu", { name: "Answer menu" });
  await expect(menu.getByRole("menuitem")).toContainText(["Report a problem…"]);
  const item = menu.getByRole("menuitem", { name: "Report a problem…" });
  if (input === "tap") await item.tap();
  else await item.click();
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a user reports a problem on an answer, updates it, and an administrator finds it in Health", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  restoreDefaults = await snapshotComposerDefaults(prisma, userId);
  await signInWithLocalToken(page);
  await disableMemoryRecall(page);
  await startNewChat(page);
  await turnComposerToolsOff(page);
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
  await sendAndExpect(page, "Problem report fixture question", "Fake answer:");
  chatId = await activeChatId(page);
  chatIds.add(chatId);

  // Keyboard: the first reason has focus; Space chooses it, Tab reaches the comment.
  let dialog = await openReportDialog(page, lastAnswer(page));
  await expect(dialog.getByRole("radiogroup", { name: "What went wrong?" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Wrong or made-up answer" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("radio", { name: "Wrong or made-up answer" })).toBeChecked();
  await page.keyboard.press("Tab");
  const comment = dialog.getByRole("textbox", { name: "Comment (optional)" });
  await expect(comment).toBeFocused();
  await expect(comment).toHaveAccessibleDescription(NOTICE);
  await page.keyboard.type(COMMENT);
  await dialog.getByRole("button", { name: "Send" }).click();
  // A fresh dev server compiles the report route on its first request.
  await expect(page.getByTestId("shell-notice")).toContainText("Report sent. Thank you.", { timeout: 30_000 });
  await expect(dialog).toHaveCount(0);
  await expect(lastAnswer(page).getByRole("button", { name: "More answer actions" })).toBeFocused();

  const created = await prisma.answerProblemReport.findMany({ where: { chatId } });
  expect(created).toEqual([expect.objectContaining({ comment: COMMENT, reason: "wrong_or_made_up", userId })]);
  expect(created[0]!.runId).toMatch(/^[0-9a-f-]{36}$/u);

  // Reopening shows the saved report with Update; Escape closes without sending.
  dialog = await openReportDialog(page, lastAnswer(page));
  await expect(dialog.getByRole("button", { name: "Update" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Wrong or made-up answer" })).toBeChecked();
  await expect(comment).toHaveValue(COMMENT);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  dialog = await openReportDialog(page, lastAnswer(page));
  await dialog.getByRole("radio", { name: "Didn't do what I asked" }).check();
  await dialog.getByRole("button", { name: "Update" }).click();
  await expect(page.getByTestId("shell-notice")).toContainText("Report updated.");
  const updated = await prisma.answerProblemReport.findMany({ where: { chatId } });
  expect(updated).toEqual([expect.objectContaining({ comment: COMMENT, id: created[0]!.id, reason: "did_not_follow_request" })]);

  await page.goto("/admin?section=health");
  const reports = page.getByTestId("admin-health-problem-reports");
  const row = reports.getByTestId("admin-health-problem-report").filter({ hasText: COMMENT });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Didn't do what I asked");
  await expect(row).toContainText("Fake QSA");
  await expect(row).not.toContainText("Problem report fixture question");
  await expect(row).not.toContainText("Fake answer:");
  const runId = updated[0]!.runId!;
  await row.getByRole("button", { name: `Look up run ${runId.slice(0, 8)}` }).click();
  await expect(page.getByTestId("admin-health-run").filter({ hasText: runId })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

for (const viewport of [{ height: 844, name: "phone portrait", width: 390 }, { height: 390, name: "phone landscape", width: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { height: viewport.height, width: viewport.width } });

    test("fits the dialog in the viewport with touch-sized reasons and actions", async ({ page }) => {
      test.skip(chatId === null, "needs the reported chat from the first test");
      await signInWithLocalToken(page, `/c/${chatId}`);
      const answer = lastAnswer(page);
      await expect(answer).toContainText("Fake answer:");
      await answer.scrollIntoViewIfNeeded();
      const dialog = await openReportDialog(page, answer, "tap");
      await expect(dialog.getByRole("button", { name: "Update" })).toBeVisible();
      await expectWithinViewport(page, dialog);
      await expectNoHorizontalOverflow(page);
      for (const reason of ["Wrong or made-up answer", "Too slow", "Other"]) {
        await dialog.locator("label").filter({ hasText: reason }).scrollIntoViewIfNeeded();
        await expectTouchSafe(dialog.locator("label").filter({ hasText: reason }));
      }
      for (const name of ["Cancel", "Update"]) {
        await dialog.getByRole("button", { name }).scrollIntoViewIfNeeded();
        await expectTouchSafe(dialog.getByRole("button", { name }));
      }
      // The comment field is 16px so phones do not zoom into it.
      expect(await dialog.getByRole("textbox", { name: "Comment (optional)" })
        .evaluate((field) => getComputedStyle(field).fontSize)).toBe("16px");
      await dialog.getByRole("button", { name: "Cancel" }).tap();
      await expect(dialog).toHaveCount(0);
    });
  });
}
