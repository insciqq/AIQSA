import { describe, expect, it, vi } from "vitest";
import { EMPTY_ADMIN_MODEL_PRICES } from "@/lib/contracts/adminProviderModelPrices";
import {
  addAdminProviderCatalogModels,
  adminProviderErrorMessage,
  createAdminProviderCredential,
  discoverAdminCompatibleModels,
  getAdminProviderConnections,
  isAdminProviderCheckRun,
  renameAdminProviderModel,
  saveAdminProviderModelMetadata,
  runAdminProviderConnectionAction
} from "./adminProvidersApi";
import { fixtureModel } from "./providers/providerFixtures";

const safeConnection = {
  activatedAt: null,
  activeChecks: [],
  activeConfig: null,
  activeVersion: 0,
  assignments: [],
  createdAt: "2026-07-23T00:00:00.000Z",
  credentials: [{
    activeVersion: null,
    draftSecretConfigured: true,
    draftVersion: 1,
    enabled: true,
    id: "credential-1",
    label: "Primary"
  }],
  defaultCredentialId: null,
  displayName: "OpenRouter",
  draftChecks: [],
  draftConfig: {
    allowPrivateNetwork: false,
    apiRoot: "https://openrouter.ai/api/v1",
    authenticationMode: "bearer",
    responseTimeoutSeconds: 300
  },
  draftVersion: 1,
  enabled: false,
  family: "openrouter",
  id: "connection-1",
  models: [],
  unassignedPolicy: "use_default",
  updatedAt: "2026-07-23T00:00:00.000Z",
  userAssignments: []
};

describe("admin provider bootstrap result decoding", () => {
  const run = (setup: unknown) => ({ credentialId: "key", current: null, done: 1, failed: [], finishedAt: "2026-09-28T00:00:01.000Z",
    id: "run", inFlight: [], reason: "setup", setup, startedAt: "2026-09-28T00:00:00.000Z", state: "completed", total: 1 });

  it("accepts results without the marker and the exact Memory marker", () => {
    expect(isAdminProviderCheckRun(run({ defaults: ["Chat: Model"], search: "ready", state: "completed" }))).toBe(true);
    expect(isAdminProviderCheckRun(run({ defaults: [], search: "failed", state: "partial" }))).toBe(true);
    expect(isAdminProviderCheckRun(run({ defaults: [], needsConfiguration: ["memory"], search: "ready", state: "completed" }))).toBe(true);
    expect(isAdminProviderCheckRun(run({ defaults: [], needsConfiguration: ["memory"], search: "failed", state: "partial" }))).toBe(true);
  });

  it.each([[[]], [["memory", "memory"]], [["search"]], ["memory"], [null], [[1]]])("rejects a malformed marker %j", (needsConfiguration) => {
    expect(isAdminProviderCheckRun(run({ defaults: [], needsConfiguration, search: "ready", state: "completed" }))).toBe(false);
  });

  it("rejects a marker on running setup and unknown setup fields", () => {
    expect(isAdminProviderCheckRun(run({ needsConfiguration: ["memory"], state: "running" }))).toBe(false);
    expect(isAdminProviderCheckRun(run({ defaults: [], search: "ready", state: "completed", memory: "missing" }))).toBe(false);
  });
});

describe("admin provider browser API", () => {
  it("validates exact admin prices and sends metadata without activating a model", async () => {
    const model = fixtureModel({ connectionId: "connection-1", id: "model", displayName: "Model" });
    for (const pricing of [undefined, { ...model.pricing, source: "unknown" },
      { ...model.pricing, prices: { ...model.pricing.prices, inputTokenPriceUsdPerMillion: 0.25 } }]) {
      expect(await getAdminProviderConnections(async () => Response.json({ connections: [{ ...safeConnection, models: [{ ...model, pricing }] }] })))
        .toMatchObject({ ok: false, error: { code: "provider_admin_response_invalid" } });
    }
    const prices = { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "9999999999.99999999" };
    const pricing = { prices, source: "admin", catalogPrices: null };
    const body = { displayName: "Model", expectedActiveVersion: 1, expectedDraftVersion: 1,
      expectedDisplayName: "Model", expectedUpdatedAt: model.updatedAt, pricing: { mode: "manual" as const, prices } };
    const fetcher = vi.fn(async () => Response.json({ receipt: { connectionId: "connection-1", modelId: "model", displayName: "Model",
      draftVersion: 1, saved: "metadata", publication: "not_requested", checks: "not_requested", pricing } }));
    expect(await saveAdminProviderModelMetadata("connection-1", "model", body, fetcher)).toMatchObject({ ok: true, data: { pricing } });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/providers/connection-1/models/model", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ ...body, action: "metadata" })
    }));
  });

  it("keeps the field of a server price rejection", async () => {
    const body = { displayName: "Model", expectedActiveVersion: 1, expectedDraftVersion: 1, expectedDisplayName: "Model",
      expectedUpdatedAt: "2026-09-30T00:00:00.000Z", pricing: { mode: "manual" as const, prices: EMPTY_ADMIN_MODEL_PRICES } };
    const rejected = async (value: unknown) => saveAdminProviderModelMetadata("connection-1", "model", body,
      async () => Response.json(value, { status: 400 }));
    expect(await rejected({ error: "provider_model_pricing_invalid", field: "outputTokenPriceUsdPerMillion" })).toMatchObject({
      ok: false, status: 400, error: { code: "provider_model_pricing_invalid", field: "outputTokenPriceUsdPerMillion" } });
    for (const value of [{ error: "provider_model_pricing_invalid" }, { field: "outputTokenPriceUsdPerMillion" }, { error: "provider_model_pricing_invalid", field: 1 }]) {
      const result = await rejected(value);
      expect(result.ok ? null : result.error).not.toHaveProperty("field");
    }
  });

  it("posts exact selected catalog identities and rejects unrelated unavailable IDs or malformed suggestions", async () => {
    const body = { credentialId: "key", expectedConnectionVersion: 3, expectedCredentialVersionId: "version", modelIds: ["builtin"] };
    const fetcher = vi.fn(async () => Response.json({ connections: [safeConnection], unavailableModelIds: ["builtin"] }));
    await expect(addAdminProviderCatalogModels("connection-1", body, fetcher)).resolves.toMatchObject({ ok: true, data: { unavailableModelIds: ["builtin"] } });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/providers/connection-1/actions", expect.objectContaining({ method: "POST", body: JSON.stringify({ ...body, action: "add_catalog_models" }) }));
    await expect(addAdminProviderCatalogModels("connection-1", body, async () => Response.json({ connections: [safeConnection], unavailableModelIds: ["upstream-only"] })))
      .resolves.toMatchObject({ ok: false, error: { code: "provider_admin_response_invalid" } });
    await expect(getAdminProviderConnections(async () => Response.json({ connections: [{ ...safeConnection,
      catalogUpdates: { available: [{ id: "builtin", displayName: "Model", upstreamModelId: "model", modelClass: "unknown" }], skipped: [] } }] })))
      .resolves.toMatchObject({ ok: false, error: { code: "provider_admin_response_invalid" } });
  });

  it.each(["saved", "publication", "checks"])("rejects non-primitive receipt %s without coercion", async (field) => {
    const receipt = { connectionId: "provider", modelId: "model", displayName: "New name", draftVersion: 1,
      saved: "name", publication: "not_requested", checks: "not_requested", [field]: { toString: "private-invalid-enum" } };
    const fetcher = vi.fn(async () => Response.json({ receipt }));
    expect(await renameAdminProviderModel("provider", "model", { displayName: "New name", expectedActiveVersion: 1,
      expectedDisplayName: "Old name", expectedDraftVersion: 1, expectedUpdatedAt: "2026-09-10T00:00:00.000Z" }, fetcher))
      .toMatchObject({ ok: false, error: { code: "provider_admin_response_invalid" } });
  });

  it("accepts a model that inherits its response timeout from the connection", async () => {
    const fetcher = vi.fn(async () => Response.json({
      connections: [{
        ...safeConnection,
        models: [{
          pricing: { prices: EMPTY_ADMIN_MODEL_PRICES, source: "catalog", catalogPrices: null },
          displayName: "Inherited timeout model",
          draftConfig: {
            adapterKind: "openai_responses_compatible",
            answerSelectable: true,
            modelClass: "answer",
            upstreamModelId: "fixture/inherited-timeout"
          },
          draftVersion: 1,
          enabled: true,
          id: "model-inherited-timeout"
        }]
      }]
    }));

    await expect(getAdminProviderConnections(fetcher)).resolves.toMatchObject({
      data: [{ models: [{ id: "model-inherited-timeout" }] }],
      ok: true
    });
  });

  it("names an Assistant deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "assistants" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("assistants: 1");
  });

  it("names an installation-default deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "installation_default" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("installation default: 1");
  });

  it("names a utility-model deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "system_model" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("utility model role: 1");
  });

  it("sends credentials only in same-origin JSON mutation bodies", async () => {
    const fetcher = vi.fn(async () => Response.json({ connections: [safeConnection] }));
    await expect(createAdminProviderCredential(
      "connection/one",
      { label: "Primary", secret: "write-only-key" },
      fetcher
    )).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/providers/connection%2Fone/credentials",
      expect.objectContaining({
        body: JSON.stringify({ label: "Primary", secret: "write-only-key" }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
  });

  it("fails closed if a catalog response contains secret material", async () => {
    const fetcher = vi.fn(async () => Response.json({
      connections: [{
        ...safeConnection,
        credentials: [{
          ...safeConnection.credentials[0],
          secretEnvelope: "must-not-reach-browser-state"
        }]
      }]
    }));
    const result = await getAdminProviderConnections(fetcher);
    expect(result).toEqual({
      error: { blockers: [], code: "provider_admin_response_invalid", resourceIds: [] },
      ok: false
    });
  });

  it("identifies a missing provider action route instead of showing a generic provider error", async () => {
    const result = await runAdminProviderConnectionAction(
      "connection-1",
      { action: "check_models", credentialId: "credential-1" },
      vi.fn(async () => new Response("<!doctype html><title>Not Found</title>", {
        headers: { "content-type": "text/html" },
        status: 404
      }))
    );

    expect(result).toEqual({
      error: { blockers: [], code: "provider_admin_route_unavailable", resourceIds: [] },
      ok: false
    });
    if (!result.ok) {
      expect(adminProviderErrorMessage(result.error)).toContain("Restart the development app");
    }
  });

  it("decodes compatible discovery as bounded capability rows and rejects secret material", async () => {
    const fetcher = vi.fn(async () => Response.json({
      models: [
        {
          capabilities: {
            defaultReasoningEffort: "medium",
            toolCalling: true, vision: false, parallelToolCalls: true, maxOutputTokens: 65_536, contextWindow: 272_000,
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"]
          },
          id: "vendor/model-a",
          ownedBy: "codex-lb"
        },
        { capabilities: {}, id: "vendor/model-b" }
      ]
    }));
    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      fetcher
    )).resolves.toEqual({
      data: [
        {
          capabilities: {
            defaultReasoningEffort: "medium",
            toolCalling: true, vision: false, parallelToolCalls: true, maxOutputTokens: 65_536, contextWindow: 272_000,
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"]
          },
          id: "vendor/model-a",
          ownedBy: "codex-lb"
        },
        { capabilities: {}, id: "vendor/model-b" }
      ],
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/providers/connection%2Fone/actions",
      expect.objectContaining({
        body: JSON.stringify({
          action: "discover_compatible_models",
          credentialId: "credential/one"
        }),
        method: "POST"
      })
    );

    for (const ownedBy of ["", "\u0000", "x".repeat(129), 42, { nested: "marker" }]) {
      await expect(discoverAdminCompatibleModels(
        "connection/one",
        "credential/one",
        vi.fn(async () => Response.json({
          models: [{ capabilities: {}, id: "vendor/model-a", ownedBy }]
        }))
      )).resolves.toMatchObject({
        error: { code: "provider_admin_response_invalid" },
        ok: false
      });
    }

    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      vi.fn(async () => Response.json({
        models: [{ capabilities: {}, id: "vendor/model-a", secret: "must-not-enter-state" }]
      }))
    )).resolves.toMatchObject({
      error: { code: "provider_admin_response_invalid" },
      ok: false
    });

    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      vi.fn(async () => Response.json({
        models: [{
          capabilities: {
            reasoning: false,
            reasoningEfforts: ["low", "low"]
          },
          id: "vendor/model-a"
        }]
      }))
    )).resolves.toMatchObject({
      error: { code: "provider_admin_response_invalid" },
      ok: false
    });
  });
});
