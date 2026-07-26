import { describe, expect, it, vi } from "vitest";
import {
  getAdminProviderQuickSetup,
  submitAdminProviderQuickSetup
} from "./adminProviderQuickSetupApi";

const checkedAt = "2026-07-26T03:00:00.000Z";

function snapshot() {
  return {
    providers: [
      {
        provider: "openai",
        providerDisplayName: "OpenAI",
        state: "not_configured",
        stateToken: "state-openai"
      },
      {
        model: { displayName: "Claude Opus 4.8" },
        provider: "anthropic",
        providerDisplayName: "Anthropic",
        state: "ready",
        stateToken: "state-anthropic"
      },
      {
        provider: "openrouter",
        providerDisplayName: "OpenRouter",
        state: "needs_attention",
        stateToken: "state-openrouter"
      }
    ],
    suggestedProvider: "anthropic"
  };
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("admin provider Quick setup API", () => {
  it("decodes the exact three-provider snapshot and sends same-origin GET", async () => {
    const fetcher = vi.fn(async () => response(snapshot()));
    await expect(getAdminProviderQuickSetup(fetcher)).resolves.toEqual({
      data: snapshot(),
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/providers/quick-setup", {
      credentials: "same-origin",
      method: "GET",
      signal: undefined
    });
  });

  it("sends only the write-only atomic request and decodes Ready", async () => {
    const ready = {
      checkedAt,
      defaultChanged: false,
      model: { displayName: "GPT-5.6 Terra" },
      outcome: "ready",
      profilesFilled: ["balanced"],
      provider: "openai",
      providerDisplayName: "OpenAI"
    };
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => response(ready));
    const request = {
      expectedState: "state-openai",
      provider: "openai" as const,
      secret: "write-only-key",
      selectedModel: {
        candidateId: "p1-o1",
        policyVersion: 1
      }
    };

    await expect(submitAdminProviderQuickSetup(request, fetcher)).resolves.toEqual({
      data: ready,
      ok: true
    });
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it("decodes a bounded no-write model selection result", async () => {
    const selection = {
      candidates: [
        { candidateId: "p1-o1", displayName: "GPT-5.6 Terra" },
        { candidateId: "p1-o3", displayName: "GPT-5.6 Sol" }
      ],
      checkedAt,
      expectedState: "state-openai",
      outcome: "selection_required",
      policyVersion: 1,
      provider: "openai",
      providerDisplayName: "OpenAI"
    };
    const fetcher = vi.fn(async () => response(selection));
    const result = await submitAdminProviderQuickSetup({
      expectedState: "state-openai",
      provider: "openai",
      secret: "write-only-key"
    }, fetcher);
    expect(result).toEqual({ data: selection, ok: true });
    expect(JSON.stringify(result)).not.toContain("write-only-key");
  });

  it.each([
    { ...snapshot(), extra: true },
    { providers: snapshot().providers.slice(0, 2), suggestedProvider: null },
    { providers: [...snapshot().providers, snapshot().providers[0]], suggestedProvider: null },
    {
      providers: snapshot().providers.map((provider) => provider.provider === "anthropic"
        ? { ...provider, model: undefined }
        : provider),
      suggestedProvider: "anthropic"
    },
    { providers: snapshot().providers, suggestedProvider: "fake" }
  ])("rejects malformed or expanded snapshots", async (body) => {
    const result = await getAdminProviderQuickSetup(async () => response(body));
    expect(result).toEqual({
      error: { code: "provider_quick_setup_response_invalid" },
      ok: false
    });
  });

  it.each([
    { secret: "reflected" },
    { nested: { secretEnvelope: "encrypted" } },
    { connectionId: "internal" },
    { credentialVersionId: "internal" },
    { evidence: { detail: "ok" } },
    { groups: [] },
    { catalog: { models: [] } },
    { resourceIds: ["internal"] }
  ])("rejects forbidden response material recursively in success", async (forbidden) => {
    const body = { ...snapshot(), providers: [
      { ...snapshot().providers[0], nested: forbidden },
      ...snapshot().providers.slice(1)
    ] };
    const result = await getAdminProviderQuickSetup(async () => response(body));
    expect(result).toEqual({
      error: { code: "provider_quick_setup_response_invalid" },
      ok: false
    });
  });

  it("rejects forbidden material in an error instead of reflecting its code", async () => {
    const result = await submitAdminProviderQuickSetup({
      expectedState: "state-openai",
      provider: "openai",
      secret: "write-only-key"
    }, async () => response({
      error: "provider_credential_test_failed",
      nested: { secret: "write-only-key" }
    }, 422));
    expect(result).toEqual({
      error: { code: "provider_quick_setup_response_invalid" },
      ok: false
    });
    expect(JSON.stringify(result)).not.toContain("write-only-key");
  });

  it.each([
    {
      checkedAt: "not-a-time",
      defaultChanged: true,
      model: { displayName: "Model" },
      outcome: "ready",
      profilesFilled: [],
      provider: "openai",
      providerDisplayName: "OpenAI"
    },
    {
      candidates: [],
      checkedAt,
      expectedState: "state-openai",
      outcome: "selection_required",
      policyVersion: 1,
      provider: "openai",
      providerDisplayName: "OpenAI"
    },
    {
      candidates: [{ candidateId: "p1-model", displayName: "Model" }],
      checkedAt,
      expectedState: "state-openai",
      outcome: "selection_required",
      policyVersion: 0,
      provider: "openai",
      providerDisplayName: "OpenAI"
    },
    { outcome: "stale" }
  ])("rejects malformed or unknown POST result unions", async (body) => {
    const result = await submitAdminProviderQuickSetup({
      expectedState: "state-openai",
      provider: "openai",
      secret: "write-only-key"
    }, async () => response(body));
    expect(result).toEqual({
      error: { code: "provider_quick_setup_response_invalid" },
      ok: false
    });
  });

  it("keeps existing safe provider failure codes value-free", async () => {
    const result = await submitAdminProviderQuickSetup({
      expectedState: "state-openai",
      provider: "openai",
      secret: "write-only-key"
    }, async () => response({ error: "provider_credential_test_failed" }, 422));
    expect(result).toEqual({
      error: { code: "provider_credential_test_failed" },
      ok: false
    });
  });
});
