import { expect, test, type Page } from "@playwright/test";
import type { AdminModelPolicyUpdateInput } from "../../components/admin/adminModelPolicyApi";
import { decodeAdminModelPolicyResponse, type AdminModelPolicyCatalog } from "../../lib/contracts/adminModelPolicy";
import { defaultProviderModels } from "../../lib/domain/catalog";
import { buildCurrentUserCatalog, type CatalogData } from "../../lib/server/catalog/currentUserCatalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { chooseReasoningEffort, expectRunSummary, selectModel } from "./shell/composer";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { matrixCatalog } from "./shell/catalog";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import type { Catalog } from "../../lib/contracts/catalog";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`default reasoning saves, reloads and reaches new chats at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    const theme = viewport.width === 390 ? "light" : "dark";
    await page.emulateMedia({ colorScheme: theme });
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    const reasoningModel = {
      connectionDisplayName: "Reasoning provider", connectionId: "openai", displayName: "GPT-5.5",
      id: "gpt-5.5", defaultReasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"]
    };
    const plainModel = {
      connectionDisplayName: "Local provider", connectionId: "fake", displayName: "Plain answer",
      id: "fake-qsa", defaultReasoningEffort: null, reasoningEfforts: []
    };
    const policy: AdminModelPolicyCatalog = {
      candidates: [reasoningModel, plainModel],
      policy: {
        defaultModel: { ...reasoningModel, available: true }, reasoningEffort: null,
        mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192, maxMcpToolsPerDiscovery: 10, maxToolCalls: 20, maxToolRounds: 8,
        updatedAt: "2026-09-07T00:00:00.000Z", updatedBy: null, version: 1
      }
    };
    const data: CatalogData = {
      entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
      modelPolicy: { defaultProviderModelId: reasoningModel.id, reasoningEffort: null },
      models: defaultProviderModels, searchStrategies: [],
      settings: {
        defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null,
        showCitations: true, showReasoningBlocks: false
      }
    };
    const saved: AdminModelPolicyUpdateInput[] = [];
    await installMatrixCatalogFixture(page);
    await page.route("**/api/me/catalog", (route) => route.fulfill({ json: { catalog: buildCurrentUserCatalog(data) } }));
    await page.route("**/api/admin/providers/model-policy", async (route) => {
      if (route.request().method() === "PATCH") {
        const body: AdminModelPolicyUpdateInput = route.request().postDataJSON();
        saved.push(body);
        expect(body.expectedVersion).toBe(policy.policy.version);
        if (body.providerModelId !== undefined) {
          const selected = policy.candidates.find((candidate) => candidate.id === body.providerModelId);
          policy.policy.defaultModel = selected ? { ...selected, available: true } : null;
          policy.policy.reasoningEffort = body.reasoningEffort ?? null;
          data.modelPolicy = { defaultProviderModelId: body.providerModelId, reasoningEffort: body.reasoningEffort ?? null };
        }
        for (const key of ["maxMcpToolsPerDiscovery", "maxToolCalls", "maxToolRounds"] as const) {
          const value = body[key];
          if (value !== undefined) policy.policy[key] = value;
        }
        if (body.mcpAutoDiscoveryTimeoutSeconds !== undefined) {
          policy.policy.mcpAutoDiscoveryTimeoutSeconds = body.mcpAutoDiscoveryTimeoutSeconds;
        }
        if (body.mcpAutoDiscoveryMaxOutputTokens !== undefined) {
          policy.policy.mcpAutoDiscoveryMaxOutputTokens = body.mcpAutoDiscoveryMaxOutputTokens;
        }
        policy.policy.version += 1;
      }
      await route.fulfill({ json: { modelPolicy: policy } });
    });
    // The Chat defaults picker lists only models some group can reach.
    await page.route("**/api/admin", (route) => route.fulfill({ json: {
      accessRules: [], catalog: { models: [], providers: [], searchStrategies: [] },
      groups: [{
        accessGrants: [
          { enabled: true, groupId: "g", id: "grant-openai", modelId: null, provider: "openai", searchStrategy: null, userId: null },
          { enabled: true, groupId: "g", id: "grant-fake", modelId: null, provider: "fake", searchStrategy: null, userId: null }
        ],
        archivedAt: null, deletion: { canDelete: false, reason: null, summary: "" }, id: "g", name: "everyone", systemRole: null, userCount: 1
      }],
      invites: [],
      navigation: { advancedConfigured: false, attention: { activeUsersWithoutModelAccess: 0, openInvites: 0, pendingUsers: 0 }, teamConfigured: false },
      usage: { byGroup: [], byUser: [], totals: { estimatedCostMicros: null, recordCount: 0, knownCostRecordCount: 0, incompleteUsageCount: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 0, lastUsedAt: null, outputTokens: 0, reasoningTokens: 0, runCount: 0, totalTokens: 0 } },
      users: []
    } }));
    await signInWithLocalToken(page);
    const livePolicy = await page.request.get("/api/admin/providers/model-policy");
    expect(livePolicy.status()).toBe(200);
    expect(Boolean(decodeAdminModelPolicyResponse(await livePolicy.json()))).toBe(true);
    await page.goto("/admin?section=roles");
    const defaults = page.getByTestId("admin-chat-defaults");
    const model = defaults.getByRole("combobox", { name: "Default chat model", exact: true });
    const effort = defaults.getByRole("combobox", { name: "Reasoning", exact: true });
    const save = defaults.getByRole("button", { name: "Save", exact: true });
    const savedNotice = page.getByTestId("admin-feedback").getByText("Chat defaults saved for new chats");
    await expect(model).toHaveValue(reasoningModel.id);
    await expect(save).toBeDisabled();
    await defaults.locator("summary").click();
    await effort.selectOption("high");
    await save.click();
    await expect(savedNotice).toBeVisible();
    expect(saved).toEqual([{ expectedVersion: 1, providerModelId: reasoningModel.id, reasoningEffort: "high" }]);
    const outputTokens = defaults.getByRole("spinbutton", { name: "MCP Auto output tokens", exact: true });
    await expect(outputTokens).toHaveValue("8192");
    await outputTokens.fill("32768");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(defaults.getByRole("status")).toHaveText("No unsaved changes");
    expect(saved.at(-1)).toEqual({
      expectedVersion: 2, maxMcpToolsPerDiscovery: 10, maxToolCalls: 20, maxToolRounds: 8,
      mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 32768
    });
    await page.reload();
    await defaults.locator("summary").click();
    await expect(effort).toHaveValue("high");
    await expect(outputTokens).toHaveValue("32768");
    await expect(model).toHaveValue(reasoningModel.id);
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await effort.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: testInfo.outputPath("default-reasoning.png") });

    const outputMode = defaults.getByRole("combobox", { name: "MCP output budget" });
    const timeout = defaults.getByRole("spinbutton", { name: "Discovery timeout", exact: true });
    await outputMode.selectOption("model");
    await timeout.fill("");
    await save.click();
    expect(saved.at(-1)).toMatchObject({ mcpAutoDiscoveryTimeoutSeconds: null, mcpAutoDiscoveryMaxOutputTokens: null });
    await page.reload();
    await defaults.locator("summary").click();
    await expect(outputMode).toHaveValue("model");
    await expect(timeout).toHaveValue("");
    await expect(timeout).toHaveAttribute("placeholder", "Auto");
    await expect(save).toBeDisabled();
    if (viewport.width === 1440) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const size of [{ width: 1440, height: 900 }, { width: 820, height: 1180 },
          { width: 1180, height: 820 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
          await page.setViewportSize(size);
          await timeout.scrollIntoViewIfNeeded();
          await expect(timeout).toBeInViewport();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`utility-auto-${theme}-${size.width}x${size.height}.png`) });
        }
      }
      await page.setViewportSize(viewport);
    }

    await page.goto("/");
    await expectRunSummary(page, { model: "GPT-5.5", reasoning: "high" });
    data.settings.defaultControlValues = { "openai:gpt-5.5": { reasoningEffort: "low" } };
    await page.reload();
    await expectRunSummary(page, { model: "GPT-5.5", reasoning: "low" });

    await page.goto("/admin?section=roles");
    await defaults.locator("summary").click();
    await effort.selectOption("");
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved.at(-1)).toMatchObject({ providerModelId: reasoningModel.id, reasoningEffort: null });
    await effort.selectOption("high");
    await model.selectOption(plainModel.id);
    await expect(effort).toHaveValue("");
    await expect(effort).toBeDisabled();
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved.at(-1)).toMatchObject({ providerModelId: plainModel.id, reasoningEffort: null });
    // Clearing the default is the empty choice of the same picker, saved the same way.
    await model.selectOption("");
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved.at(-1)).toMatchObject({ providerModelId: null, reasoningEffort: null });
  });
}

const reasoningChatId = "reasoning-chip-fixture";
const reasoningArtifactTitle = "Synthetic reference report";
const reasoningModelName = "GPT-5.5 with a deliberately long deployment name";

async function installReasoningChipFixture(page: Page, savedLevel = "xhigh") {
  const catalog: Catalog = structuredClone(matrixCatalog);
  catalog.models[0]!.displayName = reasoningModelName;
  catalog.models[1] = { ...catalog.models[1]!, displayName: "Plain fixture model",
    capabilities: { ...catalog.models[1]!.capabilities, reasoning: false },
    parameterControls: { ...catalog.models[1]!.parameterControls,
      reasoningEffort: { supported: false, options: ["none"], defaultValue: "none" } } };
  catalog.defaults.controlValues = { "openai:gpt-5.5": { reasoningEffort: savedLevel } };
  const artifact = { artifactId: "reasoning-artifact", versionId: "reasoning-version", versionNumber: 1,
    title: reasoningArtifactTitle, kind: "html", entrypoint: "index.html" };
  const timestamp = "2026-09-30T12:00:00.000Z";
  const chat = { id: reasoningChatId, title: "A long synthetic conversation title that keeps its place beside the model",
    activeLeafMessageId: "reasoning-answer", createdAt: timestamp, updatedAt: timestamp,
    defaultModelId: "gpt-5.5", defaultProvider: "openai", folderId: null, pinned: false, messageCount: 2,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: 1200 },
    messages: [{ id: "reasoning-question", role: "user", parentMessageId: null, text: "Review the synthetic report." },
      { id: "reasoning-answer", role: "assistant", parentMessageId: "reasoning-question", text: "The report is ready." }]
      .map(message => ({ ...message, createdAt: timestamp, status: "complete", errorMessage: null,
        content: { blocks: [{ type: "text", text: message.text }] }, modelId: message.role === "assistant" ? "gpt-5.5" : null,
        provider: message.role === "assistant" ? "openai" : null, modelRunId: message.role === "assistant" ? "reasoning-run" : null,
        artifactSummary: message.role === "assistant" ? { citations: [], sources: [], reasoningText: [], generatedArtifacts: [artifact] } : null })) };
  await installMatrixCatalogFixture(page, { folders: [], chats: [chat] }, { catalog });
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/artifacts/reasoning-artifact", route => route.fulfill({ json: { artifact: {
    id: artifact.artifactId, title: artifact.title, currentVersionId: artifact.versionId, sourceChatId: chat.id,
    publications: [], versions: [{ id: artifact.versionId, title: artifact.title, kind: artifact.kind,
      entrypoint: artifact.entrypoint, versionNumber: 1, createdAt: timestamp }]
  } } }));
  await page.route("**/api/artifacts/reasoning-artifact/versions/reasoning-version/content", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Reference</title><h1>Synthetic reference report</h1><p>Ready for review.</p>"
  }));
  await authenticateWithLocalToken(page.request);
  await page.goto(`/c/${reasoningChatId}`);
  await expect(page.getByTestId("header-model-trigger")).toContainText(reasoningModelName);
}

function reasoningChip(page: Page) {
  return page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u });
}

async function chooseReasoningFromChip(page: Page, level: string) {
  await reasoningChip(page).click();
  const menu = page.getByRole("menu", { name: "Reasoning effort" });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Applies to your next message.");
  await menu.getByRole("menuitemradio", { name: level, exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(reasoningChip(page)).toHaveAccessibleName(`Reasoning effort: ${level}`);
}

/**
 * The raw level is drawn whole in its chip; composer controls stay inside the
 * composer without overlap; the header carries the model name only and the
 * chat title keeps its 6rem floor beside it.
 */
async function expectReasoningChipGeometry(page: Page) {
  await expect.poll(() => page.getByTestId("composer-v2").evaluate(root => {
    const violations: string[] = [];
    const chip = root.querySelector<HTMLElement>(".v2-composer-reasoning");
    const value = chip?.querySelector(".v2-composer-reasoning-value");
    if (!chip || !value) return ["no reasoning chip"];
    const range = document.createRange(); range.selectNodeContents(value);
    const text = range.getBoundingClientRect(), box = chip.getBoundingClientRect();
    if (text.width <= 0 || text.left < box.left - 0.5 || text.right > box.right + 0.5 ||
      text.top < box.top - 0.5 || text.bottom > box.bottom + 0.5) violations.push("reasoning value is clipped");
    const topmost = document.elementFromPoint(text.left + text.width / 2, text.top + text.height / 2);
    if (!topmost || !chip.contains(topmost)) violations.push("reasoning value is obscured");
    const outer = root.getBoundingClientRect();
    const buttons = [...root.querySelectorAll<HTMLElement>("button")].filter(element => element.checkVisibility());
    const overlaps = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    for (const [index, button] of buttons.entries()) {
      const rect = button.getBoundingClientRect();
      if (rect.left < outer.left - 0.5 || rect.right > outer.right + 0.5) violations.push(`${button.getAttribute("aria-label")} outside composer`);
      for (const other of buttons.slice(index + 1)) {
        if (overlaps(rect, other.getBoundingClientRect())) violations.push(`${button.getAttribute("aria-label")} overlaps ${other.getAttribute("aria-label")}`);
      }
    }
    return violations;
  })).toEqual([]);
  await expectNoHorizontalOverflow(page);
}

async function expectHeaderWithoutReasoning(page: Page) {
  const trigger = page.getByTestId("header-model-trigger");
  await expect(trigger.locator(".v2-live-model-reasoning")).toHaveCount(0);
  await expect(trigger).not.toContainText(/·/u);
  const title = page.locator(".v2-live-header > .v2-live-title");
  await expect(page.getByTestId("header-title")).toBeVisible();
  // The title's 6rem floor (96px) holds beside the model button again.
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(95);
}

for (const theme of ["light", "dark"] as const) {
  test(`reasoning chip follows Parameters, changes the level and stays readable beside an artifact in ${theme}`, async ({ page, context }, testInfo) => {
    test.setTimeout(150_000);
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await installReasoningChipFixture(page);
    const chip = reasoningChip(page);
    await expect(chip).toHaveAccessibleName("Reasoning effort: xhigh");
    await expect(chip).toHaveText("xhigh");
    await expectHeaderWithoutReasoning(page);
    await expect(page.getByTestId("header-model-trigger").locator(".v2-live-model-name")).toHaveText(reasoningModelName);

    // Parameters and the chip share one value, also after a reload.
    await chooseReasoningEffort(page, "medium");
    await expect(chip).toHaveAccessibleName("Reasoning effort: medium");
    await page.reload();
    await expect(chip).toHaveAccessibleName("Reasoning effort: medium");
    await chooseReasoningFromChip(page, "low");
    await expectRunSummary(page, { reasoning: "low" });
    await page.reload();
    await expect(chip).toHaveAccessibleName("Reasoning effort: low");

    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Preserve this unfinished draft.");
    if (await page.locator(".v2-workspace-shell").getAttribute("data-sidebar-collapsed") === "true") {
      await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    }
    await page.getByRole("button", { name: `Open artifact: ${reasoningArtifactTitle}`, exact: true }).click();
    const panel = page.locator("[data-artifact-panel]");
    await expect(panel).toBeVisible();
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(viewport);
      await expect(panel).toHaveAttribute("role", "complementary");
      await expect(page.locator(".v2-navigation")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expectReasoningChipGeometry(page);
      await expectHeaderWithoutReasoning(page);
      await page.screenshot({ path: testInfo.outputPath(`reasoning-artifact-${theme}-${viewport.width}x${viewport.height}.png`) });
    }
    await panel.getByRole("button", { name: "Close artifact" }).click();
    for (const viewport of [{ width: 820, height: 1180 }, { width: 1180, height: 820 },
      { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect(chip).toBeVisible();
      await expectReasoningChipGeometry(page);
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Preserve this unfinished draft.");
      if (viewport.width === 390) {
        // The narrow chip row gives every chip a 44px target; the levels open as a sheet.
        const box = (await chip.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(43);
        expect(box.height).toBeGreaterThanOrEqual(43);
        await chip.click();
        const sheet = page.getByRole("menu", { name: "Reasoning effort" });
        const sheetBox = (await sheet.boundingBox())!;
        expect(sheetBox.x).toBeLessThanOrEqual(1);
        expect(sheetBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
        expect(Math.abs(sheetBox.y + sheetBox.height - viewport.height)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath(`reasoning-sheet-${theme}-${viewport.width}x${viewport.height}.png`) });
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
        await expect(sheet).toHaveCount(0);
      }
      await page.screenshot({ path: testInfo.outputPath(`reasoning-${theme}-${viewport.width}x${viewport.height}.png`) });
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await selectModel(page, "openai", "Plain fixture model");
    await expect(page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort/u })).toHaveCount(0);
  });
}

test("the reasoning chip sends its level and stays visible but unchangeable during the answer", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installReasoningChipFixture(page);
  const stream = createGatedRunStreamFixture({ key: "reasoning-chip", abortMessage: "Synthetic stream cancelled", notReadyError: "reasoning_stream_not_ready" });
  await stream.installCurrent(page, reasoningChatId);
  // Record the admitted request as the page sends it.
  await page.evaluate(() => {
    const send = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/messages") && typeof init?.body === "string") {
        (window as typeof window & { __reasoningRunBody?: string }).__reasoningRunBody = init.body;
      }
      return send(input, init);
    };
  });
  const chip = reasoningChip(page);
  await chooseReasoningFromChip(page, "low");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A bounded synthetic question.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await stream.waitForRequestCount(page, 1);
  const body = JSON.parse(await page.evaluate(() =>
    (window as typeof window & { __reasoningRunBody?: string }).__reasoningRunBody ?? "{}")) as { params?: { reasoning?: { effort?: string } } };
  expect(body.params?.reasoning?.effort).toBe("low");
  await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId: "reasoning-active-run", status: "streaming" });
  await expect(page.getByTestId("header-model-trigger")).toBeDisabled();
  await expect(chip).toBeDisabled();
  await expect(chip).toHaveAccessibleName("Reasoning effort: low");
  await expect(chip).toHaveText("low");
  await expectReasoningChipGeometry(page);
  await stream.close(page);
});

test("a saved level the model no longer offers shows the model's default in the chip and Parameters", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  // GPT-5.5 offers none … xhigh with the default medium; "max" is not among them.
  await installReasoningChipFixture(page, "max");
  await expect(reasoningChip(page)).toHaveAccessibleName("Reasoning effort: medium");
  await expectRunSummary(page, { reasoning: "medium" });
});
