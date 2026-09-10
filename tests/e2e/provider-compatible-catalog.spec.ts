import { expect, test } from "@playwright/test";
import {
  FIXTURE_NOW,
  fixtureCheck,
  fixtureCheckRun,
  fixtureConnection,
  fixtureCredential,
  fixtureModel
} from "../../components/admin/providers/providerFixtures";
import type { AdminProviderModelConfiguration } from "../../lib/contracts/adminProviders";
import { signInWithLocalToken } from "./support/localAuth";

for (const retryFirst of [false, true]) {
  test(`compatible catalog ${retryFirst ? "recovers through Retry" : "loads"} before Test & Save`, async ({ page }) => {
    const connectionId = "compatible-catalog-provider";
    const credentialId = "compatible-catalog-key";
    const existingModels = Array.from({ length: 4 }, (_, index) => {
      const model = fixtureModel({
        connectionId,
        displayName: `Saved model ${index + 1}`,
        id: `saved-model-${index + 1}`
      });
      model.draftConfig = {
        ...model.draftConfig,
        adapterKind: "openai_responses_compatible",
        upstreamModelId: `vendor/saved-${index + 1}`
      };
      model.activeConfig = model.draftConfig;
      return model;
    });
    let connection = fixtureConnection({
      credentials: [fixtureCredential({ id: credentialId, label: "Primary" })],
      defaultCredentialId: credentialId,
      displayName: "Compatible catalog provider",
      family: "openai_compatible",
      id: connectionId,
      models: existingModels
    });
    const catalog = [
      ...existingModels.map((model) => model.draftConfig.upstreamModelId),
      "vendor/new-model",
      "vendor/another-model",
      "vendor/last-model"
    ].map((id) => ({ capabilities: { toolCalling: true, vision: true }, id, ownedBy: "codex-lb" }));
    let discoveries = 0;
    const mutations: Record<string, unknown>[] = [];
    await page.route("**/api/admin/providers**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ json: { connections: [connection] } });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.action === "discover_compatible_models") {
        expect(body.credentialId).toBe(credentialId);
        discoveries += 1;
        await route.fulfill({ json: { models: retryFirst && discoveries === 1
          ? [{ ...catalog[0], ownedBy: "" }]
          : catalog } });
        return;
      }
      mutations.push(body);
      if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/models")) {
        await route.fulfill({ status: 400, json: { error: "unexpected_mutation" } });
        return;
      }
      const configuration = body.configuration as AdminProviderModelConfiguration;
      expect(body.activate).toBe(true);
      expect(configuration.upstreamModelId).toBe("vendor/new-model");
      const added = fixtureModel({
        activeConfig: configuration,
        connectionId,
        displayName: String(body.displayName),
        draftConfig: configuration,
        id: "added-model"
      });
      connection = {
        ...connection,
        activeChecks: [fixtureCheck({ credentialId, providerModelId: added.id })],
        checkRun: fixtureCheckRun({
          credentialId,
          done: 1,
          finishedAt: FIXTURE_NOW,
          id: "add-model-check",
          reason: "model",
          results: [{ providerModelId: added.id, state: "saved" }],
          state: "completed",
          total: 1
        }),
        models: [...existingModels, added]
      };
      await route.fulfill({ status: 201, json: { receipt: { connectionId, modelId: added.id, displayName: added.displayName,
        draftVersion: 1, saved: "configuration", publication: "active", checks: "checked" } } });
    });

    await signInWithLocalToken(page);
    await page.setViewportSize(retryFirst ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto(`/admin?section=providers&resource=${connectionId}`);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, retryFirst ? "dark" : "light");
    const models = page.getByTestId("provider-models");
    await expect(models).toContainText("Chat models · 4");
    await models.getByRole("button", { name: "Add model", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add model", exact: true });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Model", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Model", exact: true });
    if (retryFirst) {
      await expect(picker.getByRole("alert")).toContainText("Compatible endpoint models could not be loaded");
      expect(discoveries).toBe(1);
      await picker.getByRole("button", { name: "Retry", exact: true }).focus();
      await page.keyboard.press("Enter");
    }
    await expect(picker.getByRole("option")).toHaveCount(7);
    await expect(picker.getByRole("alert")).toHaveCount(0);
    expect(discoveries).toBe(retryFirst ? 2 : 1);
    expect(mutations).toEqual([]);
    expect(connection.models).toEqual(existingModels);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await picker.getByRole("option", { name: "vendor/new-model Reported by the endpoint" }).click();
    await expect(sheet.getByLabel("Upstream model id", { exact: true })).toHaveValue("vendor/new-model");
    expect(mutations).toEqual([]);
    await sheet.getByRole("button", { name: "Test & Save", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(models.getByTestId("provider-model-added-model")).toBeVisible();
    await expect(models).toContainText("Chat models · 5");
    expect(mutations).toHaveLength(1);
    expect(connection.models.slice(0, 4)).toEqual(existingModels);
  });
}
