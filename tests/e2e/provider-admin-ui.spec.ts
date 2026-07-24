import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection,
  AdminProviderDraftCheck,
  AdminProviderModelConfiguration
} from "../../lib/contracts/adminProviders";
import type { AdminRunProfileCatalog } from "../../lib/contracts/runProfiles";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";

const now = "2026-07-23T00:00:00.000Z";

const discoveredModels: AdminOpenRouterDiscoveredModel[] = [
  ...Array.from({ length: 332 }, (_, offset) => {
    const index = 332 - offset;
    const suffix = String(index).padStart(3, "0");
    return {
      contextLength: 32_000,
      id: `catalog/model-${suffix}`,
      inputModalities: ["text"],
      name: `Catalog Model ${suffix}`,
      outputModalities: ["text"],
      pricing: { prompt: "0.000001" },
      supportedParameters: ["tools"]
    };
  }),
  {
    contextLength: 128_000,
    id: "vendor/e2e-model",
    inputModalities: ["text", "image"],
    name: "E2E Model",
    outputModalities: ["text"],
    pricing: { prompt: "0.000001" },
    supportedParameters: ["tools", "reasoning"]
  }
];

const discoveredEndpoints: AdminOpenRouterDiscoveredEndpoint[] = [
  {
    name: "Zenith endpoint",
    providerName: "Zenith AI",
    supportedParameters: ["tools"],
    tag: "zenith"
  },
  {
    name: "Primary endpoint",
    providerName: "Acme Inference",
    quantization: "fp8",
    supportedParameters: ["tools", "reasoning"],
    tag: "acme-primary"
  },
  {
    name: "Backup endpoint",
    providerName: "Acme Inference",
    quantization: "int8",
    supportedParameters: ["tools"],
    tag: "acme-backup"
  }
];

function connectionDraft(configuration: {
  allowPrivateNetwork: boolean;
  apiRoot: string;
}, displayName: string): AdminProviderConnection {
  return {
    activatedAt: null,
    activeChecks: [],
    activeConfig: null,
    activeVersion: 0,
    assignments: [],
    createdAt: now,
    credentials: [],
    defaultCredentialId: null,
    displayName,
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: false,
    family: "openrouter",
    id: "provider-e2e",
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: now
  };
}

async function signInOrdinaryUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

async function expectFullyHitTestable(surface: Locator): Promise<void> {
  await expect(surface).toBeVisible();
  await expect.poll(() => surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const inset = 2;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const points = [
      [centerX, rect.top + inset],
      [centerX, rect.bottom - inset],
      [rect.left + inset, centerY],
      [rect.right - inset, centerY]
    ];

    return points.every(([x, y]) => {
      const target = document.elementFromPoint(x!, y!);
      return target === element || (target !== null && element.contains(target));
    });
  })).toBe(true);
}

test("administrator completes the OpenRouter key, model, route, check, and activation flow", async ({ page }) => {
  let connections: AdminProviderConnection[] = [];
  const discoveryActions: Array<Record<string, unknown>> = [];
  let activationBody: Record<string, unknown> | null = null;
  let submittedModelBody: Record<string, unknown> | null = null;
  let submittedKey: string | null = null;
  let testedKey: string | null = null;

  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON() as Record<string, unknown>;

    if (method === "GET" && path === "/api/admin/providers") {
      await route.fulfill({ contentType: "application/json", json: { connections } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers") {
      const configuration = body.configuration as { allowPrivateNetwork: boolean; apiRoot: string };
      connections = [connectionDraft(configuration, String(body.displayName))];
      await route.fulfill({ contentType: "application/json", json: { connections }, status: 201 });
      return;
    }
    if (method === "POST" && path.endsWith("/credential-tests")) {
      testedKey = String(body.secret);
      await route.fulfill({
        contentType: "application/json",
        json: {
          test: {
            checkedAt: now,
            connectionDraftVersion: Number(body.expectedConnectionDraftVersion),
            modelCount: discoveredModels.length,
            status: "valid"
          }
        }
      });
      return;
    }
    if (method === "POST" && path.endsWith("/credentials")) {
      submittedKey = String(body.secret);
      const current = connections[0]!;
      connections = [{
        ...current,
        credentials: [{
          activatedAt: null,
          activeVersion: null,
          createdAt: now,
          draftSecretConfigured: true,
          draftVersion: 1,
          enabled: true,
          id: "credential-e2e",
          label: String(body.label),
          testedAt: null,
          updatedAt: now
        }]
      }];
      await route.fulfill({ contentType: "application/json", json: { connections }, status: 201 });
      return;
    }
    if (method === "POST" && path.endsWith("/actions")) {
      const action = String(body.action);
      if (action === "discover_models") {
        discoveryActions.push(body);
        await route.fulfill({
          contentType: "application/json",
          json: { models: discoveredModels }
        });
        return;
      }
      if (action === "discover_endpoints") {
        discoveryActions.push(body);
        await route.fulfill({
          contentType: "application/json",
          json: { endpoints: discoveredEndpoints }
        });
        return;
      }
      if (action === "set_default_credential") {
        connections = [{ ...connections[0]!, defaultCredentialId: String(body.credentialId) }];
        await route.fulfill({ contentType: "application/json", json: { connections } });
        return;
      }
      if (action === "activate") {
        activationBody = body;
        const current = connections[0]!;
        const credential = current.credentials[0]!;
        const model = current.models[0]!;
        connections = [{
          ...current,
          activatedAt: now,
          activeChecks: current.draftChecks.map((check) => ({
            checkedAt: check.checkedAt,
            connectionVersion: current.draftVersion,
            credentialId: credential.id,
            credentialVersionId: "credential-version-e2e",
            evidence: check.evidence,
            latestRefreshError: null,
            modelVersion: model.draftVersion,
            providerModelId: model.id,
            refreshFailedAt: null,
            status: check.status
          })),
          activeConfig: current.draftConfig,
          activeVersion: current.draftVersion,
          credentials: [{
            ...credential,
            activatedAt: now,
            activeVersion: {
              activatedAt: now,
              id: "credential-version-e2e",
              revokedAt: null,
              testedAt: now,
              version: 1
            },
            draftSecretConfigured: false
          }],
          enabled: true,
          models: [{
            ...model,
            activatedAt: now,
            activeConfig: model.draftConfig,
            activeVersion: model.draftVersion
          }]
        }];
        await route.fulfill({ contentType: "application/json", json: { connections } });
        return;
      }
    }
    if (method === "POST" && path.endsWith("/models")) {
      submittedModelBody = body;
      const current = connections[0]!;
      connections = [{
        ...current,
        models: [{
          activatedAt: null,
          activeConfig: null,
          activeVersion: 0,
          connectionId: current.id,
          createdAt: now,
          displayName: String(body.displayName),
          draftConfig: body.configuration as AdminProviderModelConfiguration,
          draftVersion: 1,
          enabled: true,
          id: "model-e2e",
          updatedAt: now
        }]
      }];
      await route.fulfill({ contentType: "application/json", json: { connections }, status: 201 });
      return;
    }
    if (method === "POST" && path.endsWith("/tests")) {
      const current = connections[0]!;
      const check: AdminProviderDraftCheck = {
        checkedAt: now,
        connectionDraftVersion: current.draftVersion,
        credentialDraftVersion: current.credentials[0]!.draftVersion,
        credentialId: "credential-e2e",
        credentialVersionId: null,
        evidence: {
          detail: "ok",
          method: "openrouter_account_catalog",
          selectedProviders: ["acme-primary", "acme-backup"],
          upstreamModelId: "vendor/e2e-model"
        },
        fingerprint: "provider-e2e-check",
        modelDraftVersion: 1,
        providerModelId: "model-e2e",
        status: "available"
      };
      connections = [{ ...current, draftChecks: [check] }];
      await route.fulfill({ contentType: "application/json", json: { check } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_provider_e2e_request", method, path },
      status: 400
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  await expect(section.getByRole("heading", { exact: true, name: "Providers" })).toBeVisible();

  await section.getByRole("button", { name: "New connection" }).click();
  await section.getByLabel("Display name").fill("E2E OpenRouter");
  await section.getByRole("button", { name: "Save connection" }).click();
  await expect(section.getByRole("heading", { name: "E2E OpenRouter" })).toBeVisible();

  await section.getByLabel("API key").fill("e2e-write-only-provider-key");
  await expect(section.getByRole("button", { name: "Save key" })).toBeDisabled();
  const credentialTestResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/credential-tests")
  );
  await section.getByRole("button", { name: "Test new key" }).click();
  const safeTestBody = await (await credentialTestResponse).text();
  expect(JSON.parse(safeTestBody)).toEqual({
    test: {
      checkedAt: now,
      connectionDraftVersion: 1,
      modelCount: discoveredModels.length,
      status: "valid"
    }
  });
  expect(safeTestBody).not.toContain("e2e-write-only-provider-key");
  expect(testedKey).toBe("e2e-write-only-provider-key");
  expect(submittedKey).toBeNull();
  await expect(section.getByText(`Key accepted. The account catalog exposes ${discoveredModels.length} models.`)).toBeVisible();
  await expect(section.getByRole("button", { name: "Save key" })).toBeEnabled();
  await section.getByRole("button", { name: "Save key" }).click();
  await expect(section.getByLabel("API key")).toHaveCount(0);
  await section.getByRole("button", { name: "Add key" }).click();
  await expect(section.getByLabel("API key")).toHaveValue("");
  await section.getByRole("button", { name: "Close key form" }).click();
  expect(submittedKey).toBe("e2e-write-only-provider-key");
  await expect(section.getByText("e2e-write-only-provider-key")).toHaveCount(0);

  const modelWorkflow = section.locator("#provider-models-workflow");
  const modelCatalogResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/actions") &&
      (request.postDataJSON() as Record<string, unknown>).action === "discover_models";
  });
  await modelWorkflow.getByRole("button", { exact: true, name: "Add model" }).click();
  await modelCatalogResponse;
  expect(discoveryActions).toEqual([{
    action: "discover_models",
    credentialId: "credential-e2e"
  }]);

  const modelPicker = section.getByRole("button", { name: "OpenRouter model" });
  await expect(modelPicker).toContainText("Choose a model");
  await modelPicker.click();
  const modelListbox = section.getByRole("listbox", { name: "OpenRouter model" });
  await expect(section.getByText(`${discoveredModels.length} models`, { exact: true })).toBeVisible();
  await expect(modelListbox.getByRole("option").first()).toContainText("Catalog Model 001");

  await section.getByRole("combobox", { name: "Search models" }).fill("vendor reasoning");
  await expect(section.getByText(`1 of ${discoveredModels.length} models`, { exact: true })).toBeVisible();
  await modelListbox.getByRole("option", { name: /E2E Model/ }).click();
  await expect(modelPicker).toContainText("E2E Model");
  await expect(section.getByText("128,000 context tokens · tools, reasoning")).toBeVisible();

  const endpointCatalogResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/actions") &&
      (request.postDataJSON() as Record<string, unknown>).action === "discover_endpoints";
  });
  await section.getByLabel("Only selected providers").check();
  await endpointCatalogResponse;
  expect(discoveryActions).toEqual([
    { action: "discover_models", credentialId: "credential-e2e" },
    {
      action: "discover_endpoints",
      credentialId: "credential-e2e",
      modelId: "vendor/e2e-model"
    }
  ]);

  await section.getByRole("button", { name: "Add route Acme Inference (acme-backup)" }).click();
  await section.getByRole("button", { name: "Add route Acme Inference (acme-primary)" }).click();
  const routePriority = section.getByRole("list", { name: "Selected provider route priority" });
  await routePriority.getByRole("button", { name: "Move acme-primary up" }).click();
  await expect(routePriority.getByRole("listitem").nth(0)).toContainText("acme-primary");
  await expect(routePriority.getByRole("listitem").nth(1)).toContainText("acme-backup");

  await section.getByRole("button", { exact: true, name: "Save model" }).click();
  await expect(section.getByRole("list", { name: "Configured models" }).getByText("E2E Model", { exact: true })).toBeVisible();
  expect(submittedModelBody).toMatchObject({
    configuration: {
      adapterKind: "openrouter_chat_completions",
      openRouterRouting: {
        mode: "only_selected",
        providers: ["acme-primary", "acme-backup"]
      },
      upstreamModelId: "vendor/e2e-model"
    },
    displayName: "E2E Model"
  });

  const modelMore = section.getByLabel("More actions for E2E Model model");
  await modelMore.click();
  const modelActions = section.getByRole("button", { name: "Delete E2E Model model" }).locator("xpath=..");
  await expectFullyHitTestable(modelActions);
  await expect(section.getByText("vendor/e2e-model", { exact: true })).toHaveCount(0);
  await modelMore.click();

  await page.setViewportSize({ height: 844, width: 390 });
  await modelMore.scrollIntoViewIfNeeded();
  await modelMore.click();
  await expectFullyHitTestable(modelActions);
  await modelMore.click();
  await page.setViewportSize({ height: 900, width: 1440 });

  await section.locator("#provider-default-credential").selectOption("credential-e2e");
  await expect(section.getByText("Ready to activate.")).toBeVisible();

  const diagnostics = section.locator("details").filter({
    hasText: "Diagnostics and troubleshooting"
  });
  await expect(diagnostics).not.toHaveAttribute("open", "");
  await expect(diagnostics.getByRole("button", { name: "Check model route" })).toBeHidden();
  await diagnostics.locator("summary").click();
  await expect(diagnostics).toHaveAttribute("open", "");
  await diagnostics.getByRole("button", { name: "Check model route" }).click();
  await expect(section.getByText("The exact model and credential draft is available.")).toBeVisible();
  await expect(diagnostics.getByText("available", { exact: true })).toBeVisible();

  await section.getByRole("button", { name: "Activate and enable" }).click();
  await expect(section.getByText("Provider draft activated and enabled for new runs.")).toBeVisible();
  expect(activationBody).toEqual({
    action: "activate",
    confirmUnavailable: false,
    enableConnection: true
  });
  await expect(section.getByText("Provider is active and ready for new runs.")).toBeVisible();
  const providerHeader = section.getByRole("heading", {
    level: 2,
    name: "E2E OpenRouter"
  }).locator("..");
  await expect(providerHeader.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(providerHeader.getByText("Active v1", { exact: true })).toBeVisible();
});

test("administrator remaps the three composer run profiles in one save", async ({ page }) => {
  let submittedProfiles: Array<Record<string, unknown>> | null = null;
  const runProfileCatalog: AdminRunProfileCatalog = {
    models: [
      {
        connectionEnabled: true,
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        displayName: "GPT-5.6 Luna",
        id: "deployment-luna",
        modelEnabled: true,
        providerDisplayName: "Primary OpenAI",
        reasoningEfforts: ["none", "medium", "high", "max"],
        reasoningModes: ["standard", "pro"],
        selectable: true
      },
      {
        connectionEnabled: true,
        defaultReasoningEffort: "max",
        defaultReasoningMode: "pro",
        displayName: "GPT-5.6 Sol",
        id: "deployment-sol",
        modelEnabled: true,
        providerDisplayName: "Primary OpenAI",
        reasoningEfforts: ["none", "medium", "high", "max"],
        reasoningModes: ["standard", "pro"],
        selectable: true
      }
    ],
    profiles: [
      { description: "Simple questions", enabled: true, id: "fast", label: "Fast", providerModelId: "deployment-luna", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: now, version: 2 },
      { description: "Everyday questions", enabled: true, id: "balanced", label: "Balanced", providerModelId: "deployment-luna", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: now, version: 3 },
      { description: "Difficult questions", enabled: true, id: "deep", label: "Deep", providerModelId: "deployment-sol", reasoningEffort: "max", reasoningMode: "pro", updatedAt: now, version: 4 }
    ]
  };

  await page.route("**/api/admin/providers", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { connections: [] } });
  });
  await page.route("**/api/admin/run-profiles", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: runProfileCatalog });
      return;
    }
    const body = route.request().postDataJSON() as { profiles: Array<Record<string, unknown>> };
    submittedProfiles = body.profiles;
    await route.fulfill({
      contentType: "application/json",
      json: {
        models: runProfileCatalog.models,
        profiles: body.profiles.map((profile) => ({
          description: profile.description,
          enabled: profile.enabled,
          id: profile.id,
          label: profile.id === "fast" ? "Fast" : profile.id === "balanced" ? "Balanced" : "Deep",
          providerModelId: profile.providerModelId,
          reasoningEffort: profile.reasoningEffort,
          reasoningMode: profile.reasoningMode,
          updatedAt: now,
          version: Number(profile.expectedVersion) + 1
        }))
      }
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  await expect(section.getByRole("heading", { name: "Run profiles" })).toBeVisible();
  await expect(section.getByLabel("Fast description")).toHaveValue("Simple questions");
  await expect(section.getByLabel("Balanced description")).toHaveValue("Everyday questions");
  await expect(section.getByLabel("Deep description")).toHaveValue("Difficult questions");

  await section.getByLabel("Fast description").fill("Quick factual questions");
  await section.getByLabel("Fast model deployment").selectOption("deployment-sol");
  await expect(section.getByLabel("Fast reasoning mode")).toHaveValue("pro");
  await expect(section.getByLabel("Fast reasoning effort")).toHaveValue("max");
  await section.getByRole("button", { name: "Save profiles" }).click();

  await expect(section.getByText("Run profiles saved for future messages.")).toBeVisible();
  expect(submittedProfiles).toHaveLength(3);
  expect(submittedProfiles?.[0]).toMatchObject({
    description: "Quick factual questions",
    expectedVersion: 2,
    id: "fast",
    providerModelId: "deployment-sol",
    reasoningEffort: "max",
    reasoningMode: "pro"
  });
});

test("ordinary user receives real provider-admin denial without provider metadata", async ({ page }) => {
  await signInOrdinaryUser(page);

  const [catalog, mutation, runProfiles] = await Promise.all([
    page.request.get("/api/admin/providers"),
    page.request.post("/api/admin/providers/not-visible/actions", {
      data: {
        action: "discover_models",
        credentialId: "not-visible"
      }
    }),
    page.request.get("/api/admin/run-profiles")
  ]);
  for (const response of [catalog, mutation, runProfiles]) {
    expect(response.status()).toBe(403);
    const text = await response.text();
    expect(text).toBe('{"error":"forbidden"}');
    expect(text).not.toMatch(/apiRoot|credential|model|openrouter|providerModelId|secret/iu);
  }

  await page.goto("/admin?section=providers");
  await expect(page.getByTestId("admin-denied")).toContainText("Admin access required");
  await expect(page.getByRole("tab", { name: "Providers" })).toHaveCount(0);
});
