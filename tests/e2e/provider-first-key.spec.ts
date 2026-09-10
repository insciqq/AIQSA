import { expect, test } from "@playwright/test";
import { fixtureCheckRun, fixtureConnection, fixtureCredential, fixtureModel } from "../../components/admin/providers/providerFixtures";
import { adminRerankerModelConfiguration, automaticRerankerRoutePresets } from "../../lib/domain/rerankerModels";
import { signInWithLocalToken } from "./support/localAuth";

test("key-first setup reveals existing presets only after the saved key is available", async ({ page }) => {
  const presets = automaticRerankerRoutePresets.map((preset) => fixtureModel({ connectionId: "first-key-provider",
    id: `preset-${preset.id}`, displayName: preset.displayName, modelClass: "reranker",
    draftConfig: adminRerankerModelConfiguration(preset), activeConfig: null, activeVersion: 0, activatedAt: null
  }));
  let connection = fixtureConnection({ family: "openrouter", id: "first-key-provider", displayName: "First key provider", models: presets });
  let attempts = 0;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { connections: [connection] } });
    } else if (new URL(route.request().url()).pathname.endsWith("/credentials")) {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 422, json: { error: "provider_credential_test_failed" } });
      } else {
        await saveGate;
        connection = { ...connection, credentials: [fixtureCredential({ id: "first-key", label: "Main" })],
          checkRun: fixtureCheckRun({ id: "first-key-checks", credentialId: "first-key", total: presets.length,
            inFlight: presets.map(({ id }) => id) }) };
        await route.fulfill({ status: 201, json: { connections: [connection] } });
      }
    } else if (route.request().postDataJSON().action === "discover_models") {
      await route.fulfill({ json: { models: [] } });
    } else {
      await route.fulfill({ status: 400, json: { error: "unexpected_mutation" } });
    }
  });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const provider = page.getByTestId(`provider-row-${connection.id}`);
  await expect(provider).toContainText("No models");
  for (const preset of presets) await expect(provider).not.toContainText(preset.displayName);
  await provider.click();
  const models = page.getByTestId("provider-models");
  const expectPresetsHidden = async () => {
    await expect(models.getByRole("table", { name: "Models" })).toHaveCount(0);
    await expect(page.getByTestId("provider-page-status")).toContainText("No models on");
    for (const preset of presets) await expect(models.getByText(preset.displayName, { exact: true })).toHaveCount(0);
  };
  await expectPresetsHidden();
  const addKey = page.getByRole("button", { name: "Add key", exact: true });
  const addModel = page.getByTestId("provider-add-model");
  await expect(addKey).toHaveAttribute("data-tone", "primary");
  await expect(addModel).toBeDisabled();
  await expect(addModel).toHaveAccessibleDescription("Add a working key first, then add models.");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 600 }]) {
      await page.setViewportSize(viewport);
      await addModel.scrollIntoViewIfNeeded();
      await expect(page.getByText("Add a working key first, then add models.")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`first-key-${theme}-${viewport.width}.png`) });
    }
  }
  await addKey.focus();
  await page.keyboard.press("Enter");
  const form = page.getByTestId("provider-key-form");
  const secret = form.getByLabel("API key", { exact: true });
  await expect(secret).toBeFocused();
  await secret.fill("synthetic-invalid-value");
  await expectPresetsHidden();
  await form.getByRole("button", { name: "Test & Save" }).click();
  await expect(form.getByRole("alert")).toContainText("rejected this key");
  await expect(addModel).toBeDisabled();
  await expectPresetsHidden();
  await secret.fill("synthetic-saved-value");
  await form.getByRole("button", { name: "Test & Save" }).click();
  await expect(form.getByRole("button", { name: "Test & Save" })).toHaveAttribute("aria-busy", "true");
  await expect(addModel).toBeDisabled();
  await expectPresetsHidden();
  releaseSave();
  await expect(form).toHaveCount(0);
  await expect(addModel).toBeEnabled();
  await expect(addKey).toHaveAttribute("data-tone", "ghost");
  await expect(page.getByText("Add a working key first, then add models.")).toHaveCount(0);
  await expect(page.getByTestId("provider-page-status")).toContainText("3 models on");
  await expect(page.getByTestId("provider-check-banner")).toBeVisible();
  for (const preset of presets) await expect(models.getByTestId(`provider-model-${preset.id}`)).toHaveCount(1);
  connection = { ...connection, checkRun: { ...connection.checkRun!, state: "completed", done: presets.length, inFlight: [],
    failed: [presets[0]!.id], results: [{ providerModelId: presets[0]!.id, state: "partial", checks: { modelAccess: "verified", reranking: "incomplete" } }] } };
  await expect(page.getByTestId("provider-check-banner")).toHaveCount(0);
  for (const preset of presets) await expect(models.getByTestId(`provider-model-${preset.id}`)).toBeVisible();
  await addModel.click();
  await expect(page.getByRole("menuitem", { name: "Embedding preset" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reranker preset" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Chat model" }).click();
  await expect(page.getByRole("dialog", { name: "Add model" })).toBeVisible();
  expect(connection.defaultCredentialId).toBeNull();
});

test("explicitly keyless compatible providers keep model setup available", async ({ page }) => {
  const connection = fixtureConnection({ family: "openai_compatible", id: "keyless-provider", displayName: "Keyless provider" });
  connection.models = [fixtureModel({ connectionId: connection.id, id: "keyless-model", displayName: "Keyless model",
    activeConfig: null, activeVersion: 0, activatedAt: null })];
  connection.draftConfig = { ...connection.draftConfig, authenticationMode: "none" };
  connection.activeConfig = connection.draftConfig;
  await page.route("**/api/admin/providers**", (route) => route.fulfill({ json: { connections: [connection] } }));
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  await expect(page.getByTestId("provider-add-model")).toBeEnabled();
  await expect(page.getByTestId("provider-model-keyless-model")).toBeVisible();
  await expect(page.getByTestId("provider-page-status")).toContainText("1 model on");
  await expect(page.getByRole("button", { name: "Add key" })).toHaveAttribute("data-tone", "ghost");
  await expect(page.getByText("Add a working key first, then add models.")).toHaveCount(0);
});

test("configured models remain administrable after the last key is disabled, revoked or removed", async ({ page }) => {
  const model = fixtureModel({ connectionId: "configured-provider", id: "configured-model", displayName: "Configured model" });
  const credential = fixtureCredential({ id: "prior-key", label: "Main" });
  let connection = fixtureConnection({ family: "openrouter", id: "configured-provider", displayName: "Configured provider",
    models: [model], credentials: [credential] });
  await page.route("**/api/admin/providers**", (route) => route.fulfill({ json: { connections: [connection] } }));
  await signInWithLocalToken(page);
  for (const state of ["disabled", "revoked", "removed"]) {
    connection = { ...connection, credentials: state === "removed" ? [] : [{ ...credential, enabled: state !== "disabled",
      activeVersion: { ...credential.activeVersion!, revokedAt: state === "revoked" ? credential.updatedAt : null } }] };
    await page.goto(`/admin?section=providers&resource=${connection.id}`);
    const row = page.getByTestId(`provider-model-${model.id}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId("provider-page-status")).toContainText("1 model on");
    await row.getByRole("button", { name: `More actions for ${model.displayName}` }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Edit model" });
    await expect(sheet.getByLabel("Display name")).toHaveValue(model.displayName);
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});
