import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ChatDetailResponseWire } from "../../lib/contracts/chats";
import { formatAssistantEntryPath } from "../../lib/domain/chatRoute";
import { runAccountMenuAction } from "./shell/page";
import { assistantContentWithText } from "./shell/thread";
import { createAssistantFixture, e2eAssistantAvatar, fakeModelId, type AssistantFixture, type E2EAssistant } from "./support/assistants";
import { captureState, type CaptureSize, type CaptureStep } from "./support/capture";
import { prepareFakeQsaChats } from "./support/chatDefaults";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { createPeopleFixture, type E2EUser, type E2EUserOptions, type PeopleFixture } from "./support/people";
import { createCatalogOnlyAnswerModel, createCatalogOnlySearchSource } from "./support/syntheticCatalog";
import { activeChatId, startNewChat, submitPasswordSignIn } from "./support/workspace";

/**
 * Assistants v2 in the chat of the real application (PRD A-11 to A-22, A-34
 * and scenarios 2 to 8, 11, 12). Every test signs in synthetic people with the
 * Fake QSA model and the Workspace default off, creates what it needs through
 * the shared helpers and removes it afterwards; no test depends on another or
 * keeps Assistant state in localStorage. Geometry is asserted with numbers;
 * captures in both themes at the standard sizes are evidence for a visual
 * review, not assertions.
 */

test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const DESKTOP = { viewport: { height: 900, width: 1440 } } as const;
const PHONE = { viewport: { height: 844, width: 390 } } as const;
const NO_ASSISTANT = "No Assistant";
const SEND_GATE = "Nothing is sent until you choose.";
const LINK_UNAVAILABLE = "This Assistant isn't available to you.";

type Fixtures = Readonly<{
  assistants: AssistantFixture;
  /** Registers a cleanup that runs after the Assistant and people cleanups, last registered first. */
  defer(cleanup: () => Promise<void>): void;
  people: PeopleFixture;
}>;

/** Runs a scenario with fresh fixtures and always removes what they created. */
async function withFixtures(run: (fixtures: Fixtures) => Promise<void>): Promise<void> {
  const people = createPeopleFixture(prisma);
  const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
  const deferred: (() => Promise<void>)[] = [];
  try {
    await run({ assistants, defer: (cleanup) => deferred.push(cleanup), people });
  } finally {
    const errors: unknown[] = [];
    // Chats go first: runs and bindings hold the catalog fixtures they used.
    for (const cleanup of [() => assistants.cleanup(), () => people.cleanup(), ...deferred.reverse()]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  }
}

/** A synthetic member (or administrator) who sends with Fake QSA and the Workspace default off. */
async function chatUser(
  people: PeopleFixture,
  label: string,
  options: E2EUserOptions & Readonly<{ admin?: boolean }> = {}
): Promise<E2EUser> {
  const user = options.admin ? await people.admin(label, options) : await people.user(label, options);
  await prepareFakeQsaChats(prisma, user.id);
  return user;
}

async function signIn(
  people: PeopleFixture,
  browser: Browser,
  user: E2EUser,
  size: Readonly<{ viewport: Readonly<{ height: number; width: number }> }> = DESKTOP
): Promise<Page> {
  return withActionTimeout((await people.signIn(browser, user, size)).page);
}

/** A locator that cannot act fails in seconds with its own message instead of at the test timeout. */
function withActionTimeout(page: Page): Page {
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);
  return page;
}

/** The strip and the picker list Assistants in the list response's order: by name. */
function byName(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const selector = (page: Page) => page.getByTestId("header-assistant-selector");
const assistantMenu = (page: Page) => page.getByRole("menu", { name: "Assistant" });
const menuHead = (page: Page) => page.getByTestId("header-assistant-menu-head");
const pickerDialog = (page: Page) => page.getByRole("dialog", { name: "Choose an Assistant" });
const messageBox = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
const sendButton = (page: Page) => page.getByRole("button", { name: "Send message" });
const answers = (page: Page) => page.locator('article[data-role="assistant"]');
const notice = (page: Page) => page.getByTestId("assistant-binding-notice");
const modelTrigger = (page: Page) => page.getByTestId("header-model-trigger");
const modelPickerDialog = (page: Page) => page.getByRole("dialog", { name: "Choose model" });
const parametersDialog = (page: Page) => page.getByRole("dialog", { name: "Model parameters" });

/** A model the Assistant fixes: the header button stays usable, locked, with the Assistant's mark. */
async function expectFixedModelButton(page: Page, assistant: E2EAssistant, model = "Fake QSA"): Promise<void> {
  const button = modelTrigger(page);
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("data-locked", "true");
  await expect(button).toHaveAttribute("data-provenance", "assistant");
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await expect(button).toHaveAttribute("title", `${model} · fixed by ${assistant.name}`);
  await expect(button).toContainText(model);
}

/** The picker of a fixed model: why it is fixed and the Parameters row, and nothing that changes the model. */
async function expectFixedModelPicker(page: Page, assistant: E2EAssistant, model = "Fake QSA"): Promise<Locator> {
  const picker = modelPickerDialog(page);
  await expect(picker).toBeVisible();
  await expect(modelTrigger(page)).toHaveAttribute("aria-expanded", "true");
  const fixed = picker.getByTestId("composer-v2-model-fixed");
  await expect(fixed.getByTestId("assistant-row-provenance")).toHaveText(`Fixed by ${assistant.name} — ${model}`);
  await expect(fixed.getByTestId("composer-v2-model-parameters")).toBeVisible();
  await expect(fixed).toContainText("Applies to your next message.");
  await expect(picker.getByRole("searchbox")).toHaveCount(0);
  await expect(picker.getByRole("listbox")).toHaveCount(0);
  await expect(picker.getByRole("option")).toHaveCount(0);
  await expect(picker.getByRole("button", { name: /default model|Set as default/u })).toHaveCount(0);
  return picker;
}

/** Chooses an Assistant from the header picker of a chat without one. */
async function pickInHeader(page: Page, assistant: E2EAssistant): Promise<void> {
  await expect(selector(page)).toHaveAttribute("data-state", "empty");
  await selector(page).click();
  await pickerDialog(page).getByTestId(`assistant-picker-row-${assistant.id}`).click();
  await expect(pickerDialog(page)).toHaveCount(0);
  await expect(selector(page)).toHaveAttribute("data-state", "chosen");
  await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
}

/** "Change…" in the selector menu, then another Assistant in the picker. */
async function changeInHeader(page: Page, assistant: E2EAssistant): Promise<void> {
  await expect(selector(page)).toHaveAttribute("data-state", "chosen");
  await selector(page).click();
  await assistantMenu(page).getByRole("menuitem", { name: "Change…" }).click();
  await pickerDialog(page).getByTestId(`assistant-picker-row-${assistant.id}`).click();
  await expect(pickerDialog(page)).toHaveCount(0);
  await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
}

async function removeInHeader(page: Page): Promise<void> {
  await expect(selector(page)).toHaveAttribute("data-state", "chosen");
  await selector(page).click();
  await assistantMenu(page).getByRole("menuitem", { name: /^Remove for this chat/u }).click();
  await expect(selector(page)).toHaveAttribute("data-state", "empty");
}

async function expectAnswer(page: Page, text: string): Promise<void> {
  await expect(assistantContentWithText(page, `Fake answer: ${text}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 30_000 });
}

async function send(page: Page, text: string): Promise<void> {
  await messageBox(page).fill(text);
  await sendButton(page).click();
  await expectAnswer(page, text);
}

/** The bodies of `POST /api/chats/<id>/messages` the page sends from now on. */
function recordSends(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(request.url()).pathname)) {
      bodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  return bodies;
}

function chatUpdate(page: Page, chatId: string) {
  return page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/chats/${chatId}`);
}

async function readChat(request: APIRequestContext, chatId: string): Promise<ChatDetailResponseWire["chat"]> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json() as ChatDetailResponseWire).chat;
}

async function rowProvenance(request: APIRequestContext, chatId: string, row: "model" | "search" | "tools") {
  const assistant = (await readChat(request, chatId)).assistant;
  return assistant?.state === "bound" ? assistant.rows[row].provenance : null;
}

type StoredRun = Readonly<{
  assistantId: string | null;
  assistantIdentity: unknown;
  normalizedRequest: unknown;
}>;

/** The chat's runs in order, once `count` of them exist. */
async function chatRuns(chatId: string, count: number): Promise<StoredRun[]> {
  await expect.poll(() => prisma.modelRun.count({ where: { chatId } }), { timeout: 15_000 }).toBe(count);
  return prisma.modelRun.findMany({
    orderBy: { createdAt: "asc" },
    select: { assistantId: true, assistantIdentity: true, normalizedRequest: true },
    where: { chatId }
  });
}

function identityName(run: StoredRun): string | null {
  const identity = run.assistantIdentity as { name?: unknown } | null;
  return typeof identity?.name === "string" ? identity.name : null;
}

function reasoningEffort(run: StoredRun): unknown {
  return (run.normalizedRequest as { reasoningEffort?: unknown } | null)?.reasoningEffort;
}

function searchOptionIds(run: StoredRun): string[] {
  const request = run.normalizedRequest as { searchPlan?: { options?: { optionId: string }[] } } | null;
  return request?.searchPlan?.options?.map((option) => option.optionId) ?? [];
}

/**
 * The identity chip of every visible answer, in order: an Assistant name,
 * "No Assistant", or null where the answer shows no chip.
 */
async function expectIdentityChips(page: Page, expected: readonly (string | null)[]): Promise<void> {
  await expect(answers(page)).toHaveCount(expected.length);
  for (const [index, name] of expected.entries()) {
    const chip = answers(page).nth(index).getByTestId("answer-assistant-identity");
    const label = `answer ${index + 1}`;
    if (name === null) {
      await expect(chip, label).toHaveCount(0);
      continue;
    }
    await expect(chip, label).toHaveAttribute("data-identity", name === NO_ASSISTANT ? "none" : "assistant");
    await expect(chip, label).toHaveText(name);
  }
}

/** The dot a chip draws for "set by the Assistant", as computed. */
async function markerStyle(chip: Locator) {
  return chip.evaluate((element) => {
    const face = element.firstElementChild;
    if (!face) return null;
    const style = getComputedStyle(face, "::after");
    return {
      background: style.backgroundColor,
      content: style.content,
      height: style.height,
      radius: style.borderRadius,
      width: style.width
    };
  });
}

type StripLayout = Readonly<{ bottom: number; items: number; lastLabel: string; left: number; right: number; rows: number }>;

/** Rows and edges of the strip's shown items (left-out pills are hidden from assistive technology). */
async function stripLayout(strip: Locator): Promise<StripLayout> {
  return strip.evaluate((element) => {
    const shown = [...element.querySelectorAll<HTMLElement>("button")]
      .filter((item) => item.getAttribute("aria-hidden") !== "true")
      .map((item) => ({ label: item.textContent?.trim() ?? "", rect: item.getBoundingClientRect() }));
    const tops: number[] = [];
    for (const { rect } of shown) {
      if (!tops.some((top) => Math.abs(top - rect.top) <= 4)) tops.push(rect.top);
    }
    const last = shown.reduce((current, candidate) =>
      candidate.rect.top > current.rect.top + 4 ||
        (Math.abs(candidate.rect.top - current.rect.top) <= 4 && candidate.rect.left > current.rect.left)
        ? candidate
        : current);
    return {
      bottom: Math.max(...shown.map((item) => item.rect.bottom)),
      items: shown.length,
      lastLabel: last.label,
      left: Math.min(...shown.map((item) => item.rect.left)),
      right: Math.max(...shown.map((item) => item.rect.right)),
      rows: tops.length
    };
  });
}

function sizeLabel(size: CaptureSize): string {
  return `${size.width}x${size.height}`;
}

/**
 * Captures a state whose overlay is opened again after every resize: a
 * resize may replace an open menu with its phone sheet. The overlay is
 * closed afterwards.
 */
async function captureOpen(
  page: Page,
  testInfo: TestInfo,
  name: string,
  overlay: Locator,
  open: () => Promise<void>,
  options: Readonly<{ check?: (step: CaptureStep) => Promise<void>; sizes?: readonly CaptureSize[] }> = {}
): Promise<void> {
  const close = async () => {
    if (!(await overlay.isVisible())) return;
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
  };
  try {
    await captureState(page, testInfo, name, {
      atEachSize: async (step) => {
        await close();
        await open();
        await expect(overlay, sizeLabel(step.size)).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await options.check?.(step);
      },
      ...(options.sizes ? { sizes: options.sizes } : {})
    });
  } finally {
    await close().catch(() => undefined);
  }
}

test("the blank chat strip offers pinned then Featured once each and no recents; a pick shows the intro and the header Assistant; without either the header still opens the picker · A-11", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  await withFixtures(async ({ assistants, people }) => {
    const admin = await chatUser(people, "Strip admin", { admin: true });
    const author = await chatUser(people, "Strip author");
    const viewer = await chatUser(people, "Strip viewer");
    const adminApi = (await people.signIn(browser, admin, DESKTOP)).page.request;
    const authorApi = (await people.signIn(browser, author, DESKTOP)).page.request;
    const page = await signIn(people, browser, viewer);
    const strip = page.getByTestId("assistant-strip");

    // Nothing pinned and nothing Featured: no strip, and the header icon still opens the picker.
    await expect(selector(page)).toHaveAttribute("data-state", "empty");
    await expect(selector(page)).toHaveAccessibleName("Choose an Assistant");
    await selector(page).click();
    await expect(pickerDialog(page)).toBeVisible();
    await expect(pickerDialog(page).getByRole("searchbox", { name: "Search Assistants" })).toBeFocused();
    await expect(pickerDialog(page).getByText("Loading Assistants…")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(pickerDialog(page)).toHaveCount(0);
    await expect(selector(page)).toBeFocused();
    // The list has loaded (the picker read it), and there is nothing to offer under the composer.
    await expect(strip).toHaveCount(0);

    const planner = await assistants.create(page.request, {
      description: "Plans the week and keeps the list short.",
      name: "Pinned planner",
      starterPrompts: ["Plan my week", "Summarize open items", "Draft a status note"]
    });
    const pinnedFeatured = await assistants.create(page.request, { name: "Pinned and featured" });
    const recent = await assistants.create(page.request, { name: "Recent helper" });
    const featuredFirst = await assistants.create(authorApi, { name: "Featured first" });
    const featuredSecond = await assistants.create(authorApi, { name: "Featured second" });
    await assistants.pin(page.request, planner.id);
    await assistants.pin(page.request, pinnedFeatured.id);
    const listings: readonly (readonly [APIRequestContext, E2EAssistant, number])[] = [
      [authorApi, featuredFirst, 0],
      [authorApi, featuredSecond, 1],
      [page.request, pinnedFeatured, 2]
    ];
    for (const [owner, assistant, order] of listings) {
      const { requestId } = await assistants.requestListing(owner, assistant.id);
      await assistants.decideListing(adminApi, requestId, "approve");
      await assistants.feature(adminApi, assistant.id, order);
    }
    // A chat with "Recent helper" makes it recent; recents belong to the picker only.
    await assistants.createChat(page.request, { assistant: { assistantId: recent.id } });

    await page.goto("/");
    const items = strip.getByRole("button");
    await expect(items).toHaveCount(5);
    const labels = (await items.allInnerTexts()).map((label) => label.trim());
    expect(labels.slice(0, 2)).toEqual(byName([planner.name, pinnedFeatured.name]));
    expect(labels.slice(2)).toEqual([featuredFirst.name, featuredSecond.name, "All Assistants…"]);
    expect(labels).not.toContain(recent.name);

    await captureState(page, testInfo, "chat-blank-strip", {
      atEachSize: async ({ size }) => {
        const layout = await stripLayout(strip);
        expect(layout.rows, sizeLabel(size)).toBe(1);
        expect(layout.lastLabel, sizeLabel(size)).toBe("All Assistants…");
        expect(layout.right, sizeLabel(size)).toBeLessThanOrEqual(size.width);
        await expectNoHorizontalOverflow(page);
      }
    });

    // The picker lists each Assistant once, in its first section: Pinned, Recent, Featured.
    await strip.getByRole("button", { name: "All Assistants…" }).click();
    const picker = pickerDialog(page);
    const section = (label: string) => picker.getByRole("region", { exact: true, name: label });
    await expect(section("Pinned").getByTestId(`assistant-picker-row-${planner.id}`)).toBeVisible();
    await expect(section("Pinned").getByTestId(`assistant-picker-row-${pinnedFeatured.id}`)).toBeVisible();
    await expect(section("Recent").getByTestId(`assistant-picker-row-${recent.id}`)).toBeVisible();
    await expect(section("Featured").getByTestId(`assistant-picker-row-${featuredFirst.id}`)).toBeVisible();
    await expect(section("Featured").getByTestId(`assistant-picker-row-${featuredSecond.id}`)).toBeVisible();
    await expect(picker.getByTestId(`assistant-picker-row-${pinnedFeatured.id}`)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await captureOpen(page, testInfo, "chat-picker", picker, () => selector(page).click(), {
      check: async () => expectWithinViewport(page, picker)
    });

    // A pick shows the quiet intro, the Assistant in the header and its starters; the strip goes.
    await strip.getByRole("button", { name: planner.name }).click();
    await expect(selector(page)).toHaveAttribute("data-state", "chosen");
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${planner.name}`);
    const intro = page.getByTestId("assistant-blank-intro");
    await expect(intro.getByRole("heading", { name: planner.name })).toBeVisible();
    await expect(intro).toContainText("Plans the week and keeps the list short.");
    await expect(intro).toContainText("By you");
    await expect(strip).toHaveCount(0);
    const starters = page.getByTestId("assistant-starter-prompts");
    await expect(starters.getByRole("button", { name: "Plan my week" })).toBeVisible();
    await captureState(page, testInfo, "chat-intro-starters", {
      atEachSize: async ({ size }) => {
        await expectWithinViewport(page, messageBox(page));
        await expect(intro.getByRole("heading", { name: planner.name }), sizeLabel(size)).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    });
  });
});

test("changing an adjustable model keeps the Assistant and reads changed for this chat; Reset to Assistant restores the model and its dot, both after a reload · A-12", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, defer, people }) => {
    const other = await createCatalogOnlyAnswerModel(prisma, "a12");
    defer(other.cleanup);
    const user = await chatUser(people, "Model changer");
    const page = await signIn(people, browser, user);
    const modelId = await fakeModelId(prisma);
    const assistant = await assistants.create(page.request, {
      name: "Model advisor",
      rows: { model: { policy: "adjustable", value: { mode: "model", modelId } } }
    });
    const chatId = await assistants.createChat(page.request, { assistant: { assistantId: assistant.id } });
    await page.goto(`/c/${chatId}`);
    const model = modelTrigger(page);
    const modelPicker = page.getByRole("dialog", { name: "Choose model" });
    const provenanceLine = modelPicker.getByTestId("assistant-row-provenance");

    const expectAssistantModel = async () => {
      await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
      await expect(model).toContainText("Fake QSA");
      await expect(model).toHaveAttribute("data-provenance", "assistant");
      await expect(model).toHaveAttribute("title", `Fake QSA · recommended by ${assistant.name}`);
    };
    const expectChangedModel = async () => {
      await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
      await expect(model).toContainText(other.displayName);
      await expect(model).not.toHaveAttribute("data-provenance", "assistant");
      await expect(model).toHaveAttribute("title", `Changed for this chat · ${assistant.name} starts with Fake QSA`);
    };
    await expectAssistantModel();

    let update = chatUpdate(page, chatId);
    await model.click();
    await expect(provenanceLine).toContainText(`Recommended by ${assistant.name} — Fake QSA`);
    await expect(provenanceLine).toContainText("In use");
    await modelPicker.getByRole("option", { name: new RegExp(`^${escapeRegExp(other.displayName)}`, "u") }).click();
    await expect(modelPicker).toHaveCount(0);
    expect((await update).status()).toBe(200);
    await expectChangedModel();
    expect(await rowProvenance(page.request, chatId, "model")).toBe("chat");

    // Scenario 4: parameters of another model are the user's own for it.
    await model.click();
    await modelPicker.getByTestId("composer-v2-model-parameters").click();
    const parameters = page.getByRole("dialog", { name: "Model parameters" });
    await expect(parameters.getByTestId("run-setup-own-defaults")).toHaveText(`Parameters: your defaults for ${other.displayName}`);
    await parameters.getByRole("button", { name: "Close parameters" }).click();
    await expect(parameters).toHaveCount(0);

    await page.reload();
    await expectChangedModel();
    await captureState(page, testInfo, "chat-model-changed", { atEachSize: () => expectNoHorizontalOverflow(page) });

    update = chatUpdate(page, chatId);
    await model.click();
    await expect(provenanceLine).toContainText(`Changed for this chat · ${assistant.name} starts with Fake QSA`);
    await provenanceLine.getByRole("button", { name: "Reset to Assistant" }).click();
    expect((await update).status()).toBe(200);
    await expectAssistantModel();
    expect(await rowProvenance(page.request, chatId, "model")).toBe("assistant");
    await page.reload();
    await expectAssistantModel();
  });
});

test("fixed Search, MCP, Knowledge and Skills keep their chips with one dot, and each menu opens with Fixed by the Assistant over disabled options · A-13", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Fixed rows user");
    const page = await signIn(people, browser, user);
    // The helper's defaults fix the model, Search Off, MCP Off, Knowledge None and Skills Auto.
    const assistant = await assistants.create(page.request, { name: "Locked researcher" });
    await pickInHeader(page, assistant);
    const fixedBy = `Fixed by ${assistant.name}`;

    // The locked model button opens its picker, which offers no model to choose.
    await expectFixedModelButton(page, assistant);
    await modelTrigger(page).click();
    await expectFixedModelPicker(page, assistant);
    await page.keyboard.press("Escape");
    await expect(modelPickerDialog(page)).toHaveCount(0);

    const chips = {
      knowledge: { chip: page.getByRole("button", { name: "Choose Knowledge" }), description: `Knowledge: Off · ${fixedBy}` },
      mcp: { chip: page.getByRole("button", { name: "Change MCP mode" }), description: `MCP: Off · ${fixedBy}` },
      search: { chip: page.getByRole("button", { name: /^Choose web search/u }), description: `Search: Off · ${fixedBy}` },
      skills: { chip: page.getByRole("button", { name: "Change Skills mode" }), description: `Skills: Auto · ${fixedBy}` }
    };
    for (const [row, { chip, description }] of Object.entries(chips)) {
      await expect(chip, row).toBeVisible();
      await expect(chip, row).toHaveAttribute("data-provenance", "assistant");
      await expect(chip, row).toHaveAccessibleDescription(description);
    }
    const markers = await Promise.all(Object.values(chips).map(({ chip }) => markerStyle(chip)));
    expect(markers[0]?.content, "the chip draws its marker").not.toBe("none");
    expect(new Set(markers.map((marker) => JSON.stringify(marker))).size, "one marker style").toBe(1);

    const mcpMenu = page.getByRole("menu", { name: "MCP tools" });
    await chips.mcp.chip.click();
    await expect(mcpMenu.getByTestId("assistant-row-provenance")).toHaveText(fixedBy);
    for (const mode of [/^Auto/u, /^Load all/u, /^Off/u]) {
      await expect(mcpMenu.getByRole("menuitemradio", { name: mode })).toBeDisabled();
    }
    await page.keyboard.press("Escape");
    await expect(mcpMenu).toHaveCount(0);

    const skillsMenu = page.getByRole("menu", { name: "Skills" });
    await chips.skills.chip.click();
    await expect(skillsMenu.getByTestId("assistant-row-provenance")).toHaveText(fixedBy);
    await expect(skillsMenu.getByRole("menuitemradio", { name: /^Auto · loads on demand/u })).toBeDisabled();
    await expect(skillsMenu.getByRole("menuitemradio", { name: /^Off · Always Skills only/u })).toBeDisabled();
    // Users still pin their own Skills on top of the Assistant's.
    await expect(skillsMenu.getByRole("menuitem", { name: /^Pin your Skills…/u })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(skillsMenu).toHaveCount(0);

    const knowledgeMenu = page.getByRole("menu", { name: "Knowledge" });
    await chips.knowledge.chip.click();
    await expect(knowledgeMenu.getByTestId("assistant-row-provenance")).toHaveText(fixedBy);
    await expect(knowledgeMenu.getByRole("menuitemradio", { name: /^Off/u })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(knowledgeMenu).toHaveCount(0);

    const searchDialog = page.getByRole("dialog", { name: "Web search" });
    await chips.search.chip.click();
    await expect(searchDialog.getByTestId("assistant-row-provenance")).toHaveText(fixedBy);
    await expect(searchDialog.getByLabel("When the model searches")).toBeDisabled();
    await expect(searchDialog.getByRole("button", { name: "Turn off search" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(searchDialog).toHaveCount(0);

    for (const [name, overlay, chip] of [
      ["chat-chip-mcp-fixed", mcpMenu, chips.mcp.chip],
      ["chat-chip-skills-fixed", skillsMenu, chips.skills.chip],
      ["chat-chip-knowledge-fixed", knowledgeMenu, chips.knowledge.chip],
      ["chat-chip-search-fixed", searchDialog, chips.search.chip]
    ] as const) {
      await captureOpen(page, testInfo, name, overlay, () => chip.click(), {
        check: async ({ size }) => {
          await expect(overlay.getByTestId("assistant-row-provenance"), sizeLabel(size)).toHaveText(fixedBy);
        }
      });
    }
  });
});

test("the parameters layer opens in an Assistant chat with the effective reasoning effort, and an adjustable value changes and resets · A-14", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Parameters user");
    const page = await signIn(people, browser, user);
    const modelId = await fakeModelId(prisma);
    const assistant = await assistants.create(page.request, {
      name: "Deep thinker",
      rows: {
        controls: { policy: "adjustable", value: { reasoningEffort: "high" } },
        model: { policy: "adjustable", value: { mode: "model", modelId } }
      }
    });
    await pickInHeader(page, assistant);
    const parameters = page.getByRole("dialog", { name: "Model parameters" });
    const openParameters = async () => {
      await modelTrigger(page).click();
      await page.getByRole("dialog", { name: "Choose model" }).getByTestId("composer-v2-model-parameters").click();
      await expect(parameters).toBeVisible();
    };
    await openParameters();
    const effort = parameters.getByLabel("Reasoning effort");
    const line = parameters.getByTestId("assistant-row-provenance");
    await expect(effort).toHaveValue("high");
    await expect(effort).toBeEnabled();
    await expect(line).toContainText(`From ${assistant.name} · adjustable for this chat`);
    await expect(line).toContainText("unchanged");

    await effort.selectOption("low");
    await expect(effort).toHaveValue("low");
    await line.getByRole("button", { name: "Reset to Assistant" }).click();
    await expect(effort).toHaveValue("high");
    await expect(line).toContainText("unchanged");
    await parameters.getByRole("button", { name: "Close parameters" }).click();
    await expect(parameters).toHaveCount(0);

    await captureOpen(page, testInfo, "chat-parameters-adjustable", parameters, openParameters, {
      check: async ({ size }) => {
        await expect(effort, sizeLabel(size)).toHaveValue("high");
        await expectWithinViewport(page, parameters.getByRole("button", { name: "Close parameters" }));
      }
    });
  });
});

test("a fixed model opens a picker without models whose Parameters row shows the fixed reasoning effort, disabled, by keyboard and on a phone; the run carries it · A-14", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Fixed parameters user");
    const page = await signIn(people, browser, user);
    const assistant = await assistants.create(page.request, {
      name: "Fixed thinker",
      rows: { controls: { policy: "fixed", value: { reasoningEffort: "high" } } }
    });
    await pickInHeader(page, assistant);
    await expectFixedModelButton(page, assistant);

    // Keyboard: Enter opens the fixed picker on its Parameters row; Escape gives focus back to the button.
    await modelTrigger(page).focus();
    await page.keyboard.press("Enter");
    const picker = await expectFixedModelPicker(page, assistant);
    const parametersRow = picker.getByTestId("composer-v2-model-parameters");
    await expect(parametersRow).toBeFocused();
    await expect(parametersRow).toContainText("Reasoning high");
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(modelTrigger(page)).toBeFocused();
    await expect(modelTrigger(page)).toHaveAttribute("aria-expanded", "false");

    const parameters = parametersDialog(page);
    const effort = parameters.getByLabel("Reasoning effort");
    const openFixedParameters = async () => {
      await modelTrigger(page).click();
      await modelPickerDialog(page).getByTestId("composer-v2-model-parameters").click();
      await expect(parameters).toBeVisible();
    };
    await openFixedParameters();
    await expect(parameters.getByTestId("assistant-row-provenance")).toHaveText("Fixed by the Assistant");
    await expect(effort).toHaveValue("high");
    await expect(effort).toBeDisabled();
    await expect(parameters.getByLabel("Max output tokens")).toBeDisabled();
    await expect(parameters.getByRole("button", { name: "Reset output settings" })).toBeDisabled();
    const organizationDefault = parameters.getByRole("button", { name: "Use organization model default" });
    if (await organizationDefault.count() > 0) await expect(organizationDefault).toBeDisabled();
    await parameters.getByRole("button", { name: "Close parameters" }).click();
    await expect(parameters).toHaveCount(0);

    await captureOpen(page, testInfo, "chat-model-picker-fixed", modelPickerDialog(page), () => modelTrigger(page).click(), {
      check: async ({ size }) => {
        await expect(modelPickerDialog(page).getByTestId("composer-v2-model-fixed"), sizeLabel(size)).toBeVisible();
        await expectWithinViewport(page, modelPickerDialog(page).getByTestId("composer-v2-model-parameters"));
      }
    });
    await captureOpen(page, testInfo, "chat-parameters-fixed", parameters, openFixedParameters, {
      check: async ({ size }) => {
        await expect(effort, sizeLabel(size)).toBeDisabled();
        await expectWithinViewport(page, parameters.getByRole("button", { name: "Close parameters" }));
      }
    });

    // On a phone the fixed picker is the sheet with its own header and Close.
    await page.setViewportSize(PHONE.viewport);
    await modelTrigger(page).click();
    const sheet = await expectFixedModelPicker(page, assistant);
    await expect(sheet.getByText("Model", { exact: true })).toBeVisible();
    await expectWithinViewport(page, sheet);
    await expectNoHorizontalOverflow(page);
    await sheet.getByRole("button", { exact: true, name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await page.setViewportSize(DESKTOP.viewport);

    // The run carries the fixed effort.
    await send(page, `A-14 fixed ${people.suffix}`);
    const runs = await chatRuns(await activeChatId(page), 1);
    expect(runs[0]!.assistantId).toBe(assistant.id);
    expect(reasoningEffort(runs[0]!)).toBe("high");
  });
});

test("with a fixed model and adjustable parameters the reasoning effort changes for this chat and runs with the same Assistant; Reset to Assistant returns it, also after a reload · A-14", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Fixed model user");
    const page = await signIn(people, browser, user);
    // A new Assistant's default parameters: adjustable and empty, on its fixed model.
    const assistant = await assistants.create(page.request, { name: "Adjustable thinker" });
    const sends = recordSends(page);
    await pickInHeader(page, assistant);
    await expectFixedModelButton(page, assistant);

    const parameters = parametersDialog(page);
    const effort = parameters.getByLabel("Reasoning effort");
    const line = parameters.getByTestId("assistant-row-provenance");
    const openParameters = async () => {
      await modelTrigger(page).click();
      await expectFixedModelPicker(page, assistant);
      await modelPickerDialog(page).getByTestId("composer-v2-model-parameters").click();
      await expect(parameters).toBeVisible();
    };
    const closeParameters = async () => {
      await parameters.getByRole("button", { name: "Close parameters" }).click();
      await expect(parameters).toHaveCount(0);
    };

    await openParameters();
    await expect(effort).toBeEnabled();
    // Parameters the Assistant leaves empty read as the user's own until changed.
    await expect(line).toHaveCount(0);
    const initial = await effort.inputValue();
    const changed = initial === "low" ? "high" : "low";
    await effort.selectOption(changed);
    await expect(line).toContainText("Changed for this chat");
    await expect(line.getByRole("button", { name: "Reset to Assistant" })).toBeVisible();
    await closeParameters();
    await captureOpen(page, testInfo, "chat-parameters-adjustable-fixed-model", parameters, openParameters, {
      check: async ({ size }) => {
        await expect(effort, sizeLabel(size)).toHaveValue(changed);
        await expect(line, sizeLabel(size)).toContainText("Changed for this chat");
      }
    });

    await send(page, `A-14 changed ${people.suffix}`);
    const chatId = await activeChatId(page);
    let runs = await chatRuns(chatId, 1);
    expect(runs[0]!.assistantId).toBe(assistant.id);
    expect(reasoningEffort(runs[0]!)).toBe(changed);
    expect(sends[0]).toHaveProperty("controlDefaults");
    expect(sends[0]).not.toHaveProperty("params");

    await page.reload();
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
    await openParameters();
    await expect(effort).toHaveValue(changed);
    await expect(line).toContainText("Changed for this chat");
    const update = chatUpdate(page, chatId);
    await line.getByRole("button", { name: "Reset to Assistant" }).click();
    await expect(effort).toHaveValue(initial);
    await expect(line).toHaveCount(0);
    await closeParameters();
    expect((await update).status()).toBe(200);

    await page.reload();
    await openParameters();
    await expect(effort).toHaveValue(initial);
    await expect(line).toHaveCount(0);
    await closeParameters();
    await send(page, `A-14 reset ${people.suffix}`);
    runs = await chatRuns(chatId, 2);
    expect(runs[1]!.assistantId).toBe(assistant.id);
    expect(reasoningEffort(runs[1]!)).toBe(initial);
  });
});

test("turning Search off in a chat with adjustable Search sends the next answer without a source and keeps the Assistant; Reset to Assistant brings the source back · A-15", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, defer, people }) => {
    const source = await createCatalogOnlySearchSource(prisma, "a15");
    defer(source.cleanup);
    const user = await chatUser(people, "Search user");
    const page = await signIn(people, browser, user);
    const assistant = await assistants.create(page.request, {
      name: "Web analyst",
      rows: { search: { policy: "adjustable", value: { mode: "model_choice", optionIds: [source.optionId] } } }
    });
    const sends = recordSends(page);
    const fromAssistant = new RegExp(`^Search: .+ · From ${escapeRegExp(assistant.name)}$`, "u");
    await pickInHeader(page, assistant);
    const searchChip = page.getByRole("button", { name: /^Choose web search/u });
    await expect(searchChip).toHaveAttribute("data-provenance", "assistant");
    await expect(searchChip).toHaveAccessibleDescription(fromAssistant);

    const first = `A-15 with search ${people.suffix}`;
    await send(page, first);
    const chatId = await activeChatId(page);
    let runs = await chatRuns(chatId, 1);
    expect(runs[0]!.assistantId).toBe(assistant.id);
    expect(searchOptionIds(runs[0]!), "the fake provider received the Assistant's source").toEqual([source.optionId]);
    // An unchanged row sends no key of its own.
    expect(sends[0]).not.toHaveProperty("searchPlan");

    const searchDialog = page.getByRole("dialog", { name: "Web search" });
    const reset = searchDialog.getByRole("button", { name: /^Reset to Assistant/u });
    await searchChip.click();
    await expect(searchDialog.getByTestId("assistant-row-provenance")).toHaveText(`From ${assistant.name} · adjustable for this chat`);
    await expect(reset).toBeDisabled();
    await page.keyboard.press("Escape");
    await captureOpen(page, testInfo, "chat-chip-search-adjustable", searchDialog, () => searchChip.click());

    const update = chatUpdate(page, chatId);
    await searchChip.click();
    await searchDialog.getByRole("button", { name: "Turn off search" }).click();
    await page.keyboard.press("Escape");
    await expect(searchDialog).toHaveCount(0);
    expect((await update).status()).toBe(200);
    await expect(searchChip).toHaveAccessibleDescription("Search: Off · Changed for this chat");
    await expect(searchChip).not.toHaveAttribute("data-provenance", "assistant");
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
    expect(await rowProvenance(page.request, chatId, "search")).toBe("chat");
    await captureOpen(page, testInfo, "chat-chip-search-changed", searchDialog, () => searchChip.click(), {
      check: async ({ size }) => {
        await expect(reset, sizeLabel(size)).toBeEnabled();
      }
    });

    const second = `A-15 without search ${people.suffix}`;
    await send(page, second);
    runs = await chatRuns(chatId, 2);
    expect(runs[1]!.assistantId).toBe(assistant.id);
    expect(searchOptionIds(runs[1]!), "the fake provider received no Search source").toEqual([]);
    const body = sends[1]!;
    for (const key of ["prompt", "searchPreferencePlan", "searchPreferenceSource"]) {
      expect(body, key).not.toHaveProperty(key);
    }
    if ("searchPlan" in body) expect((body.searchPlan as { optionIds: string[] }).optionIds).toEqual([]);
    await expectIdentityChips(page, [assistant.name, null]);

    await searchChip.click();
    await reset.click();
    await expect(searchDialog).toHaveCount(0);
    await expect(searchChip).toHaveAccessibleDescription(fromAssistant);
    await expect(searchChip).toHaveAttribute("data-provenance", "assistant");
  });
});

test("reopening yesterday's bound chat in a fresh session restores the selector, the model and the changed values from the server, and regenerate keeps the identity · A-16", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Returning user");
    const firstSession = await signIn(people, browser, user);
    const assistant = await assistants.create(firstSession.request, {
      name: "Returning desk",
      rows: { tools: { policy: "adjustable", value: { mode: "off" } } }
    });
    await pickInHeader(firstSession, assistant);
    const question = `A-16 question ${people.suffix}`;
    await send(firstSession, question);
    const chatId = await activeChatId(firstSession);
    await assistants.bindChat(firstSession.request, chatId, { assistantOverrides: { tools: { mode: "auto" } } });

    // A second sign-in has a fresh browser context: nothing comes from localStorage.
    const page = await signIn(people, browser, user);
    await page.goto(`/c/${chatId}`);
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${assistant.name}`);
    await expect(modelTrigger(page)).toContainText("Fake QSA");
    await expect(modelTrigger(page)).toHaveAttribute("data-provenance", "assistant");
    const mcpChip = page.getByRole("button", { name: "Change MCP mode" });
    await expect(mcpChip).toHaveAccessibleDescription("MCP: Auto · Changed for this chat");
    await expect(mcpChip).not.toHaveAttribute("data-provenance", "assistant");
    await expectIdentityChips(page, [assistant.name]);

    await selector(page).click();
    const adopt = assistantMenu(page).getByRole("menuitem", { name: /^Save chat setup to Assistant/u });
    await expect(adopt).toBeEnabled();
    await expect(adopt).toContainText("MCP changed for this chat");
    await page.keyboard.press("Escape");
    await expect(assistantMenu(page)).toHaveCount(0);
    await captureOpen(page, testInfo, "chat-selector-menu", menuHead(page), () => selector(page).click());

    const mcpMenu = page.getByRole("menu", { name: "MCP tools" });
    await captureOpen(page, testInfo, "chat-chip-mcp-changed", mcpMenu, () => mcpChip.click(), {
      check: async ({ size }) => {
        await expect(mcpMenu.getByTestId("assistant-row-provenance"), sizeLabel(size))
          .toHaveText(`Changed for this chat · ${assistant.name} starts with Off`);
        await expect(mcpMenu.getByRole("menuitem", { name: /^Reset to Assistant/u }), sizeLabel(size)).toBeEnabled();
      }
    });

    // Regenerate runs with the chat's binding and keeps its identity.
    const answer = answers(page).last();
    await answer.hover();
    const regenerated = page.waitForResponse((response) =>
      response.request().method() === "POST" && /^\/api\/messages\/[^/]+\/regenerate$/u.test(new URL(response.url()).pathname));
    await answer.getByRole("button", { name: "Regenerate answer" }).click();
    expect((await regenerated).ok()).toBe(true);
    const runs = await chatRuns(chatId, 2);
    await expectAnswer(page, question);
    expect(runs.map((run) => run.assistantId)).toEqual([assistant.id, assistant.id]);
    expect(runs.map(identityName)).toEqual([assistant.name, assistant.name]);
    await expectIdentityChips(page, [assistant.name]);
  });
});

test("Change… mid-chat gives the next answer the new identity while earlier answers keep theirs, and Remove for this chat brings back the active Instructions preset · A-17", async ({ browser }) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Switching user");
    const marker = `Preset marker ${people.suffix}`;
    const preset = await prisma.instructionPreset.create({
      data: { name: `A-17 preset ${people.suffix}`, systemInstructions: `Always mention ${marker}.`, userId: user.id },
      select: { id: true }
    });
    await prisma.userSettings.update({
      data: { activeInstructionPresetId: preset.id, instructionSelectionVersion: { increment: 1 } },
      where: { userId: user.id }
    });
    const page = await signIn(people, browser, user);
    const firstVoice = await assistants.create(page.request, { name: "First voice" });
    const secondVoice = await assistants.create(page.request, { name: "Second voice" });

    await pickInHeader(page, firstVoice);
    await send(page, `A-17 one ${people.suffix}`);
    const chatId = await activeChatId(page);
    await changeInHeader(page, secondVoice);
    await send(page, `A-17 two ${people.suffix}`);
    await expectIdentityChips(page, [firstVoice.name, secondVoice.name]);

    await removeInHeader(page);
    await send(page, `A-17 three ${people.suffix}`);
    await expectIdentityChips(page, [firstVoice.name, secondVoice.name, NO_ASSISTANT]);
    expect((await prisma.chat.findUniqueOrThrow({ select: { assistantId: true }, where: { id: chatId } })).assistantId).toBeNull();

    const runs = await chatRuns(chatId, 3);
    expect(runs.map((run) => run.assistantId)).toEqual([firstVoice.id, secondVoice.id, null]);
    expect(runs.map(identityName)).toEqual([firstVoice.name, secondVoice.name, null]);
    // An Assistant replaces the personal preset; without it the preset applies again.
    for (const run of runs.slice(0, 2)) {
      expect(run.normalizedRequest).not.toHaveProperty("instructionPreset");
      expect(JSON.stringify(run.normalizedRequest)).not.toContain(marker);
    }
    expect(runs[2]!.normalizedRequest).toMatchObject({ instructionPreset: { presetId: preset.id } });
    expect(JSON.stringify(runs[2]!.normalizedRequest)).toContain(marker);
  });
});

test("a default Assistant starts every new personal chat with its intro; Remove for this chat keeps the setting; a Temporary chat starts without it; an archived default reads No longer available · A-18", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Default user");
    const page = await signIn(people, browser, user);
    const daily = await assistants.create(page.request, {
      description: "Starts every day with the plan.",
      name: "Daily co-pilot",
      starterPrompts: ["What is on today?"]
    });
    const pinned = await assistants.create(page.request, { name: "Pinned spare" });
    await assistants.pin(page.request, pinned.id);
    const savedDefault = async () => (await prisma.userSettings.findUniqueOrThrow({
      select: { defaultAssistantId: true },
      where: { userId: user.id }
    })).defaultAssistantId;
    const strip = page.getByTestId("assistant-strip");
    const intro = page.getByTestId("assistant-blank-intro");

    await runAccountMenuAction(page, "Chat defaults");
    const row = page.getByTestId("settings-default-assistant");
    await expect(row).toContainText("Starts every new personal chat. Projects use their own.");
    const trigger = row.getByRole("button", { name: "Default Assistant" });
    await expect(trigger).toBeEnabled();
    const saved = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/me/settings");
    await trigger.click();
    await page.getByRole("menu", { name: "Default Assistant" }).getByRole("menuitem", { name: daily.name }).click();
    expect((await saved).ok()).toBe(true);
    await expect(trigger).toContainText(daily.name);
    expect(await savedDefault()).toBe(daily.id);

    // A new chat starts with the default: intro, the header Assistant and no strip.
    await page.goto("/");
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${daily.name}`);
    await expect(intro.getByRole("heading", { name: daily.name })).toBeVisible();
    await expect(strip).toHaveCount(0);
    await captureState(page, testInfo, "chat-default-assistant-intro", { atEachSize: () => expectNoHorizontalOverflow(page) });

    // Remove for this chat changes this chat only.
    await removeInHeader(page);
    await expect(intro).toHaveCount(0);
    await expect(strip.getByRole("button", { name: pinned.name })).toBeVisible();
    expect(await savedDefault()).toBe(daily.id);

    // The next new chat starts with it again and runs with it.
    await page.goto("/");
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${daily.name}`);
    await send(page, `A-18 hello ${people.suffix}`);
    const chatId = await activeChatId(page);
    expect((await chatRuns(chatId, 1))[0]!.assistantId).toBe(daily.id);
    await startNewChat(page);
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${daily.name}`);

    // A Temporary chat never starts with the personal default; a Normal one does again.
    const navigation = page.getByRole("complementary", { name: "Chat navigation" });
    const newChatMode = async (mode: RegExp) => {
      await navigation.getByRole("button", { name: "New chat mode" }).click();
      await page.getByRole("menu", { name: "New chat mode" }).getByRole("menuitem", { name: mode }).click();
    };
    const temporary = page.getByTestId("header-temporary-indicator");
    await newChatMode(/^Temporary chat/u);
    await expect(temporary).toBeVisible();
    // The strip shows once the Assistants are loaded, and only in a chat without one.
    await expect(strip.getByRole("button", { name: pinned.name })).toBeVisible();
    await expect(selector(page)).toHaveAttribute("data-state", "empty");
    await expect(intro).toHaveCount(0);
    await newChatMode(/^Normal/u);
    await expect(temporary).toHaveCount(0);
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${daily.name}`);

    // An archived default is never applied; Chat defaults names it and offers Clear.
    await assistants.archive(page.request, daily.id);
    await page.goto("/");
    await expect(messageBox(page)).toBeEnabled();
    await expect(temporary).toHaveCount(0);
    await expect(strip.getByRole("button", { name: pinned.name })).toBeVisible();
    await expect(selector(page)).toHaveAttribute("data-state", "empty");
    await runAccountMenuAction(page, "Chat defaults");
    await expect(row.getByRole("status")).toHaveText("No longer available");
    await captureState(page, testInfo, "studio-chat-defaults-unavailable-assistant", {
      anchor: row,
      atEachSize: async ({ size }) => {
        await expect(row.getByRole("button", { name: "Clear" }), sizeLabel(size)).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    });
    const cleared = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/me/settings");
    await row.getByRole("button", { name: "Clear" }).click();
    expect((await cleared).ok()).toBe(true);
    await expect.poll(savedDefault).toBeNull();
  });
});

test("an unavailable Assistant blocks sending with a neutral notice for a consumer and the missing model for its owner; Choose another and Continue without the Assistant both work · A-19", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const group = await people.group("Unavailable team");
    const owner = await chatUser(people, "Unavailable owner", { groups: [{ group, role: "manager" }] });
    const consumer = await chatUser(people, "Unavailable consumer", { groups: [group] });
    const ownerPage = await signIn(people, browser, owner);
    const consumerPage = await signIn(people, browser, consumer);
    // A fixed model nobody on the stand can use: the seeded GPT-5.5 has no credential here.
    const missing = await prisma.providerModel.findUniqueOrThrow({
      select: { displayName: true, id: true },
      where: { templateKey: "openai:gpt-5.5" }
    });
    const retired = await assistants.seed(owner.id, {
      name: "Retired model desk",
      rows: { model: { policy: "fixed", value: { mode: "model", modelId: missing.id } } }
    });
    await assistants.seedPublication(retired.id, { groupId: group.id });
    const replacement = await assistants.create(consumerPage.request, { name: "Replacement desk" });
    const bindTo = async (request: APIRequestContext) => {
      const chatId = await assistants.createChat(request);
      await prisma.chat.update({ data: { assistantId: retired.id }, where: { id: chatId } });
      return chatId;
    };
    const consumerChat = await bindTo(consumerPage.request);
    const ownerChat = await bindTo(ownerPage.request);

    const expectBlocked = async (page: Page) => {
      await expect(selector(page)).toHaveAttribute("data-state", "blocked");
      await expect(messageBox(page)).toBeDisabled();
      await expect(messageBox(page)).toHaveAccessibleDescription(SEND_GATE);
      await expect(notice(page).getByRole("button", { name: "Choose another" })).toBeEnabled();
      await expect(notice(page).getByRole("button", { name: "Continue without the Assistant" })).toBeEnabled();
    };

    // The consumer reads the neutral sentence and never the name of the missing model.
    await consumerPage.goto(`/c/${consumerChat}`);
    await expectBlocked(consumerPage);
    await expect(selector(consumerPage)).toHaveAccessibleName(/^Assistant unavailable/u);
    await expect(notice(consumerPage)).toContainText("This Assistant isn't available to you right now.");
    await expect(notice(consumerPage)).not.toContainText(missing.displayName);
    await expect(notice(consumerPage).getByRole("button", { name: "Open in Studio" })).toHaveCount(0);
    await captureState(consumerPage, testInfo, "chat-assistant-unavailable-consumer", {
      atEachSize: async ({ size }) => {
        await expectWithinViewport(consumerPage, notice(consumerPage).getByRole("button", { name: "Choose another" }));
        await expect(selector(consumerPage), sizeLabel(size)).toHaveAttribute("data-state", "blocked");
        await expectNoHorizontalOverflow(consumerPage);
      }
    });

    // The owner reads which dependency is missing and how to repair it.
    await ownerPage.goto(`/c/${ownerChat}`);
    await expectBlocked(ownerPage);
    await expect(selector(ownerPage)).toHaveAccessibleName(`Assistant unavailable: ${retired.name}`);
    await expect(notice(ownerPage)).toContainText(`${missing.displayName} isn't available.`);
    await expect(notice(ownerPage)).toContainText("Fix the Assistant or continue without it.");
    await expect(notice(ownerPage).getByRole("button", { name: "Open in Studio" })).toBeEnabled();
    await captureState(ownerPage, testInfo, "chat-assistant-unavailable-owner", {
      atEachSize: async () => {
        await expectWithinViewport(ownerPage, notice(ownerPage).getByRole("button", { name: "Continue without the Assistant" }));
        await expectNoHorizontalOverflow(ownerPage);
      }
    });

    // Choose another: the consumer picks their own Assistant and sends.
    const consumerUpdate = chatUpdate(consumerPage, consumerChat);
    await notice(consumerPage).getByRole("button", { name: "Choose another" }).click();
    await expect(pickerDialog(consumerPage).getByTestId(`assistant-picker-row-${retired.id}`)).toBeDisabled();
    await pickerDialog(consumerPage).getByTestId(`assistant-picker-row-${replacement.id}`).click();
    expect((await consumerUpdate).status()).toBe(200);
    await expect(selector(consumerPage)).toHaveAccessibleName(`Assistant: ${replacement.name}`);
    await expect(notice(consumerPage)).toHaveCount(0);
    await send(consumerPage, `A-19 replacement ${people.suffix}`);
    expect((await chatRuns(consumerChat, 1))[0]!.assistantId).toBe(replacement.id);

    // Continue without the Assistant: an ordinary chat that sends.
    await notice(ownerPage).getByRole("button", { name: "Continue without the Assistant" }).click();
    await expect(selector(ownerPage)).toHaveAttribute("data-state", "empty");
    await expect(notice(ownerPage)).toHaveCount(0);
    await expect(messageBox(ownerPage)).toBeEnabled();
    await send(ownerPage, `A-19 without ${people.suffix}`);
    expect((await chatRuns(ownerChat, 1))[0]!.assistantId).toBeNull();
    expect((await prisma.chat.findUniqueOrThrow({ select: { assistantId: true }, where: { id: ownerChat } })).assistantId).toBeNull();
  });
});

test("an archived Assistant blocks sending until its owner restores it · A-19", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await chatUser(people, "Archiving owner");
    const page = await signIn(people, browser, owner);
    const shelved = await assistants.create(page.request, { name: "Shelved desk" });
    const chatId = await assistants.createChat(page.request, { assistant: { assistantId: shelved.id } });
    await assistants.archive(page.request, shelved.id);

    await page.goto(`/c/${chatId}`);
    await expect(selector(page)).toHaveAttribute("data-state", "blocked");
    await expect(selector(page)).toHaveAccessibleName(`Assistant archived: ${shelved.name}`);
    await expect(notice(page)).toContainText("You archived this Assistant.");
    await expect(messageBox(page)).toBeDisabled();
    // A blocked Assistant keeps its fixed model button disabled too.
    await expect(modelTrigger(page)).toBeDisabled();
    await expect(messageBox(page)).toHaveAccessibleDescription(SEND_GATE);
    await selector(page).click();
    for (const item of [/^Choose another…/u, /^Restore/u, /^Continue without the Assistant/u]) {
      await expect(assistantMenu(page).getByRole("menuitem", { name: item })).toBeEnabled();
    }
    await page.keyboard.press("Escape");
    await captureState(page, testInfo, "chat-assistant-archived", { atEachSize: () => expectNoHorizontalOverflow(page) });

    await notice(page).getByRole("button", { name: "Restore" }).click();
    await expect(selector(page)).toHaveAttribute("data-state", "chosen");
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${shelved.name}`);
    await expect(notice(page)).toHaveCount(0);
    await expect(messageBox(page)).toBeEnabled();
    await expect(modelTrigger(page)).toBeEnabled();
    const detail = await page.request.get(`/api/me/assistants/${shelved.id}`);
    expect(detail.ok()).toBe(true);
    expect((await detail.json() as { assistant: { archived: boolean } }).assistant.archived).toBe(false);
  });
});

test("a deleted Assistant reads Assistant deleted, earlier answers keep its identity, and Continue without the Assistant answers with No Assistant · A-19", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await chatUser(people, "Deleting owner");
    const page = await signIn(people, browser, owner);
    const doomed = await assistants.create(page.request, { name: "Doomed desk" });
    await pickInHeader(page, doomed);
    await send(page, `A-19 before deletion ${people.suffix}`);
    const chatId = await activeChatId(page);
    await assistants.remove(page.request, doomed.id);

    await page.reload();
    await expect(selector(page)).toHaveAttribute("data-state", "blocked");
    await expect(selector(page)).toHaveAccessibleName("Assistant deleted");
    await expect(notice(page)).toContainText("This Assistant was deleted.");
    await expect(messageBox(page)).toBeDisabled();
    await expect(messageBox(page)).toHaveAccessibleDescription(SEND_GATE);
    await expectIdentityChips(page, [doomed.name]);
    await captureState(page, testInfo, "chat-assistant-deleted", { atEachSize: () => expectNoHorizontalOverflow(page) });

    await notice(page).getByRole("button", { name: "Continue without the Assistant" }).click();
    await expect(selector(page)).toHaveAttribute("data-state", "empty");
    await send(page, `A-19 after deletion ${people.suffix}`);
    await expectIdentityChips(page, [doomed.name, NO_ASSISTANT]);
    const runs = await chatRuns(chatId, 2);
    expect(runs.map((run) => run.assistantId)).toEqual([null, null]);
    expect(runs.map(identityName)).toEqual([doomed.name, null]);
  });
});

test("the identity chip shows only where the Assistant changes between neighbouring answers, also after a reload · A-20", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Identity user");
    const page = await signIn(people, browser, user);
    const alpha = await assistants.create(page.request, { name: "Alpha voice" });
    const beta = await assistants.create(page.request, { avatar: e2eAssistantAvatar("ember", "square"), name: "Beta voice" });
    const expected = [alpha.name, null, beta.name, NO_ASSISTANT, null];

    await pickInHeader(page, alpha);
    await send(page, `A-20 one ${people.suffix}`);
    await send(page, `A-20 two ${people.suffix}`);
    await changeInHeader(page, beta);
    await send(page, `A-20 three ${people.suffix}`);
    await removeInHeader(page);
    await send(page, `A-20 four ${people.suffix}`);
    await send(page, `A-20 five ${people.suffix}`);
    await expectIdentityChips(page, expected);

    await page.reload();
    await expectIdentityChips(page, expected);
    await captureState(page, testInfo, "chat-conversation-assistant-changes", {
      atEachSize: async () => expectNoHorizontalOverflow(page),
      fullPage: true
    });
  });
});

test("chat list rows of bound chats show the 16 px avatar and rows without a usable binding do not, at the same row height · A-21", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "List user");
    const page = await signIn(people, browser, user);
    const marked = await assistants.create(page.request, { name: "Row marker" });
    const shelved = await assistants.create(page.request, { name: "Row shelved" });
    const boundChat = await assistants.createChat(page.request, { assistant: { assistantId: marked.id }, title: `Bound chat ${people.suffix}` });
    const plainChat = await assistants.createChat(page.request, { title: `Plain chat ${people.suffix}` });
    const shelvedChat = await assistants.createChat(page.request, { assistant: { assistantId: shelved.id }, title: `Shelved chat ${people.suffix}` });
    await assistants.archive(page.request, shelved.id);
    await page.goto("/");
    const row = (chatId: string) => page.locator(`[data-navigation-chat-id="${chatId}"]`);
    const avatar = (chatId: string) => row(chatId).getByTestId("assistant-avatar");

    await expect(avatar(boundChat)).toBeVisible();
    const box = (await avatar(boundChat).boundingBox())!;
    expect(Math.round(box.width)).toBe(16);
    expect(Math.round(box.height)).toBe(16);
    await expect(avatar(plainChat)).toHaveCount(0);
    // An Assistant the viewer cannot use now lends the row no avatar.
    await expect(avatar(shelvedChat)).toHaveCount(0);
    const heights = await Promise.all([boundChat, plainChat].map(async (chatId) =>
      Math.round((await row(chatId).getByRole("treeitem").boundingBox())!.height)));
    expect(heights[0], "a row keeps its height with an avatar").toBe(heights[1]);
    await captureState(page, testInfo, "chat-list-avatars", {
      atEachSize: () => expectNoHorizontalOverflow(page),
      sizes: [{ height: 900, width: 1440 }]
    });

    // The row follows the binding without a reload: removed here, added by a first send there.
    await row(boundChat).getByRole("treeitem").click();
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${marked.name}`);
    await removeInHeader(page);
    await expect(avatar(boundChat)).toHaveCount(0);
    await page.goto("/");
    await pickInHeader(page, marked);
    await send(page, `A-21 new chat ${people.suffix}`);
    await expect(avatar(await activeChatId(page))).toBeVisible();
  });
});

test("at 390×844 the strip takes one row without page scroll, the picker is a bottom sheet that keeps focus, and the composer chips wrap whole · A-22", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Phone user");
    const page = await signIn(people, browser, user, PHONE);
    const pinned: E2EAssistant[] = [];
    for (const name of ["Quarterly planning partner", "Release notes editor", "Customer reply drafter", "Incident review guide", "Hiring loop coordinator"]) {
      const assistant = await assistants.create(page.request, { name });
      await assistants.pin(page.request, assistant.id);
      pinned.push(assistant);
    }
    await page.goto("/");
    const strip = page.getByTestId("assistant-strip");
    await expect(strip.getByRole("button", { name: "All Assistants…" })).toBeVisible();
    const layout = await stripLayout(strip);
    expect(layout.rows, "one row on a phone").toBe(1);
    expect(layout.lastLabel).toBe("All Assistants…");
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(390);
    expect(layout.bottom).toBeLessThanOrEqual(844);
    await expectNoHorizontalOverflow(page);

    // Typing never moves the composer: the strip keeps its space, hidden, while a draft exists.
    // The draft fits one line at 390 px: a longer one wraps, and the textarea grows by a line
    // (1.5 line height) upwards from the dock anchored at the bottom, which is not what this checks.
    const composer = page.getByTestId("composer-v2");
    // The hidden strip is `visibility: hidden`, so its box is read from the layout directly.
    const measure = async () => ({
      composer: (await composer.boundingBox())!,
      strip: await strip.evaluate((element) => ({ height: element.getBoundingClientRect().height }))
    });
    const idle = await measure();
    await messageBox(page).fill("Short draft");
    await expect(strip).toHaveAttribute("aria-hidden", "true");
    const drafting = await measure();
    expect(Math.abs(drafting.composer.height - idle.composer.height), "the draft stays on one line").toBeLessThanOrEqual(0.5);
    expect(Math.abs(drafting.strip.height - idle.strip.height), "the hidden strip keeps its space").toBeLessThanOrEqual(0.5);
    expect(Math.abs(drafting.composer.y - idle.composer.y), "the composer does not move").toBeLessThanOrEqual(0.5);
    await messageBox(page).fill("");
    await expect(strip).not.toHaveAttribute("aria-hidden", "true");

    // The picker is a bottom sheet with focus kept inside.
    const allAssistants = strip.getByRole("button", { name: "All Assistants…" });
    await allAssistants.click();
    const sheet = pickerDialog(page);
    await expect(page.getByTestId("assistant-picker-backdrop")).toHaveAttribute("data-layout", "sheet");
    const sheetBox = (await sheet.boundingBox())!;
    expect(Math.round(sheetBox.x)).toBe(0);
    expect(Math.round(sheetBox.width)).toBe(390);
    expect(Math.abs(sheetBox.y + sheetBox.height - 844)).toBeLessThanOrEqual(1);
    await expect(sheet.getByRole("searchbox", { name: "Search Assistants" })).toBeFocused();
    const focusInside = () => sheet.evaluate((element) => element.contains(document.activeElement));
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await focusInside(), `focus after ${key}`).toBe(true);
    }
    await captureState(page, testInfo, "chat-picker-phone-sheet", {
      atEachSize: () => expectWithinViewport(page, sheet),
      sizes: [{ height: 844, width: 390 }]
    });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body),
      "focus returns to the page").toBe(true);

    // With an Assistant every chip stays, whole and inside the screen.
    // Pinned pills come in name order; those past the two rows are left out.
    const shown = (await strip.getByRole("button").allInnerTexts()).map((label) => label.trim()).slice(0, -1);
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown).toEqual(byName(pinned.map((assistant) => assistant.name)).slice(0, shown.length));
    await strip.getByRole("button", { name: shown[0]! }).click();
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${shown[0]}`);
    const chipRow = page.locator('[aria-label="Active capabilities"]');
    const chips = chipRow.getByRole("button");
    for (const name of ["Choose Knowledge", "Change MCP mode", "Change Skills mode"]) {
      await expect(chipRow.getByRole("button", { name })).toBeVisible();
    }
    await expect(chipRow.getByRole("button", { name: /^Choose web search/u })).toBeVisible();
    const boxes = await chips.evaluateAll((elements) => elements
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0)
      .map((rect) => ({ bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top })));
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    for (const [index, rect] of boxes.entries()) {
      expect(rect.left, `chip ${index + 1} left`).toBeGreaterThanOrEqual(0);
      expect(rect.right, `chip ${index + 1} right`).toBeLessThanOrEqual(390);
      for (const other of boxes.slice(index + 1)) {
        const overlap = Math.max(0, Math.min(rect.right, other.right) - Math.max(rect.left, other.left)) *
          Math.max(0, Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top));
        expect(overlap, `chip ${index + 1} overlaps no other chip`).toBeLessThanOrEqual(1);
      }
    }
    expect(await chipRow.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page);
    await captureState(page, testInfo, "chat-assistant-phone", {
      atEachSize: () => expectNoHorizontalOverflow(page),
      sizes: [{ height: 844, width: 390 }, { height: 390, width: 844 }]
    });
  });
});

test("/assistant/<id> lands a member in a new chat with the Assistant, an outsider or an unknown id on / with the neutral notice, and a signed-out member through sign-in · A-34", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const group = await people.group("Link team");
    const owner = await chatUser(people, "Link owner", { groups: [{ group, role: "manager" }] });
    const member = await chatUser(people, "Link member", { groups: [group] });
    const outsider = await chatUser(people, "Link outsider");
    const ownerPage = await signIn(people, browser, owner);
    const linked = await assistants.create(ownerPage.request, {
      description: "Answers onboarding questions.",
      name: "Onboarding guide",
      starterPrompts: ["Where do I start?"]
    });
    await assistants.publish(ownerPage.request, linked.id, { groupId: group.id });
    const link = formatAssistantEntryPath(linked.id);
    const atNewChat = (url: URL) => url.pathname === "/";
    const expectLinked = async (page: Page) => {
      await expect(page).toHaveURL(atNewChat);
      await expect(selector(page)).toHaveAccessibleName(`Assistant: ${linked.name}`);
      const intro = page.getByTestId("assistant-blank-intro");
      await expect(intro.getByRole("heading", { name: linked.name })).toBeVisible();
      await expect(intro).toContainText(`By ${owner.displayName}`);
    };

    const memberPage = await signIn(people, browser, member);
    await memberPage.goto(link);
    await expectLinked(memberPage);
    // The entry address is replaced: going back does not resolve the link again.
    await memberPage.goBack();
    await expect(memberPage).toHaveURL((url) => !url.pathname.startsWith("/assistant/"));

    const outsiderPage = await signIn(people, browser, outsider);
    const expectNeutral = async () => {
      await expect(outsiderPage).toHaveURL(atNewChat);
      await expect(outsiderPage.getByTestId("shell-notice")).toContainText(LINK_UNAVAILABLE);
      await expect(selector(outsiderPage)).toHaveAttribute("data-state", "empty");
      await expect(outsiderPage.getByTestId("assistant-blank-intro")).toHaveCount(0);
    };
    await outsiderPage.goto(link);
    await expectNeutral();
    await captureState(outsiderPage, testInfo, "chat-assistant-link-unavailable", {
      atEachSize: () => expectNoHorizontalOverflow(outsiderPage),
      sizes: [{ height: 900, width: 1440 }, { height: 844, width: 390 }]
    });
    const unknown = randomUUID();
    expect((await outsiderPage.request.get(`/api/me/assistants/${unknown}`)).status()).toBe(404);
    await outsiderPage.goto("/");
    await outsiderPage.goto(formatAssistantEntryPath(unknown));
    await expectNeutral();

    const context = await browser.newContext({ ...DESKTOP, baseURL: testInfo.project.use.baseURL, locale: "en-US", reducedMotion: "reduce" });
    try {
      const visitor = withActionTimeout(await context.newPage());
      await visitor.goto(link);
      await expect(visitor).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === link);
      await submitPasswordSignIn(visitor, member);
      await expectLinked(visitor);
    } finally {
      await context.close();
    }
  });
});

test("a message sent at once after choosing another Assistant or removing it runs with the new choice, only after the chat update and its re-read · task 37", async ({ browser }) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const user = await chatUser(people, "Racing user");
    const page = await signIn(people, browser, user);
    const first = await assistants.create(page.request, { name: "Race first" });
    const second = await assistants.create(page.request, { name: "Race second" });
    await pickInHeader(page, first);
    await send(page, `Race one ${people.suffix}`);
    const chatId = await activeChatId(page);

    type Entry = Readonly<{ event: "finished" | "sent"; method: string; path: string }>;
    const log: Entry[] = [];
    const entry = (event: Entry["event"]) => (request: { method(): string; url(): string }) => {
      log.push({ event, method: request.method(), path: new URL(request.url()).pathname });
    };
    page.on("request", entry("sent"));
    page.on("requestfinished", entry("finished"));
    const sends = recordSends(page);
    const expectRunAfterChatUpdate = (from: number, detailPath: string | null) => {
      const find = (predicate: (item: Entry) => boolean, after: number) =>
        log.findIndex((item, index) => index > after && predicate(item));
      const detail = detailPath ? find((item) => item.event === "sent" && item.method === "GET" && item.path === detailPath, from) : from;
      const patch = find((item) => item.event === "sent" && item.method === "PATCH" && item.path === `/api/chats/${chatId}`, detail);
      const reread = find((item) => item.event === "finished" && item.method === "GET" && item.path === `/api/chats/${chatId}`, patch);
      const run = find((item) => item.event === "sent" && item.method === "POST" && item.path === `/api/chats/${chatId}/messages`, from);
      const order = JSON.stringify(log.slice(from + 1));
      expect(detail, `detail read in ${order}`).toBeGreaterThanOrEqual(0);
      expect(patch, `chat update in ${order}`).toBeGreaterThan(detail);
      expect(reread, `chat re-read in ${order}`).toBeGreaterThan(patch);
      expect(run, `run request in ${order}`).toBeGreaterThan(reread);
    };

    // Change… then Send without waiting for the header.
    const secondText = `Race two ${people.suffix}`;
    await messageBox(page).fill(secondText);
    let mark = log.length - 1;
    await selector(page).click();
    await assistantMenu(page).getByRole("menuitem", { name: "Change…" }).click();
    await pickerDialog(page).getByTestId(`assistant-picker-row-${second.id}`).click();
    await sendButton(page).click();
    await expectAnswer(page, secondText);
    await expect(selector(page)).toHaveAccessibleName(`Assistant: ${second.name}`);
    expectRunAfterChatUpdate(mark, `/api/me/assistants/${second.id}`);
    // The request of an Assistant run carries the time zone and no ordinary composer payload.
    expect(typeof sends[0]!.timeZone).toBe("string");
    for (const key of ["modelId", "params", "prompt", "provider"]) expect(sends[0], key).not.toHaveProperty(key);

    // Remove for this chat then Send without waiting.
    const thirdText = `Race three ${people.suffix}`;
    await messageBox(page).fill(thirdText);
    mark = log.length - 1;
    await selector(page).click();
    await assistantMenu(page).getByRole("menuitem", { name: /^Remove for this chat/u }).click();
    await sendButton(page).click();
    await expectAnswer(page, thirdText);
    await expect(selector(page)).toHaveAttribute("data-state", "empty");
    expectRunAfterChatUpdate(mark, null);

    const runs = await chatRuns(chatId, 3);
    expect(runs.map((run) => run.assistantId)).toEqual([first.id, second.id, null]);
    await expectIdentityChips(page, [first.name, second.name, NO_ASSISTANT]);
  });
});
