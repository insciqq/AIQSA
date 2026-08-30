import type { PrismaClient } from "@prisma/client";
import {
  adminSearchExecutionLimits,
  type AdminSearchDraft
} from "../../../contracts/adminSearch";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { providerAuthenticationMode } from "../../providers/providerConfiguration";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import { createProviderRuntimeBinding } from "../../providers/runtimeFactory";
import type {
  ProviderModelCapabilities,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "../../providers/types";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { loadTechnicalProviderRole } from "../../providerRuntime/admission";
import { validateSearchToolArguments } from "../../search/query";
import type { AdminSearchTester } from "./service";

const connectivityQuery = "Find the official OpenAI home page and return one source.";

export function adminSearchProviderPolicy(input: Readonly<{
  capabilities: ProviderModelCapabilities;
  defaultParams: Readonly<Record<string, unknown>>;
  draft: AdminSearchDraft;
  modelId: string;
  provider: string;
}>): ProviderSearchPolicy {
  if (input.draft.protocol === "openrouter_perplexity_chat") {
    if (input.provider !== "openrouter") throw new Error("search_protocol_not_supported");
    return {
      controls: {
        maxOutputTokens: {
          defaultValue: input.draft.maxOutputTokens,
          maxValue: adminSearchExecutionLimits.maxOutputTokens.maximum
        },
        temperature: { defaultValue: 0, maxValue: 2, minValue: 0, supported: true }
      },
      defaultParams: {
        ...input.defaultParams,
        maxOutputTokens: input.draft.maxOutputTokens,
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
      maxOutputTokens: input.draft.maxOutputTokens,
      modelCapabilities: input.capabilities,
      modelId: input.modelId,
      provider: input.provider,
      reasoningPolicy: input.draft.reasoningPolicy,
      strategyId: "openai-responses-web-search"
    };
  }
  if (input.draft.protocol === "deepseek_responses_web_search") {
    if (input.provider !== "deepseek") throw new Error("search_protocol_not_supported");
    return {
      maxOutputTokens: input.draft.maxOutputTokens,
      modelCapabilities: input.capabilities,
      modelId: input.modelId,
      provider: "deepseek",
      reasoningPolicy: input.draft.reasoningPolicy,
      strategyId: "deepseek-responses-web-search"
    };
  }
  if (input.draft.protocol === "gemini_google_search" && input.provider === "gemini") {
    return {
      maxOutputTokens: input.draft.maxOutputTokens,
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

export function createAdminSearchTester(prisma: PrismaClient): AdminSearchTester {
  return {
    async currentBinding({ providerModelId, store, userId }) {
      const role = await loadTechnicalProviderRole(store, { providerModelId, userId });
      if (!role.authority) throw new Error("search_provider_model_not_available");
      return role.authority;
    },
    async test({ draft, userId }) {
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
      const signal = AbortSignal.timeout(draft.timeoutMs);
      if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
      const validatedQuery = validateSearchToolArguments(
        { query: connectivityQuery },
        draft.queryMaxCharacters
      );
      if (!validatedQuery.ok) throw new Error(validatedQuery.code);
      const searchPolicy = adminSearchProviderPolicy({
        capabilities: role.modelConfiguration.capabilities,
        defaultParams: role.modelConfiguration.defaultParams,
        draft,
        modelId: role.snapshot.model.upstreamModelId,
        provider: role.snapshot.providerFamily
      });
      const searchRequest: ProviderSearchRequest = {
        correlationId: "search-admin-test",
        query: validatedQuery.query,
        searchPolicy,
        strategyId: searchPolicy.strategyId
      };
      const result = await runtime.searchAdapter.search(searchRequest, {
        signal,
        timeoutMs: draft.timeoutMs
      });
      const normalizedSourceCount = Math.min(result.sources.length, draft.maxResults);
      const providerSourcesUnavailable = draft.protocol === "deepseek_responses_web_search" &&
        result.sourceAttribution === "provider_unavailable";

      return {
        method: "provider_search",
        normalizedSourceCount,
        probeBinding: role.authority,
        protocol: draft.protocol,
        status: normalizedSourceCount > 0 || providerSourcesUnavailable
          ? "available"
          : "unavailable"
      };
    }
  };
}
