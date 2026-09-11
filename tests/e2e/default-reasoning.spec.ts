import { expect, test } from "@playwright/test";
import type { AdminModelPolicyUpdateInput } from "../../components/admin/adminModelPolicyApi";
import { decodeAdminModelPolicyResponse, type AdminModelPolicyCatalog } from "../../lib/contracts/adminModelPolicy";
import { defaultProviderModels } from "../../lib/domain/catalog";
import { buildCurrentUserCatalog, type CatalogData } from "../../lib/server/catalog/currentUserCatalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectRunSummary } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";

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
        for (const key of ["maxMcpToolsPerDiscovery", "maxToolCalls", "maxToolRounds",
          "mcpAutoDiscoveryTimeoutSeconds", "mcpAutoDiscoveryMaxOutputTokens"] as const) {
          const value = body[key];
          if (value !== undefined) policy.policy[key] = value;
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
      usage: { byGroup: [], byUser: [], totals: { incompleteUsageCount: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 0, lastUsedAt: null, outputTokens: 0, reasoningTokens: 0, runCount: 0, totalTokens: 0 } },
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
