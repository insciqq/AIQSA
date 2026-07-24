import type {
  AdminProviderCheckStatus,
  AdminProviderTestEvidence
} from "../../../contracts/adminProviders";
import {
  createOpenRouterDiscoveryClient,
  type OpenRouterDiscoveryClient
} from "../../providers/openRouterDiscovery";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import type {
  ProviderConnectionConfiguration,
  ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import type { ProviderCredentialSource } from "../../providers/providerCredentialSource";
import {
  createProviderRuntimeBinding,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../providers/types";

export type AdminProviderDraftTestMode = "account_catalog" | "tiny_generation";

export type AdminProviderDraftTesterInput = Readonly<{
  connection: ProviderConnectionConfiguration;
  connectionDisplayName: string;
  connectionId: string;
  credentialId: string;
  credentialVersionIdentity: string;
  mode: AdminProviderDraftTestMode;
  model: ProviderModelConfiguration;
  modelDisplayName: string;
  providerFamily: string;
  providerModelId: string;
  secret: ProviderCredentialSource;
  signal?: AbortSignal;
}>;

export type AdminProviderDraftTestOutcome = Readonly<{
  evidence: AdminProviderTestEvidence;
  status: AdminProviderCheckStatus;
}>;

export type AdminProviderDraftTester = Readonly<{
  test(input: AdminProviderDraftTesterInput): Promise<AdminProviderDraftTestOutcome>;
}>;

type TesterOptions = Readonly<{
  createDiscoveryClient?: (input: {
    connection: ProviderConnectionConfiguration;
    secret: ProviderCredentialSource;
  }) => OpenRouterDiscoveryClient;
  createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
}>;

function executionSnapshot(input: AdminProviderDraftTesterInput): ProviderExecutionSnapshot {
  return {
    connection: input.connection,
    connectionDisplayName: input.connectionDisplayName,
    connectionId: input.connectionId,
    credentialId: input.credentialId,
    credentialVersionId: input.credentialVersionIdentity,
    model: input.model,
    modelDisplayName: input.modelDisplayName,
    providerFamily: input.providerFamily,
    providerModelId: input.providerModelId,
    version: 1
  };
}

function tinyGenerationRequest(input: AdminProviderDraftTesterInput): ProviderRunRequest {
  const responsesAdapter = input.model.adapterKind === "openai_responses_native" ||
    input.model.adapterKind === "openai_responses_compatible";
  const maxOutputTokens = 1_000;

  return {
    attachmentIds: [],
    attachments: [],
    chatId: "provider-admin-test",
    content: { blocks: [{ text: "Reply with OK.", type: "text" }] },
    forceNonStreaming: true,
    modelCapabilities: input.model.capabilities,
    modelId: input.model.upstreamModelId,
    params: {
      ...input.model.defaultParams,
      background: false,
      maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      ...(responsesAdapter
        ? { reasoning: { effort: "none", summary: "none" } }
        : {}),
      store: false,
      stream: false
    },
    prompt: {
      developer: null,
      presetId: null,
      system: "This is an administrator-requested connectivity test."
    },
    provider: input.providerFamily,
    searchStrategy: null
  };
}

async function runTinyGeneration(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  const fetchFn = options.createFetch?.(input.connection) ?? createProviderSafeFetch({
    configuration: input.connection
  });
  const runtime = createProviderRuntimeBinding({
    options: { allowFake: false, fetchFn },
    secret: input.secret,
    snapshot: executionSnapshot(input)
  });
  const stream = runtime.adapter.stream(tinyGenerationRequest(input), {
    signal: input.signal
  });
  while (!(await stream.next()).done) {
    // The provider output is deliberately discarded and never becomes test evidence.
  }
  return {
    evidence: {
      detail: "ok",
      method: "tiny_generation",
      selectedProviders: input.model.openRouterRouting?.providers ?? [],
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available"
  };
}

async function testOpenRouterCatalog(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  if (input.model.adapterKind !== "openrouter_chat_completions") {
    throw new Error("provider_account_catalog_test_unsupported");
  }
  const routing = input.model.openRouterRouting;
  if (!routing) {
    throw new Error("provider_account_catalog_test_unsupported");
  }
  const client = options.createDiscoveryClient?.({
    connection: input.connection,
    secret: input.secret
  }) ?? createOpenRouterDiscoveryClient({
    allowPrivateNetwork: input.connection.allowPrivateNetwork,
    apiRoot: input.connection.apiRoot,
    bearerToken: input.secret
  });
  const models = await client.listModels({ signal: input.signal });
  const model = models.find(({ id }) => id === input.model.upstreamModelId);
  if (!model) {
    return {
      evidence: {
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: input.model.openRouterRouting?.providers ?? [],
        upstreamModelId: input.model.upstreamModelId
      },
      status: "unavailable"
    };
  }

  const selectedProviders = routing.providers;
  if (routing.mode === "only_selected") {
    const endpoints = await client.listModelEndpoints(input.model.upstreamModelId, {
      signal: input.signal
    });
    const endpointTags = new Set(endpoints.map(({ tag }) => tag.toLowerCase()));
    if (selectedProviders.some((provider) => !endpointTags.has(provider.toLowerCase()))) {
      return {
        evidence: {
          detail: "route_missing",
          method: "openrouter_account_catalog",
          selectedProviders,
          upstreamModelId: input.model.upstreamModelId
        },
        status: "unavailable"
      };
    }
  }

  return {
    evidence: {
      detail: "ok",
      method: "openrouter_account_catalog",
      selectedProviders,
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available"
  };
}

export function createAdminProviderDraftTester(
  options: TesterOptions = {}
): AdminProviderDraftTester {
  return {
    async test(input) {
      return input.mode === "account_catalog"
        ? testOpenRouterCatalog(input, options)
        : runTinyGeneration(input, options);
    }
  };
}
