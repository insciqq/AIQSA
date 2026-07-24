import { describe, expect, it, vi } from "vitest";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import {
  createProviderRuntimeBinding,
  createProviderPreviewRuntimeBinding,
  normalizeProviderExecutionSnapshot
} from "./runtimeFactory";

function snapshot(
  adapterKind: Exclude<ProviderExecutionSnapshot["model"]["adapterKind"], "fake">
): ProviderExecutionSnapshot {
  const providerFamily = adapterKind === "openai_responses_native"
    ? "openai"
    : adapterKind === "anthropic_messages"
      ? "anthropic"
      : adapterKind === "openrouter_chat_completions"
        ? "openrouter"
        : "openai_compatible";
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: adapterKind === "anthropic_messages"
        ? "https://api.anthropic.com/v1"
        : "https://provider.example.test/v1"
    },
    connectionDisplayName: "Connection",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: true,
        vision: false
      },
      defaultParams: {},
      ...(adapterKind === "openrouter_chat_completions"
        ? { openRouterRouting: { mode: "automatic" as const, providers: [] as [] } }
        : {}),
      upstreamModelId: "upstream/model"
    },
    modelDisplayName: "Model",
    providerFamily,
    providerModelId: "deployment-1",
    version: 1
  };
}

describe("provider runtime factory", () => {
  it.each([
    "openai_responses_native",
    "openai_responses_compatible",
    "openai_chat_completions_compatible",
    "anthropic_messages",
    "openrouter_chat_completions"
  ] as const)("constructs %s only with an explicit safe fetch", (adapterKind) => {
    const fetchFn = vi.fn<typeof fetch>();
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: "secret",
      snapshot: snapshot(adapterKind)
    });

    expect(runtime.adapter).toBeDefined();
    expect(Boolean(runtime.searchAdapter)).toBe(adapterKind === "openrouter_chat_completions");
    expect(runtime.toolBridge?.supportsToolCalling({
      modelId: "upstream/model",
      provider: runtime.toolBridge.provider
    })).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never falls back to global fetch", () => {
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: "secret",
      snapshot: snapshot("openai_responses_compatible")
    })).toThrow("provider_safe_fetch_required");
  });

  it("builds a serializer-only preview boundary without a real credential", () => {
    const preview = createProviderPreviewRuntimeBinding(
      snapshot("openai_chat_completions_compatible"),
      false
    );
    expect(preview.adapter.buildRequestPreview).toBeTypeOf("function");
  });

  it("keeps Fake behind the explicit test boundary and credential-free", () => {
    const fake: ProviderExecutionSnapshot = {
      connection: { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1" },
      connectionDisplayName: "Fake",
      connectionId: "fake-connection",
      credentialId: null,
      credentialVersionId: null,
      model: {
        adapterKind: "fake",
        capabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          vision: true
        },
        defaultParams: {},
        upstreamModelId: "fake-qsa"
      },
      modelDisplayName: "Fake QSA",
      providerFamily: "fake",
      providerModelId: "fake-model",
      version: 1
    };

    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: null,
      snapshot: fake
    })).toThrow("fake_provider_not_allowed");
    expect(createProviderRuntimeBinding({
      options: { allowFake: true },
      secret: null,
      snapshot: fake
    }).adapter).toBeDefined();
  });

  it("rejects cross-shape, oversized, and credential-less snapshots", () => {
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      credentialVersionId: null
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      modelDisplayName: "x".repeat(100_000)
    })).toThrow("provider_execution_snapshot_invalid");
  });
});
