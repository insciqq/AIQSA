import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureConnection, fixtureCredential, fixtureModel } from "../../components/admin/providers/providerFixtures";
import type { AdminProviderModelConfiguration } from "../../lib/contracts/adminProviders";
import { signInWithLocalToken } from "./support/localAuth";

for (const family of ["openai", "openai_compatible"] as const) {
  test(`${family} saves model names without discovery and keeps mixed edits on Test & Save`, async ({ page }) => {
    const connectionId = `metadata-${family}`;
    const model = fixtureModel({ connectionId, displayName: "Original model", enabled: family !== "openai", id: "metadata-model" });
    model.draftConfig = { ...model.draftConfig,
      adapterKind: family === "openai" ? "openai_responses_native" : "openai_responses_compatible" };
    model.activeConfig = model.draftConfig;
    let connection = fixtureConnection({
      activeChecks: [fixtureCheck({ credentialId: "metadata-key", providerModelId: model.id })],
      credentials: family === "openai" ? [] : [fixtureCredential({ id: "metadata-key", label: "Primary" })],
      defaultCredentialId: family === "openai" ? null : "metadata-key",
      displayName: "Metadata provider", family, id: connectionId, models: [model]
    });
    const requests: Record<string, unknown>[] = [];
    await page.route("**/api/admin/providers**", async (route) => {
      if (route.request().method() === "GET") { await route.fulfill({ json: { connections: [connection] } }); return; }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const current = connection.models[0]!;
      if (body.action === "rename") {
        expect(body).toEqual({ action: "rename", displayName: "Renamed model", expectedActiveVersion: current.activeVersion,
          expectedDisplayName: current.displayName, expectedDraftVersion: current.draftVersion, expectedUpdatedAt: current.updatedAt });
        connection = { ...connection, models: [{ ...current, displayName: String(body.displayName), updatedAt: "2026-09-10T12:00:00.000Z" }] };
      } else if (body.action === "update") {
        expect(body.activate).toBe(true);
        expect(body.expectedDisplayName).toBe(current.displayName);
        expect(body.expectedUpdatedAt).toBe(current.updatedAt);
        const configuration = body.configuration as AdminProviderModelConfiguration;
        connection = { ...connection, models: [{ ...current, displayName: String(body.displayName),
          activeConfig: configuration, draftConfig: configuration, activeVersion: current.activeVersion + 1, draftVersion: current.draftVersion + 1 }] };
      } else {
        await route.fulfill({ status: 400, json: { error: "unexpected_provider_request" } });
        return;
      }
      await route.fulfill({ json: { receipt: { connectionId, modelId: current.id, displayName: String(body.displayName),
        draftVersion: connection.models[0]!.draftVersion, saved: body.action === "rename" ? "name" : "configuration",
        publication: body.action === "rename" ? "not_requested" : "active", checks: body.action === "rename" ? "not_requested" : "checked" } } });
    });

    await signInWithLocalToken(page);
    await page.setViewportSize(family === "openai" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    await page.goto(`/admin?section=providers&resource=${connectionId}`);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, family === "openai" ? "light" : "dark");
    const models = page.getByTestId("provider-models");
    const row = models.getByTestId("provider-model-metadata-model");
    await row.getByRole("button", { name: "More actions for Original model" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Edit model", exact: true });
    await sheet.getByLabel("Display name", { exact: true }).fill("Renamed model");
    const save = sheet.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    expect(requests).toEqual([]);
    const before = structuredClone(connection);
    await save.click();
    await expect(sheet).toHaveCount(0);
    await expect(row).toContainText("Renamed model");
    expect(requests).toHaveLength(1);
    expect(connection).toEqual({ ...before, models: [{ ...before.models[0]!, displayName: "Renamed model", updatedAt: "2026-09-10T12:00:00.000Z" }] });
    await expect(page.getByTestId("provider-model-discard")).toHaveCount(0);

    await row.getByRole("button", { name: "More actions for Renamed model" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await sheet.getByLabel("Display name", { exact: true }).fill("Unsaved name");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = page.getByTestId("provider-model-discard");
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Confirm discard changes" }).click();
    await expect(sheet).toHaveCount(0);
    expect(requests).toHaveLength(1);

    await row.getByRole("button", { name: "More actions for Renamed model" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await sheet.getByLabel("Display name", { exact: true }).fill("Name with settings");
    await sheet.getByLabel("Response timeout (seconds)").fill("120");
    await expect(sheet.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    const testAndSave = sheet.getByRole("button", { name: "Test & Save", exact: true });
    await testAndSave.scrollIntoViewIfNeeded();
    await expect(testAndSave).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await testAndSave.click();
    await expect(sheet).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ action: "update", activate: true, displayName: "Name with settings",
      configuration: { responseTimeoutSeconds: 120 } });
  });
}
