import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureConnection, fixtureModel } from "../../components/admin/providers/providerFixtures";
import { decodeAdminModelPriceChange, EMPTY_ADMIN_MODEL_PRICES, type AdminModelPricing } from "../../lib/contracts/adminProviderModelPrices";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

for (const theme of ["light", "dark"] as const) {
  test(`model prices save, clear and restore without checking the provider in ${theme}`, async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
    const connectionId = "model-price-provider";
    const catalogPrices = { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "0.25",
      cachedInputTokenPriceUsdPerMillion: "0.025", outputTokenPriceUsdPerMillion: "2" };
    const model = fixtureModel({ connectionId, displayName: "Price fixture", enabled: false, id: "price-model",
      pricing: { source: "catalog", prices: catalogPrices, catalogPrices } });
    let connection = fixtureConnection({ displayName: "Price fixture provider", id: connectionId,
      credentials: [], defaultCredentialId: null, models: [model],
      activeChecks: [fixtureCheck({ credentialId: "old-key", providerModelId: model.id })] });
    const beforeConfiguration = { active: model.activeConfig, draft: model.draftConfig, activeVersion: model.activeVersion,
      draftVersion: model.draftVersion, enabled: model.enabled, checks: connection.activeChecks };
    const writes: Record<string, unknown>[] = [];
    await page.route("**/api/admin/providers**", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { connections: [connection] } });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const requested = decodeAdminModelPriceChange(body.pricing);
      // The server's own price refusal, which the sheet attaches to the field.
      if (requested?.mode === "manual" && requested.prices.outputTokenPriceUsdPerMillion === "77") {
        return route.fulfill({ status: 400, json: { error: "provider_model_pricing_invalid", field: "outputTokenPriceUsdPerMillion" } });
      }
      writes.push(body);
      expect(body.action).toBe("metadata");
      expect(body).not.toHaveProperty("activate");
      expect(body).not.toHaveProperty("configuration");
      const current = connection.models[0]!;
      expect(body).toMatchObject({ expectedActiveVersion: current.activeVersion, expectedDraftVersion: current.draftVersion,
        expectedDisplayName: current.displayName, expectedUpdatedAt: current.updatedAt });
      const change = decodeAdminModelPriceChange(body.pricing);
      expect(change).not.toBeNull();
      const pricing: AdminModelPricing = { source: change!.mode === "manual" ? "admin" : "catalog",
        prices: change!.mode === "manual" ? change!.prices : catalogPrices, catalogPrices: current.pricing.catalogPrices };
      connection = { ...connection, models: [{ ...current, pricing, displayName: String(body.displayName),
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString() }] };
      await route.fulfill({ json: { receipt: { connectionId, modelId: model.id, displayName: String(body.displayName),
        draftVersion: current.draftVersion, saved: "metadata", publication: "not_requested", checks: "not_requested", pricing } } });
    });
    await signInWithLocalToken(page);
    await page.goto(`/admin?section=providers&resource=${connectionId}`);
    const row = page.getByTestId("provider-model-price-model");
    const sheet = page.getByRole("dialog", { name: "Edit model", exact: true });
    const open = async () => {
      await row.getByRole("button", { name: "More actions for Price fixture" }).click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await expect(sheet).toBeVisible();
    };
    await open();
    await expect(sheet.getByLabel("Input", { exact: true })).toHaveValue("0.25");
    await expect(sheet.getByLabel("Cached input", { exact: true })).toHaveValue("0.025");
    await expect(sheet.getByLabel("Cache write", { exact: true })).toHaveValue("");
    await expect(sheet.getByText("Catalog price", { exact: true })).toBeVisible();
    // The stored value typed again is no change: the source stays and closing needs no discard.
    await sheet.getByLabel("Input", { exact: true }).fill("0.250");
    await expect(sheet.getByText("Catalog price", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Use catalog price" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("provider-model-discard")).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    expect(writes).toHaveLength(0);
    await open();
    await sheet.getByLabel("Input", { exact: true }).fill("0.25000000");
    await sheet.getByLabel("Cache write", { exact: true }).fill("0.3125");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(row.getByRole("button", { name: "More actions for Price fixture" })).toBeFocused();
    expect(writes).toHaveLength(1);
    expect(connection.models[0]!.pricing.prices).toEqual({ ...catalogPrices, cacheWriteInputTokenPriceUsdPerMillion: "0.3125" });
    await open();
    await expect(sheet.getByText("Edited by an administrator", { exact: true })).toBeVisible();
    await expect(sheet.getByLabel("Input", { exact: true })).toHaveValue("0.25");
    for (const value of ["-1", "bad", "1e3", "0.000000001", "10000000000"]) {
      const input = sheet.getByLabel("Input", { exact: true });
      await input.fill(value);
      await sheet.getByRole("button", { name: "Save", exact: true }).click();
      await expect(sheet).toBeVisible();
      await expect(input).toHaveValue(value);
      await expect(input).toHaveAccessibleName("Input");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleDescription(/non-negative decimal/);
    }
    expect(writes).toHaveLength(1);
    await sheet.getByLabel("Input", { exact: true }).fill("0.25");
    const output = sheet.getByLabel("Output", { exact: true });
    await output.fill("77");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(output).toHaveAttribute("aria-invalid", "true");
    await expect(sheet).toBeVisible();
    await expect(output).toHaveValue("77");
    await expect(output).toHaveAccessibleDescription(/non-negative decimal/);
    await expect(output).toBeFocused();
    expect(writes).toHaveLength(1);
    await output.fill("2");
    for (const size of [{ width: 1440, height: 900 }, { width: 900, height: 1440 },
      { width: 820, height: 1180 }, { width: 1180, height: 820 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      const fields = sheet.getByRole("group", { name: "Prices", exact: true });
      await fields.scrollIntoViewIfNeeded();
      for (const label of ["Input", "Cached input", "Cache write", "Output"]) {
        await sheet.getByLabel(label, { exact: true }).scrollIntoViewIfNeeded();
        await expectWithinViewport(page, sheet.getByLabel(label, { exact: true }));
      }
      await expectNoHorizontalOverflow(page);
      await sheet.getByLabel("Input", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`model-prices-${theme}-${size.width}x${size.height}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await sheet.getByLabel("Input", { exact: true }).focus();
    for (const label of ["Cached input", "Cache write", "Output"]) {
      await page.keyboard.press("Tab"); await expect(sheet.getByLabel(label, { exact: true })).toBeFocused();
    }
    await page.keyboard.press("Tab"); await expect(sheet.getByRole("button", { name: "Use catalog price" })).toBeFocused();
    await sheet.getByLabel("Input", { exact: true }).fill("");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(connection.models[0]!.pricing.prices.inputTokenPriceUsdPerMillion).toBeNull();
    await open();
    await expect(sheet.getByLabel("Input", { exact: true })).toHaveValue("");
    await sheet.getByRole("button", { name: "Use catalog price" }).click();
    await expect(sheet.getByLabel("Cache write", { exact: true })).toHaveValue("");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(connection.models[0]!.pricing).toEqual({ source: "catalog", prices: catalogPrices, catalogPrices });
    expect({ active: connection.models[0]!.activeConfig, draft: connection.models[0]!.draftConfig,
      activeVersion: connection.models[0]!.activeVersion, draftVersion: connection.models[0]!.draftVersion,
      enabled: connection.models[0]!.enabled, checks: connection.activeChecks }).toEqual(beforeConfiguration);
    await open();
    await sheet.getByLabel("Output", { exact: true }).fill("9");
    await page.keyboard.press("Escape");
    const discard = page.getByTestId("provider-model-discard");
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Confirm discard changes" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(row.getByRole("button", { name: "More actions for Price fixture" })).toBeFocused();
    expect(writes).toHaveLength(3);
    connection = { ...connection, models: [{ ...connection.models[0]!, pricing: {
      ...connection.models[0]!.pricing, source: "admin", catalogPrices: null
    } }] };
    await page.reload();
    await open();
    await expect(sheet.getByRole("button", { name: "Use catalog price" })).toHaveCount(0);
  });
}

test("an embedding model shows, saves and restores only its input price", async ({ page }, testInfo) => {
  const connectionId = "embedding-price-provider";
  const catalogPrices = { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "0.13" };
  const answer = fixtureModel({ connectionId, displayName: "Embedding fixture", enabled: false, id: "embedding-price-model",
    pricing: { source: "catalog", prices: catalogPrices, catalogPrices } });
  const model = { ...answer, modelClass: "embedding" as const, activeConfig: { ...answer.activeConfig!, modelClass: "embedding" as const },
    draftConfig: { ...answer.draftConfig, modelClass: "embedding" as const } };
  let connection = fixtureConnection({ displayName: "Embedding price provider", id: connectionId, models: [model] });
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/admin/providers**", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connections: [connection] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(body);
    const change = decodeAdminModelPriceChange(body.pricing);
    expect(body.action).toBe("metadata");
    expect(change).not.toBeNull();
    const current = connection.models[0]!;
    const pricing: AdminModelPricing = { source: change!.mode === "manual" ? "admin" : "catalog",
      prices: change!.mode === "manual" ? change!.prices : catalogPrices, catalogPrices };
    connection = { ...connection, models: [{ ...current, pricing, updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString() }] };
    await route.fulfill({ json: { receipt: { connectionId, modelId: model.id, displayName: current.displayName,
      draftVersion: current.draftVersion, saved: "metadata", publication: "not_requested", checks: "not_requested", pricing } } });
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connectionId}`);
  const sheet = page.getByRole("dialog", { name: "Edit model", exact: true });
  const open = async () => {
    await page.getByTestId(`provider-model-${model.id}`).getByRole("button", { name: "More actions for Embedding fixture" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(sheet).toBeVisible();
  };
  await open();
  const input = sheet.getByLabel("Input", { exact: true });
  await expect(input).toHaveValue("0.13");
  for (const label of ["Cached input", "Cache write", "Output"]) await expect(sheet.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(sheet.getByText("Catalog price", { exact: true })).toBeVisible();
  await expect(input).toHaveAccessibleDescription(/^Used only when the provider reports no cost/);
  await input.fill("0.2");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(decodeAdminModelPriceChange(writes[0]!.pricing)).toEqual({ mode: "manual",
    prices: { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "0.2" } });
  await open();
  await expect(sheet.getByText("Edited by an administrator", { exact: true })).toBeVisible();
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await input.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, input);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`embedding-model-prices-${size.width}x${size.height}.png`) });
  }
  await sheet.getByRole("button", { name: "Use catalog price" }).click();
  await expect(input).toHaveValue("0.13");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(decodeAdminModelPriceChange(writes[1]!.pricing)).toEqual({ mode: "restore_catalog" });
  expect(connection.models[0]!.pricing).toEqual({ source: "catalog", prices: catalogPrices, catalogPrices });
});
