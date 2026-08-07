import { textMessageContent } from "../../../domain/content";
import { searchSourcesFromCitationArtifacts } from "../../search/evidence";
import {
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import {
  createProviderSafeFetch,
  type ProviderSafeFetchOptions
} from "../../providers/providerSafeFetch";
import { createProviderRuntimeBinding } from "../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../providers/types";

const connectivityQuery = "Find the official OpenAI home page and return one source.";

export type AdminProviderQuickSetupSearchTestOutcome = Readonly<{
  normalizedSourceCount: number;
  status: "available" | "unavailable";
}>;

export type AdminProviderQuickSetupSearchTester = Readonly<{
  test(input: Readonly<{
    connection: ProviderConnectionConfiguration;
    model: ProviderModelConfiguration;
    secret: string;
    signal?: AbortSignal;
  }>): Promise<AdminProviderQuickSetupSearchTestOutcome>;
}>;

function providerFamily(model: ProviderModelConfiguration): "openai" | "openai_compatible" {
  if (model.adapterKind === "openai_responses_native") return "openai";
  if (model.adapterKind === "openai_responses_compatible") return "openai_compatible";
  throw new Error("provider_search_probe_model_invalid");
}

function request(
  model: ProviderModelConfiguration,
  provider: "openai" | "openai_compatible"
): ProviderRunRequest {
  const content = textMessageContent(connectivityQuery);
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "provider-quick-setup-search-probe",
    content,
    context: {
      messages: [{
        content,
        id: "provider-quick-setup-search-query",
        role: "user"
      }],
      mode: "branch_path"
    },
    forceNonStreaming: true,
    modelCapabilities: model.capabilities,
    modelId: model.upstreamModelId,
    params: {
      ...model.defaultParams,
      background: false,
      maxOutputTokens: 1_024,
      reasoning: { effort: "none", summary: "none" },
      store: false,
      stream: false
    },
    prompt: {
      developer: "Use web search for this fixed connectivity check and return a concise sourced result.",
      system: null
    },
    provider,
    searchStrategy: "openai-native-web-search"
  };
}

export function createAdminProviderQuickSetupSearchTester(
  options: Readonly<{ network?: Omit<ProviderSafeFetchOptions, "configuration"> }> = {}
): AdminProviderQuickSetupSearchTester {
  return {
    async test(input) {
      const family = providerFamily(input.model);
      const runtime = createProviderRuntimeBinding({
        options: {
          allowFake: false,
          fetchFn: createProviderSafeFetch({
            configuration: input.connection,
            ...options.network
          })
        },
        secret: input.secret,
        snapshot: {
          connection: input.connection,
          connectionDisplayName: "OpenAI",
          connectionId: "provider-quick-setup-search-probe",
          credentialId: "provider-quick-setup-search-probe",
          credentialVersionId: "provider-quick-setup-search-probe",
          model: input.model,
          modelDisplayName: input.model.upstreamModelId,
          providerFamily: family,
          providerModelId: "provider-quick-setup-search-probe",
          version: 1
        }
      });
      const artifacts: unknown[] = [];
      const stream = runtime.adapter.stream(request(input.model, family), {
        ...(input.signal ? { signal: input.signal } : {})
      });
      let next = await stream.next();
      while (!next.done) {
        if (next.value.type === "artifact") artifacts.push(next.value);
        next = await stream.next();
      }
      const normalizedSourceCount = searchSourcesFromCitationArtifacts(
        artifacts as import("../../../domain/modelRunEvents").ModelRunSseEvent[],
        8
      ).length;
      return {
        normalizedSourceCount,
        status: normalizedSourceCount > 0 ? "available" : "unavailable"
      };
    }
  };
}
