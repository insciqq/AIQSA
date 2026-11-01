import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";
import { decodeResearchPlanAnswer } from "../../lib/contracts/research";
import { chooseSearchStrategy } from "./shell/composer";
import { captureState, type CaptureTheme } from "./support/capture";
import { prepareFakeQsaChats } from "./support/chatDefaults";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";
import { createPeopleFixture } from "./support/people";
import { createCatalogOnlySearchSource } from "./support/syntheticCatalog";
import { activeChatId, lastAnswer, lastActivity, selectFakeModel } from "./support/workspace";

/**
 * The research plan's card on a real server and the fake provider: `[AIQSA_RESEARCH_PLAN_E2E:<ms>]` makes the model call
 * `start_research`, stay `<ms>` in scoping, then call `propose_research_plan` (`lib/server/providers/fakeProvider.ts`). The window, its
 * lease and its row are the product's; the fake waits for Stop once the plan stands, because no researcher or report is under test.
 * Research is offered only with Search, so the Fake QSA run carries a catalog-only source it never searches. The oracle is the row the
 * server wrote, never wording. States the server takes minutes to reach are covered in `features/answer-outputs-v2/ResearchPlanCardV2.test.tsx`.
 *
 * Screenshots go to the test's output directory, one viewport shot per state and size, named `<state>-<theme>-<width>x<height>.png`:
 * desktop 1440x900, tablet 1024x768 and 768x1024, phone 390x844 and 844x390. Never element shots: one taller than the viewport drops touch emulation.
 */

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const START = "Начать поиск";
const DESKTOP: BrowserContextOptions = { viewport: { height: 900, width: 1440 } };
const PHONE_TOUCH: BrowserContextOptions = { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } };
const LIGHT: readonly CaptureTheme[] = ["light"];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const card = (page: Page) => lastAnswer(page).getByTestId("research-plan-card");
const clock = (page: Page) => card(page).getByTestId("research-plan-clock");
const button = (page: Page, name: string) => card(page).getByRole("button", { exact: true, name });

/** A user of their own with the Search source chosen, one research turn sent, and everything removed afterwards. */
async function withResearch(browser: Browser, options: Readonly<{ context?: BrowserContextOptions; scopingMs: number }>,
  body: (page: Page, chatId: string) => Promise<void>) {
  const people = createPeopleFixture(prisma);
  const source = await createCatalogOnlySearchSource(prisma, "research-plan");
  try {
    const user = await people.user("Research plan");
    await prepareFakeQsaChats(prisma, user.id);
    const { page } = await people.signIn(browser, user, options.context ?? DESKTOP);
    await selectFakeModel(page);
    await chooseSearchStrategy(page, escapeRegExp(source.displayName));
    const message = page.getByRole("textbox", { exact: true, name: "Message" });
    await message.fill(`Find me the quietest kettle [AIQSA_RESEARCH_PLAN_E2E:${options.scopingMs}]`);
    await message.press("Enter");
    const chatId = await activeChatId(page);
    await body(page, chatId);
    await page.getByRole("button", { name: "Stop answer" }).click();
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
  } finally {
    await people.cleanup();
    await source.cleanup();
  }
}

/** What closed the window and whether the user changed the plan, as the server recorded it. */
async function recordedAnswer(chatId: string) {
  await expect.poll(async () => (await prisma.researchFrame.findFirst({ where: { chatId } }))?.releasedAt ?? null, { timeout: 20_000 }).not.toBeNull();
  const decoded = decodeResearchPlanAnswer((await prisma.researchFrame.findFirstOrThrow({ where: { chatId } })).answer);
  if (!decoded.ok) throw new Error(decoded.message);
  return decoded.value;
}

async function capture(page: Page, testInfo: TestInfo, name: string, themes?: readonly CaptureTheme[]) {
  const shots = await captureState(page, testInfo, name, { anchor: card(page), ...themes ? { themes } : {} });
  for (const shot of shots) expect(shot.overflow, `${shot.size.width}x${shot.size.height}`).toEqual({ body: 0, document: 0 });
}

async function windowOpen(page: Page) {
  await expect(card(page)).toHaveAttribute("data-state", "window", { timeout: 30_000 });
}

async function secondsLeft(page: Page): Promise<number> {
  const match = /(\d+):(\d\d)$/u.exec((await clock(page).textContent()) ?? "");
  expect(match, "the countdown shows minutes and seconds").not.toBeNull();
  return Number(match![1]) * 60 + Number(match![2]);
}

async function ordinaryPlanTookOver(page: Page, timeout = 20_000) {
  await expect(card(page)).toHaveCount(0, { timeout });
  await expect(lastActivity(page).locator(":scope > summary")).toContainText(/Plan · \d+ of \d+ complete/u);
}

test("the plan is made, keeps its time over a reload, and an edit holds the timer and starts research when saved", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withResearch(browser, { scopingMs: 15_000 }, async (page, chatId) => {
    await expect(card(page)).toHaveAttribute("data-state", "scoping", { timeout: 30_000 });
    await expect(card(page)).toContainText("Making a plan before research starts");
    await capture(page, testInfo, "research-plan-scoping", LIGHT);

    await windowOpen(page);
    await expect(card(page)).toContainText("You want the quietest kettle for a home kitchen.");
    await expect(card(page)).toContainText("The budget is open");
    await expect(card(page).getByRole("list").last().getByRole("listitem")).toHaveCount(4);
    await expect(button(page, START)).toBeVisible();
    const before = await secondsLeft(page);
    expect(before).toBeLessThanOrEqual(60);

    await page.reload();
    await windowOpen(page);
    const after = await secondsLeft(page);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    await capture(page, testInfo, "research-plan-window", LIGHT);

    await button(page, "Edit").click();
    await expect(card(page)).toHaveAttribute("data-state", "editing");
    await expect(card(page)).toHaveAttribute("data-held", "true");
    await expect(clock(page)).toHaveText("Timer held while you edit");
    await expect(card(page).getByLabel("How I understood the task")).toBeFocused();
    await card(page).getByLabel("Step 1", { exact: true }).fill("Read how quiet kettles are tested");
    await button(page, "Delete step 4").click();
    await expect(button(page, "Add step")).toBeVisible();
    await button(page, "Add step").click();
    await card(page).getByLabel("Step 4", { exact: true }).fill("Ask owners about the noise");
    await capture(page, testInfo, "research-plan-editing");

    await button(page, START).click();
    await ordinaryPlanTookOver(page);
    const answer = await recordedAnswer(chatId);
    expect(answer).toMatchObject({ changed: true, releasedBy: "saved_edit" });
    expect(answer.plan.steps).toEqual(["Read how quiet kettles are tested", "List the quiet candidates", "Compare measured noise", "Ask owners about the noise"]);
  });
});

test("Начать поиск starts research at once", async ({ browser }) => {
  test.setTimeout(120_000);
  await withResearch(browser, { scopingMs: 0 }, async (page, chatId) => {
    await windowOpen(page);
    await button(page, START).click();
    await ordinaryPlanTookOver(page);
    expect(await recordedAnswer(chatId)).toMatchObject({ changed: false, releasedBy: "start_button" });
  });
});

test("with nobody there research starts when the time is up", async ({ browser }) => {
  test.setTimeout(180_000);
  await withResearch(browser, { scopingMs: 0 }, async (page, chatId) => {
    await windowOpen(page);
    await ordinaryPlanTookOver(page, 80_000);
    expect(await recordedAnswer(chatId)).toMatchObject({ changed: false, releasedBy: "timer" });
  });
});

test("a person can do it all by keyboard and touch on a phone, and Cancel gives the time back", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  await withResearch(browser, { context: PHONE_TOUCH, scopingMs: 0 }, async (page, chatId) => {
    await windowOpen(page);
    await expectNoHorizontalOverflow(page);
    await expectTouchSafe(button(page, "Edit"));
    await expectTouchSafe(button(page, START));

    await button(page, "Edit").focus();
    await page.keyboard.press("Enter");
    await expect(card(page)).toHaveAttribute("data-state", "editing");
    await expect(clock(page)).toHaveText("Timer held while you edit");
    await expectNoHorizontalOverflow(page);
    await expectTouchSafe(button(page, "Delete step 1"));
    await expectTouchSafe(button(page, "Add step"));
    await button(page, "Delete step 2").focus();
    await page.keyboard.press("Enter");
    await expect(button(page, "Delete step 2")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("research-plan-editing-touch-390x844.png") });

    await button(page, "Cancel").focus();
    await page.keyboard.press("Enter");
    await expect(card(page)).toHaveAttribute("data-state", "window");
    await expect(button(page, "Edit")).toBeFocused();
    expect(await secondsLeft(page)).toBeGreaterThanOrEqual(8);

    await page.setViewportSize({ height: 390, width: 844 });
    await expectNoHorizontalOverflow(page);
    await button(page, START).focus();
    await page.keyboard.press("Enter");
    await ordinaryPlanTookOver(page);
    expect(await recordedAnswer(chatId)).toMatchObject({ changed: false, releasedBy: "start_button" });
  });
});
