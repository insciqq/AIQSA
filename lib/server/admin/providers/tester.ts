import type {
  AdminProviderCheckStatus,
  AdminProviderTestEvidence
} from "../../../contracts/adminProviders";
import {
  createOpenRouterDiscoveryClient,
  type OpenRouterDiscoveryClient
} from "../../providers/openRouterDiscovery";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import { createOpenAICompatibleEmbeddingAdapter } from "../../providers/embeddings";
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
import {
  supportsStructuredOutputAdapter,
  type ProviderStructuredOutputAdapter
} from "../../providers/structuredOutput";
import { structuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";

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
  secret: ProviderCredentialSource | null;
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
    knowledgePlan: { baseIds: [] },
    toolMode: "auto",
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
      system: "This is an administrator-requested connectivity test."
    },
    provider: input.providerFamily,
    searchPlan: { mode: "all_selected", options: [] }
  };
}

const structuredOutputProbeSchema = Object.freeze({
  additionalProperties: false,
  properties: {
    count: { type: "integer" },
    label: { minLength: 1, type: "string" },
    ready: { type: "boolean" },
    tool_ids: {
      items: { enum: ["alpha", "beta"], type: "string" },
      maxItems: 2,
      type: "array",
      uniqueItems: true
    }
  },
  required: ["ready", "count", "label", "tool_ids"],
  type: "object"
});

function validStructuredOutputProbe(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === 4 && keys[0] === "count" && keys[1] === "label" &&
    keys[2] === "ready" && keys[3] === "tool_ids" &&
    typeof value.ready === "boolean" &&
    Number.isInteger(value.count) && typeof value.label === "string" &&
    value.label.trim().length > 0 && Array.isArray(value.tool_ids) &&
    value.tool_ids.length === 2 && value.tool_ids[0] === "alpha" &&
    value.tool_ids[1] === "beta";
}

function providerRuntime(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
) {
  const fetchFn = options.createFetch?.(input.connection) ?? createProviderSafeFetch({
    configuration: input.connection
  });
  return createProviderRuntimeBinding({
    options: { allowFake: false, fetchFn },
    secret: input.secret,
    snapshot: executionSnapshot(input)
  });
}

async function runStructuredOutputProbe(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
) {
  const adapter: ProviderStructuredOutputAdapter | undefined =
    providerRuntime(input, options).structuredOutputAdapter;
  if (!adapter) throw new Error("structured_output_adapter_unsupported");
  const output = await adapter.execute({
    maxOutputTokens: 128,
    name: "aiqsa_structured_output_probe",
    schema: structuredOutputProbeSchema,
    systemPrompt: "Return only the object required by the supplied strict JSON Schema.",
    userPrompt: "Return ready=true, count=2, a non-empty label, and tool_ids=[alpha,beta]."
  }, { signal: input.signal });
  if (!validStructuredOutputProbe(output)) {
    throw new Error("structured_output_probe_invalid");
  }
  const evidence = structuredOutputVerificationEvidence(
    input.model.adapterKind,
    input.model.upstreamModelId
  );
  if (!evidence) throw new Error("structured_output_adapter_unsupported");
  return evidence;
}

async function runTinyGeneration(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  if (input.model.modelClass === "embedding") {
    const fetchFn = options.createFetch?.(input.connection) ?? createProviderSafeFetch({
      configuration: input.connection
    });
    await createOpenAICompatibleEmbeddingAdapter({
      connection: input.connection,
      model: input.model,
      network: { fetchFn },
      secret: input.secret
    }).embed({
      mode: "document",
      signal: input.signal,
      texts: ["AIQSA provider connectivity check"]
    });
    return {
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: input.model.upstreamModelId
      },
      status: "available"
    };
  }
  if (supportsStructuredOutputAdapter(input.model.adapterKind)) {
    const structuredOutput = await runStructuredOutputProbe(input, options);
    return {
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: input.model.openRouterRouting?.providers ?? [],
        structuredOutput,
        upstreamModelId: input.model.upstreamModelId
      },
      status: "available"
    };
  }
  const runtime = providerRuntime(input, options);
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
  if (input.providerFamily !== "openrouter") {
    throw new Error("provider_account_catalog_test_unsupported");
  }
  const routing = input.model.openRouterRouting;
  if (input.model.modelClass === "answer" && !routing) {
    throw new Error("provider_account_catalog_test_unsupported");
  }
  if (input.secret === null) {
    throw new Error("provider_credential_missing");
  }
  const client = options.createDiscoveryClient?.({
    connection: input.connection,
    secret: input.secret
  }) ?? createOpenRouterDiscoveryClient({
    allowPrivateNetwork: input.connection.allowPrivateNetwork,
    apiRoot: input.connection.apiRoot,
    bearerToken: input.secret,
    responseTimeoutMs: input.connection.responseTimeoutMs
  });
  const models = input.model.modelClass === "embedding"
    ? await client.listEmbeddingModels({ signal: input.signal })
    : await client.listModels({ signal: input.signal });
  const model = models.find(({ id }) => id === input.model.upstreamModelId);
  if (!model) {
    return {
      evidence: {
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: routing?.providers ?? [],
        upstreamModelId: input.model.upstreamModelId
      },
      status: "unavailable"
    };
  }

  const selectedProviders = routing?.providers ?? [];
  if (routing?.mode === "only_selected") {
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

  const structuredOutput = input.model.modelClass === "answer"
    ? await runStructuredOutputProbe(input, options)
    : null;

  return {
    evidence: {
      detail: "ok",
      method: "openrouter_account_catalog",
      selectedProviders,
      ...(structuredOutput ? { structuredOutput } : {}),
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
