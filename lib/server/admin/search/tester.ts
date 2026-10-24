import { admitModelGenerationBudget, modelOutputAllowance } from "../../providers/modelOutputAllowance";
import type { ProviderAdapterKind } from "../../providers/providerConfiguration";
import type { PrismaClient } from "@prisma/client";
import {
  adminSearchExecutionLimits,
  type AdminSearchDraft
} from "../../../contracts/adminSearch";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import {
  DEEPSEEK_SEARCH_API_MODEL_ID,
  DEEPSEEK_SEARCH_API_STRATEGY_ID
} from "../../providers/deepSeekSearchApi";
import { providerAuthenticationMode } from "../../providers/providerConfiguration";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import { createProviderRuntimeBinding } from "../../providers/runtimeFactory";
import { withTimeoutSignal } from "../../providers/network";
import type {
  ProviderModelCapabilities,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "../../providers/types";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import { createModelCheckUsageRecorder, type ModelCheckUsageWriter } from "../providers/modelCheckUsage";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { loadTechnicalProviderRole } from "../../providerRuntime/admission";
import { validateSearchToolArguments } from "../../search/query";
import type { AdminSearchTester } from "./service";

const connectivityQuery = "OpenAI official website";

export function adminSearchProviderPolicy(input: Readonly<{
  capabilities: ProviderModelCapabilities;
  adapterKind?: ProviderAdapterKind;
  defaultParams: Readonly<Record<string, unknown>>;
  draft: AdminSearchDraft;
  modelId: string;
  provider: string;
}>): ProviderSearchPolicy {
  const maxOutputTokens = modelOutputAllowance({ providerFamily: input.provider, model: {
    adapterKind: input.adapterKind ?? "fake", capabilities: input.capabilities, defaultParams: { ...input.defaultParams },
    upstreamModelId: input.modelId
  } }, { query: connectivityQuery }, input.draft.maxOutputTokens);
  if (input.draft.protocol === "openrouter_perplexity_chat") {
    if (input.provider !== "openrouter") throw new Error("search_protocol_not_supported");
    return {
      controls: {
        maxOutputTokens: {
          defaultValue: maxOutputTokens,
          maxValue: adminSearchExecutionLimits.maxOutputTokens.maximum
        },
        temperature: { defaultValue: 0, maxValue: 2, minValue: 0, supported: true }
      },
      defaultParams: {
        ...input.defaultParams,
        maxOutputTokens: maxOutputTokens,
        stream: false,
        temperature: 0
      },
      modelId: input.modelId,
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    };
  }
  if (input.draft.protocol === "openai_responses_web_search") {
    if (input.provider !== "openai" && input.provider !== "openai_compatible") {
      throw new Error("search_protocol_not_supported");
    }
    return {
      maxOutputTokens: maxOutputTokens,
      modelCapabilities: input.capabilities,
      modelId: input.modelId,
      provider: input.provider,
      reasoningPolicy: input.draft.reasoningPolicy,
      strategyId: "openai-responses-web-search"
    };
  }
  if (input.draft.protocol === "deepseek_search_api") {
    // One search call; the model only resolved the connection key.
    if (input.provider !== "deepseek") throw new Error("search_protocol_not_supported");
    return {
      maxResults: input.draft.maxResults,
      modelId: DEEPSEEK_SEARCH_API_MODEL_ID,
      provider: "deepseek",
      strategyId: DEEPSEEK_SEARCH_API_STRATEGY_ID
    };
  }
  if (input.draft.protocol === "deepseek_responses_web_search") {
    if (input.provider !== "deepseek") throw new Error("search_protocol_not_supported");
    return {
      maxOutputTokens: maxOutputTokens,
      modelCapabilities: input.capabilities,
      modelId: input.modelId,
      provider: "deepseek",
      reasoningPolicy: input.draft.reasoningPolicy,
      strategyId: "deepseek-responses-web-search"
    };
  }
  if (input.draft.protocol === "anthropic_web_search") {
    if (input.provider !== "anthropic") throw new Error("search_protocol_not_supported");
    return {
      maxOutputTokens: maxOutputTokens,
      modelCapabilities: input.capabilities,
      modelId: input.modelId,
      provider: "anthropic",
      reasoningPolicy: input.draft.reasoningPolicy,
      strategyId: "anthropic-web-search"
    };
  }
  if (input.draft.protocol === "gemini_google_search" && input.provider === "gemini") {
    return {
      maxOutputTokens: maxOutputTokens,
      modelCapabilities: input.capabilities,
      modelId: input.modelId,
      provider: "gemini",
      reasoningPolicy: input.draft.reasoningPolicy,
      strategyId: "gemini-google-search"
    };
  }
  throw new Error("search_protocol_not_supported");
}

async function credentialSource(
  prisma: PrismaClient,
  snapshot: Awaited<ReturnType<typeof loadTechnicalProviderRole>>["snapshot"]
): Promise<string | null> {
  if (providerAuthenticationMode(snapshot.connection) === "none") return null;
  if (!snapshot.credentialId || !snapshot.credentialVersionId) {
    throw new Error("provider_credential_missing");
  }
  const version = await prisma.providerCredentialVersion.findUnique({
    select: { credentialId: true, id: true, revokedAt: true, secretEnvelope: true },
    where: {
      credentialId_id: {
        credentialId: snapshot.credentialId,
        id: snapshot.credentialVersionId
      }
    }
  });
  if (!version || version.revokedAt || !version.secretEnvelope) {
    throw new Error("provider_credential_missing");
  }
  return decryptProviderCredentialSecret({
    credentialId: version.credentialId,
    envelope: version.secretEnvelope,
    key: getSecretEncryptionKey(),
    valueId: version.id
  });
}

export function createAdminSearchTester(prisma: PrismaClient, options: Readonly<{
  /** Writes the administrator's `model_check` usage rows; absent, checks stay unaccounted. */
  recordUsage?: ModelCheckUsageWriter;
}> = {}): AdminSearchTester {
  return {
    async currentBinding({ providerModelId, store, userId }) {
      const role = await loadTechnicalProviderRole(store, { providerModelId, userId });
      if (!role.authority) throw new Error("search_provider_model_not_available");
      return role.authority;
    },
    async test({ draft, userId, signal: parentSignal }) {
      if (draft.adapterKind === "answer_provider_hosted") {
        throw new Error("search_configuration_invalid");
      }
      if (!draft.providerModelId) throw new Error("search_provider_model_not_available");
      const role = await loadTechnicalProviderRole(prisma, {
        providerModelId: draft.providerModelId,
        userId
      });
      if (!role.authority) throw new Error("search_provider_model_not_available");
      const secret = await credentialSource(prisma, role.snapshot);
      const runtime = createProviderRuntimeBinding({
        options: {
          allowFake: false,
          fetchFn: createProviderSafeFetch({ configuration: role.snapshot.connection })
        },
        secret,
        snapshot: role.snapshot
      });
      if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
      const validatedQuery = validateSearchToolArguments(
        { query: connectivityQuery },
        draft.queryMaxCharacters
      );
      if (!validatedQuery.ok) throw new Error(validatedQuery.code);
      const searchPolicy = adminSearchProviderPolicy({
        capabilities: role.modelConfiguration.capabilities,
        ...(role.snapshot.model.adapterKind !== "fake" ? { adapterKind: role.snapshot.model.adapterKind } : {}),
        defaultParams: role.modelConfiguration.defaultParams,
        draft,
        modelId: role.snapshot.model.upstreamModelId,
        provider: role.snapshot.providerFamily
      });
      const searchRequest: ProviderSearchRequest = {
        correlationId: "search-admin-test",
        generationBudget: admitModelGenerationBudget(role.snapshot, draft.maxOutputTokens),
        query: validatedQuery.query,
        searchPolicy,
        strategyId: searchPolicy.strategyId
      };
      const timeoutMs = Math.min(draft.timeoutMs, runtime.responseTimeoutMs);
      // A probe is paid: the acting administrator is charged one `model_check`
      // row per request the exact checked deployment answered, whether the
      // check then passes, fails or was cancelled meanwhile.
      const usage = createModelCheckUsageRecorder(options.recordUsage, {
        userId, provider: role.snapshot.providerFamily, modelId: searchPolicy.modelId,
        providerModelId: role.snapshot.providerModelId,
        modelClass: "modelClass" in role.snapshot.model ? role.snapshot.model.modelClass : "answer"
      });
      async function dispatch<T>(request: Readonly<{
        body: unknown;
        cost?(value: T): number | null;
        execute(): Promise<T>;
        usage(value: T): ModelRunUsage;
      }>): Promise<T> {
        const value = await request.execute();
        try {
          usage?.record({ reportedCostUsd: request.cost?.(value) ?? null, usage: request.usage(value) });
        } catch {
          // Unreadable usage stays unknown; the adapter reports that failure itself.
        }
        return value;
      }
      const deadline = withTimeoutSignal(parentSignal, timeoutMs, "operation");
      try {
        deadline.signal.throwIfAborted();
        const result = await runtime.searchAdapter.search(searchRequest, {
          ...(usage ? { dispatch } : {}),
          signal: deadline.signal,
          timeoutMs
        });
        deadline.signal.throwIfAborted();
        const normalizedSourceCount = Math.min(result.sources.length, draft.maxResults);
        const providerSourcesUnavailable = draft.protocol === "deepseek_responses_web_search" &&
          result.sourceAttribution === "provider_unavailable";

        return {
          method: "provider_search",
          normalizedSourceCount,
          probeBinding: role.authority,
          protocol: draft.protocol,
          ...(providerSourcesUnavailable ? { sourceAttribution: "provider_unavailable" as const } : {}),
          status: normalizedSourceCount > 0 || providerSourcesUnavailable
            ? "available"
            : "unavailable"
        };
      } finally {
        deadline.clear();
        await usage?.settled();
      }
    }
  };
}
