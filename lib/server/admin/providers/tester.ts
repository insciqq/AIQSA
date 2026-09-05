import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
import type {
  AdminProviderCheckStatus,
  AdminProviderCompatibilityStatus,
  AdminProviderTestEvidence
} from "../../../contracts/adminProviders";
import {
  createOpenRouterDiscoveryClient,
  type OpenRouterDiscoveryClient
} from "../../providers/openRouterDiscovery";
import { createProviderSafeFetch } from "../../providers/providerSafeFetch";
import { createOpenAICompatibleEmbeddingAdapter } from "../../providers/embeddings";
import { createOpenRouterRerankAdapter } from "../../providers/rerank";
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
import {
  forcedToolCallVerificationEvidence,
  supportsForcedToolCallProbe
} from "../../providers/forcedToolCallEvidence";
import {
  createProviderPdfInputProbe,
  type ProviderPdfInputProbe
} from "../../providers/pdfInputProbe";
import { supportsPdfInputAdapter } from "../../providers/pdfInputEvidence";
import { createProviderVisionInputProbe } from "../../providers/visionInputProbe";
import { decodeVisionInputVerificationEvidence } from "../../providers/visionInputEvidence";
import {
  ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
  unsupportedAdminProviderCompatibilityEvidence
} from "./compatibilityEvidence";

export type AdminProviderDraftTestMode = "account_catalog" | "tiny_generation";

export type AdminProviderDraftTesterInput = Readonly<{
  connection: ProviderConnectionConfiguration;
  connectionDisplayName: string;
  connectionId: string;
  credentialId: string;
  credentialVersionIdentity: string;
  mode: AdminProviderDraftTestMode;
  capabilityRole?: SystemModelVerificationRole;
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
  pdfInputProbe?: ProviderPdfInputProbe;
}>;

type ResolvedTesterOptions = TesterOptions & Readonly<{
  pdfInputProbe: ProviderPdfInputProbe;
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

function generationRequest(
  input: AdminProviderDraftTesterInput,
  streaming: boolean
): ProviderRunRequest {
  const responsesAdapter = input.model.adapterKind === "openai_responses_native" ||
    input.model.adapterKind === "openai_responses_compatible" ||
    input.model.adapterKind === "deepseek_responses_native";
  const maxOutputTokens = 1_000;

  return {
    attachmentIds: [],
    attachments: [],
    chatId: "provider-admin-test",
    content: { blocks: [{ text: "Reply with exactly OK.", type: "text" }] },
    forceNonStreaming: !streaming,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      ...input.model.capabilities,
      ...(streaming ? { streaming: true, streamUsage: true } : {})
    },
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
      stream: streaming
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

const forcedToolCallProbeName = "aiqsa_forced_tool_call_probe";
const forcedToolCallProbeSchema = Object.freeze({
  additionalProperties: false,
  properties: {
    nonce: { enum: ["aiqsa-control-ready"], type: "string" }
  },
  required: ["nonce"],
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

async function runForcedToolCallProbe(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
) {
  const runtime = providerRuntime(input, options);
  if (
    input.model.modelClass !== "answer" ||
    input.model.capabilities.toolCalling !== true ||
    !supportsForcedToolCallProbe(input.model.adapterKind) ||
    !runtime.toolBridge
  ) throw new Error("forced_tool_call_adapter_unsupported");
  const request = generationRequest(input, false);
  const stream = runtime.adapter.stream({
    ...request,
    content: {
      blocks: [{
        text: "Call the supplied function exactly once with nonce aiqsa-control-ready.",
        type: "text"
      }]
    },
    modelCapabilities: {
      ...request.modelCapabilities,
      toolCalling: true
    },
    parallelToolCalls: false,
    params: {
      ...request.params,
      ...(input.model.adapterKind === "openrouter_chat_completions"
        ? { reasoning: { enabled: false, exclude: true } }
        : {}),
      maxOutputTokens: 128,
      max_output_tokens: 128
    },
    prompt: {
      developer: null,
      system: "This is a bounded capability probe. Call the single strict function; do not answer with text."
    },
    toolChoice: "required",
    toolMode: "auto",
    tools: [{
      capability: "memory",
      description: "Confirm support for one forced strict Memory utility call.",
      inputSchema: forcedToolCallProbeSchema,
      name: forcedToolCallProbeName,
      strict: true
    }]
  }, { signal: input.signal });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  const calls = next.value.toolCalls;
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== forcedToolCallProbeName ||
    Object.keys(call.arguments).length !== 1 ||
    call.arguments.nonce !== "aiqsa-control-ready"
  ) throw new Error("forced_tool_call_probe_invalid");
  const evidence = forcedToolCallVerificationEvidence(
    input.model.adapterKind,
    input.model.upstreamModelId
  );
  if (!evidence) throw new Error("forced_tool_call_adapter_unsupported");
  return evidence;
}

type CapabilityProbeResult<Evidence> = Readonly<{
  evidence: Evidence | null;
  status: AdminProviderCompatibilityStatus;
}>;

type GenerationProbeResult = Readonly<{
  status: AdminProviderCompatibilityStatus;
  usageSeen: boolean;
}>;

// Capability probes run only after the same exact route has completed the
// ordinary access request. A capability-only 404 therefore means that the
// pinned route could not satisfy the requested wire contract (OpenRouter uses
// this for "no endpoint supports these parameters"), not that access to the
// model is unknown. The later streaming request still guards route liveness.
const deterministicCapabilityHttpStatuses = new Set([400, 404, 405, 415, 422]);
const testWideErrorCodes = new Set([
  "provider_request_timed_out",
  "provider_response_too_large",
  "provider_stream_deadline_exceeded",
  "provider_stream_event_too_large",
  "provider_stream_timeout",
  "provider_stream_too_large"
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerHttpStatus(error: unknown): number | null {
  const candidate = record(error);
  if (Number.isSafeInteger(candidate?.status)) return Number(candidate?.status);
  const message = error instanceof Error ? error.message : "";
  const match = /request failed with status (\d{3})$/u.exec(message);
  return match ? Number(match[1]) : null;
}

function isTestWideCapabilityFailure(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  const candidate = record(error);
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  if (code?.startsWith("provider_http_") || code && testWideErrorCodes.has(code)) {
    return true;
  }
  const status = providerHttpStatus(error);
  return status !== null && !deterministicCapabilityHttpStatuses.has(status);
}

function preserveTestWideFailure(
  input: AdminProviderDraftTesterInput,
  error: unknown
): void {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? error;
  }
  if (isTestWideCapabilityFailure(error)) throw error;
}

async function testStructuredOutput(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
): Promise<CapabilityProbeResult<NonNullable<AdminProviderTestEvidence["structuredOutput"]>>> {
  if (
    input.model.modelClass !== "answer" ||
    !supportsStructuredOutputAdapter(input.model.adapterKind)
  ) {
    return { evidence: null, status: "not_supported" };
  }
  try {
    return {
      evidence: await runStructuredOutputProbe(input, options),
      status: "verified"
    };
  } catch (error) {
    preserveTestWideFailure(input, error);
    return { evidence: null, status: "not_supported" };
  }
}

async function testForcedToolCall(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
): Promise<CapabilityProbeResult<NonNullable<AdminProviderTestEvidence["forcedToolCall"]>>> {
  if (
    input.model.modelClass !== "answer" ||
    input.model.capabilities.toolCalling !== true ||
    !supportsForcedToolCallProbe(input.model.adapterKind)
  ) return { evidence: null, status: "not_supported" };
  try {
    return {
      evidence: await runForcedToolCallProbe(input, options),
      status: "verified"
    };
  } catch (error) {
    preserveTestWideFailure(input, error);
    return { evidence: null, status: "not_supported" };
  }
}

async function testPdfInput(
  input: AdminProviderDraftTesterInput,
  options: ResolvedTesterOptions
): Promise<CapabilityProbeResult<NonNullable<AdminProviderTestEvidence["pdfInput"]>>> {
  if (
    input.model.modelClass !== "answer" ||
    !supportsPdfInputAdapter(input.model.adapterKind)
  ) {
    return { evidence: null, status: "not_supported" };
  }
  try {
    const evidence = await options.pdfInputProbe.probe({
      connection: input.connection,
      connectionDisplayName: input.connectionDisplayName,
      connectionId: input.connectionId,
      credentialId: input.credentialId,
      credentialVersionId: input.credentialVersionIdentity,
      model: input.model,
      modelDisplayName: input.modelDisplayName,
      providerFamily: input.providerFamily,
      providerModelId: input.providerModelId,
      secret: input.secret,
      ...(input.signal ? { signal: input.signal } : {})
    });
    return evidence
      ? { evidence, status: "verified" }
      : { evidence: null, status: "not_supported" };
  } catch (error) {
    preserveTestWideFailure(input, error);
    return { evidence: null, status: "not_supported" };
  }
}

async function runGenerationProbe(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions,
  streaming: boolean
): Promise<GenerationProbeResult> {
  const stream = providerRuntime(input, options).adapter.stream(
    generationRequest(input, streaming),
    { signal: input.signal }
  );
  let usageSeen = false;
  try {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "usage") usageSeen = true;
      next = await stream.next();
    }
    if (
      !usageSeen &&
      (input.model.adapterKind === "openai_chat_completions_compatible" ||
        input.model.adapterKind === "openrouter_chat_completions") &&
      record(next.value.finalProviderResponsePreview.usage)
    ) {
      usageSeen = true;
    }
    return { status: "verified", usageSeen };
  } catch (error) {
    if (!streaming) throw error;
    preserveTestWideFailure(input, error);
    return { status: "not_supported", usageSeen };
  }
}

async function testEmbedding(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions,
  method: AdminProviderTestEvidence["method"],
  selectedProviders: string[]
): Promise<AdminProviderDraftTestOutcome> {
  const fetchFn = options.createFetch?.(input.connection) ?? createProviderSafeFetch({
    configuration: input.connection
  });
  const adapter = createOpenAICompatibleEmbeddingAdapter({
    connection: input.connection,
    model: input.model,
    network: { fetchFn },
    secret: input.secret
  });
  const result = await adapter.embed({
    mode: "document",
    signal: input.signal,
    texts: ["AIQSA provider compatibility check"]
  });
  await adapter.embed({ mode: "query", signal: input.signal, texts: ["AIQSA provider compatibility query"] });
  const usage = result.usage.inputTokens !== null || result.usage.totalTokens !== null
    ? "verified"
    : "not_supported";

  return {
    evidence: {
      embedding: { probeVersion: 1, document: true, query: true, dimensions: result.vectors[0]!.length },
      compatibility: {
        directPdf: "not_supported",
        modelAccess: "verified",
        probeVersion: ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
        streaming: "not_supported",
        structuredOutput: "not_supported",
        usage
      },
      detail: "ok",
      method,
      selectedProviders,
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available"
  };
}

async function testReranker(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions,
  method: AdminProviderTestEvidence["method"],
  selectedProviders: string[]
): Promise<AdminProviderDraftTestOutcome> {
  const fetchFn = options.createFetch?.(input.connection) ?? createProviderSafeFetch({
    configuration: input.connection
  });
  const result = await createOpenRouterRerankAdapter({
    connection: input.connection,
    model: input.model,
    network: { fetchFn },
    secret: input.secret ?? (() => Promise.reject(new Error("provider_credential_missing")))
  }).rerank({
    documents: [
      { handle: "probe-0", text: "A bounded unrelated provider check." },
      { handle: "probe-1", text: "AIQSA reranker compatibility check." }
    ],
    query: "AIQSA reranker compatibility check",
    signal: input.signal
  });
  const usage = result.usage.inputTokens !== null ||
    result.usage.totalTokens !== null || result.usage.searchUnits !== null
    ? "verified"
    : "not_supported";
  return {
    evidence: {
      reranking: { probeVersion: 1, completeScores: true },
      compatibility: {
        directPdf: "not_supported",
        modelAccess: "verified",
        probeVersion: ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
        streaming: "not_supported",
        structuredOutput: "not_supported",
        usage
      },
      detail: "ok",
      method,
      selectedProviders,
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available"
  };
}

async function testVisionInput(input: AdminProviderDraftTesterInput, options: TesterOptions) {
  let visionInput: AdminProviderTestEvidence["visionInput"];
  if (input.model.capabilities.vision === true) {
    try {
      const probe = createProviderVisionInputProbe({
        execute: async (_snapshot, request, execution) => {
          const stream = providerRuntime(input, options).adapter.stream(request, execution);
          let next = await stream.next();
          while (!next.done) next = await stream.next();
          return next.value;
        }
      });
      if (await probe.probe(executionSnapshot(input), input.signal)) {
        visionInput = decodeVisionInputVerificationEvidence({
          adapterKind: input.model.adapterKind,
          probeVersion: 1,
          upstreamModelId: input.model.upstreamModelId,
          verified: true
        }) ?? undefined;
      }
    } catch (error) {
      preserveTestWideFailure(input, error);
    }
  }
  return visionInput;
}

async function testAnswerModel(
  input: AdminProviderDraftTesterInput,
  options: ResolvedTesterOptions,
  method: AdminProviderTestEvidence["method"],
  selectedProviders: string[]
): Promise<AdminProviderDraftTestOutcome> {
  const access = await runGenerationProbe(input, options, false);
  const structuredOutput = await testStructuredOutput(input, options);
  const forcedToolCall = await testForcedToolCall(input, options);
  const pdfInput = await testPdfInput(input, options);
  const visionInput = await testVisionInput(input, options);
  const streaming = await runGenerationProbe(input, options, true);

  return {
    evidence: {
      compatibility: {
        directPdf: pdfInput.status,
        ...(input.model.capabilities.vision === true
          ? { vision: visionInput ? "verified" as const : "not_supported" as const } : {}),
        ...(input.model.capabilities.toolCalling === true &&
          supportsForcedToolCallProbe(input.model.adapterKind)
          ? { forcedToolCall: forcedToolCall.status }
          : {}),
        modelAccess: access.status,
        probeVersion: ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
        streaming: streaming.status,
        structuredOutput: structuredOutput.status,
        usage: access.usageSeen || streaming.usageSeen ? "verified" : "not_supported"
      },
      detail: "ok",
      method,
      selectedProviders,
      ...(pdfInput.evidence ? { pdfInput: pdfInput.evidence } : {}),
      ...(visionInput ? { visionInput } : {}),
      ...(forcedToolCall.evidence
        ? { forcedToolCall: forcedToolCall.evidence }
        : {}),
      ...(structuredOutput.evidence
        ? { structuredOutput: structuredOutput.evidence }
        : {}),
      upstreamModelId: input.model.upstreamModelId
    },
    status: "available"
  };
}

async function testSystemRole(
  input: AdminProviderDraftTesterInput,
  options: ResolvedTesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  if (input.capabilityRole === "embedding") return testEmbedding(input, options, "tiny_generation", input.model.openRouterRouting?.providers ?? []);
  if (input.capabilityRole === "reranker") return testReranker(input, options, "tiny_generation", input.model.openRouterRouting?.providers ?? []);
  const access = await runGenerationProbe(input, options, false);
  const structured = input.capabilityRole === "memory" ? await testStructuredOutput(input, options) : null;
  const forced = input.capabilityRole === "memory" ? await testForcedToolCall(input, options) : null;
  const pdf = input.capabilityRole === "direct_pdf" ? await testPdfInput(input, options) : null;
  const vision = input.capabilityRole === "vision" ? await testVisionInput(input, options) : undefined;
  return { status: "available", evidence: {
    compatibility: {
      probeVersion: ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
      modelAccess: access.status, streaming: "not_supported", usage: access.usageSeen ? "verified" : "not_supported",
      structuredOutput: structured?.status ?? "not_supported", forcedToolCall: forced?.status ?? "not_supported",
      directPdf: pdf?.status ?? "not_supported", vision: vision ? "verified" : "not_supported"
    },
    detail: "ok", method: "tiny_generation", selectedProviders: input.model.openRouterRouting?.providers ?? [],
    upstreamModelId: input.model.upstreamModelId,
    ...(structured?.evidence ? { structuredOutput: structured.evidence } : {}),
    ...(forced?.evidence ? { forcedToolCall: forced.evidence } : {}),
    ...(pdf?.evidence ? { pdfInput: pdf.evidence } : {}), ...(vision ? { visionInput: vision } : {})
  } };
}

async function runTinyGeneration(
  input: AdminProviderDraftTesterInput,
  options: ResolvedTesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  const selectedProviders = input.model.openRouterRouting?.providers ?? [];
  if (input.model.modelClass === "embedding") {
    return testEmbedding(input, options, "tiny_generation", selectedProviders);
  }
  if (input.model.modelClass === "reranker") {
    return testReranker(input, options, "tiny_generation", selectedProviders);
  }
  return testAnswerModel(input, options, "tiny_generation", selectedProviders);
}

async function testOpenRouterCatalog(
  input: AdminProviderDraftTesterInput,
  options: ResolvedTesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  if (input.providerFamily !== "openrouter") {
    throw new Error("provider_account_catalog_test_unsupported");
  }
  const routing = input.model.openRouterRouting;
  if (input.model.modelClass !== "embedding" && !routing) {
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
    : input.model.modelClass === "reranker"
      ? await client.listRerankModels({ signal: input.signal })
      : await client.listModels({ signal: input.signal });
  const model = models.find(({ id }) => id === input.model.upstreamModelId);
  if (!model) {
    return {
      evidence: {
        compatibility: unsupportedAdminProviderCompatibilityEvidence(),
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
          compatibility: unsupportedAdminProviderCompatibilityEvidence(),
          detail: "route_missing",
          method: "openrouter_account_catalog",
          selectedProviders,
          upstreamModelId: input.model.upstreamModelId
        },
        status: "unavailable"
      };
    }
  }

  if (input.model.modelClass === "embedding") {
    return testEmbedding(input, options, "openrouter_account_catalog", selectedProviders);
  }
  if (input.model.modelClass === "reranker") {
    return testReranker(input, options, "openrouter_account_catalog", selectedProviders);
  }
  return testAnswerModel(input, options, "openrouter_account_catalog", selectedProviders);
}

export function createAdminProviderDraftTester(
  options: TesterOptions = {}
): AdminProviderDraftTester {
  const resolvedOptions: ResolvedTesterOptions = {
    ...options,
    pdfInputProbe: options.pdfInputProbe ?? createProviderPdfInputProbe({
      ...(options.createFetch ? { createFetch: options.createFetch } : {})
    })
  };
  return {
    async test(input) {
      if (input.capabilityRole) return testSystemRole(input, resolvedOptions);
      return input.mode === "account_catalog"
        ? testOpenRouterCatalog(input, resolvedOptions)
        : runTinyGeneration(input, resolvedOptions);
    }
  };
}
