import { Prisma, type PrismaClient } from "@prisma/client";
import { safeExternalHref } from "../../../domain/links";
import { textMessageContent } from "../../../domain/content";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { providerAuthenticationMode } from "../../providers/providerConfiguration";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import { createProviderRuntimeBinding } from "../../providers/runtimeFactory";
import type {
  ProviderRunRequest,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "../../providers/types";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { loadTechnicalProviderRole } from "../../providerRuntime/admission";
import type { AdminSearchTester } from "./service";

const connectivityQuery = "Find the official OpenAI home page and return one source.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSourceCount(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value !== "object" || value === null) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + safeSourceCount(entry, seen), 0);
  }
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "url" || key === "href") && typeof entry === "string" && safeExternalHref(entry)) {
      count += 1;
    } else {
      count += safeSourceCount(entry, seen);
    }
  }
  return count;
}

function baseRequest(input: {
  capabilities: ProviderRunRequest["modelCapabilities"];
  modelId: string;
  provider: string;
  queryMaxCharacters: number;
}): ProviderRunRequest {
  const query = connectivityQuery.slice(0, input.queryMaxCharacters);
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "search-admin-test",
    content: textMessageContent(query),
    context: {
      messages: [{ content: textMessageContent(query), id: "search-admin-query", role: "user" }],
      mode: "branch_path"
    },
    forceNonStreaming: true,
    modelCapabilities: input.capabilities,
    modelId: input.modelId,
    params: {
      background: false,
      maxOutputTokens: 512,
      max_output_tokens: 512,
      reasoning: { effort: "none", summary: "none" },
      store: false,
      stream: false,
      temperature: 0
    },
    prompt: {
      developer: "Use web search and return only a concise sourced result.",
      presetId: null,
      system: null
    },
    provider: input.provider,
    searchStrategy: null
  };
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
    async test({ draft, userId }) {
      if (draft.adapterKind === "answer_provider_hosted") {
        return {
          method: "configuration",
          normalizedSourceCount: 0,
          protocol: draft.protocol,
          status: "available"
        };
      }
      if (!draft.providerModelId) throw new Error("search_provider_model_not_available");
      const role = await loadTechnicalProviderRole(prisma, {
        providerModelId: draft.providerModelId,
        userId
      });
      const secret = await credentialSource(prisma, role.snapshot);
      const runtime = createProviderRuntimeBinding({
        options: {
          allowFake: false,
          fetchFn: createProviderSafeFetch({ configuration: role.snapshot.connection })
        },
        secret,
        snapshot: role.snapshot
      });
      const request = baseRequest({
        capabilities: role.modelConfiguration.capabilities,
        modelId: role.snapshot.model.upstreamModelId,
        provider: role.snapshot.providerFamily,
        queryMaxCharacters: draft.queryMaxCharacters
      });
      const signal = AbortSignal.timeout(draft.timeoutMs);
      let normalizedSourceCount = 0;

      if (draft.protocol === "openrouter_perplexity_chat") {
        if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
        const searchPolicy: ProviderSearchPolicy = {
          controls: {
            maxOutputTokens: { defaultValue: 512, maxValue: 2_048 },
            temperature: { defaultValue: 0, maxValue: 2, minValue: 0, supported: true }
          },
          defaultParams: { maxOutputTokens: 512, stream: false, temperature: 0 },
          modelId: request.modelId,
          provider: "openrouter",
          strategyId: "perplexity-tool-search"
        };
        const searchRequest: ProviderSearchRequest = {
          ...request,
          answerModelId: "search-admin-test",
          answerProvider: "search-admin-test",
          searchModelId: request.modelId,
          searchPolicy,
          searchStrategy: "perplexity-tool-search",
          strategyId: "perplexity-tool-search"
        };
        const result = await runtime.searchAdapter.search(searchRequest, { signal });
        normalizedSourceCount = safeSourceCount(result.artifacts) +
          safeSourceCount(result.finalProviderResponsePreview);
      } else if (draft.protocol === "openai_responses_web_search") {
        const events: unknown[] = [];
        const stream = runtime.adapter.stream({
          ...request,
          searchStrategy: "openai-native-web-search"
        }, { signal });
        let next = await stream.next();
        while (!next.done) {
          if (next.value.type === "artifact") events.push(next.value.data);
          next = await stream.next();
        }
        normalizedSourceCount = safeSourceCount(events) +
          safeSourceCount(next.value.finalProviderResponsePreview);
      } else {
        throw new Error("search_protocol_not_supported");
      }

      return {
        method: "provider_search",
        normalizedSourceCount,
        protocol: draft.protocol,
        status: normalizedSourceCount > 0 ? "available" : "unavailable"
      };
    }
  };
}
