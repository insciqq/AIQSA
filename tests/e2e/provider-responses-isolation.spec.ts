import { expect, test } from "@playwright/test";
import type { AdminProviderConnection, AdminProviderConnectionConfiguration } from "../../lib/contracts/adminProviders";
import { fixtureCheck, fixtureConnection, fixtureCredential, fixtureModel } from "../../components/admin/providers/providerFixtures";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const checkedAt = "2026-09-09T12:00:00.000Z";
const apiRoot = "https://responses-fixture.example.test/v1";
const replacementRoot = "https://replacement-fixture.example.test/v1";
const upstreamModelId = "fixture/response-model";
type IsolationMode = "auto" | "on" | "off";

function quickSetupSnapshot() {
  return { providers: ["openai", "anthropic", "gemini", "deepseek", "openrouter"].map((provider) => ({
    candidateModels: [{ displayName: `Synthetic ${provider} model` }], provider,
    providerDisplayName: provider, stateToken: `synthetic-state-${provider}`
  })) };
}

function customConnection(id: string, displayName: string, configuration: AdminProviderConnectionConfiguration): AdminProviderConnection {
  const credentialId = `${id}-credential`;
  const model = fixtureModel({ connectionId: id, displayName: "Synthetic Responses model", id: `${id}-model` });
  const modelConfiguration = { ...model.draftConfig, adapterKind: "openai_responses_compatible" as const, upstreamModelId };
  return fixtureConnection({
    activeChecks: [fixtureCheck({ credentialId, providerModelId: model.id })],
    activeConfig: configuration, credentials: [fixtureCredential({ id: credentialId, label: "Synthetic key" })],
    defaultCredentialId: credentialId, displayName, draftConfig: configuration, family: "openai_compatible", id,
    models: [{ ...model, activeConfig: modelConfiguration, draftConfig: modelConfiguration }]
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Responses isolation defaults, detection and saved overrides remain clear on desktop and mobile (${theme})`, async ({ page, context }) => {
    test.setTimeout(60_000);
    const connections: AdminProviderConnection[] = [];
    const setups: Record<string, unknown>[] = [];
    const saves: Record<string, unknown>[] = [];
    const discoveries: Record<string, unknown>[] = [];
    await page.route("**/api/admin/providers**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (method === "GET" && path === "/api/admin/providers") {
        await route.fulfill({ json: { connections } });
        return;
      }
      if (method === "GET" && path === "/api/admin/providers/quick-setup") {
        await route.fulfill({ json: quickSetupSnapshot() });
        return;
      }
      if (method === "POST" && path === "/api/admin/providers/custom-setup/discover") {
        const body = request.postDataJSON() as Record<string, unknown>;
        discoveries.push(body);
        await route.fulfill({ json: {
          catalogProof: "synthetic-catalog-proof", responsesRequestIsolationDetected: body.apiRoot === apiRoot,
          checkedAt, modelCount: 1, models: [{ capabilities: {}, id: upstreamModelId,
            ownedBy: body.apiRoot === apiRoot ? "codex-lb" : "synthetic-other" }],
          source: "models_catalog", status: "valid"
        } });
        return;
      }
      if (method === "POST" && path === "/api/admin/providers/custom-setup") {
        const body = request.postDataJSON() as Record<string, unknown>;
        setups.push(body);
        const connection = customConnection(`responses-isolation-${theme}-${setups.length}`, String(body.connectionDisplayName), {
          allowPrivateNetwork: false, apiRoot: String(body.apiRoot), authenticationMode: "bearer", responseTimeoutSeconds: 300,
          responsesRequestIsolation: body.responsesRequestIsolation as IsolationMode,
          responsesRequestIsolationDetected: body.apiRoot === apiRoot
        });
        connections.push(connection);
        await route.fulfill({ json: {
          authenticationMode: "bearer", checkedAt, connectionDisplayName: connection.displayName, connectionId: connection.id,
          defaultChanged: false, modelDisplayName: connection.models[0]!.displayName,
          models: [{ modelDisplayName: connection.models[0]!.displayName, providerModelId: connection.models[0]!.id }],
          outcome: "ready", providerModelId: connection.models[0]!.id, search: null
        } });
        return;
      }
      const index = connections.findIndex((connection) => path === `/api/admin/providers/${connection.id}`);
      if (method === "PATCH" && index >= 0) {
        const body = request.postDataJSON() as Record<string, unknown>;
        saves.push(body);
        const current = connections[index]!;
        const configuration = body.configuration as AdminProviderConnectionConfiguration;
        const accepted = { ...configuration, responsesRequestIsolationDetected: configuration.apiRoot === apiRoot };
        connections[index] = {
          ...current, activeConfig: accepted, activeVersion: current.activeVersion + 1,
          activeChecks: current.activeChecks.map((check) => ({ ...check, connectionVersion: current.activeVersion + 1 })),
          displayName: String(body.displayName), draftConfig: accepted, draftVersion: current.draftVersion + 1
        };
        await route.fulfill({ json: { connections } });
        return;
      }
      // Every provider request stays inside this synthetic browser fixture.
      await route.fulfill({ status: 400, json: { error: "unexpected_responses_isolation_fixture_request" } });
    });
    await authenticateWithLocalToken(page.request);
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.addInitScript((value) => { localStorage.setItem("aiqsa.theme", value); }, theme);
    await page.emulateMedia({ colorScheme: theme });

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/admin?section=providers");
      await page.getByRole("button", { name: "Add provider", exact: true }).click();
      const add = page.getByRole("dialog", { name: "Add provider" });
      await add.getByRole("button", { name: /^Custom/ }).click();
      await add.getByLabel("Base URL").fill(apiRoot);
      await add.getByLabel("API key", { exact: true }).fill("synthetic-responses-write-only-key");
      await add.getByLabel("Name", { exact: true }).fill(`Synthetic Responses ${theme} ${viewport.width}`);
      await add.getByLabel("API style").selectOption("responses");
      await add.getByText("Advanced · timeout, private network, reasoning mapping", { exact: true }).click();
      const isolation = add.getByRole("combobox", { name: "Responses request isolation", exact: true });
      await expect(isolation).toHaveValue("auto");
      await expect(isolation.locator("option")).toHaveText(["Automatic (Codex LB detection)", "Always on", "Always off"]);
      await expect(add.getByText(/fresh prompt_cache_key/)).toContainText(/prefix-cache reuse.*connection overhead/);
      await isolation.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, isolation);
      await expectNoHorizontalOverflow(page);

      await add.getByRole("button", { name: "Find models", exact: true }).click();
      const detection = add.getByRole("status").filter({ hasText: /Codex LB/ });
      await expect(detection).toContainText(/detected/i);
      await expect(detection).toContainText(/(?:enabled|\bon\b)/i);
      await expect(add.getByTestId("provider-add-models").getByRole("checkbox")).toBeChecked();
      await isolation.selectOption("off");
      await expect(isolation).toHaveValue("off");
      await expect(detection).toContainText(/(?:disabled|\boff\b)/i);
      await expect(detection).not.toContainText(/enabled automatically/i);
      await isolation.selectOption("on");
      await expect(detection).toContainText(/(?:enabled|\bon\b)/i);

      await add.getByLabel("Base URL").fill(replacementRoot);
      await expect(add.getByTestId("provider-add-models")).toHaveCount(0);
      await expect(detection).toHaveCount(0);
      await expect(isolation).toHaveValue("on");
      await expect(add.getByRole("button", { name: "Test & Save", exact: true })).toBeDisabled();
      await add.getByLabel("Base URL").fill(apiRoot);
      await add.getByRole("button", { name: "Look again", exact: true }).click();
      await expect(detection).toContainText(/detected/i);
      await isolation.selectOption("auto");
      await expect(detection).toContainText(/(?:enabled|\bon\b)/i);
      await add.getByRole("button", { name: "Test & Save 1 model", exact: true }).click();
      await expect(add).toHaveCount(0);
      expect(setups.at(-1)).toMatchObject({ catalogProof: "synthetic-catalog-proof", modelIds: [upstreamModelId],
        protocol: "responses", responsesRequestIsolation: "auto" });
      expect(setups.at(-1)).not.toHaveProperty("responsesRequestIsolationDetected");

      const provider = page.getByTestId("provider-page");
      await provider.getByRole("button", { name: "Connection settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Connection settings" });
      const savedIsolation = settings.getByRole("combobox", { name: /^Compatible Responses request isolation/ });
      await expect(savedIsolation).toHaveValue("auto");
      await expect(settings.getByText(/Codex LB (?:was )?detected/i)).toBeVisible();
      const savedStatus = settings.getByRole("status");
      await expect(savedStatus).toContainText("Responses isolation is enabled.");
      for (const mode of ["off", "on", "auto"] as const) {
        await savedIsolation.selectOption(mode);
        await expect(savedStatus).toContainText(`Responses isolation is ${mode === "off" ? "disabled" : "enabled"}.`);
        await savedIsolation.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, savedIsolation);
        await expectNoHorizontalOverflow(page);
        await settings.getByRole("button", { name: "Test & Save", exact: true }).click();
        await expect(settings).toHaveCount(0);
        expect(saves.at(-1)).toMatchObject({ activate: true, configuration: { responsesRequestIsolation: mode } });
        expect(saves.at(-1)!.configuration).not.toHaveProperty("responsesRequestIsolationDetected");
        await provider.getByRole("button", { name: "Connection settings", exact: true }).click();
        await expect(savedIsolation).toHaveValue(mode);
        await expect(settings.getByText(/Codex LB (?:was )?detected/i)).toBeVisible();
        await expect(savedStatus).toContainText(`Responses isolation is ${mode === "off" ? "disabled" : "enabled"}.`);
      }
      await settings.getByLabel(/^Endpoint/).fill(replacementRoot);
      await expect(settings.getByText(/Codex LB (?:was )?detected/i)).toHaveCount(0);
      await expect(savedStatus).toContainText("Automatic isolation will follow that result.");
      await settings.getByLabel(/^API key for Synthetic key/).fill("synthetic-new-endpoint-key");
      await settings.getByRole("button", { name: "Test & Save", exact: true }).click();
      await expect(settings).toHaveCount(0);
      await provider.getByRole("button", { name: "Connection settings", exact: true }).click();
      await expect(savedIsolation).toHaveValue("auto");
      await expect(settings.getByLabel(/^Endpoint/)).toHaveValue(replacementRoot);
      await expect(settings.getByText(/Codex LB (?:was )?detected/i)).toHaveCount(0);
      await expect(savedStatus).toContainText("Responses isolation is disabled.");
      await settings.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(settings).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    }
    expect(setups).toHaveLength(2);
    expect(discoveries).toHaveLength(4);
    expect(saves).toHaveLength(8);
    expect(discoveries.every((request) => request.apiRoot === apiRoot)).toBe(true);
  });
}
