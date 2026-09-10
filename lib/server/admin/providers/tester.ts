import { capabilityFailureAttempt, retryCapabilityAttempt } from "./capabilityProbeFailure";
import { isRetryableProviderNetworkError } from "../../providers/providerRetry";
import { testImageCapabilities } from "./imageCapabilityProbe";
import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
import type {
  AdminProviderCapabilityAttempt,
  AdminProviderCheckStatus,
  AdminProviderCapabilityCheck,
  AdminProviderCapabilityCheckStatus,
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
import type { ProviderRunRequest, ProviderRunResult } from "../../providers/types";
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
import { declaredModelOutputTokenLimit, lowestConfiguredReasoningEffort } from "../../providers/providerModelCapabilities";
import { withTimeoutSignal } from "../../providers/network";
import { decodeParallelToolCallVerificationEvidence } from "../../providers/parallelToolCallEvidence";
import { INITIAL_CAPABILITY_MODEL_TIMEOUT_MS, INITIAL_CAPABILITY_SETUP_POLICY_VERSION,
  reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
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
  /** Initial setup authorizes probing and enabling implemented capabilities. */
  initialSetup?: boolean;
  /** Internal only: caller already fenced all exact-current tuple revisions. */
  reuseSetupEvidence?: AdminProviderTestEvidence;
  /** Exact-current proof to retain if a full refresh is inconclusive. */
  priorEvidence?: AdminProviderTestEvidence;
  /** Internal probe controls; never accepted from an API request. */
  independentCapabilities?: boolean;
  probeOutputTokenOverride?: number;
  onCapabilityProgress?(value: { capability: AdminProviderCapabilityCheck; completed: number; total: number }): void;
  onSetupCheckpoint?(value: AdminProviderDraftTestOutcome): void | Promise<void>;
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
  retrySleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
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
  const maxOutputTokens = probeOutputTokens(input, 1_000);

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
        ? { reasoning: { effort: lowestConfiguredReasoningEffort(input.model, input.providerFamily), summary: "none" } }
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

function probeOutputTokens(input: AdminProviderDraftTesterInput, desired: number): number {
  const requested = input.probeOutputTokenOverride ?? desired;
  return Math.min(requested, declaredModelOutputTokenLimit(input.model, input.providerFamily) ?? requested);
}

function assertProbeTerminal(result: ProviderRunResult): void {
  const finish = result.finalProviderResponsePreview.finishReason;
  if (finish === "length" || finish === "content_filter") throw Object.assign(new Error("capability_probe_inconclusive"), {
    capabilityFailureReason: finish === "length" ? "budget_exhausted" : "refusal"
  });
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
    city: { enum: ["Oslo"], type: "string" }
  },
  required: ["city"],
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
    options: { allowFake: false, disableRequestRetries: true, fetchFn },
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
    maxOutputTokens: probeOutputTokens(input, input.model.capabilities.reasoning ? 1_024 : 128),
    reasoningEffort: lowestConfiguredReasoningEffort(input.model, input.providerFamily),
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
        text: "Look up the weather in Oslo.",
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
      maxOutputTokens: probeOutputTokens(input, lowestConfiguredReasoningEffort(input.model, input.providerFamily) === "none" ? 128 : 1_024),
      max_output_tokens: probeOutputTokens(input, lowestConfiguredReasoningEffort(input.model, input.providerFamily) === "none" ? 128 : 1_024)
    },
    prompt: {
      developer: null,
      system: "Use the weather lookup to answer the request."
    },
    toolChoice: "required",
    toolMode: "auto",
    tools: [{
      capability: "memory",
      description: "Look up the current weather in a city.",
      inputSchema: forcedToolCallProbeSchema,
      name: forcedToolCallProbeName,
      strict: true
    }]
  }, { signal: input.signal });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  assertProbeTerminal(next.value);
  const calls = next.value.toolCalls;
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== forcedToolCallProbeName ||
    Object.keys(call.arguments).length !== 1 ||
    call.arguments.city !== "Oslo"
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
  "compatible_response_cancelled",
  "compatible_response_failed",
  "compatible_response_incomplete",
  "compatible_response_not_completed",
  "openai_response_cancelled",
  "openai_response_failed",
  "openai_response_incomplete",
  "openai_response_not_completed",
  "provider_request_timed_out",
  "provider_response_too_large",
  "provider_output_too_large",
  "provider_stream_deadline_exceeded",
  "provider_stream_event_too_large",
  "provider_stream_timeout",
  "provider_stream_too_large",
  "structured_output_provider_incomplete",
  "structured_output_output_limit_exceeded",
  "vision_input_fixture_unavailable"
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerHttpStatus(error: unknown): number | null {
  const candidate = record(error);
  if (Number.isSafeInteger(candidate?.status)) return Number(candidate?.status);
  if (Number.isSafeInteger(candidate?.httpStatus)) return Number(candidate?.httpStatus);
  const message = error instanceof Error ? error.message : "";
  const match = /request failed with status (\d{3})$/u.exec(message);
  return match ? Number(match[1]) : null;
}

function isTestWideCapabilityFailure(error: unknown): boolean {
  if (record(error)?.code === "provider_capability_unsupported") return false;
  if (record(error)?.code === "provider_response_cancelled" || record(error)?.code === "provider_response_not_retryable") return true;
  if (error instanceof TypeError ||
    (error instanceof Error || error instanceof DOMException) && error.name === "AbortError") {
    return true;
  }
  const candidate = record(error);
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  if (code?.startsWith("provider_http_") || code && testWideErrorCodes.has(code)) {
    return true;
  }
  // Adapters also emit bounded logical-terminal codes as Error messages.
  // A reachable route with an incomplete response has proved no incompatibility.
  if (error instanceof Error && testWideErrorCodes.has(error.message)) return true;
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
  if (input.independentCapabilities || isTestWideCapabilityFailure(error)) throw error;
}

const capabilityRetryDelays = [2_000, 3_000] as const;
const retryableCapabilityCodes = new Set([
  "compatible_response_failed", "compatible_response_incomplete", "compatible_response_not_completed",
  "openai_response_failed", "openai_response_incomplete", "openai_response_not_completed",
  "structured_output_provider_incomplete", "provider_request_timed_out",
  "embedding_request_timed_out", "rerank_request_timed_out"
]);

function retryableCapabilityFailure(error: unknown): boolean {
  const candidate = record(error);
  if (candidate?.code === "provider_capability_unsupported" || candidate?.code === "provider_response_cancelled" ||
    candidate?.code === "provider_response_not_retryable" || candidate?.name === "AbortError") return false;
  const status = providerHttpStatus(error);
  if (status !== null) return status === 429 || status >= 500 && status <= 599;
  return candidate?.retryableNetworkFailure === true || isRetryableProviderNetworkError(error) ||
    typeof candidate?.code === "string" && retryableCapabilityCodes.has(candidate.code) ||
    error instanceof Error && retryableCapabilityCodes.has(error.message);
}

async function sleepBeforeCapabilityRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function withCapabilityRetries<T>(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions,
  operation: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    input.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      input.signal?.throwIfAborted();
      const delayMs = capabilityRetryDelays[attempt];
      if (delayMs === undefined || !retryableCapabilityFailure(error)) throw error;
      await (options.retrySleep ?? sleepBeforeCapabilityRetry)(delayMs, input.signal);
    }
  }
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

async function testToolCalling(
  input: AdminProviderDraftTesterInput,
  options: TesterOptions
): Promise<AdminProviderCompatibilityStatus> {
  if (input.model.modelClass !== "answer" || input.model.capabilities.toolCalling !== true) {
    return "not_supported";
  }
  try {
    const runtime = providerRuntime(input, options);
    if (!runtime.toolBridge) return "not_supported";
    const request = generationRequest(input, false);
    const effort = lowestConfiguredReasoningEffort(input.model, input.providerFamily);
    const maxOutputTokens = probeOutputTokens(input, effort === "none" ? 128 : 1_024);
    const stream = runtime.adapter.stream({
      ...request,
      content: { blocks: [{ text: "Use the supplied weather lookup function for Oslo.", type: "text" }] },
      params: {
        ...request.params,
        maxOutputTokens,
        max_output_tokens: maxOutputTokens,
        ...(input.model.adapterKind === "openrouter_chat_completions"
          ? { reasoning: { enabled: effort !== "none", effort, exclude: true } }
          : {})
      },
      toolChoice: "auto",
      tools: [{
        capability: "mcp",
        description: "Look up the current weather in a city.",
        inputSchema: {
          additionalProperties: false,
          properties: { city: { type: "string" } },
          required: ["city"],
          type: "object"
        },
        name: "aiqsa_tool_call_probe",
        strict: false
      }]
    }, { signal: input.signal });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    assertProbeTerminal(next.value);
    const calls = next.value.toolCalls;
    const call = calls?.[0];
    return calls?.length === 1 && call?.name === "aiqsa_tool_call_probe" &&
      Object.keys(call.arguments).length === 1 && call.arguments.city === "Oslo"
      ? "verified" : "not_supported";
  } catch (error) {
    preserveTestWideFailure(input, error);
    return "not_supported";
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
      ...(input.probeOutputTokenOverride ? { maxOutputTokens: input.probeOutputTokenOverride } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    return evidence
      ? { evidence, status: "verified" }
      : { evidence: null, status: "not_supported" };
  } catch (error) {
    preserveTestWideFailure(input, error);
    const status = providerHttpStatus(error);
    if (status !== null && !deterministicCapabilityHttpStatuses.has(status)) throw error;
    if (record(error)?.code === "provider_capability_unsupported" && record(error)?.unsupportedInput === true ||
      error instanceof Error && error.message === "pdf_input_adapter_unsupported") {
      return { evidence: null, status: "not_supported" };
    }
    // HTTP 400, refusal, parser failure and a wrong/truncated answer do not
    // establish unsupported PDF input. Setup records incomplete; refresh keeps
    // the exact tuple's previous evidence and exposes a retryable check warning.
    throw error;
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
    assertProbeTerminal(next.value);
    if (!next.value.finalText.trim()) throw new Error("capability_probe_inconclusive");
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
    network: { fetchFn, retry: { maxAttempts: 1 } },
    secret: input.secret
  });
  const result = await withCapabilityRetries(input, options, () => adapter.embed({
    latencyClass: "background",
    mode: "document",
    signal: input.signal,
    texts: ["AIQSA provider compatibility check"]
  }));
  await withCapabilityRetries(input, options, () => adapter.embed({ latencyClass: "background", mode: "query", signal: input.signal, texts: ["AIQSA provider compatibility query"] }));
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
  const result = await withCapabilityRetries(input, options, () => createOpenRouterRerankAdapter({
    connection: input.connection,
    model: input.model,
    network: { fetchFn, retry: { maxAttempts: 1 } },
    secret: input.secret ?? (() => Promise.reject(new Error("provider_credential_missing")))
  }).rerank({
    documents: [
      { handle: "probe-0", text: "A bounded unrelated provider check." },
      { handle: "probe-1", text: "AIQSA reranker compatibility check." }
    ],
    query: "AIQSA reranker compatibility check",
    signal: input.signal
  }));
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
      if (await probe.probe(executionSnapshot(input), input.signal, input.probeOutputTokenOverride)) {
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
  return testAnswerCapabilities(input, options, method, selectedProviders);
}

async function testParallelToolCalls(input: AdminProviderDraftTesterInput, options: TesterOptions) {
  const runtime = providerRuntime(input, options);
  if (!runtime.toolBridge || !supportsForcedToolCallProbe(input.model.adapterKind)) return null;
  const request = generationRequest(input, false);
  const cap = probeOutputTokens(input, input.model.capabilities.reasoning ? 1_024 : 256);
  const stream = runtime.adapter.stream({
    ...request,
    content: { blocks: [{ type: "text", text: "Call aiqsa_parallel_probe exactly twice in this response: once for Oslo and once for Rome. Both calls are independent; emit both before waiting for results." }] },
    modelCapabilities: { ...request.modelCapabilities, parallelToolCalls: true, toolCalling: true },
    parallelToolCalls: true,
    params: { ...request.params, maxOutputTokens: cap, max_output_tokens: cap, parallel_tool_calls: true },
    toolChoice: "auto",
    tools: [{ capability: "mcp", name: "aiqsa_parallel_probe", description: "Look up a city independently.", strict: false,
      inputSchema: { type: "object", additionalProperties: false, required: ["city"],
        properties: { city: { type: "string", enum: ["Oslo", "Rome"] } } } }]
  }, { signal: input.signal });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  assertProbeTerminal(next.value);
  const calls = next.value.toolCalls ?? [];
  if (calls.length !== 2 || calls.some((call) => call.name !== "aiqsa_parallel_probe" ||
    Object.keys(call.arguments).length !== 1) ||
    new Set(calls.map((call) => call.id)).size !== 2 ||
    calls.map((call) => call.arguments.city).sort().join(",") !== "Oslo,Rome") return null;
  return decodeParallelToolCallVerificationEvidence({ adapterKind: input.model.adapterKind,
    probeVersion: 1, upstreamModelId: input.model.upstreamModelId, verified: true });
}

type AnswerCheck = "modelAccess" | "structuredOutput" | "toolCalling" | "forcedToolCall" | "parallelToolCalls" | "vision" | "directPdf" | "streaming";
type AnswerProbeResult = { verified: boolean; proof?: AdminProviderTestEvidence[keyof AdminProviderTestEvidence]; usageSeen?: boolean };
const answerProofFields = { structuredOutput: "structuredOutput", forcedToolCall: "forcedToolCall", parallelToolCalls: "parallelToolCalls",
  vision: "visionInput", directPdf: "pdfInput" } as const;

function beforeProbeAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Each capability owns its deadline. Late results have no access to mutable
 * evidence; only this owner applies a settled result and awaits its checkpoint. */
async function testAnswerCapabilities(original: AdminProviderDraftTesterInput, options: ResolvedTesterOptions,
  method: AdminProviderTestEvidence["method"] = "tiny_generation", selectedProviders = original.model.openRouterRouting?.providers ?? []
): Promise<AdminProviderDraftTestOutcome> {
  const probeModel = { ...original.model, capabilities: { ...original.model.capabilities,
    toolCalling: true, parallelToolCalls: true, vision: true, nativePdfInput: true, streaming: true } };
  const previous = reusableCapabilitySetupEvidence(original.reuseSetupEvidence ?? original.priorEvidence, original.model);
  const reuse = Boolean(original.reuseSetupEvidence);
  const applicable: readonly AnswerCheck[] = ["modelAccess", "structuredOutput", "toolCalling", "forcedToolCall", "parallelToolCalls", "vision", "directPdf", "streaming"];
  const checks = { ...Object.fromEntries(applicable.map((key) => [key, "not_checked"])) as
    Partial<Record<AdminProviderCapabilityCheck, AdminProviderCapabilityCheckStatus>>, ...previous?.capabilitySetup?.checks };
  const compatibility = { ...unsupportedAdminProviderCompatibilityEvidence(), ...previous?.compatibility,
    toolCalling: previous?.compatibility?.toolCalling ?? "not_supported" as const,
    parallelToolCalls: previous?.compatibility?.parallelToolCalls ?? "not_supported" as const,
    forcedToolCall: previous?.compatibility?.forcedToolCall ?? "not_supported" as const,
    vision: previous?.compatibility?.vision ?? "not_supported" as const };
  const attempts = { ...previous?.capabilitySetup?.attempts };
  const evidence: AdminProviderTestEvidence = { ...previous, compatibility,
    detail: "model_missing", method, selectedProviders, upstreamModelId: original.model.upstreamModelId,
    capabilitySetup: { policyVersion: INITIAL_CAPABILITY_SETUP_POLICY_VERSION,
      activation: original.initialSetup ? "initial" : "preserve", checks, attempts } };
  let completed = 0;
  let accessVerified = reuse && checks.modelAccess === "verified";
  const snapshot = (): AdminProviderDraftTestOutcome => {
    const available = checks.modelAccess === "verified";
    evidence.detail = available ? "ok" : "model_missing";
    return { status: available ? "available" : "unavailable", evidence: structuredClone(evidence) };
  };
  async function check(key: AnswerCheck, supported: boolean, operation: (input: AdminProviderDraftTesterInput) => Promise<AnswerProbeResult>) {
    original.signal?.throwIfAborted();
    original.onCapabilityProgress?.({ capability: key, completed, total: applicable.length });
    if (reuse && (checks[key] === "verified" || checks[key] === "unsupported")) {
      completed += 1;
      original.onCapabilityProgress?.({ capability: key, completed, total: applicable.length });
      return;
    }
    let attempt: AdminProviderCapabilityAttempt;
    let result: AnswerProbeResult | undefined;
    if (!supported) attempt = { attempts: 0, status: "unsupported", reason: "adapter_unsupported" };
    else if (key !== "modelAccess" && !accessVerified) attempt = { attempts: 0, status: "not_checked", reason: "not_checked" };
    else {
      const timeout = withTimeoutSignal(original.signal, Math.min(120_000, original.model.responseTimeoutMs ?? original.connection.responseTimeoutMs));
      let count = 0;
      let raisedBudget = false;
      try {
        for (;;) {
          count += 1;
          const input = { ...original, independentCapabilities: true, signal: timeout.signal, model: probeModel,
            ...(raisedBudget ? { probeOutputTokenOverride: 4_096 } : {}) };
          try {
            const settled = await beforeProbeAbort(timeout.signal, () => operation(input));
            timeout.signal.throwIfAborted();
            if (!settled.verified) throw new Error("capability_probe_inconclusive");
            result = settled;
            attempt = { attempts: count, status: "verified", reason: "verified" };
            break;
          } catch (error) {
            original.signal?.throwIfAborted();
            attempt = capabilityFailureAttempt(error, { attempts: count, capability: key, adapterKind: original.model.adapterKind,
              accessVerified, timedOut: timeout.signal.aborted });
            if (timeout.signal.aborted || !retryCapabilityAttempt(attempt)) break;
            raisedBudget ||= attempt.reason === "budget_exhausted";
            try { await (options.retrySleep ?? sleepBeforeCapabilityRetry)(capabilityRetryDelays[count - 1] ?? 0, timeout.signal); }
            catch { original.signal?.throwIfAborted(); attempt = { attempts: count, status: "incomplete", reason: "timeout" }; break; }
          }
        }
      } finally { timeout.clear(); }
    }
    original.signal?.throwIfAborted();
    attempts[key] = attempt;
    if (key === "modelAccess") accessVerified = attempt.status === "verified";
    const field = key in answerProofFields ? answerProofFields[key as keyof typeof answerProofFields] : undefined;
    if (attempt.status === "verified" && result) {
      checks[key] = "verified";
      compatibility[key] = "verified";
      if (result.usageSeen) compatibility.usage = "verified";
      if (field && result.proof) Object.assign(evidence, { [field]: result.proof });
    } else if (attempt.status === "unsupported" || checks[key] !== "verified") {
      checks[key] = attempt.status;
      compatibility[key] = "not_supported";
      if (field) delete evidence[field];
    }
    completed += 1;
    if (checks.modelAccess === "verified") await original.onSetupCheckpoint?.(snapshot());
    original.signal?.throwIfAborted();
    original.onCapabilityProgress?.({ capability: key, completed, total: applicable.length });
  }
  await check("modelAccess", true, async (input) => {
    const result = await runGenerationProbe(input, options, false);
    return { verified: result.status === "verified", usageSeen: result.usageSeen };
  });
  await check("structuredOutput", supportsStructuredOutputAdapter(probeModel.adapterKind), async (input) => {
    const result = await testStructuredOutput(input, options);
    return { verified: Boolean(result.evidence), ...(result.evidence ? { proof: result.evidence } : {}) };
  });
  const supportsTools = supportsForcedToolCallProbe(probeModel.adapterKind);
  await check("toolCalling", supportsTools, async (input) => ({ verified: await testToolCalling(input, options) === "verified" }));
  await check("forcedToolCall", supportsTools, async (input) => {
    const result = await testForcedToolCall(input, options);
    return { verified: Boolean(result.evidence), ...(result.evidence ? { proof: result.evidence } : {}) };
  });
  await check("parallelToolCalls", supportsTools, async (input) => {
    const proof = await testParallelToolCalls(input, options);
    return { verified: Boolean(proof), ...(proof ? { proof } : {}) };
  });
  await check("vision", supportsTools, async (input) => {
    const proof = await testVisionInput(input, options);
    return { verified: Boolean(proof), ...(proof ? { proof } : {}) };
  });
  await check("directPdf", supportsPdfInputAdapter(probeModel.adapterKind), async (input) => {
    const result = await testPdfInput(input, options);
    return { verified: Boolean(result.evidence), ...(result.evidence ? { proof: result.evidence } : {}) };
  });
  await check("streaming", true, async (input) => {
    const result = await runGenerationProbe(input, options, true);
    return { verified: result.status === "verified", usageSeen: result.usageSeen };
  });
  original.signal?.throwIfAborted();
  return snapshot();
}

async function testSystemRole(
  input: AdminProviderDraftTesterInput,
  options: ResolvedTesterOptions
): Promise<AdminProviderDraftTestOutcome> {
  if (input.capabilityRole === "embedding") return testEmbedding(input, options, "tiny_generation", input.model.openRouterRouting?.providers ?? []);
  if (input.capabilityRole === "reranker") return testReranker(input, options, "tiny_generation", input.model.openRouterRouting?.providers ?? []);
  const access = await withCapabilityRetries(input, options, () => runGenerationProbe(input, options, false));
  const structured = input.capabilityRole === "memory" ? await withCapabilityRetries(input, options, () => testStructuredOutput(input, options)) : null;
  const forced = input.capabilityRole === "memory" ? await withCapabilityRetries(input, options, () => testForcedToolCall(input, options)) : null;
  const pdf = input.capabilityRole === "direct_pdf" ? await withCapabilityRetries(input, options, () => testPdfInput(input, options)) : null;
  const vision = input.capabilityRole === "vision" ? await withCapabilityRetries(input, options, () => testVisionInput(input, options)) : undefined;
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
      disableRequestRetries: true,
      ...(options.createFetch ? { createFetch: options.createFetch } : {})
    })
  };
  return {
    async test(input) {
      if (input.model.modelClass === "image") return testImageCapabilities(input, resolvedOptions);
      if (input.initialSetup && input.model.modelClass === "answer") return testAnswerCapabilities(input, resolvedOptions);
      if (input.initialSetup && input.model.modelClass !== "answer") {
        const previous = reusableCapabilitySetupEvidence(input.reuseSetupEvidence, input.model);
        const capability = input.model.modelClass === "embedding" ? "embedding" : "reranking";
        if (previous?.capabilitySetup?.checks[capability] === "verified") return { evidence: previous, status: "available" };
        const timeout = withTimeoutSignal(input.signal, Math.min(INITIAL_CAPABILITY_MODEL_TIMEOUT_MS,
          input.model.responseTimeoutMs ?? input.connection.responseTimeoutMs));
        input.onCapabilityProgress?.({ capability, completed: 0, total: 1 });
        try {
          const outcome = await runTinyGeneration({ ...input, signal: timeout.signal }, resolvedOptions);
          input.signal?.throwIfAborted();
          return { ...outcome, evidence: { ...outcome.evidence,
            capabilitySetup: { policyVersion: 1, checks: { modelAccess: "verified", [capability]: "verified" } } } };
        } catch {
          input.signal?.throwIfAborted();
          return { status: "unavailable", evidence: { detail: "model_missing", method: "tiny_generation",
            selectedProviders: input.model.openRouterRouting?.providers ?? [], upstreamModelId: input.model.upstreamModelId,
            capabilitySetup: { policyVersion: 1, checks: { modelAccess: "incomplete", [capability]: "incomplete" } } } };
        } finally {
          timeout.clear();
          input.onCapabilityProgress?.({ capability, completed: 1, total: 1 });
        }
      }
      if (input.capabilityRole) return testSystemRole(input, resolvedOptions);
      return input.mode === "account_catalog"
        ? testOpenRouterCatalog(input, resolvedOptions)
        : runTinyGeneration(input, resolvedOptions);
    }
  };
}
