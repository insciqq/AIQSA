import { describe, expect, it, vi } from "vitest";
import {
  discoverAdminProviderCustomModels,
  submitAdminProviderCustomSetup
} from "./adminProviderCustomSetupApi";

const request = {
  allowPrivateNetwork: false,
  apiRoot: "https://llm.example.test/v1",
  authenticationMode: "bearer" as const,
  confirmPaidRequest: true as const,
  modelId: "vendor/model-1",
  protocol: "chat_completions" as const,
  responseTimeoutSeconds: 300,
  secret: "browser-only-key"
};

const ready = {
  authenticationMode: "bearer",
  checkedAt: "2026-07-26T10:00:00.000Z",
  connectionDisplayName: "Custom provider",
  connectionId: "connection-1",
  defaultChanged: true,
  modelDisplayName: "Model 1",
  models: [{ modelDisplayName: "Model 1", providerModelId: "model-1" }],
  outcome: "ready",
  providerModelId: "model-1",
  search: null
};

describe("custom provider setup API", () => {
  it("decodes only bounded model IDs and safe capability hints from Custom discovery", async () => {
    const body = {
      checkedAt: "2026-07-26T10:00:00.000Z",
      modelCount: 2,
      models: [
        {
          capabilities: {
            contextWindow: 272_000,
            toolCalling: true,
            vision: false,
            parallelToolCalls: true,
            maxOutputTokens: 65_536,
            defaultMaxOutputTokens: 2_048,
            defaultReasoningEffort: "low",
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"]
          },
          id: "model-b"
        },
        { capabilities: {}, id: "model-a" }
      ],
      source: "models_catalog",
      status: "valid"
    } as const;
    const fetcher = vi.fn(async () => Response.json(body));
    await expect(discoverAdminProviderCustomModels({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 300,
      secret: "browser-only-key"
    }, fetcher)).resolves.toEqual({ data: body, ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/providers/custom-setup/discover",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("rejects discovery responses containing endpoint or credential material", async () => {
    const result = await discoverAdminProviderCustomModels({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 300,
      secret: "browser-only-key"
    }, vi.fn(async () => Response.json({
      apiRoot: "https://leaked.example.test/v1",
      checkedAt: "2026-07-26T10:00:00.000Z",
      modelCount: 1,
      models: [{ capabilities: {}, id: "model-a" }],
      source: "models_catalog",
      status: "valid"
    })));
    expect(result).toEqual({
      error: { code: "provider_custom_setup_discovery_response_invalid" },
      ok: false
    });
  });

  it("rejects contradictory or duplicate reasoning hints", async () => {
    const result = await discoverAdminProviderCustomModels({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 300,
      secret: "browser-only-key"
    }, vi.fn(async () => Response.json({
      checkedAt: "2026-07-26T10:00:00.000Z",
      modelCount: 1,
      models: [{
        capabilities: { reasoning: false, reasoningEfforts: ["low", "low"] },
        id: "model-a"
      }],
      source: "models_catalog",
      status: "valid"
    })));
    expect(result).toEqual({
      error: { code: "provider_custom_setup_discovery_response_invalid" },
      ok: false
    });
  });

  it.each([{ toolCalling: "true" }, { vision: null }, { parallelToolCalls: 1 }, { maxOutputTokens: -1 }, { maxOutputTokens: 10_000_001 }, { metadata: { supports_tools: true } }])("rejects malformed capability hints: %j", async (capabilities) => {
    const result = await discoverAdminProviderCustomModels(request, vi.fn(async () => Response.json({
      checkedAt: "2026-07-26T10:00:00.000Z", modelCount: 1, models: [{ id: "model", capabilities }], source: "models_catalog", status: "valid"
    })));
    expect(result).toMatchObject({ ok: false, error: { code: "provider_custom_setup_discovery_response_invalid" } });
  });

  it("sends one same-origin write-only request and decodes the safe receipt", async () => {
    const fetcher = vi.fn(async () => Response.json(ready));
    await expect(submitAdminProviderCustomSetup(request, fetcher)).resolves.toEqual({
      data: ready,
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/providers/custom-setup", {
      body: JSON.stringify(request),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined
    });
  });

  it("accepts partial saved results but rejects full success with unpublished or unsafe results", async () => {
    const checkRun = {
      credentialId: "credential-1", current: null, done: 1, failed: ["model-1"], finishedAt: ready.checkedAt,
      id: "run-1", inFlight: [], reason: "setup", startedAt: ready.checkedAt, state: "completed", total: 1,
      results: [{ providerModelId: "model-1", state: "save_failed", checks: { structuredOutput: "verified", forcedToolCall: "rejected" } }]
    };
    const body = { ...ready, outcome: "partial", checkRun };
    await expect(submitAdminProviderCustomSetup(request, vi.fn(async () => Response.json(body))))
      .resolves.toEqual({ ok: true, data: body });
    for (const invalid of [
      { ...body, outcome: "ready" },
      { ...body, outcome: "cancelled" },
      { ...body, models: [body.models[0], body.models[0]] },
      { ...body, checkRun: { ...checkRun, state: "running" } },
      { ...body, checkRun: { ...checkRun, results: [{ ...checkRun.results[0], rawBody: "private-response" }] } },
      { ...body, checkRun: { ...checkRun, results: [{ ...checkRun.results[0], checks: { vision: "yes" } }] } }
    ]) {
      await expect(submitAdminProviderCustomSetup(request, vi.fn(async () => Response.json(invalid))))
        .resolves.toMatchObject({ ok: false, error: { code: "provider_custom_setup_response_invalid" } });
    }
  });

  it("decodes one friendly Search receipt without transport vocabulary", async () => {
    const body = {
      ...ready,
      search: { displayName: "Custom provider Search", status: "needs_attention" }
    };
    await expect(submitAdminProviderCustomSetup(
      request,
      vi.fn(async () => Response.json(body))
    )).resolves.toEqual({ data: body, ok: true });
  });

  it.each([
    { ...ready, secret: "leaked" },
    { ...ready, apiRoot: "https://private.example.test/v1" },
    { ...ready, unexpected: true },
    { ...ready, outcome: "created" },
    { ...ready, checkedAt: "not-a-timestamp" }
  ])("rejects malformed or secret-bearing success responses", async (body) => {
    const result = await submitAdminProviderCustomSetup(
      request,
      vi.fn(async () => Response.json(body))
    );
    expect(result).toEqual({
      error: { code: "provider_custom_setup_response_invalid" },
      ok: false
    });
    expect(JSON.stringify(result)).not.toContain("browser-only-key");
  });

  it("preserves only a stable server error code", async () => {
    const result = await submitAdminProviderCustomSetup(
      request,
      vi.fn(async () => Response.json({
        error: "provider_custom_setup_test_failed",
        rawBody: "must not be decoded"
      }, { status: 422 }))
    );
    expect(result).toEqual({
      error: { code: "provider_custom_setup_test_failed" },
      ok: false
    });
  });
});
