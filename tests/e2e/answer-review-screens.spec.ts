import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { runAccountMenuAction } from "./shell/page";
import { answerReviewSettingsDialog, chooseAnswerReview, modelPicker, openAnswerReviewSettings } from "./support/answerReviewAuto";
import {
  openAnswerReviewStand,
  REVIEW_FINDING,
  REVIEWER_NAME,
  reviewStatus,
  shownAnswer,
  type AnswerReviewStand
} from "./support/answerReviewStand";
import { forEachCaptureTheme } from "./support/capture";
import { turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, sendAndExpect, startNewChat } from "./support/workspace";

/**
 * Inspection screenshots of the answer review surfaces at the gallery's four
 * viewports (features-wave-parity-screens.spec.ts) in the light and the dark
 * theme, named `<surface>-<theme>-<viewport>.png`: the manual Review dialog,
 * a review's finding with Revise, Version 2 with its expanded history and
 * decisions, the model picker's Answer review row, the automatic review
 * settings, the header chip's review glyph and the Settings › Chat defaults
 * row with its dialog. They run on the fake-provider review stand (see
 * support/answerReviewStand.ts), which the gallery's own fixtures do not set
 * up: its chats are written once, before the viewports, and only viewed
 * afterwards. Layout checks run after each pair of shots and fail softly,
 * so a broken layout fails the spec without hiding the remaining shots.
 */

const prisma = new PrismaClient();
const userId = DEFAULT_BOOTSTRAP_USER_ID;
const REVISED = "Revised answer: the figure is verified and its source is named.";

type Viewport = Readonly<{ height: number; name: string; touch: boolean; width: number }>;

const VIEWPORTS: readonly Viewport[] = [
  { height: 900, name: "desktop", touch: false, width: 1440 },
  { height: 1180, name: "tablet-portrait", touch: false, width: 820 },
  { height: 844, name: "phone-portrait", touch: true, width: 390 },
  { height: 390, name: "phone-landscape", touch: true, width: 844 }
];

type ScreenChats = Readonly<{
  /** Automatic review on (the fixture reviewer, up to 2 rounds); never reviewed. */
  auto: string;
  /** A manual review's round 1 with one finding to evaluate. */
  findings: string;
  /** The finding accepted and revised into Version 2. */
  revised: string;
  /** Answered once, with no review. */
  unreviewed: string;
}>;

let stand: AnswerReviewStand | null = null;
let chats: ScreenChats | null = null;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(480_000);
  stand = await openAnswerReviewStand({ baseURL: testInfo.project.use.baseURL, browser, prisma, userId, warmPaths: [
    `/api/chats/${randomUUID()}/answer-reviews`, "/api/answer-reviews/route-warmup/steps", `/api/model-runs/${randomUUID()}/cancel`
  ] });
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL, viewport: { height: 900, width: 1440 } });
  try {
    await signInWithLocalToken(page);
    await disableMemoryRecall(page);
    const unreviewed = await answeredChat(page, "Summarize the plan in one line [AIQSA_REVIEW_E2E:clean]");
    const findings = await answeredChat(page, "Check the quarterly total of 12, 15 and 14 [AIQSA_REVIEW_E2E:findings]");
    await startManualReview(page);
    await expect(reviewStatus(page)).toHaveText(/Review · round 1 · 1 finding to evaluate/u, { timeout: 60_000 });
    const revised = await answeredChat(page, "Check the invoice total [AIQSA_REVIEW_E2E:findings]");
    await startManualReview(page);
    await expect(reviewStatus(page)).toHaveText(/1 finding to evaluate/u, { timeout: 60_000 });
    await reviewStatus(page).getByRole("button", { name: "Revise" }).click();
    await expect(shownAnswer(page)).toContainText(REVISED, { timeout: 60_000 });
    await expect(reviewStatus(page)).toHaveCount(0);
    const auto = await answeredChat(page, "Name one risk in one line [AIQSA_REVIEW_E2E:clean]");
    await chooseAnswerReview(page, { enabled: true, reviewer: REVIEWER_NAME, rounds: 2 });
    chats = { auto, findings, revised, unreviewed };
  } finally {
    await page.close();
  }
});

test.afterAll(async () => {
  await stand?.close();
  await prisma.$disconnect();
});

/** A new chat with Fake QSA and every tool off, answered once. */
async function answeredChat(page: Page, question: string): Promise<string> {
  await startNewChat(page);
  await turnComposerToolsOff(page);
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
  await sendAndExpect(page, question, "Fake answer:");
  const chatId = await activeChatId(page);
  stand!.chatIds.add(chatId);
  return chatId;
}

/** "Review…" on the latest answer with the fixture reviewer only. */
async function startManualReview(page: Page): Promise<void> {
  await shownAnswer(page).getByRole("button", { name: "More answer actions" }).click();
  await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Review…" }).click();
  const dialog = page.getByRole("dialog", { name: "Review with another model" });
  await expect(dialog).toBeVisible();
  // Every box by position, so unchecking one never shifts the others.
  for (const box of await dialog.getByRole("checkbox").all()) {
    const name = (await box.locator("xpath=following-sibling::span[1]").innerText()).trim();
    if (name !== REVIEWER_NAME && await box.isChecked()) await box.uncheck();
  }
  await dialog.getByRole("checkbox", { exact: true, name: REVIEWER_NAME }).check();
  await dialog.getByRole("button", { name: "Start review" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

/** The state as it is, in both themes. */
async function shot(page: Page, testInfo: TestInfo, surface: string, viewport: Viewport) {
  await forEachCaptureTheme(page, async (theme) => {
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`${surface}-${theme}-${viewport.name}.png`) });
  });
}

/** Runs a layout check as a soft assertion: the test fails, later shots are still taken. */
async function softly(label: string, check: () => Promise<void>) {
  const failure = await check().then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
  expect.soft(failure, label).toBeNull();
}

/**
 * A surface sits in the viewport horizontally; vertically too unless it is
 * taller than the viewport, when its top is on screen.
 */
async function expectFits(page: Page, surface: Locator) {
  await expect(surface).toBeVisible();
  const [box, viewport] = await Promise.all([surface.boundingBox(), page.viewportSize()]);
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  if (box!.height <= viewport!.height) expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  else expect(box!.y).toBeLessThan(viewport!.height);
}

/**
 * No horizontal overflow, the surfaces fit, and each control can be brought
 * into the viewport (a dialog may scroll) and is touch-safe on touch viewports.
 */
async function expectContained(page: Page, viewport: Viewport, label: string, input: Readonly<{
  controls?: readonly Locator[];
  surfaces?: readonly Locator[];
}>) {
  await softly(`${label}: no horizontal overflow`, () => expectNoHorizontalOverflow(page));
  for (const surface of input.surfaces ?? []) await softly(`${label}: surface fits the viewport`, () => expectFits(page, surface));
  for (const control of input.controls ?? []) {
    await softly(`${label}: control within the viewport`, async () => {
      await control.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, control);
    });
    if (viewport.touch) await softly(`${label}: touch-safe control`, () => expectTouchSafe(control));
  }
}

async function centered(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

/** Pages already signed in: a second sign-in would wait for a login redirect that never comes. */
const signedIn = new WeakSet<Page>();

async function openChat(page: Page, chatId: string) {
  if (signedIn.has(page)) {
    await page.goto(`/c/${chatId}`);
  } else {
    await signInWithLocalToken(page, `/c/${chatId}`);
    signedIn.add(page);
  }
  await expect(shownAnswer(page)).toContainText(/Fake answer:|Revised answer:/u, { timeout: 30_000 });
}

/** The header's model chip and the composer's chips all sit in the viewport. */
async function expectChipsFit(page: Page, viewport: Viewport, label: string) {
  const trigger = page.getByTestId("header-model-trigger");
  await expectContained(page, viewport, label, { controls: [trigger] });
  for (const chip of await page.getByTestId("composer-v2").locator(".v2-composer-indicator").all()) {
    await softly(`${label}: composer chip within the viewport`, () => expectWithinViewport(page, chip));
  }
}

// --------------------------------------------------------------- manual review

async function manualReviewScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  // The reviewer picker of "Review…".
  await openChat(page, chats!.unreviewed);
  const answer = shownAnswer(page);
  await answer.scrollIntoViewIfNeeded();
  if (!viewport.touch) await answer.hover();
  await answer.getByRole("button", { name: "More answer actions" }).click();
  await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Review…" }).click();
  const start = page.getByRole("dialog", { name: "Review with another model" });
  await expect(start.getByRole("checkbox", { exact: true, name: REVIEWER_NAME })).toBeVisible();
  await shot(page, testInfo, "answer-review-start-dialog", viewport);
  await expectContained(page, viewport, "answer-review-start-dialog", { controls: [start.getByRole("button", { name: "Start review" }),
    start.getByRole("button", { name: "Cancel" })], surfaces: [start] });
  await start.getByRole("button", { name: "Cancel" }).click();
  await expect(start).toHaveCount(0);

  // Round 1's finding: the status line with Revise, then the review card in the history.
  await openChat(page, chats!.findings);
  const status = reviewStatus(page);
  await expect(status).toHaveText(/Review · round 1 · 1 finding to evaluate/u);
  const revise = status.getByRole("button", { name: "Revise" });
  await centered(status);
  await shot(page, testInfo, "answer-review-findings-status", viewport);
  await expectContained(page, viewport, "answer-review-findings-status", { controls: [revise], surfaces: [status] });
  const history = page.getByTestId("answer-review-history");
  const toggle = history.getByRole("button", { name: "Review history · 1 round" });
  await toggle.click();
  const card = history.getByTestId("answer-review-card");
  await expect(card).toContainText(`Review by ${REVIEWER_NAME}: 1 finding`);
  await expect(card).toContainText(REVIEW_FINDING.problem);
  await centered(card);
  await shot(page, testInfo, "answer-review-findings-card", viewport);
  await expectContained(page, viewport, "answer-review-findings-card", { controls: [toggle], surfaces: [card] });

  // Version 2: the history collapsed under the revised answer, then expanded on the author's decisions.
  await openChat(page, chats!.revised);
  await expect(shownAnswer(page)).toContainText(REVISED);
  const revisedHistory = page.getByTestId("answer-review-history");
  const revisedToggle = revisedHistory.getByRole("button", { name: "Review history · 1 round" });
  await expect(revisedToggle).toHaveAttribute("aria-expanded", "false");
  await centered(revisedToggle);
  await shot(page, testInfo, "answer-review-version-2-collapsed", viewport);
  await expectContained(page, viewport, "answer-review-version-2-collapsed", { controls: [revisedToggle], surfaces: [shownAnswer(page)] });
  await revisedToggle.click();
  await expect(revisedHistory).toContainText("Version 1");
  await expect(revisedHistory.getByTestId("answer-review-card")).toContainText("Accepted");
  await expect(revisedHistory.getByTestId("answer-review-decisions")).toHaveText(/Decisions: 1 accepted, 0 rejected/u);
  const revision = revisedHistory.locator('li[data-kind="revision"]');
  await expect(revision).toContainText("Version 2 is the answer shown above.");
  await centered(revisedHistory.getByTestId("answer-review-card"));
  await shot(page, testInfo, "answer-review-version-2-review", viewport);
  await expectContained(page, viewport, "answer-review-version-2-review", { surfaces: [revisedHistory.getByTestId("answer-review-card")] });
  await centered(revision);
  await shot(page, testInfo, "answer-review-version-2-decisions", viewport);
  await expectContained(page, viewport, "answer-review-version-2-decisions", { controls: [revisedToggle], surfaces: [revision] });
}

// ------------------------------------------------------------ automatic review

async function automaticReviewScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  await openChat(page, chats!.auto);
  const trigger = page.getByTestId("header-model-trigger");
  const glyph = trigger.getByTestId("header-model-review");
  await expect(glyph).toHaveAttribute("data-state", "on");
  await expect(trigger).toHaveAttribute("title", new RegExp(`Review: ${REVIEWER_NAME}, up to 2 rounds`, "u"));
  // The count beside the glyph shows from tablets up.
  const count = glyph.locator(".v2-live-model-review-count");
  if (viewport.width < 768) await expect(count).toBeHidden();
  else await expect(count).toHaveText("1");
  await shot(page, testInfo, "answer-review-header-chip", viewport);
  await expectChipsFit(page, viewport, "answer-review-header-chip");
  await softly("answer-review-header-chip: glyph within the viewport", () => expectWithinViewport(page, glyph));

  await trigger.click();
  const row = modelPicker(page).getByTestId("composer-v2-model-answer-review");
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText("On · 1 reviewer · up to 2 rounds");
  await shot(page, testInfo, "answer-review-picker-row", viewport);
  await expectContained(page, viewport, "answer-review-picker-row", { controls: [row] });
  await page.keyboard.press("Escape");
  await expect(modelPicker(page)).toHaveCount(0);

  const dialog = await openAnswerReviewSettings(page);
  const toggle = dialog.getByRole("switch", { name: /Review answers automatically/u });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("checkbox", { exact: true, name: REVIEWER_NAME })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Up to 2" })).toBeChecked();
  await expect(dialog.getByTestId("answer-review-cost-hint")).toContainText("Up to 4 extra answers per question");
  await shot(page, testInfo, "answer-review-settings-dialog", viewport);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expectContained(page, viewport, "answer-review-settings-dialog", { controls: [toggle,
    dialog.locator("label.v2-answer-review-round", { hasText: "Up to 2" }), dialog.getByRole("button", { name: "Save", exact: true }), cancel],
  surfaces: [dialog] });
  await cancel.click();
  await expect(answerReviewSettingsDialog(page)).toHaveCount(0);
  // Nothing changed: the chip still carries the review.
  await expect(glyph).toHaveAttribute("data-state", "on");
}

// -------------------------------------------------------- Settings › Chat defaults

async function chatDefaultsScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  await signInWithLocalToken(page);
  await runAccountMenuAction(page, "Chat defaults");
  const row = page.getByTestId("settings-default-answer-review");
  await expect(row.getByTestId("settings-default-answer-review-summary")).toHaveText("Off", { timeout: 30_000 });
  const change = row.getByRole("button", { name: "Change…" });
  await centered(row);
  await shot(page, testInfo, "answer-review-default-row", viewport);
  await expectContained(page, viewport, "answer-review-default-row", { controls: [change], surfaces: [row] });

  await change.click();
  const dialog = page.getByRole("dialog", { name: "Answer review for new chats" });
  await expect(dialog.getByRole("switch", { name: /Review answers in new chats/u })).toHaveAttribute("aria-checked", "false");
  await shot(page, testInfo, "answer-review-default-dialog", viewport);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expectContained(page, viewport, "answer-review-default-dialog", { controls: [cancel], surfaces: [dialog] });
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByTestId("settings-default-answer-review-summary")).toHaveText("Off");
}

// --------------------------------------------------------------------- tests

for (const viewport of VIEWPORTS) {
  test.describe(`answer review screens · ${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch, viewport: { height: viewport.height, width: viewport.width } });

    test("manual review: Review dialog, a finding to evaluate, Version 2 with its history", async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await manualReviewScreens(page, testInfo, viewport);
    });

    test("automatic review: header chip, picker row and settings dialog", async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await automaticReviewScreens(page, testInfo, viewport);
    });

    test("Settings › Chat defaults: the answer review row and its dialog", async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await chatDefaultsScreens(page, testInfo, viewport);
    });
  });
}
