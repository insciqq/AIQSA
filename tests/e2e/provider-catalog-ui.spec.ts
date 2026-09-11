import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureCheckRun, fixtureConnection, fixtureCredential, fixtureModel } from "../../components/admin/providers/providerFixtures";
import type { AdminProviderModelConfiguration } from "../../lib/contracts/adminProviders";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

for (const viewport of [{ width: 1280, height: 560, theme: "dark" }, { width: 390, height: 844, theme: "light" }] as const) {
  test(`catalog selection, failure recovery, skip and restore at ${viewport.width}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: viewport.theme });
    const candidates = ["Selected image model", "Unavailable image model", "Later catalog model"].map((displayName, index) => ({
      displayName, id: `builtin-${index}`, upstreamModelId: `synthetic/model-${index}`, modelClass: "image" as const
    }));
    const connection = fixtureConnection({ id: "synthetic-catalog", displayName: "Synthetic catalog provider", family: "openrouter",
      defaultCredentialId: "key", credentials: [fixtureCredential({ id: "key", label: "Selected default key" })],
      catalogUpdates: { available: [...candidates], skipped: [] } });
    const actions: Record<string, unknown>[] = [];
    let fail = true;
    let polls = 0;
    await page.route("**/api/admin/providers**", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        actions.push(body);
        const selected = body.modelIds as string[];
        expect(body.expectedConnectionVersion).toBe(1);
        if (body.action === "add_catalog_models") {
          if (connection.models.length) {
            expect(body).toMatchObject({ credentialId: "key", modelIds: ["builtin-0"] });
            const model = connection.models[0]!;
            model.activeVersion++;
            model.activeConfig!.capabilities.imageGeneration = true;
            const check = connection.activeChecks[0]!;
            check.modelVersion = model.activeVersion;
            check.evidence!.imageGeneration = check.evidence!.imageEditing;
            check.evidence!.capabilitySetup!.checks.imageGeneration = "verified";
            connection.checkRun = { ...connection.checkRun!, failed: [], results: [{ providerModelId: model.id, state: "saved", checks: check.evidence!.capabilitySetup!.checks }] };
            return route.fulfill({ json: { connections: [connection], unavailableModelIds: [] } });
          }
          expect(body).toMatchObject({ credentialId: "key", expectedCredentialVersionId: "key-version", modelIds: ["builtin-0", "builtin-1"] });
          if (fail) { fail = false; return route.fulfill({ status: 409, json: { error: { code: "provider_draft_stale" } } }); }
          const configuration: AdminProviderModelConfiguration = { adapterKind: "openrouter_images", answerSelectable: false,
            modelClass: "image", upstreamModelId: candidates[0]!.upstreamModelId, defaultParams: {}, image: { profile: "openrouter", parameters: {} },
            capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, imageGeneration: false, imageEditing: true } };
          connection.models.push(fixtureModel({ id: "saved-image", displayName: candidates[0]!.displayName, connectionId: connection.id,
            modelClass: "image", activeConfig: configuration, draftConfig: configuration }));
          const checks = { modelAccess: "verified", imageGeneration: "incomplete", imageEditing: "verified" } as const;
          connection.activeChecks = [fixtureCheck({ credentialId: "key", providerModelId: "saved-image", evidence: {
            detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: configuration.upstreamModelId,
            imageEditing: { adapterKind: "openrouter_images", upstreamModelId: configuration.upstreamModelId, probeVersion: 1, verified: true },
            capabilitySetup: { policyVersion: 2, activation: "initial", checks }
          } })];
          connection.checkRun = fixtureCheckRun({ id: "catalog-check", credentialId: "key", catalogModelIds: ["builtin-0"],
            reason: "requested", total: 1, done: 0, inFlight: ["saved-image"], failed: ["saved-image"],
            results: [{ providerModelId: "saved-image", state: "partial", checks }] });
          connection.catalogUpdates = { ...connection.catalogUpdates!, available: connection.catalogUpdates!.available.filter(({ id }) => id !== "builtin-0") };
          return route.fulfill({ json: { connections: [connection], unavailableModelIds: ["builtin-1"] } });
        }
        const source = body.action === "skip_catalog_models" ? "available" : "skipped";
        const target = source === "available" ? "skipped" : "available";
        connection.catalogUpdates = { ...connection.catalogUpdates!,
          [target]: [...connection.catalogUpdates![target], ...connection.catalogUpdates![source].filter(({ id }) => selected.includes(id))],
          [source]: connection.catalogUpdates![source].filter(({ id }) => !selected.includes(id)) };
      }
      if (route.request().method() === "GET" && connection.checkRun?.state === "running" && ++polls >= 2) {
        connection.checkRun = { ...connection.checkRun, state: "completed", done: 1, inFlight: [], finishedAt: new Date().toISOString() };
      }
      return route.fulfill({ json: { connections: [connection] } });
    });
    await page.route("**/api/admin/attention", (route) => route.fulfill({ json: { attention: {
      checkedAt: new Date().toISOString(), unavailable: [], items: connection.catalogUpdates!.available.length ? [{ action: "View models",
        code: "provider_catalog_models_available", id: `provider_catalog_models_available:${connection.id}`, severity: "neutral",
        count: connection.catalogUpdates!.available.length, title: "New models in the AIQSA catalog",
        detail: `New models for ${connection.displayName}. Check availability with your key.`, target: { section: "providers", resource: connection.id } }] : []
    } } }));
    await signInWithLocalToken(page);
    await page.goto("/admin?section=overview");
    const notice = page.getByTestId("admin-attention-item").filter({ hasText: "New models in the AIQSA catalog" });
    await expect(notice.getByTestId("admin-attention-status")).toHaveAttribute("data-severity", "neutral");
    await notice.getByRole("button").click();
    const card = page.getByTestId("provider-catalog-models");
    await expect(card).toBeVisible();
    for (const box of await card.getByRole("checkbox").all()) await expect(box).toBeChecked();
    await card.getByRole("checkbox", { name: /Later catalog model/ }).uncheck();
    await card.getByRole("button", { name: "Add & check selected" }).click();
    await expect(card.getByRole("alert")).toBeVisible();
    await expect(card.getByRole("checkbox", { name: /Selected image model/ })).toBeChecked();
    await card.getByRole("button", { name: "Add & check selected" }).click();
    await expect(card.getByText(/Not available in this key/)).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Models checked" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry checks" })).toBeVisible();
    const row = page.getByTestId("provider-model-saved-image");
    await expect(row.getByTestId("model-chip-imageEditing")).toHaveAttribute("data-chip-tone", "ok");
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`catalog-partial-${viewport.width}-${viewport.theme}.png`) });
    await page.getByRole("button", { name: "Retry checks" }).click();
    await expect(page.getByRole("button", { name: "Retry checks" })).toHaveCount(0);
    await expect(row.getByTestId("model-chip-imageGeneration")).toHaveAttribute("data-chip-tone", "ok");
    await expect(card.getByRole("checkbox", { name: /Later catalog model/ })).not.toBeChecked();
    await card.getByRole("button", { name: "Skip selected" }).click();
    await expect(card.getByText("Skipped models (1)")).toBeVisible();
    await page.reload();
    await expect(card.getByRole("checkbox", { name: /Later catalog model/ })).toBeChecked();
    await card.getByText("Skipped models (1)").click();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`catalog-${viewport.width}-${viewport.theme}.png`) });
    const restore = card.getByRole("button", { name: "Restore Unavailable image model" });
    await restore.focus();
    await page.keyboard.press("Enter");
    await expect(card.getByRole("checkbox", { name: /Unavailable image model/ })).toBeChecked();
    expect(actions.map(({ action }) => action)).toEqual(["add_catalog_models", "add_catalog_models", "add_catalog_models", "skip_catalog_models", "restore_catalog_models"]);
    expect(connection.models).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    // The deliberately rejected stale mutation is the only browser error.
    expect(browserErrors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
  });
}
