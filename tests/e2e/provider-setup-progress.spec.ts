import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { fixtureCheck, fixtureCheckRun, fixtureConnection, fixtureCredential, fixtureModel, FIXTURE_NOW, workingConnection } from "../../components/admin/providers/providerFixtures";
import type { AdminProviderConnection } from "../../lib/contracts/adminProviders";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS } from "../../lib/contracts/adminProviderQuickSetup";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const modelNames = ["Fixture one", "Fixture two", "Fixture three", "Fixture four"];
const snapshot = {
  providers: ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.map((provider) => ({
    candidateModels: modelNames.map((displayName) => ({ displayName })),
    provider, providerDisplayName: provider === "openai" ? "OpenAI" : provider, stateToken: `state-${provider}`
  }))
};

async function streamFixture() {
  const channels: ServerResponse[] = [];
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("access-control-allow-headers", "content-type,accept");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/x-ndjson", "x-accel-buffering": "no" });
    response.flushHeaders();
    channels.push(response);
    const heartbeat = setInterval(() => response.write('{"type":"heartbeat"}\n'), 10_000);
    response.once("close", () => clearInterval(heartbeat));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    channels,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/setup`,
    send(index: number, value: unknown) { channels[index]!.write(`${JSON.stringify(value)}\n`); },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function openSetup(page: Page, kind: "custom" | "native") {
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add provider" });
  if (kind === "custom") {
    await sheet.getByRole("button", { name: /^Custom/ }).click();
    await sheet.getByLabel("Base URL").fill("https://fixture.invalid/v1");
    await sheet.getByLabel("API style").selectOption("responses");
  }
  await sheet.getByLabel("API key").fill("synthetic-setup-key");
  if (kind === "custom") {
    await sheet.getByRole("button", { name: "Find models" }).click();
    for (const name of modelNames) await sheet.getByTestId("provider-add-models").getByLabel(name).check();
  }
  return sheet;
}

for (const kind of ["custom", "native"] as const) {
  test(`${kind} setup shows incremental four-model checks and recovers from rejection and Stop`, async ({ page }) => {
    test.setTimeout(90_000);
    const fixture = await streamFixture();
    let connections: AdminProviderConnection[] = [];
    await page.route("**/api/admin/providers", (route) => route.fulfill({ json: { connections } }));
    await page.route("**/api/admin/providers/quick-setup", (route) => route.request().method() === "GET"
      ? route.fulfill({ json: snapshot }) : route.continue({ url: fixture.url }));
    await page.route("**/api/admin/providers/custom-setup", (route) => route.continue({ url: fixture.url }));
    await page.route("**/api/admin/providers/custom-setup/discover", (route) => route.fulfill({ json: {
      checkedAt: FIXTURE_NOW, modelCount: 4,
      models: modelNames.map((id) => ({ capabilities: {}, id })), source: "models_catalog", status: "valid"
    } }));
    try {
      await signInWithLocalToken(page);
      await page.goto("/admin?section=providers");
      let sheet = await openSetup(page, kind);
      const save = () => sheet.getByRole("button", { name: /^Test & Save/ });
      await save().click();
      await expect.poll(() => fixture.channels.length).toBe(1);
      const progress = () => sheet.getByTestId("provider-setup-progress");
      await expect(progress().getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
      fixture.send(0, { type: "progress", progress: { phase: "checking", completed: 1, total: 4 } });
      await expect(progress()).toContainText("1 of 4 models checked.");
      await expect(save()).toBeDisabled();
      await expect(sheet.getByLabel("API key")).toBeDisabled();
      fixture.send(0, { type: "result", status: 422, data: { error: kind === "custom" ? "provider_custom_setup_test_failed" : "provider_credential_test_failed" } });
      fixture.channels[0]!.end();
      await expect(sheet.getByRole("alert")).toContainText(kind === "custom" ? "did not complete the exact model test" : "rejected the key");
      await expect(sheet.getByLabel("API key")).toHaveValue("synthetic-setup-key");
      await expect(save()).toBeEnabled();

      await save().click();
      await expect.poll(() => fixture.channels.length).toBe(2);
      fixture.send(1, { type: "progress", progress: { phase: "checking", completed: 2, total: 4 } });
      await expect(progress()).toContainText("2 of 4 models checked.");
      await sheet.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(sheet.getByRole("alert")).toContainText("Setup stopped before its saved state was received.");
      await expect(progress()).toHaveCount(0);
      await expect(save()).toBeDisabled();
      await expect.poll(() => fixture.channels[1]!.destroyed).toBe(true);
      await sheet.getByRole("button", { name: "Close and review providers" }).click();
      await expect(sheet).toHaveCount(0);
      expect(connections).toEqual([]);

      sheet = await openSetup(page, kind);
      await save().click();
      await expect.poll(() => fixture.channels.length).toBe(3);
      for (let completed = 0; completed <= 4; completed += 1) {
        fixture.send(2, { type: "progress", progress: { phase: "checking", completed, total: 4 } });
        await expect(progress().getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(completed));
        await expect(progress().getByRole("progressbar")).toHaveAttribute("aria-valuemax", "4");
        await expect(progress()).toContainText(`${completed} of 4 models checked.`);
        await expect(sheet).toBeVisible();
        expect(connections).toEqual([]);
      }
      // Counts remain tied to server frames even while the elapsed-time label updates.
      await expect(progress()).toContainText(/Elapsed: [1-9]\d*s/, { timeout: 3_000 });
      await expect(progress().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 1280, height: 500 }]) {
          await page.setViewportSize(viewport);
          await progress().scrollIntoViewIfNeeded();
          await expect(progress().getByRole("status")).toHaveAttribute("aria-live", "polite");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          const box = await progress().boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
          await page.screenshot({ path: test.info().outputPath(`setup-${kind}-${colorScheme}-${viewport.width}x${viewport.height}.png`) });
          await sheet.getByRole("button", { name: "Stop", exact: true }).focus();
          await page.keyboard.press("Tab");
          expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
          await page.keyboard.press("Escape");
          await expect(sheet).toBeVisible();
        }
      }
      fixture.send(2, { type: "progress", progress: { phase: "saving", completed: 0, total: null } });
      await expect(progress()).toContainText("Saving the provider");
      await expect(progress().getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
      const models = modelNames.map((displayName, index) => fixtureModel({ connectionId: "saved-provider", displayName, id: `saved-model-${index}` }));
      const connection = fixtureConnection({
        activeChecks: models.map((model) => fixtureCheck({
          credentialId: "saved-key", providerModelId: model.id,
          evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: model.draftConfig.upstreamModelId,
            compatibility: { directPdf: "verified", modelAccess: "verified", probeVersion: 2, structuredOutput: "verified", toolCalling: "verified", streaming: "verified", usage: "verified" } }
        })),
        credentials: [fixtureCredential({ id: "saved-key", label: "Main" })],
        defaultCredentialId: kind === "native" ? "saved-key" : null,
        displayName: "Saved provider", family: kind === "native" ? "openai" : "openai_compatible", id: "saved-provider", models
      });
      connections = [connection];
      const data = kind === "custom" ? {
        authenticationMode: "bearer", checkedAt: FIXTURE_NOW, connectionDisplayName: connection.displayName,
        connectionId: connection.id, defaultChanged: false, modelDisplayName: models[0]!.displayName,
        models: models.map((model) => ({ modelDisplayName: model.displayName, providerModelId: model.id })),
        outcome: "ready", providerModelId: models[0]!.id, search: null
      } : {
        checkedAt: FIXTURE_NOW, connectionId: connection.id, defaultCredentialChanged: true, defaultChanged: false,
        model: { displayName: models[0]!.displayName }, models: modelNames.map((displayName) => ({ displayName })),
        outcome: "ready", provider: "openai", providerDisplayName: "OpenAI", search: null
      };
      fixture.send(2, { type: "result", status: 200, data });
      fixture.channels[2]!.end();
      await expect(sheet).toHaveCount(0);
      await expect(page).toHaveURL(/resource=saved-provider/);
      await expect(page.getByTestId("provider-models")).toContainText("Chat models · 4");
      for (const model of models) await expect(page.getByTestId(`provider-model-${model.id}-works-with`)).toHaveAttribute("data-works-with", "checked");
    } finally {
      await fixture.close();
    }
  });
}

test("a truncated setup stream leaves a review action and cannot be resubmitted accidentally", async ({ page }) => {
  const fixture = await streamFixture();
  await page.route("**/api/admin/providers", (route) => route.fulfill({ json: { connections: [] } }));
  await page.route("**/api/admin/providers/quick-setup", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: snapshot }) : route.continue({ url: fixture.url }));
  try {
    await signInWithLocalToken(page);
    await page.goto("/admin?section=providers");
    const sheet = await openSetup(page, "native");
    await sheet.getByRole("button", { name: "Test & Save", exact: true }).click();
    await expect.poll(() => fixture.channels.length).toBe(1);
    fixture.send(0, { type: "progress", progress: { phase: "checking", completed: 2, total: 4 } });
    await expect(sheet.getByTestId("provider-setup-progress")).toContainText("2 of 4 models checked.");
    fixture.channels[0]!.end();
    await expect(sheet.getByRole("alert")).toContainText("The setup connection was interrupted. Saved results are kept; review them before continuing.");
    await expect(sheet.getByRole("button", { name: "Test & Save", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Close and review providers" })).toBeEnabled();
    expect(fixture.channels).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("running checkpoints and a large completed optional-capability report stay compact and neutral", async ({ page }) => {
  const connection = workingConnection();
  connection.family = "gemini";
  connection.displayName = "Gemini";
  connection.models = Array.from({ length: 11 }, (_, index) => fixtureModel({
    connectionId: connection.id, displayName: `Model ${index + 1}`, id: `model-${index + 1}`
  }));
  connection.checkRun = fixtureCheckRun({ credentialId: "cred-primary", id: "checkpoint-run", done: 0, total: 11,
    inFlight: [connection.models[0]!.id], results: [{ providerModelId: connection.models[0]!.id, state: "partial",
      checks: { modelAccess: "verified", vision: "not_checked" } }],
    capabilityProgress: { capability: "vision", completed: 2, total: 7, providerModelId: connection.models[0]!.id }
  });
  await page.route("**/api/admin/providers**", (route) => route.fulfill({ json: { connections: [connection] } }));
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  const banner = page.getByTestId("provider-check-banner");
  await expect(banner).toContainText("0 of 11 done");
  await expect(banner).toContainText("Image input · 2 of 7 checks finished");
  await expect(banner.locator(".text-critical")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Model setup summary" })).toHaveCount(0);
  await expect(page.getByText(/some capabilities need attention/)).toHaveCount(0);

  connection.family = "openrouter";
  connection.displayName = "OpenRouter";
  connection.checkRun = { ...connection.checkRun, state: "completed", done: 11, inFlight: [], failed: ["model-10", "model-11"],
    results: connection.models.map((model, index) => ({ providerModelId: model.id, state: index < 9 ? "saved" : "partial",
      checks: { modelAccess: "verified", toolCalling: "verified", forcedToolCall: "unsupported", directPdf: "incomplete" } })) };
  await page.reload();
  const summary = page.getByRole("group", { name: "Model setup summary" });
  await expect(summary).toContainText("11 of 11 model results saved.");
  await expect(summary.locator("p")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Model setup results" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await summary.scrollIntoViewIfNeeded();
      await expect(summary).toBeInViewport();
      expect((await summary.boundingBox())!.height).toBeLessThan(120);
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("failed persistence keeps saved models and retries unfinished work on the existing provider", async ({ page }) => {
  const fixture = await streamFixture();
  const connection = workingConnection();
  const savedModel = connection.models[0]!;
  const partialModel = connection.models[1]!;
  const credentialId = connection.defaultCredentialId!;
  let persisted = false;
  let run = fixtureCheckRun({
    credentialId, done: 2, failed: [partialModel.id], finishedAt: FIXTURE_NOW, id: "partial-run", reason: "setup",
    state: "completed", total: 2,
    results: [
      { providerModelId: savedModel.id, state: "saved", checks: { structuredOutput: "verified", forcedToolCall: "verified" } },
      { providerModelId: partialModel.id, state: "save_failed", checks: { structuredOutput: "verified", forcedToolCall: "verified" } }
    ]
  });
  const catalog = () => ({ connections: persisted ? [{ ...connection, checkRun: run }] : [] });
  const actions: unknown[] = [];
  await page.route("**/api/admin/providers", (route) => route.fulfill({ json: catalog() }));
  await page.route("**/api/admin/providers/quick-setup", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: snapshot }) : route.continue({ url: fixture.url }));
  await page.route(`**/api/admin/providers/${connection.id}/actions**`, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { run } });
    actions.push(route.request().postDataJSON());
    run = {
      ...run, current: partialModel.id, done: 1, failed: [], finishedAt: null, id: "retry-run",
      inFlight: [partialModel.id], reason: "requested", state: "running",
      capabilityProgress: { capability: "forcedToolCall", completed: 1, total: 2, providerModelId: partialModel.id }
    };
    return route.fulfill({ json: catalog() });
  });
  try {
    await signInWithLocalToken(page);
    await page.goto("/admin?section=providers");
    const sheet = await openSetup(page, "native");
    await sheet.getByRole("button", { name: "Test & Save", exact: true }).click();
    await expect.poll(() => fixture.channels.length).toBe(1);
    fixture.send(0, { type: "progress", progress: {
      phase: "checking", completed: 1, total: 2, connectionId: connection.id,
      credentialId, runId: run.id, capability: "forcedToolCall"
    } });
    await expect(sheet.getByTestId("provider-setup-progress")).toContainText("Checking Forced tool calls…");
    persisted = true;
    fixture.send(0, { type: "result", status: 200, data: {
      checkedAt: FIXTURE_NOW, checkRun: run, connectionId: connection.id,
      defaultCredentialChanged: true, defaultChanged: false,
      model: { displayName: savedModel.displayName }, models: connection.models.map(({ displayName }) => ({ displayName })),
      outcome: "partial", provider: "openai", providerDisplayName: "OpenAI", search: null
    } });
    fixture.channels[0]!.end();

    const results = sheet.getByRole("group", { name: "Model setup summary" });
    await expect(sheet.getByRole("heading", { name: "Some setup steps need attention" })).toBeVisible();
    await expect(results).toContainText("1 of 2 model results saved.");
    await expect(results).toContainText(`Could not save checked settings for ${partialModel.displayName}.`);
    await expect(sheet.getByRole("list", { name: "Model setup results" })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Test & Save", exact: true })).toHaveCount(0);

    const retry = sheet.getByRole("button", { name: "Retry unfinished checks" });
    await retry.click();
    await expect(sheet.getByRole("heading", { name: "Checking unfinished work…" })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await expect(sheet.getByTestId("provider-setup-progress")).toContainText("Checking Forced tool calls…");
    await expect(results).toHaveCount(0);
    expect(actions).toEqual([{ action: "check_models", credentialId, retryUnresolved: true }]);

    run = fixtureCheckRun({
      credentialId, done: 2, finishedAt: FIXTURE_NOW, id: "retry-run", reason: "requested", state: "completed", total: 2,
      results: connection.models.map((model) => ({
        providerModelId: model.id, state: "saved", checks: { structuredOutput: "verified", forcedToolCall: "verified" }
      }))
    });
    await expect(sheet.getByRole("heading", { name: "Setup finished" })).toBeVisible();
    await expect(results).toContainText("2 of 2 model results saved.");
    await expect(results).not.toContainText("Could not save");
    await expect(retry).toHaveCount(0);
    await sheet.getByRole("button", { name: "View provider" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`resource=${connection.id}`));
    await expect(page.getByTestId("provider-models")).toContainText("Chat models · 2");
    expect(fixture.channels).toHaveLength(1);
    expect(actions).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
