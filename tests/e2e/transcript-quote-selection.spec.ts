import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Catalog } from "../../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "quote-selection-chat";
const answerId = "quote-selection-answer";
const questionId = "quote-selection-question";
const timestamp = "2026-09-30T00:00:00.000Z";
const answerText = "Finished answer to quote.";
/** The same answer with inline Markdown; Quote must insert `answerText`. */
const formattedAnswer = "**Finished** answer to quote.";
const questionText = "Finished question to quote.";

test.setTimeout(60_000);

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

function quoteButton(page: Page) {
  return page.getByRole("button", { name: "Quote", exact: true });
}

function markdown(page: Page, id = answerId) {
  return page.locator(`article[data-message-id="${id}"] .v2-conversation-markdown`);
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, status: "complete", createdAt: timestamp,
    citationMessageId: null, errorMessage: null, modelId: null, modelRunId: null, provider: null };
}

async function prepare(page: Page, content = answerText): Promise<ChatDetailWire> {
  const chat: ChatDetailWire = {
    assistant: null, id: chatId, title: "Quote selection", createdAt: timestamp, updatedAt: timestamp,
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
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] }, { catalog });
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", route => route.fulfill({ json: {
    allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
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

async function clearSelection(page: Page) {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

const viewports = [
  { name: "desktop-landscape", width: 1440, height: 900, touch: false },
  { name: "desktop-portrait", width: 900, height: 1440, touch: false },
  { name: "tablet-portrait", width: 820, height: 1180, touch: true },
  { name: "tablet-landscape", width: 1180, height: 820, touch: true },
  { name: "phone-portrait", width: 390, height: 844, touch: true },
  { name: "phone-landscape", width: 844, height: 390, touch: true }
] as const;

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });
    for (const theme of ["light", "dark"] as const) {
      test(`Quote appends answer and question without replacing the draft in ${theme}`, async ({ page, context }, testInfo) => {
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        await prepare(page, formattedAnswer);
        await expect(markdown(page).locator("strong")).toHaveText("Finished");
        expect(await page.evaluate(() => matchMedia("(hover: none), (pointer: coarse)").matches)).toBe(viewport.touch);
        const input = composer(page);
        const firstDraft = `Existing draft\n\n> ${answerText}\n\n`;
        await input.fill("Existing draft");
        await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2));
        await selectContents(markdown(page));
        const quote = quoteButton(page);
        await expectWithinViewport(page, quote);
        await expectNoHorizontalOverflow(page);
        if (viewport.touch) {
          await expectTouchSafe(quote);
          const pill = await quote.boundingBox();
          const dock = await input.boundingBox();
          expect(pill!.height).toBeGreaterThanOrEqual(44);
          expect(pill!.width).toBeGreaterThanOrEqual(44);
          expect(pill!.y + pill!.height).toBeLessThanOrEqual(dock!.y + 1);
        }
        await page.screenshot({ path: testInfo.outputPath(`quote-selection-${viewport.name}-${theme}.png`) });
        if (viewport.touch) await quote.tap();
        else await quote.click();
        await expect(input).toHaveValue(firstDraft);
        if (viewport.touch) {
          await expect(input).not.toBeFocused();
          await expect(page.getByText("Quoted", { exact: true })).toBeVisible();
        } else {
          await expect(input).toBeFocused();
          expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]))
            .toEqual([firstDraft.length, firstDraft.length]);
        }
        await selectContents(markdown(page, questionId));
        if (viewport.touch) await quote.tap();
        else await quote.click();
        await expect(input).toHaveValue(`Existing draft\n\n> ${answerText}\n\n> ${questionText}\n\n`);
        if (viewport.touch) {
          await expect(input).not.toBeFocused();
          await expect(page.getByText("Quoted", { exact: true })).toBeVisible();
        } else await expect(input).toBeFocused();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`quote-appended-${viewport.name}-${theme}.png`) });
      });
    }
  });
}

test("rich selections quote prose as plain text, keep code, lists, tables and TeX, and send as one block quote", async ({ page }, testInfo) => {
  const richText = [
    "## Selected details", "", "First paragraph with **bold**, *em*, ~~del~~ and `code`.", "",
    "Second paragraph with [reference](https://example.com/reference).",
    "", "- First item", "- Second item", "", "1. Ordered item", "2. Next item", "",
    "| Name | Value |", "| --- | --- |", "| Alpha | Beta |", "",
    "Inline $x^2$ and a display formula:", "", "$$", "E = mc^2", "$$", "",
    "```typescript", "const answer = 42;", "console.log(answer);", "```"
  ].join("\n");
  const stream = createGatedRunStreamFixture({
    key: "quote-rich", abortMessage: "Synthetic quote run stopped", notReadyError: "quote_stream_not_ready"
  });
  await stream.install(page, chatId);
  await prepare(page, richText);
  await expect(markdown(page).locator(".katex")).toHaveCount(2);
  // Wait for syntax highlighting to settle before capturing a DOM Range.
  await expect(markdown(page).locator("pre.shiki")).toHaveCount(1);
  await selectContents(markdown(page).locator("pre code"));
  await quoteButton(page).click();
  await expect(composer(page)).toHaveValue("> ```typescript\n> const answer = 42;\n> console.log(answer);\n> ```\n\n");
  await composer(page).fill("");
  await selectContents(markdown(page));
  await quoteButton(page).click();
  const draft = await composer(page).inputValue();
  for (const fragment of ["> Selected details", "> First paragraph with bold, em, del and code.\n>\n> Second paragraph with reference.",
    "> - First item", "> - Second item", "> 1. Ordered item",
    "> 2. Next item", "| Name | Value |", "| --- | --- |", "| Alpha | Beta |", "$x^2$", "$$",
    "E = mc^2", "> ```typescript\n> const answer = 42;"]) expect(draft).toContain(fragment);
  expect(draft).not.toMatch(/Copy|Thinking|Private reasoning|<annotation|<math/u);
  expect(draft).not.toMatch(/^> #|\*\*|~~|`code`|\]\(|example\.com/mu);
  expect(draft.match(/x\^2/gu)).toHaveLength(1);
  expect(draft.match(/E = mc\^2/gu)).toHaveLength(1);
  await composer(page).press("Enter");
  await stream.waitForRequestCount(page, 1);
  const sent = page.locator('article[data-role="user"]').last().locator(".v2-conversation-markdown");
  await expect(sent.locator("blockquote")).toHaveCount(1);
  await expect(sent.locator("blockquote h3")).toHaveCount(0);
  await expect(sent.locator("blockquote strong, blockquote em, blockquote del, blockquote a, blockquote p code")).toHaveCount(0);
  await expect(sent.locator("blockquote")).toContainText("Selected details");
  await expect(sent.locator("blockquote table")).toContainText("Alpha");
  await expect(sent.locator("blockquote pre code")).toContainText("const answer = 42;");
  await expect(sent.locator("blockquote ul li")).toHaveCount(2);
  await expect(sent.locator("blockquote ol li")).toHaveCount(2);
  await expect(sent.locator("blockquote .katex")).toHaveCount(2);
  await expect(sent.locator("blockquote")).toContainText("First paragraph with bold, em, del and code.");
  await expect(sent.locator("blockquote")).toContainText("Second paragraph with reference.");
  await sent.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("quote-sent-rich-markdown.png") });
  await stream.emit(page, "done", { status: "complete" });
  await stream.close(page);
});

test("mouse selection keeps turn actions closed and dismisses Quote on Escape, clear and scroll", async ({ page }) => {
  await prepare(page, [answerText, ...Array.from({ length: 35 }, (_, index) => `Additional paragraph ${index + 1}.`)].join("\n\n"));
  const paragraph = markdown(page).locator("p").first();
  const turn = page.locator(`article[data-message-id="${answerId}"]`);
  await paragraph.scrollIntoViewIfNeeded();
  const bounds = await paragraph.evaluate(element => {
    const node = element.firstChild!;
    const start = document.createRange();
    start.setStart(node, 0);
    start.setEnd(node, 1);
    const end = document.createRange();
    end.setStart(node, 14);
    end.setEnd(node, 15);
    const first = start.getBoundingClientRect();
    const last = end.getBoundingClientRect();
    return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
  });
  await page.mouse.move(bounds.x1, bounds.y1);
  await page.mouse.down();
  await page.mouse.move((bounds.x1 + bounds.x2) / 2, bounds.y2, { steps: 6 });
  // A paused drag outlasts the settle delay: still no toolbar while the button is down.
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await expect(quoteButton(page)).toHaveCount(0);
  await page.mouse.move(bounds.x2, bounds.y2, { steps: 6 });
  await expect(quoteButton(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(quoteButton(page)).toBeVisible();
  // It appears once at the final position and stays there.
  const placed = await quoteButton(page).boundingBox();
  await page.waitForTimeout(400);
  expect(await quoteButton(page).boundingBox()).toEqual(placed);
  await expect(turn).not.toHaveAttribute("data-controls-open", "true");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("Finished ans");
  await page.keyboard.press("Escape");
  await expect(quoteButton(page)).toHaveCount(0);
  await selectContents(paragraph);
  await expect(quoteButton(page)).toBeVisible();
  await clearSelection(page);
  await expect(quoteButton(page)).toHaveCount(0);
  await selectContents(paragraph);
  await expect(quoteButton(page)).toBeVisible();
  await page.locator(".v2-conversation-scroll").evaluate(element => element.scrollBy({ top: 150 }));
  await expect(quoteButton(page)).toHaveCount(0);
});

test("a selection made without the mouse shows Quote only after it settles", async ({ page }) => {
  await prepare(page);
  const paragraph = markdown(page).locator("p").first();
  await paragraph.scrollIntoViewIfNeeded();
  // Measured in the page: a keyboard or touch-handle selection that keeps changing never shows the toolbar.
  const seen = await paragraph.evaluate(async element => {
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const text = element.firstChild!;
    const visible = () => document.querySelector(".v2-selection-quote-button") !== null;
    const states: boolean[] = [];
    for (const end of [3, 6, 9, 12]) {
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, end);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      await frame(); await frame();
      states.push(visible());
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    await frame();
    states.push(visible());
    return states;
  });
  expect(seen).toEqual([false, false, false, false, true]);
  await expect(quoteButton(page)).toBeVisible();
});

test("reasoning, cross-message ranges, composer text and inline editing cannot be quoted", async ({ page }) => {
  await prepare(page);
  const disclosure = page.getByTestId("tool-activity-disclosure");
  await disclosure.locator(":scope > summary").click();
  await selectContents(page.getByTestId("answer-reasoning").locator("p"));
  await expect(quoteButton(page)).toHaveCount(0);
  await page.evaluate(async ({ questionId, answerId }) => {
    const question = document.querySelector(`article[data-message-id="${questionId}"] .v2-conversation-markdown`)!;
    const answer = document.querySelector(`article[data-message-id="${answerId}"] .v2-conversation-markdown`)!;
    const range = document.createRange();
    range.setStart(question, 0);
    range.setEnd(answer, answer.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    // Outlast the 250 ms settle delay of a selection made without a mouse drag.
    await new Promise<void>(resolve => setTimeout(resolve, 300));
  }, { questionId, answerId });
  await expect(quoteButton(page)).toHaveCount(0);
  await clearSelection(page);
  await composer(page).fill("Composer text stays intact");
  await composer(page).selectText();
  await expect(quoteButton(page)).toHaveCount(0);
  const question = page.locator(`article[data-message-id="${questionId}"]`);
  await question.hover();
  await question.getByRole("button", { name: "Edit question", exact: true }).click();
  const edit = question.getByRole("textbox", { name: "Edit question", exact: true });
  await expect(edit).toHaveValue(questionText);
  await selectContents(markdown(page));
  await expect(quoteButton(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue("Composer text stays intact");
  await edit.press("Escape");
  await expect(edit).toHaveCount(0);
  await selectContents(markdown(page));
  await expect(quoteButton(page)).toBeVisible();
});

test("streaming answer is excluded and an oversized follow-up quote leaves the draft unchanged", async ({ page }, testInfo) => {
  const runId = "quote-active-run";
  const activeAnswerId = "quote-active-answer";
  const activeQuestionId = "quote-active-question";
  const stream = createGatedRunStreamFixture({
    key: "quote-followup", abortMessage: "Synthetic quote run stopped", notReadyError: "quote_stream_not_ready"
  });
  await stream.install(page, chatId);
  const chat = await prepare(page);
  await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({
    json: { version: 1, run: { id: runId, status: "streaming" } }
  }));
  await composer(page).fill("Start a running answer");
  await composer(page).press("Enter");
  await stream.waitForRequestCount(page, 1);
  await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
  await stream.emit(page, "message_start", { assistantMessageId: activeAnswerId, userMessageId: activeQuestionId });
  const activeAnswer: ChatMessageWire = {
    ...message(activeAnswerId, "assistant", "An unfinished streaming answer.", activeQuestionId),
    status: "streaming", modelRunId: runId, followups: { available: true, entries: [] }
  };
  const messages = [...chat.messages, message(activeQuestionId, "user", "Start a running answer", answerId), activeAnswer];
  await stream.emit(page, "chat_update", {
    chat: { ...chat, activeLeafMessageId: activeAnswerId, messageCount: messages.length }, messages
  });
  await expect(composer(page)).toHaveAttribute("placeholder", "Follow up…");
  await expect(markdown(page, activeAnswerId)).toContainText("An unfinished streaming answer.");
  await selectContents(markdown(page, activeAnswerId));
  await expect(quoteButton(page)).toHaveCount(0);
  const original = "x".repeat(15_990);
  await composer(page).fill(original);
  await selectContents(markdown(page));
  await quoteButton(page).click();
  await expect(composer(page)).toHaveValue(original);
  await expect(page.getByRole("alert").filter({ hasText: /16[,.]?000|too long|limit/iu })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("quote-followup-limit.png") });
  await stream.emit(page, "chat_update", {
    chat: { ...chat, activeLeafMessageId: activeAnswerId, messageCount: messages.length },
    messages: messages.map(entry => entry.id === activeAnswerId
      ? { ...entry, status: "complete", followups: { available: false, entries: [] } } : entry)
  });
  await stream.emit(page, "done", { runId, status: "complete" });
  await stream.close(page);
});
