import { createHash } from "node:crypto";
import type { ModelRunUsage } from "../../lib/domain/modelRunEvents";
import {
  estimateCostMicros,
  sumTokenUsage,
  type ModelTokenPricing
} from "../../lib/domain/usage";
import {
  knowledgeSemanticGroundingDecisions,
  knowledgeSemanticReasonFamilies,
  type KnowledgeSemanticGroundingDecision,
  type KnowledgeSemanticReasonFamily
} from "../../lib/server/knowledge/semanticGrounding";
import type { ProviderAdmissionRole } from "../../lib/server/providerRuntime/admission";
import type { SystemModelRoleResolution } from "../../lib/server/providerRuntime/systemModelRole";
import { readBoundedResponseText } from "../../lib/server/providers/network";
import type {
  ProviderStructuredOutputOptions,
  ProviderStructuredOutputRequest
} from "../../lib/server/providers/structuredOutput";
import { z } from "zod";
import {
  assertKnowledgeSemanticCandidateResult,
  knowledgeSemanticCandidateInputContract,
  knowledgeSemanticCandidateResultContract,
  type KnowledgeSemanticCandidateExecutor,
  type KnowledgeSemanticCandidateInput,
  type KnowledgeSemanticCandidateResult,
  type KnowledgeSemanticCandidateUnavailableReason,
  type KnowledgeSemanticDecisionScores
} from "./semanticGroundingCandidates";

export const KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION =
  "knowledge-semantic-local-runner-v1" as const;
export const KNOWLEDGE_SEMANTIC_SYSTEM_RUNNER_PROTOCOL_VERSION =
  "knowledge-semantic-system-runner-v1" as const;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_EVIDENCE_ITEMS = 16;

function implementationSources(...values: readonly CallableFunction[]): readonly string[] {
  return Object.freeze(values.map((value) =>
    Function.prototype.toString.call(value).replace(/\r\n?/gu, "\n").trim()));
}

const safeIdentity = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const probability = z.number().finite().min(0).max(1);
const decisionScoresSchema = z.strictObject({
  contradicted: probability,
  supported: probability,
  uncertain: probability,
  unsupported: probability
});

export const knowledgeSemanticLocalRunnerConfigSchema = z.strictObject({
  endpoint: z.url(),
  hardware: z.enum(["cpu", "gpu"]),
  modelId: safeIdentity,
  profile: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/u),
  resources: z.strictObject({
    cpuLogicalCores: z.number().int().min(1).max(1_024),
    gpuDevice: safeIdentity.nullable()
  }),
  revision: safeIdentity,
  timeoutMs: z.number().int().min(50).max(300_000),
  validatorVersion: z.number().int().min(1).max(10_000),
  version: z.literal(KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION)
});

export type KnowledgeSemanticLocalRunnerConfig = z.infer<
  typeof knowledgeSemanticLocalRunnerConfigSchema
>;

const localResponseSchema = z.strictObject({
  attributableEvidenceHandles: z.array(z.string().regex(/^e(?:[1-9]|1[0-6])$/u))
    .max(MAX_EVIDENCE_ITEMS),
  decisionScores: decisionScoresSchema,
  identity: z.strictObject({
    modelId: safeIdentity,
    profile: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/u),
    resources: z.strictObject({
      cpuLogicalCores: z.number().int().min(1).max(1_024),
      gpuDevice: safeIdentity.nullable()
    }),
    revision: safeIdentity,
    validatorVersion: z.number().int().min(1).max(10_000)
  }),
  reasonFamily: z.enum(knowledgeSemanticReasonFamilies),
  usage: z.strictObject({
    costMicros: z.literal(0),
    inputTokens: z.number().int().nonnegative().nullable(),
    peakGpuMemoryBytes: z.number().int().nonnegative().nullable(),
    peakRssBytes: z.number().int().positive()
  }),
  version: z.literal(KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION)
});

const localInputProjectionContract = Object.freeze({
  candidateBoundary: knowledgeSemanticCandidateInputContract,
  claimFields: Object.freeze(["context", "text", "type"]),
  evidenceHandleMapping: "ordered_request_scoped_e1_through_e16",
  evidenceItemFields: Object.freeze([
    "ambiguous", "handle", "locatorState", "state", "text"
  ]),
  rootFields: Object.freeze(["claim", "evidence", "language", "query", "scopeEvidence"]),
  version: 1
});

function localWireProtocolContract(config: KnowledgeSemanticLocalRunnerConfig): unknown {
  return Object.freeze({
    configSchema: z.toJSONSchema(knowledgeSemanticLocalRunnerConfigSchema),
    endpoint: config.endpoint,
    endpointPolicy: "http_loopback_without_credentials_query_or_fragment",
    headers: Object.freeze({ accept: "application/json", contentType: "application/json" }),
    identityEchoRequired: true,
    maxEvidenceItems: MAX_EVIDENCE_ITEMS,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    method: "POST",
    redirect: "error",
    timeoutMs: config.timeoutMs,
    version: KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION
  });
}

function loopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]"]).has(endpoint.hostname) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("knowledge_semantic_local_endpoint_invalid");
  }
  return endpoint;
}

function opaqueRequest(input: KnowledgeSemanticCandidateInput): Readonly<{
  body: Readonly<Record<string, unknown>>;
  evidenceHandles: ReadonlyMap<string, string>;
}> {
  if (input.evidence.length > MAX_EVIDENCE_ITEMS || input.text.length < 1 ||
    input.text.length > 8_000 || input.query.length > 4_000 ||
    input.context.length > 16 || input.context.some((value) => value.length > 1_000) ||
    input.evidence.some((item) => item.text !== null && item.text.length > 8_000)) {
    throw new Error("knowledge_semantic_runner_input_invalid");
  }
  const evidenceHandles = new Map(input.evidence.map((item, index) =>
    [`e${index + 1}`, item.handle] as const));
  const body = Object.freeze({
    claim: Object.freeze({
      context: input.context,
      text: input.text,
      type: input.type
    }),
    evidence: Object.freeze(input.evidence.map((item, index) => Object.freeze({
      ambiguous: item.ambiguous,
      handle: `e${index + 1}`,
      locatorState: item.locatorState,
      state: item.state,
      text: item.text
    }))),
    language: input.language,
    query: input.query,
    scopeEvidence: input.scopeEvidence
  });
  return Object.freeze({ body, evidenceHandles });
}

function assertRequestBytes(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("knowledge_semantic_runner_input_too_large");
  }
  return serialized;
}

function decodedResult(input: Readonly<{
  attributableEvidenceHandles: readonly string[];
  decisionScores: KnowledgeSemanticDecisionScores;
  evidenceHandles: ReadonlyMap<string, string>;
  reasonFamily: KnowledgeSemanticReasonFamily;
}>): Readonly<{
  attributableHandles: readonly string[];
  decisionScores: KnowledgeSemanticDecisionScores;
  reasonFamily: KnowledgeSemanticReasonFamily;
}> {
  if (input.attributableEvidenceHandles.length !==
      new Set(input.attributableEvidenceHandles).size ||
    input.attributableEvidenceHandles.some((handle) => !input.evidenceHandles.has(handle))) {
    throw new Error("knowledge_semantic_runner_response_invalid");
  }
  return Object.freeze({
    attributableHandles: Object.freeze(input.attributableEvidenceHandles.map((handle) =>
      input.evidenceHandles.get(handle)!)),
    decisionScores: Object.freeze({ ...input.decisionScores }),
    reasonFamily: input.reasonFamily
  });
}

/** Executes a preloaded multilingual NLI/cross-encoder through a credential-free,
 * loopback-only protocol. Raw benchmark text never leaves the host here. */
export function createLocalSemanticGroundingExecutor(
  value: unknown,
  dependencies: Readonly<{ fetchFn?: typeof fetch }> = {}
): KnowledgeSemanticCandidateExecutor {
  const config = knowledgeSemanticLocalRunnerConfigSchema.parse(value);
  if (config.hardware === "cpu" && config.resources.gpuDevice !== null ||
    config.hardware === "gpu" && config.resources.gpuDevice === null) {
    throw new Error("knowledge_semantic_local_resource_profile_invalid");
  }
  const endpoint = loopbackEndpoint(config.endpoint);
  const fetchFn = dependencies.fetchFn ?? fetch;
  const executor: KnowledgeSemanticCandidateExecutor = Object.freeze({
    contract: Object.freeze({
      inputProjection: localInputProjectionContract,
      prompt: Object.freeze({ status: "not_used_by_wire_protocol" }),
      protocol: localWireProtocolContract(config),
      responseSchema: z.toJSONSchema(localResponseSchema),
      supportingImplementation: implementationSources(
        loopbackEndpoint,
        opaqueRequest,
        assertRequestBytes,
        decodedResult,
        createLocalSemanticGroundingExecutor
      )
    }),
    identity: Object.freeze({
      authorization: "evaluation_only" as const,
      backend: "loopback-json-v1",
      egress: "none" as const,
      executionClass: "real_model" as const,
      hardware: config.hardware,
      modelId: config.modelId,
      profile: config.profile,
      provider: "local",
      resources: Object.freeze({
        cpuLogicalCores: config.resources.cpuLogicalCores,
        gpuDevice: config.resources.gpuDevice,
        scope: "isolated_runner" as const
      }),
      revision: config.revision,
      version: config.validatorVersion
    }),
    async validate(input) {
      const opaque = opaqueRequest(input);
      const signal = AbortSignal.timeout(config.timeoutMs);
      const response = await fetchFn(endpoint, {
        body: assertRequestBytes({
          ...opaque.body,
          expectedIdentity: {
            modelId: config.modelId,
            profile: config.profile,
            resources: config.resources,
            revision: config.revision,
            validatorVersion: config.validatorVersion
          },
          version: KNOWLEDGE_SEMANTIC_LOCAL_RUNNER_PROTOCOL_VERSION
        }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal
      });
      const text = await readBoundedResponseText(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        signal
      });
      if (!response.ok) throw new Error("knowledge_semantic_local_runner_unavailable");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("knowledge_semantic_local_runner_response_invalid");
      }
      const result = localResponseSchema.parse(parsed);
      if (result.identity.modelId !== config.modelId ||
        result.identity.profile !== config.profile ||
        result.identity.resources.cpuLogicalCores !== config.resources.cpuLogicalCores ||
        result.identity.resources.gpuDevice !== config.resources.gpuDevice ||
        result.identity.revision !== config.revision ||
        result.identity.validatorVersion !== config.validatorVersion ||
        config.hardware === "cpu" && result.usage.peakGpuMemoryBytes !== null ||
        config.hardware === "gpu" && result.usage.peakGpuMemoryBytes === null) {
        throw new Error("knowledge_semantic_local_runner_response_invalid");
      }
      const decoded = decodedResult({
        attributableEvidenceHandles: result.attributableEvidenceHandles,
        decisionScores: result.decisionScores,
        evidenceHandles: opaque.evidenceHandles,
        reasonFamily: result.reasonFamily
      });
      const candidateResult: KnowledgeSemanticCandidateResult = Object.freeze({
        ...decoded,
        costMicros: 0,
        inputTokens: result.usage.inputTokens,
        resourceUsage: Object.freeze({
          peakGpuMemoryBytes: result.usage.peakGpuMemoryBytes,
          peakRssBytes: result.usage.peakRssBytes
        }),
        usage: Object.freeze({
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          inputTokens: result.usage.inputTokens,
          outputTokens: null,
          providerRequestCount: 1,
          reasoningTokens: null,
          status: "partial" as const,
          totalTokens: null
        })
      });
      assertKnowledgeSemanticCandidateResult(input, candidateResult);
      return candidateResult;
    }
  });
  return executor;
}

type StructuredExecutor = (
  role: ProviderAdmissionRole,
  request: ProviderStructuredOutputRequest,
  options?: ProviderStructuredOutputOptions
) => Promise<Record<string, unknown>>;

export type KnowledgeSemanticSystemModelResolution =
  | Readonly<{ executor: KnowledgeSemanticCandidateExecutor; status: "available" }>
  | Readonly<{
      reason: Extract<KnowledgeSemanticCandidateUnavailableReason,
        "system_model_not_authorized" | "system_model_structured_output_unavailable">;
      status: "unavailable";
    }>;

export const KNOWLEDGE_SEMANTIC_SYSTEM_PROMPT = [
  "Validate one answer claim against only its supplied local evidence neighborhood.",
  "Return probabilities summing to one for supported, unsupported, contradicted, uncertain.",
  "Use contradicted only for incompatible same-context evidence; dates and versions differ.",
  "Return only opaque evidence handles that materially support the decision and no explanation."
].join(" ");

const systemModelOutputSchema = z.strictObject({
  attributableEvidenceHandles: z.array(z.string()).max(MAX_EVIDENCE_ITEMS),
  decisionScores: decisionScoresSchema,
  reasonFamily: z.enum(knowledgeSemanticReasonFamilies)
});

function systemModelResponseJsonSchema(
  evidenceHandleValues: readonly string[]
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    additionalProperties: false,
    properties: {
      attributableEvidenceHandles: {
        items: evidenceHandleValues.length > 0
          ? { enum: evidenceHandleValues, type: "string" }
          : { type: "string" },
        maxItems: evidenceHandleValues.length,
        minItems: 0,
        type: "array",
        uniqueItems: true
      },
      decisionScores: {
        additionalProperties: false,
        properties: Object.fromEntries(knowledgeSemanticGroundingDecisions.map((decision) => [
          decision,
          { maximum: 1, minimum: 0, type: "number" }
        ])),
        required: [...knowledgeSemanticGroundingDecisions],
        type: "object"
      },
      reasonFamily: { enum: [...knowledgeSemanticReasonFamilies], type: "string" }
    },
    required: ["attributableEvidenceHandles", "decisionScores", "reasonFamily"],
    type: "object"
  });
}

function systemModelRequest(
  input: KnowledgeSemanticCandidateInput,
  reasoningEffort: string | null
): Readonly<{
  evidenceHandles: ReadonlyMap<string, string>;
  request: ProviderStructuredOutputRequest;
}> {
  const opaque = opaqueRequest(input);
  assertRequestBytes(opaque.body);
  const evidenceHandleValues = [...opaque.evidenceHandles.keys()];
  const request = Object.freeze({
    maxOutputTokens: 512,
    name: "knowledge_semantic_grounding_v1",
    ...(reasoningEffort ? { reasoningEffort } : {}),
    schema: systemModelResponseJsonSchema(evidenceHandleValues),
    systemPrompt: KNOWLEDGE_SEMANTIC_SYSTEM_PROMPT,
    userPrompt: JSON.stringify(opaque.body)
  } satisfies ProviderStructuredOutputRequest);
  return Object.freeze({ evidenceHandles: opaque.evidenceHandles, request });
}

function summedUsage(
  usages: readonly ModelRunUsage[],
  pricing?: ModelTokenPricing
): Readonly<{
  costMicros: number | null;
  inputTokens: number | null;
  usage: KnowledgeSemanticCandidateResult["usage"];
}> {
  if (usages.length === 0) return Object.freeze({
    costMicros: null,
    inputTokens: null,
    usage: Object.freeze({
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      inputTokens: null,
      outputTokens: null,
      providerRequestCount: 1,
      reasoningTokens: null,
      status: "unavailable" as const,
      totalTokens: null
    })
  });
  const costs = usages.map((usage) => usage.estimatedCostMicros ??
    (pricing ? estimateCostMicros(usage, pricing) : null));
  const tokens = sumTokenUsage([...usages]);
  return Object.freeze({
    costMicros: costs.every((value) => value !== null)
      ? costs.reduce((sum, value) => sum + value!, 0)
      : null,
    inputTokens: tokens.inputTokens,
    usage: Object.freeze({
      cachedInputTokens: tokens.cachedInputTokens,
      cacheWriteInputTokens: tokens.cacheWriteInputTokens,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      providerRequestCount: 1,
      reasoningTokens: tokens.reasoningTokens,
      status: "measured" as const,
      totalTokens: tokens.totalTokens
    })
  });
}

/** Resolves only the exact admitted installation System Model strict-output role.
 * Missing authority or capability remains typed unavailable; no provider/model fallback runs. */
export async function resolveSystemModelSemanticGroundingExecutor(input: Readonly<{
  executeStructuredOutput: StructuredExecutor;
  pricing?: ModelTokenPricing;
  resolveSystemModel(): Promise<SystemModelRoleResolution>;
}>): Promise<KnowledgeSemanticSystemModelResolution> {
  let resolution: SystemModelRoleResolution;
  try {
    resolution = await input.resolveSystemModel();
  } catch {
    return Object.freeze({ reason: "system_model_not_authorized", status: "unavailable" });
  }
  if (!resolution.ok) {
    return Object.freeze({ reason: "system_model_not_authorized", status: "unavailable" });
  }
  const model = resolution.role.snapshot.model;
  if (resolution.role.modelConfiguration.capabilities.structuredOutput !== true ||
    model.adapterKind === "fake") {
    return Object.freeze({
      reason: "system_model_structured_output_unavailable",
      status: "unavailable"
    });
  }
  const modelRevision = createHash("sha256").update(JSON.stringify(model), "utf8")
    .digest("hex").slice(0, 16);
  const executor: KnowledgeSemanticCandidateExecutor = Object.freeze({
    contract: Object.freeze({
      inputProjection: localInputProjectionContract,
      prompt: Object.freeze({ systemPrompt: KNOWLEDGE_SEMANTIC_SYSTEM_PROMPT }),
      protocol: Object.freeze({
        maxOutputTokens: 512,
        name: "knowledge_semantic_grounding_v1",
        reasoningEffort: resolution.reasoningEffort,
        requestTimeoutMs: 30_000,
        transport: "admitted_installation_system_model_structured_output",
        userPrompt: "canonical_json_of_opaque_input_projection",
        version: KNOWLEDGE_SEMANTIC_SYSTEM_RUNNER_PROTOCOL_VERSION
      }),
      responseSchema: Object.freeze({
        decoder: z.toJSONSchema(systemModelOutputSchema),
        provider: systemModelResponseJsonSchema(Object.freeze(["e1", "e2"]))
      }),
      supportingImplementation: implementationSources(
        opaqueRequest,
        assertRequestBytes,
        decodedResult,
        systemModelResponseJsonSchema,
        systemModelRequest,
        summedUsage,
        resolveSystemModelSemanticGroundingExecutor
      )
    }),
    identity: Object.freeze({
      authorization: "evaluation_only" as const,
      backend: model.adapterKind,
      egress: "external" as const,
      executionClass: "real_model" as const,
      hardware: "provider_managed" as const,
      modelId: model.upstreamModelId,
      profile: "system-model-semantic-v1",
      provider: resolution.role.snapshot.providerFamily,
      resources: Object.freeze({
        cpuLogicalCores: null,
        gpuDevice: null,
        scope: "provider_managed" as const
      }),
      revision: `installation-policy-${resolution.policyVersion}-model-${modelRevision}`,
      version: 1
    }),
    async validate(candidateInput) {
      const structured = systemModelRequest(candidateInput, resolution.reasoningEffort);
      const usages: ModelRunUsage[] = [];
      const raw = await input.executeStructuredOutput(
        resolution.role,
        structured.request,
        { onUsage: (usage) => usages.push(usage), timeoutMs: 30_000 }
      );
      const parsed = systemModelOutputSchema.parse(raw);
      const decoded = decodedResult({
        attributableEvidenceHandles: parsed.attributableEvidenceHandles,
        decisionScores: parsed.decisionScores,
        evidenceHandles: structured.evidenceHandles,
        reasonFamily: parsed.reasonFamily
      });
      const usage = summedUsage(usages, input.pricing);
      const result: KnowledgeSemanticCandidateResult = Object.freeze({
        ...decoded,
        ...usage,
        resourceUsage: null
      });
      assertKnowledgeSemanticCandidateResult(candidateInput, result);
      return result;
    }
  });
  return Object.freeze({ executor, status: "available" });
}
