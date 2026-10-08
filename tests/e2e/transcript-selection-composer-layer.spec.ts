import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Catalog } from "../../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/*
 * Issue #44: the transcript Quote/Comment toolbar is body-portaled above the
 * live composer dock, so it covered the first row of an open composer menu.
 * Any composer layer now dismisses the captured selection and hides the
 * toolbar and its notice; a new selection while the layer is open does not
 * restore it, and after the layer closes it returns only with the next
 * selection change. The shell learns about a layer one effect late, so every
 * assertion waits for the UI to settle.
 */

const chatId = "selection-layer-chat";
const answerId = "selection-layer-answer";
const questionId = "selection-layer-question";
const timestamp = "2026-10-02T00:00:00.000Z";
const questionText = "Synthetic question for the composer layer check.";
/** Short single-line paragraphs: a range's rect is then the rect of its one line. */
const paragraphs = Array.from({ length: 30 }, (_, index) => `Synthetic paragraph ${index + 1} for the layer check.`);
const LEVELS = ["low", "medium", "high", "xhigh"] as const;
const DEFAULT_LEVEL = "medium";
const ATTACHMENT_ID = "attachment-selection-layer";
const ATTACHMENT_NAME = "selection-layer.docx";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ADD_TRIGGER = '.v2-composer-controls button[aria-label="Add"]';

test.setTimeout(90_000);

type Box = Readonly<{ bottom: number; left: number; right: number; top: number }>;

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

function toolbar(page: Page) {
  return page.locator(".v2-selection-quote");
}

function quoteButton(page: Page) {
  return page.getByRole("button", { name: "Quote", exact: true });
}

function commentButton(page: Page) {
  return page.getByRole("button", { name: "Comment", exact: true });
}

function addTrigger(page: Page) {
  return page.locator(ADD_TRIGGER);
}

function addMenu(page: Page) {
  return page.getByRole("menu", { name: "Add" });
}

function markdown(page: Page, id = answerId) {
  return page.locator(`article[data-message-id="${id}"] .v2-conversation-markdown`);
}

function attachmentChip(page: Page): Locator {
  return page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: ATTACHMENT_NAME });
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, status: "complete", createdAt: timestamp,
    citationMessageId: null, errorMessage: null, modelId: null, modelRunId: null, provider: null };
}

/** The matrix catalog with a reasoning-effort chip on its default model. */
function fixtureCatalog(): Catalog {
  const catalog: Catalog = structuredClone(matrixCatalog);
  const model = catalog.models[0]!;
  model.parameterControls = {
    ...model.parameterControls,
    reasoningEffort: { defaultValue: DEFAULT_LEVEL, options: [...LEVELS], supported: true }
  };
  model.defaultParams = { ...model.defaultParams, reasoning: { effort: DEFAULT_LEVEL } };
  return catalog;
}

function attachmentWire() {
  return { attachment: {
    byteSize: 128, extractedText: "Synthetic report text", fileName: ATTACHMENT_NAME, id: ATTACHMENT_ID, kind: "document",
    metadata: { document: { engine: "docling" } }, mimeType: DOCX, processingErrorCode: null, status: "ready",
    updatedAt: timestamp
  } };
}

async function prepare(page: Page, content = paragraphs.join("\n\n")): Promise<void> {
  const chat: ChatDetailWire = {
    assistant: null, id: chatId, title: "Selection and composer layers", createdAt: timestamp, updatedAt: timestamp,
    activeLeafMessageId: answerId, defaultModelId: matrixCatalog.models[0]!.modelId,
    defaultProvider: matrixCatalog.models[0]!.provider, folderId: null, pinned: false, messageCount: 2,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: 100 },
    pageInfo: { activeLeafMessageId: answerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: [message(questionId, "user", questionText, null), message(answerId, "assistant", content, questionId)]
  };
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] }, { catalog: fixtureCatalog() });
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", route => route.fulfill({ json: {
    allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
  } }));
  await page.route("**/api/uploads", route => route.request().method() === "POST"
    ? route.fulfill({ status: 201, json: attachmentWire() }) : route.fallback());
  await page.route(`**/api/uploads/${ATTACHMENT_ID}`, route => route.fulfill({ json: attachmentWire() }));
  // A missed stream interception must never reach a provider.
  await page.route("**/api/chats/*/messages", route => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await signInWithLocalToken(page, `/c/${chatId}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(markdown(page)).toContainText(content.split("\n")[0]!);
  await expect(composer(page)).toBeVisible();
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

/** Selects the contents again without scrolling or moving focus, as a selection made while a layer is open. */
async function reselect(locator: Locator) {
  await locator.evaluate(async element => {
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

async function selectionCollapsed(page: Page) {
  return page.evaluate(() => window.getSelection()?.isCollapsed ?? true);
}

/** Lets effects, the shell's one-effect-late layer state and placement run. */
async function settleFrames(page: Page, count = 4) {
  await page.evaluate(async frames => {
    for (let index = 0; index < frames; index += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
}

/**
 * Waits for the layer's entrance animation, which scales its box. Only
 * time-based animations end: the list's scroll-driven fade never finishes.
 */
async function settleLayer(page: Page) {
  await page.locator(".v2-composer-layer").evaluate(layer => Promise.all(layer.getAnimations({ subtree: true })
    .filter(animation => animation.timeline === document.timeline).map(animation => animation.finished)));
}

async function rectOf(locator: Locator): Promise<Box> {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
  });
}

/** The rect once placement has stopped moving it across two frames. */
async function stableRect(page: Page, locator: Locator): Promise<Box> {
  let previous = await rectOf(locator);
  await expect.poll(async () => {
    await settleFrames(page, 2);
    const next = await rectOf(locator);
    const same = JSON.stringify(next) === JSON.stringify(previous);
    previous = next;
    return same;
  }).toBe(true);
  return previous;
}

function intersection(a: Box, b: Box): Box | null {
  const box = { bottom: Math.min(a.bottom, b.bottom), left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right), top: Math.max(a.top, b.top) };
  return box.right - box.left >= 2 && box.bottom - box.top >= 2 ? box : null;
}

async function openAdd(page: Page): Promise<Locator> {
  await addTrigger(page).click();
  const menu = addMenu(page);
  await expect(menu).toBeVisible();
  await settleLayer(page);
  return menu;
}

/** Closes the open layer: a sheet by its Close button, a popover by Escape. */
async function closeLayer(page: Page) {
  const close = page.locator(".v2-composer-layer-header").getByRole("button", { name: "Close", exact: true });
  if (await close.isVisible()) await close.click();
  else await page.keyboard.press("Escape");
  await expect(page.locator(".v2-composer-layer")).toHaveCount(0);
}

/** The toolbar and its notice are absent, after the shell has caught up with the layer. */
async function expectToolbarGone(page: Page, label: string) {
  await expect(toolbar(page), label).toHaveCount(0);
  await settleFrames(page);
  await expect(toolbar(page), `${label}, settled`).toHaveCount(0);
}

/**
 * Scrolls one answer paragraph to the height where its toolbar (drawn above
 * the selection with an 8px gap) centres on `target`, then selects it from
 * the first character at or right of `target.left`.
 */
async function selectOver(page: Page, target: Box, toolbarHeight: number): Promise<Box> {
  const placed = await page.evaluate(async ({ answer, height, box }) => {
    const scroller = document.querySelector<HTMLElement>(".v2-conversation-scroll")!;
    const lines = [...document.querySelectorAll<HTMLElement>(`article[data-message-id="${answer}"] .v2-conversation-markdown p`)];
    const desiredTop = box.top + (box.bottom - box.top) / 2 - height / 2 + height + 8;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    let best: { line: HTMLElement; delta: number } | null = null;
    for (const line of lines) {
      const range = document.createRange();
      range.selectNodeContents(line);
      const delta = range.getBoundingClientRect().top - desiredTop;
      const next = scroller.scrollTop + delta;
      if (next < 0 || next > maxScroll) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { line, delta };
    }
    if (!best) return null;
    scroller.scrollTop += best.delta;
    // Let the scroll event dismiss an older toolbar before creating this range.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const text = best.line.firstChild!;
    const length = text.textContent!.length;
    let start = 0;
    for (; start < length - 4; start += 1) {
      const character = document.createRange();
      character.setStart(text, start);
      character.setEnd(text, start + 1);
      if (character.getBoundingClientRect().left >= box.left + 4) break;
    }
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    // Outlast the 250 ms settle delay of a selection made without a mouse drag.
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    const rect = range.getBoundingClientRect();
    return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
  }, { answer: answerId, height: toolbarHeight, box: target });
  expect(placed, `a paragraph can be scrolled under the first Add row ${JSON.stringify(target)}`).not.toBeNull();
  return placed!;
}

test.describe("desktop 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of ["dark", "light"] as const) {
    test(`Add gives way to no toolbar: its first row is reachable and works in ${theme}`, async ({ page, context }, testInfo) => {
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
      await prepare(page);
      await composer(page).fill("Draft survives the menus");

      // Where the first Add row lies, and how tall the toolbar is.
      let menu = await openAdd(page);
      const firstRowTarget = await rectOf(menu.getByRole("menuitem").first());
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await selectContents(markdown(page).locator("p").first());
      await expect(quoteButton(page)).toBeVisible();
      const probe = await stableRect(page, toolbar(page));
      await page.keyboard.press("Escape");
      await expect(toolbar(page)).toHaveCount(0);

      // The toolbar of this selection, recorded before opening +, covers the first row.
      const selected = await selectOver(page, firstRowTarget, probe.bottom - probe.top);
      await expect(quoteButton(page)).toBeVisible();
      await expect(commentButton(page)).toBeVisible();
      const toolbarBox = await stableRect(page, toolbar(page));
      await page.screenshot({ path: testInfo.outputPath(`collision-before-add-1440x900-${theme}.png`) });

      menu = await openAdd(page);
      const firstRow = menu.getByRole("menuitem").first();
      const rowBox = await rectOf(firstRow);
      const overlap = intersection(toolbarBox, rowBox);
      expect(overlap, `toolbar ${JSON.stringify(toolbarBox)} (selection ${JSON.stringify(selected)}) ` +
        `intersects the first Add row ${JSON.stringify(rowBox)}`).not.toBeNull();
      await expectToolbarGone(page, "Add open");
      // A selection made while the layer is open stays non-collapsed and brings nothing back.
      await reselect(markdown(page).locator("p").first());
      expect(await selectionCollapsed(page)).toBe(false);
      await expectToolbarGone(page, "selection while Add is open");
      const point = { x: (overlap!.left + overlap!.right) / 2, y: (overlap!.top + overlap!.bottom) / 2 };
      expect(await page.evaluate(({ x, y }) => {
        const row = document.querySelector('[role="menu"][aria-label="Add"] [role="menuitem"]');
        const topmost = document.elementFromPoint(x, y);
        return Boolean(row && topmost && (topmost === row || row.contains(topmost)));
      }, point), `elementFromPoint(${point.x}, ${point.y}) is inside the first Add row`).toBe(true);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`collision-add-open-1440x900-${theme}.png`) });

      if (await firstRow.isEnabled()) {
        await expect(firstRow).toContainText("Create artifact");
        await page.mouse.click(point.x, point.y);
        await expect(menu).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Remove artifact creation" })).toBeVisible();
        await expectToolbarGone(page, "after choosing a row");
      } else {
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
      }
      await expect(composer(page)).toHaveValue("Draft survives the menus");

      // A fresh selection shows working Quote and Comment.
      await selectContents(markdown(page).locator("p").nth(1));
      await expect(quoteButton(page)).toBeVisible();
      await quoteButton(page).click();
      await expect(composer(page)).toHaveValue(`Draft survives the menus\n\n> ${paragraphs[1]}\n\n`);
      await selectContents(markdown(page).locator("p").nth(2));
      await commentButton(page).click();
      const form = page.getByRole("dialog", { name: "Add comment", exact: true });
      await expect(form.getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(form).toHaveCount(0);
    });
  }

  test("Escape, outside clicks and keyboard keep the toolbar hidden until the next selection", async ({ page }) => {
    await prepare(page);
    const line = markdown(page).locator("p").last();

    // Escape: focus returns to +, the still-highlighted selection stays dismissed.
    await selectContents(line);
    await expect(quoteButton(page)).toBeVisible();
    let menu = await openAdd(page);
    await expectToolbarGone(page, "Add open");
    await reselect(line);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => {
      const active = document.activeElement;
      const rows = [...document.querySelectorAll('[role="menu"][aria-label="Add"] [role="menuitem"]')];
      return rows.indexOf(active as Element);
    }), "ArrowDown moves focus to a later row").toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(addTrigger(page)).toBeFocused();
    expect(await selectionCollapsed(page)).toBe(false);
    await expectToolbarGone(page, "after Escape");
    await selectContents(line);
    await expect(quoteButton(page)).toBeVisible();

    // Outside click.
    menu = await openAdd(page);
    await expectToolbarGone(page, "Add open again");
    // A point of the reading column outside the composer and its layer.
    const owner = await page.locator(".v2-conversation-scroll").boundingBox();
    await page.mouse.click(owner!.x + 12, owner!.y + 12);
    await expect(menu).toHaveCount(0);
    await expectToolbarGone(page, "after the outside click");
    await selectContents(line);
    await expect(quoteButton(page)).toBeVisible();
    await expect(commentButton(page)).toBeVisible();
  });

  test("Reasoning and the header model layer also suppress the toolbar", async ({ page }) => {
    await prepare(page);
    const line = markdown(page).locator("p").last();
    const layers: Array<Readonly<{ name: string; layer: Locator; open(): Promise<void> }>> = [
      { name: "Reasoning effort", layer: page.getByRole("menu", { name: "Reasoning effort" }),
        open: () => page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u }).click() },
      { name: "Choose model", layer: page.getByRole("dialog", { name: "Choose model" }),
        open: () => page.getByTestId("header-model-trigger").click() }
    ];
    for (const { layer, name, open } of layers) {
      await selectContents(line);
      await expect(quoteButton(page), name).toBeVisible();
      await open();
      await expect(layer).toBeVisible();
      await expectToolbarGone(page, `${name} open`);
      await reselect(line);
      await expectToolbarGone(page, `selection while ${name} is open`);
      await page.keyboard.press("Escape");
      await expect(layer).toHaveCount(0);
      await expectToolbarGone(page, `after ${name} closes`);
    }
    await selectContents(line);
    await expect(quoteButton(page)).toBeVisible();
  });

  test("Escape closes the open composer layer after focus has left it", async ({ page }) => {
    await prepare(page);
    await composer(page).fill("Draft survives Escape");
    const layers: Array<Readonly<{ name: string; layer: Locator; open(): Promise<unknown> }>> = [
      { name: "Add", layer: addMenu(page), open: () => openAdd(page) },
      { name: "Reasoning effort", layer: page.getByRole("menu", { name: "Reasoning effort" }),
        open: () => page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u }).click() }
    ];
    for (const { layer, name, open } of layers) {
      await open();
      await expect(layer, name).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(await page.evaluate(() => document.activeElement === document.body), `${name}: focus left the layer`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(layer, `${name} closed by Escape`).toHaveCount(0);
    }
    await expect(composer(page)).toHaveValue("Draft survives Escape");
  });

  test("one click on a pending-comment mark closes Add and opens its editor; draft, attachment and comment survive", async ({ page }, testInfo) => {
    await prepare(page, paragraphs.slice(0, 3).join("\n\n"));
    const marked = markdown(page).locator("p").first();
    await composer(page).fill("Draft beside a pending comment");
    await page.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("OOXML fixture routed by the browser contract"), mimeType: DOCX, name: ATTACHMENT_NAME
    });
    await expect(attachmentChip(page)).toHaveAttribute("data-attachment-status", "ready");
    await selectContents(marked);
    await commentButton(page).click();
    const add = page.getByRole("dialog", { name: "Add comment", exact: true });
    await add.getByRole("textbox", { name: "Comment", exact: true }).fill("Pending note");
    await add.getByRole("button", { name: "Save", exact: true }).click();
    await expect(add).toHaveCount(0);
    const chip = page.getByRole("button", { name: "1 comment", exact: true });
    await expect(chip).toBeVisible();

    const menu = await openAdd(page);
    await page.screenshot({ path: testInfo.outputPath("live-dock-add-open-1440x900.png") });
    const point = await marked.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + Math.min(40, rect.width / 2), y: rect.top + rect.height / 2 };
    });
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".v2-conversation-markdown") !== null, point),
      "the mark is not covered by the Add menu").toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(menu).toHaveCount(0);
    const edit = page.getByRole("dialog", { name: "Edit comment", exact: true });
    await expect(edit).toBeVisible();
    await expect(edit.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("Pending note");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(edit).toHaveCount(0);

    for (const open of [() => openAdd(page), async () => {
      await page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u }).click();
      await expect(page.getByRole("menu", { name: "Reasoning effort" })).toBeVisible();
    }]) {
      await open();
      await page.keyboard.press("Escape");
      await expect(page.locator(".v2-composer-layer")).toHaveCount(0);
    }
    await expect(composer(page)).toHaveValue("Draft beside a pending comment");
    await expect(attachmentChip(page)).toHaveCount(1);
    await expect(chip).toBeVisible();
  });
});

for (const viewport of [
  { name: "tablet-landscape", width: 1180, height: 820 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 }
] as const) test.describe(viewport.name, () => {
  test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true });

  test(`no toolbar or notice while a layer or sheet is open at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await prepare(page);
    expect(await page.evaluate(() => matchMedia("(hover: none), (pointer: coarse)").matches)).toBe(true);
    const line = markdown(page).locator("p").last();

    // The touch notice sits right above the dock, where the layer opens.
    await selectContents(line);
    await quoteButton(page).tap();
    await expect(page.getByRole("status").filter({ hasText: "Quoted" })).toBeVisible();
    await openAdd(page);
    await expectToolbarGone(page, "notice under Add");
    await closeLayer(page);

    await selectContents(line);
    await expect(quoteButton(page)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`touch-before-add-${viewport.name}.png`) });
    await openAdd(page);
    await expectToolbarGone(page, "Add open");
    await reselect(line);
    await expectToolbarGone(page, "selection while Add is open");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`touch-add-open-${viewport.name}.png`) });
    await closeLayer(page);
    await expectToolbarGone(page, "after Add closes");

    // A compact composer may fold the chip away; Add alone covers the sheet case then.
    const reasoning = page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u });
    await selectContents(line);
    await expect(quoteButton(page)).toBeVisible();
    if (await reasoning.isVisible()) {
      await reasoning.click();
      await expect(page.getByRole("menu", { name: "Reasoning effort" })).toBeVisible();
      await expectToolbarGone(page, "Reasoning open");
      await page.screenshot({ path: testInfo.outputPath(`touch-reasoning-open-${viewport.name}.png`) });
      await closeLayer(page);
      await selectContents(line);
    }
    await expect(quoteButton(page)).toBeVisible();
  });
});
