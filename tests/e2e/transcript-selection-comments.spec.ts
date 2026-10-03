import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Catalog } from "../../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "comments-selection-chat";
const answerId = "comments-selection-answer";
const questionId = "comments-selection-question";
const timestamp = "2026-09-30T00:00:00.000Z";
const answerText = "Finished answer to quote.";
const questionText = "Finished question to quote.";

test.setTimeout(90_000);

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

function markdown(page: Page, id = answerId) {
  return page.locator(`article[data-message-id="${id}"] .v2-conversation-markdown`);
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, status: "complete", createdAt: timestamp,
    citationMessageId: null, errorMessage: null, modelId: null, modelRunId: null, provider: null };
}

async function prepare(page: Page, content = answerText, options: { temporary?: boolean; secondChat?: boolean } = {}): Promise<ChatDetailWire> {
  const memoryMode = options.temporary ? "TEMPORARY" : "NORMAL";
  const temporaryRetentionDeadline = options.temporary ? new Date(Date.now() + 86_400_000).toISOString() : null;
  const chat: ChatDetailWire = {
    assistant: null, id: chatId, title: "Selection comments", createdAt: timestamp, updatedAt: timestamp,
    activeLeafMessageId: answerId, defaultModelId: matrixCatalog.models[0]!.modelId,
    defaultProvider: matrixCatalog.models[0]!.provider, folderId: null, pinned: false, messageCount: 2,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: 100 },
    pageInfo: { activeLeafMessageId: answerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: [message(questionId, "user", questionText, null), {
      ...message(answerId, "assistant", content, questionId),
      artifactSummary: { citations: [], sources: [], reasoningText: ["Private reasoning stays outside the quoted answer."] }
    }]
  };
  const catalog: Catalog = structuredClone(matrixCatalog);
  catalog.defaults.showReasoningBlocks = true;
  const chats = [chat];
  if (options.secondChat) chats.push({ ...chat, id: `${chatId}-other`, title: "Other conversation" });
  await installMatrixCatalogFixture(page, { chats, folders: [] }, { catalog });
  if (options.temporary) {
    // Temporary chats are recovered from their URL and Memory classification;
    // the real personal-history endpoint never lists them.
    await page.route("**/api/chats", route => route.request().method() === "GET"
      ? route.fulfill({ json: { chats: [], folders: [], contentMatches: [] } }) : route.fallback());
  }
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", route => route.fulfill({ json: {
    allowedActions: options.temporary ? [] : ["EXCLUDE"], archived: false, mode: memoryMode,
    temporaryRetentionDeadline
  } }));
  // A missed stream interception must never reach a provider.
  await page.route("**/api/chats/*/messages", route => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(markdown(page)).toContainText(content.split("\n")[0]!.replace(/^#+ /u, "").replace(/[*_~`]/gu, ""));
  await expect(composer(page)).toBeVisible();
  return chat;
}

async function selectContents(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(async element => {
    // Let the scroll event dismiss an older toolbar before creating this range.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    // Outlast the 250 ms settle delay of a selection made without a mouse drag.
    await new Promise<void>(resolve => setTimeout(resolve, 300));
  });
}

async function addComment(page: Page, text: string, index = 0, save: "button" | "enter" | "outside" = "button") {
  await selectContents(markdown(page).locator("p").nth(index));
  await expect(page.getByRole("button", { name: "Quote", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add comment", exact: true });
  const field = dialog.getByRole("textbox", { name: "Comment", exact: true });
  await expect(field).toBeFocused();
  await field.fill(text);
  if (save === "enter") await field.press("Enter");
  else if (save === "outside") await page.getByRole("button", { name: "Save and close comment" }).click({ position: { x: 4, y: 4 }, force: true });
  else await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function storedDraftIncludes(page: Page, text: string) {
  return page.evaluate(value => Object.keys(localStorage)
    .some(key => key.startsWith("aiqsa.composerDrafts.v1:") && Boolean(localStorage.getItem(key)?.includes(value))), text);
}

test("queues comments, edits and deletes, restores on reload, and sends the exact multi-quote once", async ({ page }, testInfo) => {
  const chat = await prepare(page, "**First** selected fragment.\n\n*Second* selected fragment.\n\nThird selected fragment.");
  await addComment(page, "First comment", 0, "enter");
  await addComment(page, "Second comment", 1, "outside");
  await addComment(page, "Third comment", 2);
  const chip = page.getByRole("button", { name: "3 comments", exact: true });
  await expect(chip).toBeVisible();
  await composer(page).fill("Additional request");
  await page.reload();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(composer(page)).toHaveValue("Additional request");
  await chip.click();
  const list = page.getByRole("dialog", { name: "Comments", exact: true });
  await expect(list).toContainText("First comment");
  await expect(list).toContainText("Second comment");
  await expect(list).toContainText("Third comment");
  // Formatted fragments are queued as plain text.
  const quotes = list.locator(".v2-composer-comment-quote");
  await expect(quotes.nth(0)).toHaveText("First selected fragment.");
  await expect(quotes.nth(1)).toHaveText("Second selected fragment.");
  await expect(list).not.toContainText("**");
  await list.getByRole("button", { name: /Edit/u }).first().click();
  const edit = list.getByRole("textbox", { name: "Comment", exact: true });
  await edit.fill("Edited first comment");
  await list.getByRole("button", { name: "Save", exact: true }).click();
  await list.getByRole("button", { name: /Delete/u }).last().click();
  await expect(list).toContainText("2 comments");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByRole("button", { name: "2 comments", exact: true })).toBeVisible();
  const rejected = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/chats/${chatId}/messages`));
  await composer(page).press("Enter");
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole("button", { name: "2 comments", exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue("Additional request");
  const expectedText = "> First selected fragment.\n\nEdited first comment\n\n> Second selected fragment.\n\nSecond comment\n\nAdditional request";
  const runId = "comments-send-run", sentQuestionId = "comments-sent-question", sentAnswerId = "comments-sent-answer";
  const messages = [...chat.messages, message(sentQuestionId, "user", expectedText, answerId), {
    ...message(sentAnswerId, "assistant", "Both comments received.", sentQuestionId), modelRunId: runId
  }];
  const settledChat: ChatDetailWire = { ...chat, activeLeafMessageId: sentAnswerId, messageCount: messages.length,
    messages, pageInfo: { ...chat.pageInfo!, activeLeafMessageId: sentAnswerId } };
  const submittedBodies: unknown[] = [];
  await page.route(`**/api/chats/${chatId}/messages`, async route => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    submittedBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: [
      ["run_start", { provider: chat.defaultProvider, modelId: chat.defaultModelId, runId, status: "streaming" }],
      ["message_start", { assistantMessageId: sentAnswerId, userMessageId: sentQuestionId }],
      ["chat_update", { chat: settledChat, messages }],
      ["done", { runId, status: "complete" }]
    ].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("") });
  });
  await page.route(`**/api/chats/${chatId}`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: settledChat } }) : route.fallback());
  await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({ json: { version: 1,
    run: { id: runId, status: "complete" } } }));
  const settled = page.waitForResponse(response => response.url().endsWith(`/api/model-runs/${runId}`));
  await composer(page).press("Enter");
  expect((await settled).status()).toBe(200);
  await expect(markdown(page, sentAnswerId)).toHaveText("Both comments received.");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  expect(submittedBodies).toHaveLength(1);
  expect(submittedBodies[0]).toMatchObject({ content: { blocks: [{ type: "text", text: expectedText }] } });
  await expect(page.getByRole("button", { name: "2 comments", exact: true })).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
  const sent = markdown(page, sentQuestionId);
  await expect(sent.locator("blockquote")).toHaveCount(2);
  await expect(sent).toContainText("Edited first comment");
  await expect(sent).toContainText("Second comment");
  await expect(sent).toContainText("Additional request");
  await expect(sent).not.toContainText("Third comment");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("comments-sent.png") });
  await page.reload();
  await expect(markdown(page, sentAnswerId)).toHaveText("Both comments received.");
  await expect(page.getByRole("button", { name: "2 comments", exact: true })).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
});

test("comment IME Escape preserves input and backward Tab stays inside the edited list", async ({ page }, testInfo) => {
  await prepare(page);
  await selectContents(markdown(page));
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add comment", exact: true });
  const field = form.getByRole("textbox", { name: "Comment", exact: true });
  await field.fill("入力中のコメント");
  // Exercise browser event bubbling; native IME composition cannot be driven
  // by Playwright keyboard, so both supported composition signals are explicit.
  for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
    await field.dispatchEvent("keydown", { key: "Escape", bubbles: true, ...signal });
    await expect(field).toHaveValue("入力中のコメント");
    await expect(field).toBeFocused();
  }
  await field.press("Escape");
  await expect(form).toHaveCount(0);
  await addComment(page, "Saved comment");
  await page.getByRole("button", { name: "1 comment", exact: true }).click();
  const list = page.getByRole("dialog", { name: "Comments", exact: true });
  const close = list.getByRole("button", { name: "Close comments", exact: true });
  await list.getByRole("button", { name: "Edit comment 1", exact: true }).click();
  const edit = list.getByRole("textbox", { name: "Comment", exact: true });
  await edit.fill("入力中の変更");
  for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
    await edit.dispatchEvent("keydown", { key: "Escape", bubbles: true, ...signal });
    await expect(edit).toHaveValue("入力中の変更");
    await expect(edit).toBeFocused();
  }
  await edit.press("Escape");
  await expect(list).toContainText("Saved comment");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(list.getByRole("button", { name: "Delete comment 1", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await list.getByRole("button", { name: "Edit comment 1", exact: true }).click();
  await edit.fill("Saved revision");
  await edit.press("Enter");
  await expect(close).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("comment-edit-restored-focus.png") });
  await page.keyboard.press("Shift+Tab");
  await expect(list.getByRole("button", { name: "Delete comment 1", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeFocused();
});

test("temporary comments stay volatile across reload", async ({ page }) => {
  await prepare(page, answerText, { temporary: true });
  await addComment(page, "Temporary comment must not be stored");
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeVisible();
  await composer(page).fill("Temporary text");
  await page.reload();
  await expect(markdown(page)).toContainText(answerText);
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
  expect(await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith("aiqsa.composerDrafts.v1:"))
    .some(key => localStorage.getItem(key)?.includes("Temporary comment must not be stored")))).toBe(false);
});

test("chat navigation isolates comments and explicit sign-out removes them", async ({ page }) => {
  await prepare(page, answerText, { secondChat: true });
  await addComment(page, "Keep this in its own conversation");
  await page.goto(`/c/${chatId}-other`);
  await expect(markdown(page)).toContainText(answerText);
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toHaveCount(0);
  await page.goto(`/c/${chatId}`);
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeVisible();
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Account", exact: true }).click();
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(markdown(page)).toContainText(answerText);
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toHaveCount(0);
});

test("keeps comments when their complete follow-up exceeds the limit", async ({ page }, testInfo) => {
  const runId = "comments-followup-run", activeAnswerId = "comments-followup-answer", activeQuestionId = "comments-followup-question";
  const stream = createGatedRunStreamFixture({ key: "comments-followup", abortMessage: "Synthetic comments follow-up stopped", notReadyError: "comments_stream_not_ready" });
  await stream.install(page, chatId);
  const chat = await prepare(page);
  let runStatus = "streaming";
  let followupPosts = 0;
  await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({ json: { version: 1, run: { id: runId, status: runStatus } } }));
  await page.route(`**/api/model-runs/${runId}/followups`, route => {
    if (route.request().method() !== "POST") return route.fallback();
    followupPosts += 1;
    return route.fulfill({ status: 409, json: { error: "unexpected_fixture_followup" } });
  });
  await composer(page).fill("Start answer");
  await composer(page).press("Enter");
  await stream.waitForRequestCount(page, 1);
  await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
  await stream.emit(page, "message_start", { assistantMessageId: activeAnswerId, userMessageId: activeQuestionId });
  const activeAnswer: ChatMessageWire = { ...message(activeAnswerId, "assistant", "Answer in progress", activeQuestionId),
    status: "streaming", modelRunId: runId, followups: { available: true, entries: [] } };
  const messages = [...chat.messages, message(activeQuestionId, "user", "Start answer", answerId), activeAnswer];
  await stream.emit(page, "chat_update", { chat: { ...chat, activeLeafMessageId: activeAnswerId, messageCount: messages.length }, messages });
  await expect(composer(page)).toHaveAttribute("placeholder", "Follow up…");
  await addComment(page, "Preserved pending comment");
  await composer(page).fill("x".repeat(15990));
  await expect(page.getByRole("button", { name: "Send follow-up", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "edit or delete a comment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeVisible();
  await composer(page).press("Enter");
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue("x".repeat(15990));
  await page.screenshot({ path: testInfo.outputPath("comments-followup-limit.png") });
  expect(followupPosts).toBe(0);
  runStatus = "complete";
  await stream.emit(page, "chat_update", { chat: { ...chat, activeLeafMessageId: activeAnswerId, messageCount: messages.length },
    messages: messages.map(item => item.id === activeAnswerId ? { ...item, status: "complete", followups: { available: false, entries: [] } } : item) });
  await stream.emit(page, "done", { runId, status: "complete" });
  await stream.close(page);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  expect(followupPosts).toBe(0);
});

test("comments a long fragment whole, keeps a list edit on outside click and stops at the count bound", async ({ page }, testInfo) => {
  const fragment = `Long fragment ${"word ".repeat(2_000)}end.`;
  const longComment = "c".repeat(5_000);
  await prepare(page, fragment);
  await selectContents(markdown(page));
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add comment", exact: true });
  const field = form.getByRole("textbox", { name: "Comment", exact: true });
  await expect(field).not.toHaveAttribute("maxlength");
  await field.fill(longComment);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  const chip = page.getByRole("button", { name: "1 comment", exact: true });
  await chip.click();
  const list = page.getByRole("dialog", { name: "Comments", exact: true });
  await expect(list.locator(".v2-composer-comment-text")).toHaveText(longComment);
  expect((await list.locator(".v2-composer-comment-quote").textContent())!.length).toBeGreaterThanOrEqual(10_000);
  await list.getByRole("button", { name: "Edit comment 1", exact: true }).click();
  await list.getByRole("textbox", { name: "Comment", exact: true }).fill("Edited, then clicked outside");
  await page.locator(".v2-composer-comments-scrim").click({ position: { x: 4, y: 4 }, force: true });
  await expect(list).toHaveCount(0);
  await chip.click();
  await expect(list).toContainText("Edited, then clicked outside");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  // Seed the stored record up to the count bound, then reload it.
  await expect.poll(() => storedDraftIncludes(page, "Edited, then clicked outside")).toBe(true);
  await page.evaluate(sessionKey => {
    const key = Object.keys(localStorage).find(name => name.startsWith("aiqsa.composerDrafts.v1:"))!;
    const entry = JSON.parse(localStorage.getItem(key)!) as { records: { sessionKey: string; comments?: unknown[] }[] };
    entry.records.find(record => record.sessionKey === sessionKey)!.comments = Array.from({ length: 100 }, (_, index) => ({
      id: `seeded-${index}`, quote: `Seeded fragment ${index}`, text: `Seeded comment ${index}`
    }));
    localStorage.setItem(key, JSON.stringify(entry));
  }, `chat:${chatId}`);
  await page.reload();
  await expect(page.getByRole("button", { name: "100 comments", exact: true })).toBeVisible({ timeout: 30_000 });
  await selectContents(markdown(page));
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already has 100 pending comments. Send them or delete one" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Add comment", exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("comment-count-bound-notice.png") });
});

test("keeps the last stored copy when unsent input outgrows the browser record", async ({ page }, testInfo) => {
  await prepare(page);
  await addComment(page, "Stored comment");
  await composer(page).fill("Stored draft");
  await expect.poll(() => storedDraftIncludes(page, "Stored draft")).toBe(true);
  const oversizedLength = 530_000;
  await composer(page).fill("x".repeat(oversizedLength));
  const notice = page.getByRole("status").filter({ hasText: "Too large to keep after a reload" });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCount(1);
  expect(await composer(page).evaluate(element => (element as HTMLTextAreaElement).value.length)).toBe(oversizedLength);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  expect(await storedDraftIncludes(page, "Stored draft")).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("draft-too-large-notice.png") });
  await page.reload();
  await expect(composer(page)).toHaveValue("Stored draft", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "1 comment", exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "small-desktop", width: 1024, height: 768, touch: false },
  { name: "tablet-portrait", width: 820, height: 1180, touch: true },
  { name: "tablet-landscape", width: 1180, height: 820, touch: true },
  { name: "phone-portrait", width: 390, height: 844, touch: true },
  { name: "phone-landscape", width: 844, height: 390, touch: true }
] as const) test.describe(viewport.name, () => {
  test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });
  for (const theme of ["light", "dark"] as const) test(`comment form, count and list in ${theme}`, async ({ page, context }, testInfo) => {
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
    await prepare(page);
    await selectContents(markdown(page));
    const comment = page.getByRole("button", { name: "Comment", exact: true });
    await expectWithinViewport(page, comment);
    if (viewport.touch) await expectTouchSafe(comment);
    await comment.click();
    const form = page.getByRole("dialog", { name: "Add comment", exact: true });
    await expect(form.getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
    await form.getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this pending comment.");
    if (viewport.touch) await expectTouchSafe(form.getByRole("button", { name: "Save", exact: true }));
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`comment-form-${viewport.name}-${theme}.png`) });
    await form.getByRole("button", { name: "Save", exact: true }).click();
    const chip = page.getByRole("button", { name: "1 comment", exact: true });
    await expect(chip).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`comment-chip-${viewport.name}-${theme}.png`) });
    await chip.click();
    const list = page.getByRole("dialog", { name: "Comments", exact: true });
    await expect(list).toContainText("Keep this pending comment.");
    await expectNoHorizontalOverflow(page);
    if (viewport.touch) await expectTouchSafe(list.getByRole("button", { name: /Delete/u }).first());
    await page.screenshot({ path: testInfo.outputPath(`comment-list-${viewport.name}-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(chip).toBeFocused();
  });
});
