import { expect, test } from "@playwright/test";
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
        mcpAutoDiscoveryTimeoutSeconds: 60, maxMcpToolsPerDiscovery: 10, maxToolCalls: 20, maxToolRounds: 8,
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
    const saved: unknown[] = [];
    await installMatrixCatalogFixture(page);
    await page.route("**/api/me/catalog", (route) => route.fulfill({ json: { catalog: buildCurrentUserCatalog(data) } }));
    await page.route("**/api/admin/providers/model-policy", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        saved.push(body);
        expect(body.expectedVersion).toBe(policy.policy.version);
        const selected = policy.candidates.find((candidate) => candidate.id === body.providerModelId);
        policy.policy.defaultModel = selected ? { ...selected, available: true } : null;
        policy.policy.reasoningEffort = body.reasoningEffort;
        policy.policy.version += 1;
        data.modelPolicy = { defaultProviderModelId: body.providerModelId, reasoningEffort: body.reasoningEffort };
      }
      await route.fulfill({ json: { modelPolicy: policy } });
    });
    await signInWithLocalToken(page);
    const livePolicy = await page.request.get("/api/admin/providers/model-policy");
    expect(livePolicy.status()).toBe(200);
    expect(Boolean(decodeAdminModelPolicyResponse(await livePolicy.json()))).toBe(true);
    await page.goto("/admin");
    await page.getByRole("tab", { name: "Default model" }).click();
    const model = page.getByLabel("Active answer model deployment");
    const effort = page.getByLabel("Default reasoning effort");
    const save = page.getByRole("button", { name: "Save default" });
    await expect(model).toHaveValue(reasoningModel.id);
    await expect(save).toBeDisabled();
    await effort.selectOption("high");
    await save.click();
    await expect(page.getByText("Installation default updated.", { exact: true })).toBeVisible();
    expect(saved).toEqual([{ expectedVersion: 1, providerModelId: reasoningModel.id, reasoningEffort: "high" }]);
    await page.reload();
    await page.getByRole("tab", { name: "Default model" }).click();
    await expect(effort).toHaveValue("high");
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

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Default model" }).click();
    await effort.selectOption("");
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved.at(-1)).toMatchObject({ providerModelId: reasoningModel.id, reasoningEffort: null });
    await effort.selectOption("high");
    await model.selectOption(plainModel.id);
    await expect(effort).toHaveValue("");
    await expect(effort).toBeDisabled();
    await expect(page.getByText("This model does not support adjustable reasoning.")).toBeVisible();
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved.at(-1)).toMatchObject({ providerModelId: plainModel.id, reasoningEffort: null });
    await page.getByRole("button", { name: "Clear default" }).click();
    await expect(page.getByText("Installation default cleared.", { exact: true })).toBeVisible();
    expect(saved.at(-1)).toMatchObject({ providerModelId: null, reasoningEffort: null });
  });
}
