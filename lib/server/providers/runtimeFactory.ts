import { createAnthropicMessagesAdapter, createFetchAnthropicMessagesClient } from "./anthropicMessages";
import { createAnthropicMessagesSearchAdapter } from "./anthropicMessagesSearch";
import { createCompatibleResponsesAdapter } from "./compatibleResponses";
import { createFakeProviderAdapter } from "./fakeProvider";
import {
  createFetchGeminiInteractionsClient,
  createGeminiInteractionsAdapter
} from "./geminiInteractions";
import { createGeminiInteractionsSearchAdapter } from "./geminiInteractionsSearch";
import {
  createOpenAICompatibleChatAdapter,
  createFetchOpenAICompatibleChatClient
} from "./openaiCompatibleChat";
import {
  createOpenAIResponsesAdapter,
  createFetchOpenAIResponsesClient
} from "./openaiResponses";
import { createOpenAIResponsesSearchAdapter } from "./openaiResponsesSearch";
import {
  createFetchOpenRouterChatClient,
  createOpenRouterChatAdapter,
  createOpenRouterPerplexitySearchAdapter
} from "./openRouterChat";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderDefaultParams,
  normalizeProviderModelCapabilities,
  normalizeProviderModelConfiguration,
  effectiveProviderResponseTimeoutMs,
  providerAuthenticationMode,
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "./providerConfiguration";
import { withTimeoutSignal } from "./network";
import { effectiveOpenAIBackgroundPollTimeoutMs } from "./openaiBackgroundPolling";
import type { ProviderAdapter, ProviderSearchAdapter } from "./types";
import { warnProviderStreamSafetyOnce } from "./streamSafetyObservability";
import {
  assertProviderCredentialSource,
  resolveProviderCredentialSource,
  type ProviderCredentialSource
} from "./providerCredentialSource";
import {
  anthropicMessagesToolBridge,
  geminiInteractionsToolBridge,
  openAICompatibleChatToolBridge,
  openAICompatibleResponsesToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "../tools/bridges";
import type { ProviderToolBridge } from "../tools/types";
import {
  createOpenAIResponsesStructuredOutputAdapter,
  createOpenRouterStructuredOutputAdapter,
  type ProviderStructuredOutputAdapter
} from "./structuredOutput";

const MAX_DISPLAY_TEXT = 256;
const MAX_SNAPSHOT_BYTES = 96 * 1024;

export type ProviderExecutionSnapshot = Readonly<{
  connection: ProviderConnectionConfiguration;
  connectionDisplayName: string;
  connectionId: string;
  credentialId: string | null;
  credentialVersionId: string | null;
  model: ProviderModelConfiguration | Readonly<{
    adapterKind: "fake";
    capabilities: ProviderModelConfiguration["capabilities"];
    defaultParams: Record<string, unknown>;
    upstreamModelId: string;
  }>;
  modelDisplayName: string;
  providerFamily: string;
  providerModelId: string;
  version: 1;
}>;

export type ProviderRuntimeFactoryOptions = Readonly<{
  allowFake: boolean;
  fetchFn?: typeof fetch;
}>;

type ProviderRuntimeComponents = Readonly<{
  adapter: ProviderAdapter;
  backgroundPollTimeoutMs?: number;
  searchAdapter?: ProviderSearchAdapter;
  structuredOutputAdapter?: ProviderStructuredOutputAdapter;
  toolBridge?: ProviderToolBridge;
}>;

export type ProviderRuntimeBinding = ProviderRuntimeComponents & Readonly<{
  responseTimeoutMs: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = MAX_DISPLAY_TEXT): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function snapshotSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Infinity;
  }
}

export function normalizeProviderExecutionSnapshot(value: unknown): ProviderExecutionSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !boundedString(value.connectionId) ||
    !boundedString(value.providerModelId) ||
    !boundedString(value.connectionDisplayName) ||
    !boundedString(value.modelDisplayName) ||
    !boundedString(value.providerFamily) ||
    snapshotSize(value) > MAX_SNAPSHOT_BYTES ||
    (value.credentialId !== null && !boundedString(value.credentialId)) ||
    (value.credentialVersionId !== null && !boundedString(value.credentialVersionId)) ||
    (value.credentialId === null) !== (value.credentialVersionId === null)
  ) {
    throw new Error("provider_execution_snapshot_invalid");
  }

  const connection = normalizeProviderConnectionConfiguration(value.connection);
  const model = isRecord(value.model) && value.model.adapterKind === "fake"
    ? {
        adapterKind: "fake" as const,
        capabilities: normalizeProviderModelCapabilities(value.model.capabilities),
        defaultParams: normalizeProviderDefaultParams(value.model.defaultParams),
        upstreamModelId: boundedString(value.model.upstreamModelId)
          ? value.model.upstreamModelId.trim()
          : (() => { throw new Error("provider_execution_snapshot_invalid"); })()
      }
    : normalizeProviderModelConfiguration(value.model);

  if (model.adapterKind === "fake" && (value.credentialId !== null || value.providerFamily !== "fake")) {
    throw new Error("provider_execution_snapshot_invalid");
  }
  if (model.adapterKind !== "fake" && (!value.credentialId || !value.credentialVersionId)) {
    throw new Error("provider_execution_snapshot_invalid");
  }
  const compatibleAdapter = model.adapterKind === "openai_chat_completions_compatible" ||
    model.adapterKind === "openai_responses_compatible" ||
    (model.adapterKind === "openai_embeddings_compatible" &&
      model.modelClass === "embedding" &&
      model.embedding?.providerFamily === "openai_compatible");
  if (
    (model.adapterKind === "gemini_interactions_native") !==
    (value.providerFamily === "gemini")
  ) {
    throw new Error("provider_execution_snapshot_invalid");
  }
  if (compatibleAdapter !== (value.providerFamily === "openai_compatible")) {
    throw new Error("provider_execution_snapshot_invalid");
  }
  if (
    model.adapterKind !== "fake" &&
    model.modelClass === "embedding" &&
    model.embedding?.providerFamily !== value.providerFamily
  ) {
    throw new Error("provider_execution_snapshot_invalid");
  }
  if (
    providerAuthenticationMode(connection) === "none" &&
    model.adapterKind !== "fake" &&
    model.adapterKind !== "openai_chat_completions_compatible" &&
    model.adapterKind !== "openai_responses_compatible" &&
    model.adapterKind !== "openai_embeddings_compatible"
  ) {
    throw new Error("provider_execution_snapshot_invalid");
  }

  return Object.freeze({
    connection,
    connectionDisplayName: value.connectionDisplayName.trim(),
    connectionId: value.connectionId.trim(),
    credentialId: value.credentialId,
    credentialVersionId: value.credentialVersionId,
    model,
    modelDisplayName: value.modelDisplayName.trim(),
    providerFamily: value.providerFamily.trim(),
    providerModelId: value.providerModelId.trim(),
    version: 1
  });
}

function requiredFetch(options: ProviderRuntimeFactoryOptions): typeof fetch {
  if (!options.fetchFn) {
    throw new Error("provider_safe_fetch_required");
  }
  return options.fetchFn;
}

const PER_REQUEST_CREDENTIAL_PLACEHOLDER = "credential-resolved-per-request";

function fetchWithPerRequestCredential(
  fetchFn: typeof fetch,
  adapterKind: Exclude<ProviderExecutionSnapshot["model"]["adapterKind"], "fake">,
  source: ProviderCredentialSource
): typeof fetch {
  if (typeof source === "string") {
    return fetchFn;
  }

  return async (request, init) => {
    const secret = await resolveProviderCredentialSource(source, "provider_credential_missing");
    const headers = new Headers(init?.headers);
    if (adapterKind === "anthropic_messages") {
      headers.set("x-api-key", secret);
    } else if (adapterKind === "gemini_interactions_native") {
      headers.delete("authorization");
      headers.set("x-goog-api-key", secret);
    } else {
      headers.set("authorization", `Bearer ${secret}`);
    }
    return fetchFn(request, { ...init, headers });
  };
}

function createProviderRuntimeBindingUnobserved(input: Readonly<{
  options: ProviderRuntimeFactoryOptions;
  secret: ProviderCredentialSource | null;
  snapshot: ProviderExecutionSnapshot;
}>): ProviderRuntimeComponents {
  const snapshot = normalizeProviderExecutionSnapshot(input.snapshot);
  const responseTimeoutMs = effectiveProviderResponseTimeoutMs(
    snapshot.connection,
    snapshot.model.adapterKind === "fake" ? null : snapshot.model
  );

  if (snapshot.model.adapterKind === "fake") {
    if (!input.options.allowFake) {
      throw new Error("fake_provider_not_allowed");
    }
    if (input.secret !== null) {
      throw new Error("provider_credential_unexpected");
    }
    return { adapter: createFakeProviderAdapter() };
  }
  if (snapshot.model.modelClass !== "answer") {
    throw new Error("provider_model_class_invalid");
  }

  const authenticationMode = providerAuthenticationMode(snapshot.connection);
  if (authenticationMode === "none") {
    if (input.secret !== null) {
      throw new Error("provider_credential_unexpected");
    }
    const fetchFn = requiredFetch(input.options);
    if (snapshot.model.adapterKind === "openai_responses_compatible") {
      const client = createFetchOpenAIResponsesClient({
        apiKey: null,
        baseUrl: snapshot.connection.apiRoot,
        defaultTimeoutMs: responseTimeoutMs,
        fetchFn
      });
      return {
        adapter: createCompatibleResponsesAdapter({
          client,
          reasoningRequestMapping: snapshot.model.reasoningRequestMapping
        }),
        structuredOutputAdapter: createOpenAIResponsesStructuredOutputAdapter({
          client,
          model: snapshot.model
        }),
        ...(snapshot.model.capabilities.nativeSearch
          ? {
              searchAdapter: createOpenAIResponsesSearchAdapter({
                client,
                provider: "openai_compatible",
                reasoningRequestMapping: snapshot.model.reasoningRequestMapping
              })
            }
          : {}),
        toolBridge: openAICompatibleResponsesToolBridge
      };
    }
    return {
      adapter: createOpenAICompatibleChatAdapter({
        client: createFetchOpenAICompatibleChatClient({
          apiRoot: snapshot.connection.apiRoot,
          authenticationMode,
          bearerToken: null,
          defaultTimeoutMs: responseTimeoutMs,
          fetchFn
        }),
        reasoningRequestMapping: snapshot.model.reasoningRequestMapping
      }),
      toolBridge: openAICompatibleChatToolBridge
    };
  }

  if (!input.secret) {
    throw new Error("provider_credential_missing");
  }
  assertProviderCredentialSource(input.secret, "provider_credential_missing");
  const fetchFn = fetchWithPerRequestCredential(
    requiredFetch(input.options),
    snapshot.model.adapterKind,
    input.secret
  );
  const clientSecret = typeof input.secret === "string"
    ? input.secret.trim()
    : PER_REQUEST_CREDENTIAL_PLACEHOLDER;
  const baseUrl = snapshot.connection.apiRoot;

  switch (snapshot.model.adapterKind) {
    case "gemini_interactions_native": {
      const client = createFetchGeminiInteractionsClient({
        apiKey: clientSecret,
        apiRoot: baseUrl,
        defaultTimeoutMs: responseTimeoutMs,
        fetchFn
      });
      return {
        adapter: createGeminiInteractionsAdapter({
          client
        }),
        ...(snapshot.model.capabilities.nativeSearch
          ? { searchAdapter: createGeminiInteractionsSearchAdapter({ client }) }
          : {}),
        toolBridge: geminiInteractionsToolBridge
      };
    }
    case "openai_responses_native": {
      const backgroundPollTimeoutMs = effectiveOpenAIBackgroundPollTimeoutMs(responseTimeoutMs);
      const client = createFetchOpenAIResponsesClient({
        apiKey: clientSecret,
        baseUrl,
        defaultTimeoutMs: responseTimeoutMs,
        fetchFn
      });
      return {
        adapter: createOpenAIResponsesAdapter({ client, pollTimeoutMs: backgroundPollTimeoutMs }),
        backgroundPollTimeoutMs,
        structuredOutputAdapter: createOpenAIResponsesStructuredOutputAdapter({
          client,
          model: snapshot.model
        }),
        ...(snapshot.model.capabilities.nativeSearch
          ? {
              searchAdapter: createOpenAIResponsesSearchAdapter({
                client,
                provider: "openai"
              })
            }
          : {}),
        toolBridge: openAIResponsesToolBridge
      };
    }
    case "openai_responses_compatible": {
      const client = createFetchOpenAIResponsesClient({
        apiKey: clientSecret,
        baseUrl,
        defaultTimeoutMs: responseTimeoutMs,
        fetchFn
      });
      return {
        adapter: createCompatibleResponsesAdapter({
          client,
          reasoningRequestMapping: snapshot.model.reasoningRequestMapping
        }),
        structuredOutputAdapter: createOpenAIResponsesStructuredOutputAdapter({
          client,
          model: snapshot.model
        }),
        ...(snapshot.model.capabilities.nativeSearch
          ? {
              searchAdapter: createOpenAIResponsesSearchAdapter({
                client,
                provider: "openai_compatible",
                reasoningRequestMapping: snapshot.model.reasoningRequestMapping
              })
            }
          : {}),
        toolBridge: openAICompatibleResponsesToolBridge
      };
    }
    case "openai_chat_completions_compatible":
      return {
        adapter: createOpenAICompatibleChatAdapter({
          client: createFetchOpenAICompatibleChatClient({
            apiRoot: baseUrl,
            authenticationMode,
            bearerToken: clientSecret,
            defaultTimeoutMs: responseTimeoutMs,
            fetchFn
          }),
          reasoningRequestMapping: snapshot.model.reasoningRequestMapping
        }),
        toolBridge: openAICompatibleChatToolBridge
      };
    case "anthropic_messages": {
      const client = createFetchAnthropicMessagesClient({
        apiKey: clientSecret,
        baseUrl,
        defaultTimeoutMs: responseTimeoutMs,
        fetchFn
      });
      return {
        adapter: createAnthropicMessagesAdapter({
          client
        }),
        ...(snapshot.model.capabilities.nativeSearch
          ? { searchAdapter: createAnthropicMessagesSearchAdapter({ client }) }
          : {}),
        toolBridge: anthropicMessagesToolBridge
      };
    }
    case "openrouter_chat_completions": {
      const client = createFetchOpenRouterChatClient({
        apiKey: clientSecret,
        baseUrl,
        defaultTimeoutMs: responseTimeoutMs,
        fetchFn
      });
      return {
        adapter: createOpenRouterChatAdapter({ client }),
        searchAdapter: createOpenRouterPerplexitySearchAdapter({ client }),
        structuredOutputAdapter: createOpenRouterStructuredOutputAdapter({
          client,
          model: snapshot.model
        }),
        toolBridge: openRouterChatToolBridge
      };
    }
    case "openai_embeddings_compatible":
    case "openrouter_rerank":
      throw new Error("provider_model_class_invalid");
  }
}

function withProviderStreamSafetyObservability(
  binding: ProviderRuntimeComponents,
  snapshot: ProviderExecutionSnapshot
): ProviderRuntimeBinding {
  const responseTimeoutMs = effectiveProviderResponseTimeoutMs(
    snapshot.connection,
    snapshot.model.adapterKind === "fake" ? null : snapshot.model
  );
  const operationTimeoutMs = (requested?: number) =>
    typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, responseTimeoutMs)
      : responseTimeoutMs;
  const adapter = binding.adapter;
  const observedAdapter: ProviderAdapter = {
    buildRequestPreview: (request) => adapter.buildRequestPreview(request),
    ...(adapter.cancel
      ? { cancel: (providerResponseId: string) => adapter.cancel!(providerResponseId) }
      : {}),
    ...(adapter.refresh
      ? { refresh: (providerResponseId: string) => adapter.refresh!(providerResponseId) }
      : {}),
    ...(adapter.retrieve
      ? { retrieve: (providerResponseId: string) => adapter.retrieve!(providerResponseId) }
      : {}),
    async *stream(request, options) {
      const timeoutMs = operationTimeoutMs(options?.timeoutMs);
      const useBackgroundPollTimeout = typeof options?.timeoutMs !== "number" &&
        typeof binding.backgroundPollTimeoutMs === "number" &&
        (request.forceNonStreaming === true || request.params.stream !== true);
      const runTimeoutMs = useBackgroundPollTimeout
        ? binding.backgroundPollTimeoutMs ?? timeoutMs
        : timeoutMs;
      const timeout = withTimeoutSignal(
        options?.signal,
        runTimeoutMs
      );
      try {
        return yield* adapter.stream(request, {
          ...options,
          signal: timeout.signal,
          timeoutMs
        });
      } catch (error) {
        warnProviderStreamSafetyOnce(error, {
          adapterKind: snapshot.model.adapterKind,
          connectionId: snapshot.connectionId,
          providerFamily: snapshot.providerFamily,
          providerModelId: snapshot.providerModelId
        });
        throw error;
      } finally {
        timeout.clear();
      }
    }
  };
  const searchAdapter = binding.searchAdapter
    ? {
        buildRequestPreview: (request: Parameters<ProviderSearchAdapter["buildRequestPreview"]>[0]) =>
          binding.searchAdapter!.buildRequestPreview(request),
        async search(
          request: Parameters<ProviderSearchAdapter["search"]>[0],
          options?: Parameters<ProviderSearchAdapter["search"]>[1]
        ) {
          const timeoutMs = operationTimeoutMs(options?.timeoutMs);
          const timeout = withTimeoutSignal(options?.signal, timeoutMs);
          try {
            return await binding.searchAdapter!.search(request, {
              ...options,
              signal: timeout.signal,
              timeoutMs
            });
          } finally {
            timeout.clear();
          }
        }
      } satisfies ProviderSearchAdapter
    : undefined;
  const structuredOutputAdapter = binding.structuredOutputAdapter
    ? {
        async execute(request, options) {
          const timeoutMs = operationTimeoutMs(options?.timeoutMs);
          const timeout = withTimeoutSignal(options?.signal, timeoutMs);
          try {
            return await binding.structuredOutputAdapter!.execute(request, {
              ...options,
              signal: timeout.signal,
              timeoutMs
            });
          } finally {
            timeout.clear();
          }
        }
      } satisfies ProviderStructuredOutputAdapter
    : undefined;
  return {
    adapter: observedAdapter,
    responseTimeoutMs,
    ...(searchAdapter ? { searchAdapter } : {}),
    ...(structuredOutputAdapter ? { structuredOutputAdapter } : {}),
    ...(binding.toolBridge ? { toolBridge: binding.toolBridge } : {})
  };
}

export function createProviderRuntimeBinding(input: Readonly<{
  options: ProviderRuntimeFactoryOptions;
  secret: ProviderCredentialSource | null;
  snapshot: ProviderExecutionSnapshot;
}>): ProviderRuntimeBinding {
  const snapshot = normalizeProviderExecutionSnapshot(input.snapshot);
  return withProviderStreamSafetyObservability(
    createProviderRuntimeBindingUnobserved({ ...input, snapshot }),
    snapshot
  );
}

export function createProviderPreviewRuntimeBinding(
  snapshot: ProviderExecutionSnapshot,
  allowFake: boolean
): ProviderRuntimeBinding {
  const normalized = normalizeProviderExecutionSnapshot(snapshot);
  const unavailableFetch: typeof fetch = async () => {
    throw new Error("provider_preview_network_forbidden");
  };
  return createProviderRuntimeBinding({
    options: {
      allowFake,
      ...(normalized.model.adapterKind === "fake" ? {} : { fetchFn: unavailableFetch })
    },
    secret: normalized.model.adapterKind === "fake" ||
      providerAuthenticationMode(normalized.connection) === "none"
      ? null
      : "preview-only",
    snapshot: normalized
  });
}
