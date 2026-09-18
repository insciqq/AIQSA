import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureConnection, fixtureCredential, fixtureModel } from "../../components/admin/providers/providerFixtures";
import type { AdminProviderModelConfiguration } from "../../lib/contracts/adminProviders";
import { signInWithLocalToken } from "./support/localAuth";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";

for (const kind of ["answer", "image"] as const) test(`${kind} native, automatic and custom routes survive save and refresh across orientations`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const id = `native-routing-provider-${kind}`;
  const modelName = kind === "image" ? "Native image model" : "Claude Sonnet 5";
  const nativeTag = kind === "image" ? "google-ai-studio" : "anthropic";
  const customTag = kind === "image" ? "third-party" : "amazon-bedrock";
  const customName = kind === "image" ? "Other image provider" : "Amazon Bedrock";
  const configuration: AdminProviderModelConfiguration = { adapterKind: kind === "image" ? "openrouter_images" : "openrouter_chat_completions", answerSelectable: kind === "answer",
    modelClass: kind, upstreamModelId: kind === "image" ? "google/synthetic-image" : "anthropic/claude-sonnet-5", defaultParams: {},
    ...(kind === "image" ? { image: { profile: "openrouter" as const } } : {}),
    capabilities: { pdf: false, nativePdfInput: false, nativeSearch: false, reasoning: false, vision: false, toolCalling: kind === "answer", ...(kind === "image" ? { imageGeneration: true, imageEditing: true } : {}) },
    openRouterRouting: { mode: "automatic", providers: [] } };
  let connection = fixtureConnection({ id, displayName: "OpenRouter native routing", family: "openrouter", defaultCredentialId: "native-key",
    credentials: [fixtureCredential({ id: "native-key", label: "Primary" })],
    models: [fixtureModel({ id: "native-model", connectionId: id, displayName: modelName, modelClass: kind, activeConfig: configuration, draftConfig: configuration })],
    activeChecks: [fixtureCheck({ credentialId: "native-key", providerModelId: "native-model", evidence: {
      method: "tiny_generation", detail: "ok", selectedProviders: [], upstreamModelId: configuration.upstreamModelId
    } })] });
  const mutations: AdminProviderModelConfiguration[] = [];
  connection.models[0]!.nativeRoutingAdoption = { reason: "native_incompatible", diagnostic: {
    version: 1, stage: "modelAccess", code: "http_error", servingMode: "automatic", provider: nativeTag, httpStatus: 404,
    missing: ["modelAccess"], previouslyUnverified: [kind === "image" ? "imageEditing" : "directPdf"]
  } };
  let nativeAvailable = true;
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connections: [connection] } });
    const body = route.request().postDataJSON();
    if (["discover_endpoints", "discover_image_endpoints"].includes(body.action)) return route.fulfill({ json: { endpoints: [
      ...(nativeAvailable ? [{ tag: nativeTag, name: "Native publisher", providerName: "Native publisher", supportedParameters: ["tools", "response_format"], image: { profile: "openrouter" } }] : []),
      { tag: customTag, name: customName, providerName: customName, supportedParameters: ["tools"], image: { profile: "openrouter" } }
    ] } });
    if (body.action === "discover_image_models") return route.fulfill({ json: { models: [{ id: configuration.upstreamModelId, name: modelName, image: { profile: "openrouter" }, source: "catalog", editing: true }] } });
    if (body.action === "discover_models") return route.fulfill({ json: { models: [] } });
    expect(body.action).toBe("update"); expect(body.activate).toBe(true);
    const current = connection.models[0]!;
    expect(body.expectedDraftVersion).toBe(current.draftVersion);
    mutations.push(body.configuration);
    const next = { ...current, nativeRoutingAdoption: undefined, activeConfig: body.configuration, draftConfig: body.configuration,
      activeVersion: current.activeVersion + 1, draftVersion: current.draftVersion + 1 };
    connection = { ...connection, models: [next] };
    return route.fulfill({ json: { receipt: { connectionId: id, modelId: current.id, displayName: current.displayName,
      draftVersion: next.draftVersion, saved: "configuration", publication: "active", checks: "checked" } } });
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${id}`);
  const row = page.getByTestId("provider-model-native-model");
  const sheet = page.getByRole("dialog", { name: "Edit model", exact: true });
  const open = async () => {
    await row.getByRole("button", { name: `More actions for ${modelName}` }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const find = sheet.getByRole("button", { name: "Find native provider" });
    if (await find.isVisible()) await find.click();
  };
  await open();
  const adoptionSummary = sheet.locator("summary", { hasText: "Automatic routing kept during native setup" });
  const adoptionDetails = adoptionSummary.locator("..");
  await expect(adoptionDetails).not.toHaveAttribute("open");
  await adoptionSummary.focus();
  await adoptionSummary.press("Enter");
  await expect(adoptionDetails).toContainText("HTTP 404");
  await expect(adoptionDetails).toContainText("The saved route and model checks were kept");
  expect(mutations).toHaveLength(0);
  const native = sheet.getByRole("radio", { name: /Native · recommended/ });
  await expect(native).toBeEnabled();
  await sheet.getByText("Native · recommended", { exact: true }).click();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 1440 }, { width: 1024, height: 768 },
      { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const field = sheet.getByRole("group", { name: kind === "image" ? "Image providers" : "Routing", exact: true });
      await field.scrollIntoViewIfNeeded();
      await native.focus();
      await expect(native).toBeChecked();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`native-${theme}-${viewport.width}x${viewport.height}.png`) });
      await adoptionSummary.scrollIntoViewIfNeeded();
      await adoptionSummary.focus();
      await expect(adoptionSummary).toBeInViewport();
      await expectTouchSafe(adoptionSummary);
      const lastExplanation = adoptionDetails.locator("p").last();
      await lastExplanation.scrollIntoViewIfNeeded();
      await expectCenterUnobscured(lastExplanation);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`native-retained-${theme}-${viewport.width}x${viewport.height}.png`) });
      await sheet.getByRole("button", { name: "Test & Save", exact: true }).scrollIntoViewIfNeeded();
      await expect(sheet.getByRole("button", { name: "Test & Save", exact: true })).toBeInViewport();
    }
  }
  await native.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await sheet.getByRole("button", { name: "Test & Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(mutations[0]!.openRouterRouting).toEqual({ mode: "only_selected", providers: [nativeTag] });
  await page.reload(); await open(); await expect(native).toBeChecked();
  await sheet.getByText("Automatic", { exact: true }).click();
  await sheet.getByRole("button", { name: "Test & Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.reload(); await open();
  await expect(sheet.getByRole("radio", { name: /^Automatic/ })).toBeChecked();
  await sheet.getByText("Custom providers", { exact: true }).click();
  if (kind === "image") await sheet.getByRole("checkbox", { name: customName }).check();
  else await sheet.getByRole("button", { name: new RegExp(`^${customName}`) }).click();
  await sheet.getByRole("button", { name: "Test & Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(mutations.map((model) => model.openRouterRouting)).toEqual([
    { mode: "only_selected", providers: [nativeTag] }, { mode: "automatic", providers: [] },
    { mode: "only_selected", providers: [customTag] }
  ]);
  nativeAvailable = false;
  await page.reload(); await open();
  await expect(native).toBeDisabled();
  await expect(sheet).toContainText(kind === "image" ? "No native provider is confirmed" : "No compatible native provider is confirmed");
  await expect(sheet.getByRole("radio", { name: /Custom providers/ })).toBeChecked();
  if (kind === "image") await expect(sheet.getByRole("checkbox", { name: customName })).toBeChecked();
  else await expect(sheet.getByRole("list", { name: "Providers in order" })).toContainText(customName);
  await page.screenshot({ path: testInfo.outputPath("native-unavailable-phone.png") });
  await sheet.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(row.getByRole("button", { name: `More actions for ${modelName}` })).toBeFocused();
});
