import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { AdminSearchCatalog, AdminSearchDraft, AdminSearchIntegration } from "../../lib/contracts/adminSearch";
import type { Catalog, CatalogSearch } from "../../lib/contracts/catalog";
import { searchSettingPlan, type ModelWebSearch } from "../../lib/contracts/search";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { engageComposer } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import { createAssistantFixture, type E2EAssistant } from "./support/assistants";
import { prepareFakeQsaChats } from "./support/chatDefaults";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { createPeopleFixture } from "./support/people";
import { createCatalogOnlySearchSource, type CatalogOnlySearchSource } from "./support/syntheticCatalog";

/**
 * Screenshots of the Search switch (search-v2, 2026-11-26) for a visual
 * review: the composer's Web search chip and layer, Settings › Chat defaults,
 * Admin › Search with its Engine card, source page and sheets, the Assistant
 * editor's Web search row, and a keyboard-only pass through the composer.
 * Captures are evidence, not assertions; each step asserts only that its state
 * was reached. Nothing is sent to a provider: the composer and Chat defaults
 * states come from the matrix catalog fixture (as `studio-current-ui.spec.ts`
 * does), Admin › Search from a routed admin catalog (as
 * `provider-admin-ui.spec.ts` does), and the Assistant states from synthetic
 * people, Assistants and a catalog-only Search source the spec removes.
 * Every shot is a viewport shot named `<surface>-<state>-<viewport>-<theme>.png`.
 */

test.use({ locale: "en-US", colorScheme: "light", contextOptions: { reducedMotion: "reduce" } });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

type Theme = "dark" | "light";
type Size = Readonly<{ dark: boolean; height: number; touch: boolean; width: number }>;

const DESKTOP: Size = { dark: true, height: 900, touch: false, width: 1440 };
const PHONE: Size = { dark: true, height: 844, touch: true, width: 390 };
/** Dark theme only for the composer layer at desktop and phone. */
const COMPOSER_SIZES: readonly Size[] = [
  DESKTOP,
  { dark: false, height: 1180, touch: true, width: 820 },
  { dark: false, height: 820, touch: true, width: 1180 },
  PHONE,
  { dark: false, height: 390, touch: true, width: 844 }
];
const ADMIN_SIZES: readonly Size[] = [
  DESKTOP,
  { dark: false, height: 768, touch: false, width: 1024 },
  { dark: false, height: 1024, touch: false, width: 768 },
  { dark: false, height: 844, touch: false, width: 390 },
  { dark: false, height: 390, touch: false, width: 844 }
];

function sizeLabel(size: Size): string {
  return `${size.width}x${size.height}`;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
    document.documentElement.setAttribute("data-color-scheme", value);
  }, theme);
  await settle(page);
}

/** One viewport shot, `<surface>-<state>-<viewport>-<theme>.png`. */
async function shot(page: Page, testInfo: TestInfo, surface: string, state: string, size: Size, theme: Theme = "light") {
  await settle(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath(`${surface}-${state}-${sizeLabel(size)}-${theme}.png`)
  });
}

/** The light shot, and at the sizes that take one the dark shot of the same state. */
async function shotBothThemes(page: Page, testInfo: TestInfo, surface: string, state: string, size: Size) {
  await shot(page, testInfo, surface, state, size);
  if (!size.dark) return;
  await setTheme(page, "dark");
  await shot(page, testInfo, surface, state, size, "dark");
  await setTheme(page, "light");
}

/* Composer and Chat defaults: the matrix catalog fixture */

type ComposerState = Readonly<{
  description: string;
  key: string;
  search: CatalogSearch;
  searchEnabled: boolean;
  status: string | null;
  webSearch: ModelWebSearch;
}>;

const ENGINE: CatalogSearch = { engine: { displayName: "OpenRouter Web Search" }, reason: null };
const COMPOSER_STATES: readonly ComposerState[] = [
  // A user who turned Search off in Chat defaults.
  { description: "Search: Off", key: "off", search: ENGINE, searchEnabled: false, status: null, webSearch: "engine" },
  // An OpenAI-protocol model with hosted search: on and locked.
  {
    description: "Search: On", key: "in-answer", search: ENGINE, searchEnabled: true,
    status: "This model searches inside its own answer.", webSearch: "in_answer"
  },
  {
    description: "Search: On", key: "engine", search: ENGINE, searchEnabled: true,
    status: "Searches with OpenRouter Web Search.", webSearch: "engine"
  },
  // No engine can search: the amber status line.
  {
    description: "Search: On · unavailable right now", key: "unavailable",
    search: { engine: null, reason: "search_engine_unavailable" }, searchEnabled: true,
    status: "Unavailable right now.", webSearch: null
  }
];

/** Puts the fixture catalog in `state`; the fixture reads it on every catalog request. */
function applyComposerState(catalog: Catalog, state: ComposerState): void {
  catalog.defaults.searchEnabled = state.searchEnabled;
  catalog.defaults.searchPlan = searchSettingPlan(state.searchEnabled);
  for (const model of catalog.models) model.webSearch = state.webSearch;
  catalog.search = structuredClone(state.search);
}

/**
 * Signs in with the local token in a new context and installs the matrix
 * catalog, whose Settings writes are routed and never stored. The switch the
 * page saves is mirrored into the catalog, so a refetch keeps it.
 */
async function openFixtureContext(browser: Browser, size: Size, catalog: Catalog): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: "light",
    hasTouch: size.touch,
    locale: "en-US",
    reducedMotion: "reduce",
    viewport: { height: size.height, width: size.width }
  });
  const page = await context.newPage();
  await authenticateWithLocalToken(page.request);
  await installMatrixCatalogFixture(page, undefined, { catalog });
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || !request.url().endsWith("/api/me/settings")) return;
    const body = request.postDataJSON() as { defaultSearchPlan?: { optionIds?: unknown } } | null;
    const optionIds = body?.defaultSearchPlan?.optionIds;
    if (Array.isArray(optionIds)) catalog.defaults.searchEnabled = optionIds.length > 0;
  });
  return page;
}

async function openNewChat(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
}

const searchChip = (page: Page) => page.getByRole("button", { name: "Web search", exact: true });
const searchLayer = (page: Page) => page.getByRole("dialog", { name: "Web search" });
const searchSwitch = (page: Page) => searchLayer(page).getByRole("switch", { name: "Search the web" });

for (const size of COMPOSER_SIZES) {
  test(`composer Web search chip and layer · ${sizeLabel(size)}`, async ({ browser }, testInfo) => {
    test.setTimeout(150_000);
    const catalog: Catalog = structuredClone(matrixCatalog);
    const page = await openFixtureContext(browser, size, catalog);
    try {
      for (const state of COMPOSER_STATES) {
        applyComposerState(catalog, state);
        await openNewChat(page);
        await engageComposer(page);
        await expect(searchChip(page)).toHaveAccessibleDescription(state.description);
        await shot(page, testInfo, "composer", `${state.key}-chip`, size);
        await searchChip(page).click();
        await expect(searchSwitch(page)).toHaveAttribute("aria-checked", String(state.searchEnabled));
        if (state.status) await expect(searchLayer(page)).toContainText(state.status);
        await shotBothThemes(page, testInfo, "composer", `${state.key}-layer`, size);
        await page.keyboard.press("Escape");
        await expect(searchLayer(page)).toHaveCount(0);
      }
    } finally {
      await page.context().close();
    }
  });
}

test("composer Web search in Assistant chats with a fixed and an adjustable Search row", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  const people = createPeopleFixture(prisma);
  const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
  let source: CatalogOnlySearchSource | null = null;
  try {
    source = await createCatalogOnlySearchSource(prisma, "screens");
    const user = await people.user("Search screens");
    await prepareFakeQsaChats(prisma, user.id);
    const setup = await people.signIn(browser, user, { viewport: { height: DESKTOP.height, width: DESKTOP.width } });
    // The helper's defaults fix Search Off; the adjustable row starts with the catalog-only source, as A-15 does.
    const fixed = await assistants.create(setup.page.request, { name: "Fixed search" });
    const adjustable = await assistants.create(setup.page.request, {
      name: "Adjustable search",
      rows: { search: { policy: "adjustable", value: { mode: "model_choice", optionIds: [source.optionId] } } }
    });
    const chats: readonly Readonly<{ assistant: E2EAssistant; chatId: string; key: string }>[] = [
      { assistant: fixed, chatId: await assistants.createChat(setup.page.request, { assistant: { assistantId: fixed.id } }), key: "assistant-fixed" },
      {
        assistant: adjustable,
        chatId: await assistants.createChat(setup.page.request, { assistant: { assistantId: adjustable.id } }),
        key: "assistant-adjustable"
      }
    ];
    await setup.context.close();

    for (const size of COMPOSER_SIZES) {
      const { context, page } = await people.signIn(browser, user, {
        colorScheme: "light",
        hasTouch: size.touch,
        viewport: { height: size.height, width: size.width }
      });
      for (const { assistant, chatId, key } of chats) {
        await page.goto(`/c/${chatId}`);
        await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
        await engageComposer(page);
        await expect(searchChip(page)).toHaveAttribute("data-provenance", "assistant");
        await shot(page, testInfo, "composer", `${key}-chip`, size);
        await searchChip(page).click();
        if (assistant === fixed) {
          await expect(searchLayer(page).getByTestId("assistant-row-provenance")).toHaveText(`Fixed by ${assistant.name}`);
          await expect(searchSwitch(page)).toBeDisabled();
        } else {
          await expect(searchSwitch(page)).toBeEnabled();
        }
        await shotBothThemes(page, testInfo, "composer", `${key}-layer`, size);
        await page.keyboard.press("Escape");
        await expect(searchLayer(page)).toHaveCount(0);
      }
      await context.close();
    }
  } finally {
    try {
      await assistants.cleanup();
    } finally {
      try {
        await people.cleanup();
      } finally {
        // The source goes last: the chats that carried it are gone by now.
        await source?.cleanup();
      }
    }
  }
});

test("keyboard-only composer pass: Tab to Web search, Enter, Space, Escape", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const catalog: Catalog = structuredClone(matrixCatalog);
  applyComposerState(catalog, COMPOSER_STATES[0]!);
  const page = await openFixtureContext(browser, DESKTOP, catalog);
  try {
    await openNewChat(page);
    const chip = searchChip(page);
    await page.getByRole("textbox", { name: "Message", exact: true }).focus();
    for (let step = 0; step < 25 && !(await chip.evaluate((element) => element === document.activeElement)); step++) {
      await page.keyboard.press("Tab");
    }
    await expect(chip).toBeFocused();
    await shot(page, testInfo, "keyboard", "1-chip-focused", DESKTOP);
    await page.keyboard.press("Enter");
    await expect(searchLayer(page)).toBeVisible();
    await expect(searchSwitch(page)).toBeFocused();
    await shot(page, testInfo, "keyboard", "2-layer-open", DESKTOP);
    await page.keyboard.press("Space");
    await expect(searchSwitch(page)).toHaveAttribute("aria-checked", "true");
    await shot(page, testInfo, "keyboard", "3-switch-on", DESKTOP);
    await page.keyboard.press("Escape");
    await expect(searchLayer(page)).toHaveCount(0);
    await expect(chip).toBeFocused();
    await shot(page, testInfo, "keyboard", "4-closed-focus-on-chip", DESKTOP);
  } finally {
    await page.context().close();
  }
});

for (const size of [DESKTOP, PHONE]) {
  test(`Settings › Chat defaults Web search row · ${sizeLabel(size)}`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const catalog: Catalog = structuredClone(matrixCatalog);
    applyComposerState(catalog, COMPOSER_STATES[2]!);
    const page = await openFixtureContext(browser, size, catalog);
    try {
      await openNewChat(page);
      await runAccountMenuAction(page, "Chat defaults");
      const settings = page.getByTestId("library-v2");
      const row = settings.getByTestId("settings-default-search");
      const control = row.getByRole("switch", { name: "Web search default" });
      await row.scrollIntoViewIfNeeded();
      await expect(control).toHaveAttribute("aria-checked", "true");
      await shot(page, testInfo, "settings-search", "on", size);
      await control.click();
      const confirmation = page.getByRole("dialog", { name: "Turn off web search" });
      await expect(confirmation).toBeVisible();
      await shot(page, testInfo, "settings-search", "confirm-off", size);
      await confirmation.getByRole("button", { name: "Confirm turn off" }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(control).toHaveAttribute("aria-checked", "false");
      await row.scrollIntoViewIfNeeded();
      await shot(page, testInfo, "settings-search", "off", size);
    } finally {
      await page.context().close();
    }
  });
}

/* Admin › Search: a routed admin catalog */

const now = "2026-11-26T09:00:00.000Z";

function draft(protocol: AdminSearchDraft["protocol"], providerModelId: string, patch: Partial<AdminSearchDraft> = {}): AdminSearchDraft {
  return {
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxOutputTokens: null,
    protocol,
    providerModelId,
    queryMaxCharacters: 1_000,
    reasoningPolicy: "lowest_supported",
    timeoutMs: 120_000,
    ...patch
  };
}

function source(input: Readonly<{
  configuration: AdminSearchDraft;
  connection: string;
  description: string;
  displayName: string;
  id: string;
  kind: AdminSearchIntegration["kind"];
  model: string;
  strategyId: string;
}>, patch: Partial<AdminSearchIntegration> = {}): AdminSearchIntegration {
  return {
    archivedAt: null,
    broaderModelSetup: "ready",
    configurable: true,
    configuration: input.configuration,
    configurationActive: true,
    description: input.description,
    displayName: input.displayName,
    draftDirty: false,
    draftTestEvidence: {
      checkedAt: now,
      method: "provider_search",
      normalizedSourceCount: 6,
      protocol: input.configuration.protocol,
      status: "available"
    },
    draftVersion: 1,
    enabled: true,
    executionModes: ["all_selected", "model_choice"],
    id: input.id,
    kind: input.kind,
    providerModel: {
      connectionDisplayName: input.connection,
      connectionId: `connection-${input.connection.toLowerCase()}`,
      displayName: input.model,
      id: input.configuration.providerModelId!
    },
    ready: true,
    readiness: "ready",
    sourceConnectionId: `connection-${input.connection.toLowerCase()}`,
    strategyId: input.strategyId,
    system: false,
    ...patch
  };
}

const OPENAI = source({
  configuration: draft("openai_responses_web_search", "model-openai-luna"),
  connection: "OpenAI",
  description: "Web search through OpenAI.",
  displayName: "OpenAI Web Search",
  id: "search-source-openai",
  kind: "web_search",
  model: "GPT-6 Luna",
  strategyId: "openai-web-search-1a2b3c4d"
});
const OPENROUTER = source({
  configuration: draft("openrouter_web_search", "model-openrouter-flash", { openRouterWebSearch: { engine: "exa", mode: "auto" } }),
  connection: "OpenRouter",
  description: "Web results with source links through OpenRouter web search.",
  displayName: "OpenRouter Web Search",
  id: "search-source-openrouter",
  kind: "web_search",
  model: "DeepSeek V4.1 Flash",
  strategyId: "openrouter-web-search-5e6f7a8b"
});
const DEEPSEEK = source({
  configuration: draft("deepseek_search_api", "model-deepseek-chat", { queryMaxCharacters: 128 }),
  connection: "DeepSeek",
  description: "Web results with source links from the DeepSeek Search API.",
  displayName: "DeepSeek Search API",
  id: "search-source-deepseek",
  kind: "deepseek_search_api",
  model: "DeepSeek V4.1",
  strategyId: "deepseek-search-api-9c0d1e2f"
});

const PROVIDER_MODELS: AdminSearchCatalog["providerModels"] = [
  { connectionDisplayName: "OpenAI", connectionId: "connection-openai", displayName: "GPT-6 Luna", enabled: true,
    id: "model-openai-luna", searchKind: "web_search", searchReasoningSupported: true },
  { connectionDisplayName: "OpenRouter", connectionId: "connection-openrouter", displayName: "DeepSeek V4.1 Flash", enabled: true,
    id: "model-openrouter-flash", searchKind: "openrouter_web_search", searchReasoningSupported: false },
  { connectionDisplayName: "OpenRouter", connectionId: "connection-openrouter", displayName: "Sonar Pro", enabled: true,
    id: "model-openrouter-sonar", searchKind: "perplexity_search", searchReasoningSupported: false },
  { connectionDisplayName: "DeepSeek", connectionId: "connection-deepseek", displayName: "DeepSeek V4.1", enabled: true,
    id: "model-deepseek-chat", searchKind: "deepseek_search_api", searchReasoningSupported: false }
];

function adminCatalog(
  integrations: AdminSearchIntegration[],
  policy: Partial<AdminSearchCatalog["policy"]> = {}
): AdminSearchCatalog {
  return {
    integrations,
    policy: {
      backupOptionId: null,
      defaultPlan: { mode: "all_selected", optionIds: [] },
      engineOptionId: null,
      inAnswerSearch: true,
      resolved: { automatic: true, backupOptionId: null, engineOptionId: OPENAI.strategyId, reason: null },
      updatedAt: now,
      version: 3,
      ...policy
    },
    providerModels: PROVIDER_MODELS
  };
}

const ADMIN_CLEAN = adminCatalog([OPENAI, OPENROUTER, DEEPSEEK]);
// The chosen engine is turned off, so it cannot search and nothing replaces it.
const ADMIN_UNAVAILABLE = adminCatalog([OPENAI, { ...OPENROUTER, enabled: false }, DEEPSEEK], {
  defaultPlan: { mode: "all_selected", optionIds: [OPENROUTER.strategyId] },
  engineOptionId: OPENROUTER.strategyId,
  resolved: { automatic: false, backupOptionId: null, engineOptionId: null, reason: "search_engine_unavailable" }
});
// A built-in that only GPT answers can use and a source that still needs its Search model.
const ADMIN_NO_CANDIDATES = adminCatalog([
  { ...OPENAI, configurable: false, configuration: null, executionModes: ["model_choice"], system: true },
  { ...OPENROUTER, configurationActive: false, executionModes: [], ready: false, readiness: "setup_required" }
], { resolved: { automatic: true, backupOptionId: null, engineOptionId: null, reason: "search_engine_not_configured" } });
const ADMIN_ROLES = adminCatalog([OPENAI, OPENROUTER, DEEPSEEK], {
  backupOptionId: DEEPSEEK.strategyId,
  defaultPlan: { mode: "all_selected", optionIds: [OPENROUTER.strategyId, DEEPSEEK.strategyId] },
  engineOptionId: OPENROUTER.strategyId,
  resolved: { automatic: false, backupOptionId: DEEPSEEK.strategyId, engineOptionId: OPENROUTER.strategyId, reason: null }
});
// Without a configured OpenRouter web search source, Add source offers it.
const ADMIN_ADDABLE = adminCatalog([OPENAI, DEEPSEEK]);

test("Admin › Search Engine card, source list, source page and sheets", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.clock.setFixedTime(new Date(now));
  let search = ADMIN_CLEAN;
  await page.route("**/api/admin/search", async (route) => {
    // Nothing is saved: the spec only looks.
    if (route.request().method() !== "GET") {
      await route.fulfill({ contentType: "application/json", json: { error: "not_in_this_spec" }, status: 409 });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { search } });
  });
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=search");
  const section = page.getByTestId("admin-search-section");
  const card = section.getByRole("region", { name: "Engine" });
  const resolved = card.getByTestId("admin-search-engine-resolved");
  const engineSelect = card.getByLabel(/^Search engine/u);

  await expect(resolved).toHaveText("Automatic: searching with OpenAI Web Search.");
  for (const size of ADMIN_SIZES) {
    await page.setViewportSize({ height: size.height, width: size.width });
    await card.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "admin-search", "clean", size);
  }

  await engineSelect.selectOption(OPENROUTER.strategyId);
  const save = card.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  for (const size of ADMIN_SIZES) {
    await page.setViewportSize({ height: size.height, width: size.width });
    await save.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "admin-search", "dirty", size);
  }

  search = ADMIN_UNAVAILABLE;
  await page.reload();
  await expect(resolved).toContainText("OpenRouter Web Search cannot search now");
  await expect(card.getByRole("status")).toContainText("can no longer be the engine");
  for (const size of ADMIN_SIZES) {
    await page.setViewportSize({ height: size.height, width: size.width });
    await engineSelect.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "admin-search", "engine-unavailable", size);
  }

  search = ADMIN_NO_CANDIDATES;
  await page.reload();
  await expect(resolved).toContainText("No engine can search yet.");
  const noCandidates = card.getByText("No source can be the engine yet");
  await expect(noCandidates).toBeVisible();
  for (const size of ADMIN_SIZES) {
    await page.setViewportSize({ height: size.height, width: size.width });
    await noCandidates.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "admin-search", "no-candidates", size);
  }

  search = ADMIN_ROLES;
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });
  await page.reload();
  const list = section.getByRole("list", { name: "Search sources" });
  await expect(list.getByTestId(`search-source-row-${OPENROUTER.id}`).getByTestId("search-source-role")).toHaveText("Engine");
  await expect(list.getByTestId(`search-source-row-${DEEPSEEK.id}`).getByTestId("search-source-role")).toHaveText("Backup");
  await list.scrollIntoViewIfNeeded();
  await shot(page, testInfo, "admin-search", "use-engine-backup", DESKTOP);

  // The OpenRouter web search source: its page and its Configure sheet with the engine and the mode.
  search = ADMIN_CLEAN;
  await page.reload();
  await list.getByTestId(`search-source-row-${OPENROUTER.id}`).click();
  const sourcePage = section.getByTestId("search-source-page");
  await expect(sourcePage.getByTestId("search-source-page-status")).toContainText("Working");
  await shot(page, testInfo, "admin-source", "openrouter-page", DESKTOP);
  await page.setViewportSize({ height: PHONE.height, width: PHONE.width });
  await shot(page, testInfo, "admin-source", "openrouter-page", PHONE);
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });
  await sourcePage.getByRole("button", { name: "Configure" }).click();
  const configure = page.getByRole("dialog", { name: "Configure source" });
  const openRouterEngine = configure.getByLabel("OpenRouter engine");
  await expect(openRouterEngine).toHaveValue("exa");
  await expect(configure.getByLabel("Engine mode")).toHaveValue("auto");
  await shot(page, testInfo, "admin-configure", "openrouter", DESKTOP);
  await page.setViewportSize({ height: PHONE.height, width: PHONE.width });
  await openRouterEngine.scrollIntoViewIfNeeded();
  await shot(page, testInfo, "admin-configure", "openrouter", PHONE);
  await page.setViewportSize({ height: DESKTOP.height, width: DESKTOP.width });
  await page.keyboard.press("Escape");
  await expect(configure).toHaveCount(0);

  // A DeepSeek Search API source returns results, so its sheet has no Advanced section.
  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Search" }).click();
  await list.getByTestId(`search-source-row-${DEEPSEEK.id}`).click();
  await sourcePage.getByRole("button", { name: "Configure" }).click();
  await expect(configure).toBeVisible();
  await expect(configure.getByText("Advanced Search execution")).toHaveCount(0);
  await shot(page, testInfo, "admin-configure", "deepseek-no-advanced", DESKTOP);
  await page.keyboard.press("Escape");
  await expect(configure).toHaveCount(0);

  // Add source offers OpenRouter Web Search; choosing it names the source and shows the engine fields.
  search = ADMIN_ADDABLE;
  await page.goto("/admin?section=search");
  await page.getByTestId("search-add").click();
  const add = page.getByRole("dialog", { name: "Add source" });
  const model = add.getByLabel(/^Search model/u);
  await model.selectOption({ label: "OpenRouter web search · DeepSeek V4.1 Flash" });
  await expect(add.getByLabel("Name", { exact: true })).toHaveValue("OpenRouter Web Search");
  await expect(add.getByLabel("OpenRouter engine")).toHaveValue("perplexity");
  await shot(page, testInfo, "admin-add-source", "openrouter-web-search", DESKTOP);
  await page.setViewportSize({ height: PHONE.height, width: PHONE.width });
  await model.scrollIntoViewIfNeeded();
  await shot(page, testInfo, "admin-add-source", "openrouter-web-search", PHONE);
});

/* Settings › Assistants: the editor's Web search row */

test("Assistant editor Web search row offers Inherit, Off and On", async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const people = createPeopleFixture(prisma);
  try {
    const user = await people.user("Search editor");
    for (const size of [DESKTOP, PHONE]) {
      const { context, page } = await people.signIn(browser, user, {
        colorScheme: "light",
        hasTouch: size.touch,
        viewport: { height: size.height, width: size.width }
      });
      await runAccountMenuAction(page, "Assistants");
      const library = page.getByTestId("library-v2");
      await expect(library.getByTestId("assistant-gallery")).toBeVisible();
      // A new, unsaved Assistant: nothing is created.
      await library.getByRole("button", { exact: true, name: "New assistant" }).first().click();
      const sheet = page.getByRole("dialog", { exact: true, name: "New assistant" });
      await expect(sheet.getByRole("radio", { exact: true, name: "Blank" })).toBeChecked();
      await sheet.getByRole("button", { exact: true, name: "Continue" }).click();
      const row = library.getByTestId("assistant-editor").getByTestId("assistant-setup-row-search");
      await row.getByRole("button", { exact: true, name: "Web search" }).click();
      await expect(row.getByRole("radio")).toHaveCount(3);
      await row.scrollIntoViewIfNeeded();
      await shot(page, testInfo, "assistant-editor", "search-row-open", size);
      await context.close();
    }
  } finally {
    await people.cleanup();
  }
});
