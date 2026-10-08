import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Catalog } from "../../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/*
 * Issue #43: in a blank chat with a tall draft and an attachment, a
 * toolbar-anchored composer layer (Reasoning effort, and the shared path's
 * Add menu) shows its whole content inside the reading column without an
 * internal scrollbar. Geometry is measured from the live shell; visibility
 * alone does not prove that the content is unclipped.
 */

const LEVELS = ["low", "medium", "high", "xhigh"] as const;
const DEFAULT_LEVEL = "medium";
const ATTACHMENT_ID = "attachment-blank-chat-layer";
const ATTACHMENT_NAME = "blank-chat-layer.docx";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TALL_DRAFT = Array.from(
  { length: 12 },
  (_, index) => `${String(index + 1).padStart(2, "0")} Synthetic draft line for the blank chat layer check, padded to one hundred characters.`
).join("\n");
const SHORT_DRAFT = "One short line.";
const TARGET_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1180, height: 820 }
] as const;
const REASONING_TRIGGER = ".v2-composer-reasoning";
const ADD_TRIGGER = '.v2-composer-controls button[aria-label="Add"]';

test.setTimeout(90_000);

type Box = Readonly<{ bottom: number; left: number; right: number; top: number }>;

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

function attachmentWire(status: "processing" | "ready") {
  return {
    attachment: {
      byteSize: 128,
      extractedText: status === "ready" ? "Synthetic report text" : null,
      fileName: ATTACHMENT_NAME,
      id: ATTACHMENT_ID,
      kind: "document",
      metadata: status === "ready" ? { document: { engine: "docling" } } : {},
      mimeType: DOCX,
      processingErrorCode: null,
      status,
      updatedAt: "2026-10-02T00:00:00.000Z"
    }
  };
}

function composerInput(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

function attachmentChip(page: Page): Locator {
  return page.getByRole("region", { name: "Attachments" }).getByRole("listitem")
    .filter({ hasText: ATTACHMENT_NAME });
}

function reasoningChip(page: Page): Locator {
  return page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u });
}

function reasoningMenu(page: Page): Locator {
  return page.getByRole("menu", { name: "Reasoning effort" });
}

/**
 * The live blank chat with the 4-level reasoning model. A "tall" composer
 * holds a draft past the input's height cap; `attachment` adds one routed
 * upload, and "processing" holds its first status poll until released.
 */
async function openBlankChat(
  page: Page,
  options: Readonly<{ attachment?: "processing" | "ready"; draft: string }>
): Promise<Readonly<{ releaseStatusPoll(): void }>> {
  let releaseStatusPoll = () => {};
  const statusPollHeld = new Promise<void>((resolve) => {
    releaseStatusPoll = resolve;
  });
  await installMatrixCatalogFixture(page, undefined, { catalog: fixtureCatalog() });
  await page.route("**/api/uploads", (route) => route.fulfill({
    contentType: "application/json",
    json: attachmentWire(options.attachment ?? "ready"),
    status: 201
  }));
  await page.route(`**/api/uploads/${ATTACHMENT_ID}`, async (route) => {
    if (options.attachment === "processing" && route.request().method() === "GET") await statusPollHeld;
    await route.fulfill({ contentType: "application/json", json: attachmentWire("ready") });
  });
  await signInWithLocalToken(page);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".v2-conversation-empty-composer")).toBeVisible();
  const input = composerInput(page);
  await input.fill(options.draft);
  if (options.attachment) {
    await page.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("OOXML fixture routed by the browser contract"),
      mimeType: DOCX,
      name: ATTACHMENT_NAME
    });
    await expect(attachmentChip(page)).toHaveAttribute("data-attachment-status", options.attachment);
  }
  if (options.draft === TALL_DRAFT) {
    // The draft reaches the input's height cap: the field scrolls internally.
    await expect.poll(() => input.evaluate((element) => element.scrollHeight > element.clientHeight + 1))
      .toBe(true);
  }
  await expect(reasoningChip(page)).toHaveAccessibleName(`Reasoning effort: ${DEFAULT_LEVEL}`);
  return { releaseStatusPoll: () => releaseStatusPoll() };
}

/**
 * Waits for the layer's entrance animation, which scales its box. Only
 * time-based animations end: the list's scroll-driven fade never finishes.
 */
async function settleLayer(page: Page): Promise<void> {
  await page.locator(".v2-composer-layer").evaluate((layer) => Promise.all(layer.getAnimations({ subtree: true })
    .filter((animation) => animation.timeline === document.timeline).map((animation) => animation.finished)));
}

/**
 * Everything that makes an open layer's content unclipped, as readable
 * violations carrying the measured rects (empty when the layer is whole):
 * the bounds are below the chat header and inside the viewport; the layer,
 * its title, rows and note lie inside the bounds and inside the layer's own
 * list; neither the layer nor its list scrolls; and the layer does not
 * overlap its trigger. The bounds are the blank chat's scroll owner (the
 * `.v2-conversation-scroll` client rect) or, for a docked composer outside
 * it, the viewport below the header.
 */
async function layerViolations(page: Page, triggerSelector: string, docked: boolean): Promise<string[]> {
  return page.evaluate(({ docked: dockedComposer, selector }) => {
    const round = (box: DOMRect | { bottom: number; left: number; right: number; top: number }) => ({
      bottom: Math.round(box.bottom * 10) / 10,
      left: Math.round(box.left * 10) / 10,
      right: Math.round(box.right * 10) / 10,
      top: Math.round(box.top * 10) / 10
    });
    const inside = (inner: Box, outer: Box) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 &&
      inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
    const clientBox = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      const top = rect.top + element.clientTop;
      const left = rect.left + element.clientLeft;
      return round({ bottom: top + element.clientHeight, left, right: left + element.clientWidth, top });
    };
    const problems: string[] = [];
    const layer = document.querySelector(".v2-composer-layer");
    const trigger = document.querySelector(selector);
    const composer = document.querySelector(".v2-composer");
    const owner = composer?.closest(".v2-conversation-scroll") ?? null;
    if (!layer || !trigger || (!owner && !dockedComposer)) {
      return [`missing: layer ${Boolean(layer)}, trigger ${Boolean(trigger)}, owner ${Boolean(owner)}`];
    }
    const header = document.querySelector(".v2-live-header");
    const headerBottom = header ? round(header.getBoundingClientRect()).bottom : 0;
    const ownerBox = owner
      ? clientBox(owner)
      : { bottom: window.innerHeight, left: 0, right: document.documentElement.clientWidth, top: headerBottom };
    if (ownerBox.top < headerBottom - 1) problems.push(`owner ${JSON.stringify(ownerBox)} starts above the header bottom ${headerBottom}`);
    if (ownerBox.top < -1 || ownerBox.bottom > window.innerHeight + 1) {
      problems.push(`owner ${JSON.stringify(ownerBox)} leaves the ${window.innerWidth}x${window.innerHeight} viewport`);
    }
    const layerBox = round(layer.getBoundingClientRect());
    const triggerBox = round(trigger.getBoundingClientRect());
    const context = `layer ${JSON.stringify(layerBox)} placement ${layer.getAttribute("data-placement") ?? "above"}, ` +
      `trigger ${JSON.stringify(triggerBox)}, owner ${JSON.stringify(ownerBox)}, ` +
      `composer ${JSON.stringify(composer ? round(composer.getBoundingClientRect()) : null)}`;
    if (!inside(layerBox, ownerBox)) problems.push(`layer outside the owner: ${context}`);
    if (!(layerBox.bottom <= triggerBox.top + 1 || layerBox.top >= triggerBox.bottom - 1)) {
      problems.push(`layer overlaps its trigger: ${context}`);
    }
    if (layer.scrollHeight > layer.clientHeight + 1) {
      problems.push(`layer scrolls: ${layer.scrollHeight}/${layer.clientHeight}; ${context}`);
    }
    const list = layer.querySelector(".v2-composer-layer-scroll");
    if (list) {
      if (list.scrollHeight > list.clientHeight + 1) {
        problems.push(`list scrolls: ${list.scrollHeight}/${list.clientHeight}; ${context}`);
      }
      if (list.scrollTop !== 0) problems.push(`list scrollTop ${list.scrollTop}`);
    }
    const listBox = list ? clientBox(list) : layerBox;
    const parts = [...layer.querySelectorAll(".v2-composer-layer-title, [role^='menuitem'], .v2-composer-layer-note")]
      .filter((part) => part.getClientRects().length > 0);
    if (parts.length === 0) problems.push(`layer has no content: ${context}`);
    for (const part of parts) {
      const box = round(part.getBoundingClientRect());
      const name = `${part.getAttribute("role") ?? part.className} "${(part.textContent ?? "").trim().slice(0, 40)}"`;
      if (!inside(box, ownerBox) || !inside(box, listBox)) {
        problems.push(`${name} ${JSON.stringify(box)} clipped: list ${JSON.stringify(listBox)}; ${context}`);
      }
    }
    return problems;
  }, { docked, selector: triggerSelector });
}

async function expectLayerWhole(page: Page, triggerSelector: string, label: string, docked = false): Promise<void> {
  await settleLayer(page);
  // ResizeObserver, resize and scroll re-measure asynchronously: poll.
  await expect.poll(() => layerViolations(page, triggerSelector, docked), { message: label }).toEqual([]);
}

async function layerPlacement(page: Page): Promise<string | null> {
  return page.locator(".v2-composer-layer").getAttribute("data-placement");
}

/** The topmost element at the row's centre is that row: no surface covers it. */
async function expectRowHit(row: Locator): Promise<void> {
  await expect.poll(() => row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return topmost === element || element.contains(topmost);
  })).toBe(true);
}

async function openReasoning(page: Page): Promise<Locator> {
  await reasoningChip(page).click();
  const menu = reasoningMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveText([...LEVELS]);
  await expect(menu).toContainText("Reasoning effort");
  await expect(menu).toContainText("Applies to your next message.");
  return menu;
}

async function expectDraftKept(page: Page, draft: string, attachment: boolean): Promise<void> {
  await expect(composerInput(page)).toHaveValue(draft);
  if (attachment) {
    await expect(attachmentChip(page)).toHaveCount(1);
    await expect(attachmentChip(page)).toHaveAttribute("data-attachment-status", "ready");
  }
}

test.describe("tall blank chat: Reasoning effort", () => {
  for (const viewport of TARGET_VIEWPORTS) {
    test(`shows every level without an internal scroll at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openBlankChat(page, { attachment: "ready", draft: TALL_DRAFT });
      // Leaves the default for last, so every pick changes the value.
      for (const level of ["low", "high", "xhigh", "medium"] as const) {
        const menu = await openReasoning(page);
        await expectLayerWhole(page, REASONING_TRIGGER, `${viewport.width}x${viewport.height} before ${level}`);
        const row = menu.getByRole("menuitemradio", { name: level, exact: true });
        await expectRowHit(row);
        await row.click();
        await expect(menu).toHaveCount(0);
        await expect(reasoningChip(page)).toHaveAccessibleName(`Reasoning effort: ${level}`);
        await expect(reasoningChip(page)).toBeFocused();
        await expectDraftKept(page, TALL_DRAFT, true);
      }
      await expectNoHorizontalOverflow(page);
    });
  }

  test("dismisses with Escape and an outside click", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBlankChat(page, { attachment: "ready", draft: TALL_DRAFT });

    await openReasoning(page);
    await expectLayerWhole(page, REASONING_TRIGGER, "before Escape");
    await page.keyboard.press("Escape");
    await expect(reasoningMenu(page)).toHaveCount(0);
    await expect(reasoningChip(page)).toBeFocused();
    await expectDraftKept(page, TALL_DRAFT, true);

    await openReasoning(page);
    await expectLayerWhole(page, REASONING_TRIGGER, "before the outside click");
    // A point of the reading column outside the composer and its layer.
    const owner = await page.locator(".v2-conversation-scroll").boundingBox();
    await page.mouse.click(owner!.x + 12, owner!.y + 12);
    await expect(reasoningMenu(page)).toHaveCount(0);
    await expect(reasoningChip(page)).toHaveAccessibleName(`Reasoning effort: ${DEFAULT_LEVEL}`);
    await expectDraftKept(page, TALL_DRAFT, true);
  });

  test("stays whole while the viewport resizes from 1440x900 to 1366x768", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBlankChat(page, { attachment: "ready", draft: TALL_DRAFT });
    await openReasoning(page);
    await expectLayerWhole(page, REASONING_TRIGGER, "at 1440x900");
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(reasoningMenu(page)).toBeVisible();
    await expectLayerWhole(page, REASONING_TRIGGER, "after the resize to 1366x768");
    await expectNoHorizontalOverflow(page);
  });

  test("stays whole while the attachment turns from processing to ready", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { releaseStatusPoll } = await openBlankChat(page, { attachment: "processing", draft: TALL_DRAFT });
    await openReasoning(page);
    await expectLayerWhole(page, REASONING_TRIGGER, "while the attachment is processing");
    releaseStatusPoll();
    await expect(attachmentChip(page)).toHaveAttribute("data-attachment-status", "ready");
    await expect(reasoningMenu(page)).toBeVisible();
    await expectLayerWhole(page, REASONING_TRIGGER, "after the attachment is ready");
    await expectNoHorizontalOverflow(page);
  });

  test("stays whole while the overflowing blank chat scrolls", async ({ page }) => {
    // A shorter desktop window: the greeting and the tall composer overflow
    // the reading column, which then scrolls.
    await page.setViewportSize({ width: 1280, height: 600 });
    await openBlankChat(page, { attachment: "ready", draft: TALL_DRAFT });
    const owner = page.locator(".v2-conversation-scroll");
    const overflow = await owner.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(overflow, "the blank chat overflows its reading column").toBeGreaterThan(8);

    await owner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await openReasoning(page);
    await expectLayerWhole(page, REASONING_TRIGGER, "scrolled to the end");

    // Scroll back as far as the chip stays inside the column.
    await owner.evaluate((element, selector) => {
      const chip = element.querySelector(selector)!.getBoundingClientRect();
      const bottom = element.getBoundingClientRect().top + element.clientTop + element.clientHeight;
      element.scrollTop = Math.max(0, element.scrollTop - Math.max(0, bottom - 8 - chip.bottom));
    }, REASONING_TRIGGER);
    await expect(reasoningMenu(page)).toBeVisible();
    await expectLayerWhole(page, REASONING_TRIGGER, "scrolled back");

    await owner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(reasoningMenu(page)).toBeVisible();
    await expectLayerWhole(page, REASONING_TRIGGER, "scrolled to the end again");
    await expectNoHorizontalOverflow(page);
  });

  test("the shared path: the Add menu is whole beside its trigger at 1440x900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBlankChat(page, { attachment: "ready", draft: TALL_DRAFT });
    const trigger = page.locator(ADD_TRIGGER);
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Add" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeVisible();
    await expectLayerWhole(page, ADD_TRIGGER, "Add menu at 1440x900");
    await expectRowHit(menu.getByRole("menuitem").first());
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expectDraftKept(page, TALL_DRAFT, true);
  });
});

test.describe("short blank chat: Reasoning effort", () => {
  for (const viewport of TARGET_VIEWPORTS.slice(0, 2)) {
    test(`opens outside the composer without an internal scroll at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openBlankChat(page, { draft: SHORT_DRAFT });
      const menu = await openReasoning(page);
      await expectLayerWhole(page, REASONING_TRIGGER, `short ${viewport.width}x${viewport.height}`);
      // The fallback over the draft is only for a layer that fits on neither side.
      expect(await layerPlacement(page)).not.toBe("over");
      const [menuBox, composerBox] = await Promise.all([
        menu.boundingBox(),
        page.getByTestId("composer-v2-surface").boundingBox()
      ]);
      expect(
        menuBox!.y + menuBox!.height <= composerBox!.y + 1 || menuBox!.y >= composerBox!.y + composerBox!.height - 1,
        "the menu lies wholly above or below the composer"
      ).toBe(true);
      const row = menu.getByRole("menuitemradio", { name: "high", exact: true });
      await expectRowHit(row);
      await row.click();
      await expect(menu).toHaveCount(0);
      await expect(reasoningChip(page)).toHaveAccessibleName("Reasoning effort: high");
      await expect(reasoningChip(page)).toBeFocused();
      await expect(composerInput(page)).toHaveValue(SHORT_DRAFT);
      await expectNoHorizontalOverflow(page);
    });
  }
});

const chatId = "blank-chat-layer-docked";
const questionId = "blank-chat-layer-question";
const answerId = "blank-chat-layer-answer";
const timestamp = "2026-10-02T00:00:00.000Z";

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, status: "complete", createdAt: timestamp,
    citationMessageId: null, errorMessage: null, modelId: null, modelRunId: null, provider: null };
}

test("a populated chat's docked composer still opens Reasoning above itself", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const chat: ChatDetailWire = {
    assistant: null, id: chatId, title: "Docked composer", createdAt: timestamp, updatedAt: timestamp,
    activeLeafMessageId: answerId, defaultModelId: matrixCatalog.models[0]!.modelId,
    defaultProvider: matrixCatalog.models[0]!.provider, folderId: null, pinned: false, messageCount: 2,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: 100 },
    pageInfo: { activeLeafMessageId: answerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: [
      message(questionId, "user", "Synthetic docked question.", null),
      message(answerId, "assistant", "Synthetic docked answer.", questionId)
    ]
  };
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] }, { catalog: fixtureCatalog() });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", (route) => route.fulfill({ json: {
    allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
  } }));
  // A missed stream interception must never reach a provider.
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.getByText("Synthetic docked answer.")).toBeVisible();
  await composerInput(page).fill(SHORT_DRAFT);

  const menu = await openReasoning(page);
  await expectLayerWhole(page, REASONING_TRIGGER, "docked composer", true);
  expect(await layerPlacement(page), "the docked layer opens above the composer").toBeNull();
  const [menuBox, composerBox] = await Promise.all([
    menu.boundingBox(),
    page.getByTestId("composer-v2-surface").boundingBox()
  ]);
  expect(menuBox!.y + menuBox!.height, "the layer does not cover the draft").toBeLessThanOrEqual(composerBox!.y + 1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(reasoningChip(page)).toBeFocused();
  await expect(composerInput(page)).toHaveValue(SHORT_DRAFT);
});
