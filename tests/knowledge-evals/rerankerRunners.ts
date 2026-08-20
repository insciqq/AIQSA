import { createHash } from "node:crypto";
import type { ModelRunUsage } from "../../lib/domain/modelRunEvents";
import { estimateCostMicros, type ModelTokenPricing } from "../../lib/domain/usage";
import type { ProviderAdmissionRole } from "../../lib/server/providerRuntime/admission";
import type { SystemModelRoleResolution } from "../../lib/server/providerRuntime/systemModelRole";
import type {
  ProviderStructuredOutputOptions,
  ProviderStructuredOutputRequest
} from "../../lib/server/providers/structuredOutput";
import { readBoundedResponseText } from "../../lib/server/providers/network";
import { z } from "zod";
import type {
  KnowledgeRerankerUnavailableReason,
  KnowledgeSemanticRerankerExecutor
} from "./rerankerCandidates";

export const KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION =
  "knowledge-reranker-runner-v1" as const;

const MAX_RUNNER_REQUEST_BYTES = 64 * 1024;
const MAX_RUNNER_RESPONSE_BYTES = 128 * 1024;
const MAX_RUNNER_PASSAGES = 50;

const safeIdentity = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export const knowledgeLocalCrossEncoderRunnerConfigSchema = z.strictObject({
  endpoint: z.url(),
  hardware: z.enum(["cpu", "gpu"]),
  modelId: safeIdentity,
  resources: z.strictObject({
    cpuLogicalCores: z.number().int().min(1).max(1_024),
    gpuDevice: safeIdentity.nullable()
  }),
  revision: safeIdentity,
  timeoutMs: z.number().int().min(50).max(300_000),
  version: z.literal(KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION)
});

export type KnowledgeLocalCrossEncoderRunnerConfig = z.infer<
  typeof knowledgeLocalCrossEncoderRunnerConfigSchema
>;

const runnerResponseSchema = z.strictObject({
  identity: z.strictObject({
    modelId: safeIdentity,
    resources: z.strictObject({
      cpuLogicalCores: z.number().int().min(1).max(1_024),
      gpuDevice: safeIdentity.nullable()
    }),
    revision: safeIdentity
  }),
  scores: z.array(z.strictObject({
    passageId: z.string().min(1).max(128),
    score: z.number().finite().min(0).max(1)
  })).min(1).max(MAX_RUNNER_PASSAGES),
  usage: z.strictObject({
    costMicros: z.literal(0),
    inputTokens: z.number().int().nonnegative().nullable(),
    peakGpuMemoryBytes: z.number().int().nonnegative().nullable(),
    peakRssBytes: z.number().int().positive()
  }),
  version: z.literal(KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION)
});

function loopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);
  if (endpoint.protocol !== "http:" || !loopbackHosts.has(endpoint.hostname) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("knowledge_reranker_local_endpoint_invalid");
  }
  return endpoint;
}

function serializedRunnerRequest(
  input: Parameters<KnowledgeSemanticRerankerExecutor["rerank"]>[0],
  expectedIdentity?: Readonly<{
    modelId: string;
    resources: Readonly<{ cpuLogicalCores: number; gpuDevice: string | null }>;
    revision: string;
  }>
) {
  if (input.passages.length < 1 || input.passages.length > MAX_RUNNER_PASSAGES ||
    input.query.length < 1 || input.query.length > 4_000 ||
    /\u0000/u.test(input.query) || input.passages.some((passage) =>
      !passage.id || passage.id.length > 128 || passage.text.length < 1 ||
      passage.text.length > 4_000 || /\u0000/u.test(passage.id) || /\u0000/u.test(passage.text)) ||
    new Set(input.passages.map((passage) => passage.id)).size !== input.passages.length) {
    throw new Error("knowledge_reranker_runner_input_invalid");
  }
  const serialized = JSON.stringify({
    ...(expectedIdentity ? { expectedIdentity } : {}),
    passages: input.passages,
    query: input.query,
    version: KNOWLEDGE_RERANKER_RUNNER_PROTOCOL_VERSION
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_RUNNER_REQUEST_BYTES) {
    throw new Error("knowledge_reranker_runner_input_too_large");
  }
  return serialized;
}

/**
 * Adapts a pre-loaded local multilingual cross-encoder sidecar. The endpoint is
 * deliberately loopback-only and accepts no credentials; private evaluation
 * text therefore never leaves the host through this adapter.
 */
export function createLocalCrossEncoderRerankerExecutor(
  value: unknown,
  dependencies: Readonly<{ fetchFn?: typeof fetch }> = {}
): KnowledgeSemanticRerankerExecutor {
  const config = knowledgeLocalCrossEncoderRunnerConfigSchema.parse(value);
  if (config.hardware === "cpu" && config.resources.gpuDevice !== null ||
    config.hardware === "gpu" && config.resources.gpuDevice === null) {
    throw new Error("knowledge_reranker_local_resource_profile_invalid");
  }
  const endpoint = loopbackEndpoint(config.endpoint);
  const fetchFn = dependencies.fetchFn ?? fetch;
  return Object.freeze({
    identity: Object.freeze({
      authorization: "evaluation_only" as const,
      backend: "loopback-json-v1",
      egress: "none" as const,
      hardware: config.hardware,
      modelId: config.modelId,
      provider: "local",
      resources: Object.freeze({
        cpuLogicalCores: config.resources.cpuLogicalCores,
        gpuDevice: config.resources.gpuDevice,
        scope: "isolated_runner" as const
      }),
      revision: config.revision
    }),
    async rerank(input) {
      const signal = AbortSignal.timeout(config.timeoutMs);
      const response = await fetchFn(endpoint, {
        body: serializedRunnerRequest(input, {
          modelId: config.modelId,
          resources: config.resources,
          revision: config.revision
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        method: "POST",
        redirect: "error",
        signal
      });
      const text = await readBoundedResponseText(response, {
        maxBytes: MAX_RUNNER_RESPONSE_BYTES,
        signal
      });
      if (!response.ok) throw new Error("knowledge_reranker_local_runner_unavailable");
      let decoded: unknown;
      try {
        decoded = JSON.parse(text) as unknown;
      } catch {
        throw new Error("knowledge_reranker_local_runner_response_invalid");
      }
      const result = runnerResponseSchema.parse(decoded);
      const expected = new Set(input.passages.map((passage) => passage.id));
      if (result.identity.modelId !== config.modelId ||
        result.identity.resources.cpuLogicalCores !== config.resources.cpuLogicalCores ||
        result.identity.resources.gpuDevice !== config.resources.gpuDevice ||
        result.identity.revision !== config.revision ||
        result.scores.length !== expected.size ||
        new Set(result.scores.map((score) => score.passageId)).size !== expected.size ||
        result.scores.some((score) => !expected.has(score.passageId)) ||
        config.hardware === "cpu" && result.usage.peakGpuMemoryBytes !== null ||
        config.hardware === "gpu" && result.usage.peakGpuMemoryBytes === null) {
        throw new Error("knowledge_reranker_local_runner_response_invalid");
      }
      return Object.freeze({
        costMicros: 0,
        inputTokens: result.usage.inputTokens,
        resourceUsage: Object.freeze({
          peakGpuMemoryBytes: result.usage.peakGpuMemoryBytes,
          peakRssBytes: result.usage.peakRssBytes
        }),
        scores: Object.freeze(result.scores.map((score) => Object.freeze({ ...score })))
      });
    }
  });
}

type StructuredExecutor = (
  role: ProviderAdmissionRole,
  request: ProviderStructuredOutputRequest,
  options?: ProviderStructuredOutputOptions
) => Promise<Record<string, unknown>>;

export type KnowledgeSystemModelRunnerResolution =
  | Readonly<{
      executor: KnowledgeSemanticRerankerExecutor;
      status: "available";
    }>
  | Readonly<{
      reason: KnowledgeRerankerUnavailableReason;
      status: "unavailable";
    }>;

function systemModelRequest(
  input: Parameters<KnowledgeSemanticRerankerExecutor["rerank"]>[0],
  reasoningEffort: string | null
): Readonly<{
  handles: ReadonlyMap<string, string>;
  request: ProviderStructuredOutputRequest;
}> {
  serializedRunnerRequest(input);
  const handles = new Map(input.passages.map((passage, index) =>
    [`p${index + 1}`, passage.id] as const));
  const prompt = JSON.stringify({
    passages: input.passages.map((passage, index) => ({
      handle: `p${index + 1}`,
      text: passage.text
    })),
    query: input.query
  });
  return Object.freeze({
    handles,
    request: Object.freeze({
      maxOutputTokens: Math.min(2_048, 64 + input.passages.length * 32),
      name: "knowledge_reranker_scores_v1",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      schema: {
        additionalProperties: false,
        properties: {
          scores: {
            items: {
              additionalProperties: false,
              properties: {
                handle: { enum: [...handles.keys()], type: "string" },
                score: { maximum: 1, minimum: 0, type: "number" }
              },
              required: ["handle", "score"],
              type: "object"
            },
            maxItems: input.passages.length,
            minItems: input.passages.length,
            type: "array",
            uniqueItems: true
          }
        },
        required: ["scores"],
        type: "object"
      },
      systemPrompt: "Score every supplied passage for direct relevance to the query. " +
        "Use only the opaque handles, return every handle exactly once, and return no explanation.",
      userPrompt: prompt
    })
  });
}

const systemScoresSchema = z.strictObject({
  scores: z.array(z.strictObject({
    handle: z.string().regex(/^p[1-9][0-9]?$/u),
    score: z.number().finite().min(0).max(1)
  })).min(1).max(MAX_RUNNER_PASSAGES)
});

function summedUsage(
  usages: readonly ModelRunUsage[],
  pricing?: ModelTokenPricing
): Readonly<{
  costMicros: number | null;
  inputTokens: number | null;
}> {
  if (usages.length === 0) {
    return Object.freeze({ costMicros: null, inputTokens: null });
  }
  const costs = usages.map((usage) => usage.estimatedCostMicros ??
    (pricing ? estimateCostMicros(usage, pricing) : null));
  const inputTokens = usages.map((usage) => usage.inputTokens);
  return Object.freeze({
    costMicros: costs.every((value) => value !== null)
      ? costs.reduce((sum, value) => sum + value!, 0)
      : null,
    inputTokens: inputTokens.every(Number.isSafeInteger)
      ? inputTokens.reduce((sum, value) => sum + value, 0)
      : null
  });
}

/**
 * Resolves the installation System Model without substitution and adapts its
 * verified strict-structured-output path to reranker scores. It never treats
 * System Model installation authority as Knowledge Profile authorization.
 */
export async function resolveSystemModelRerankerExecutor(input: Readonly<{
  executeStructuredOutput: StructuredExecutor;
  pricing?: ModelTokenPricing;
  resolveSystemModel(): Promise<SystemModelRoleResolution>;
}>): Promise<KnowledgeSystemModelRunnerResolution> {
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
  const modelRevision = createHash("sha256")
    .update(JSON.stringify(model), "utf8")
    .digest("hex")
    .slice(0, 16);
  const executor: KnowledgeSemanticRerankerExecutor = Object.freeze({
    identity: Object.freeze({
      authorization: "evaluation_only" as const,
      backend: model.adapterKind,
      egress: "external" as const,
      hardware: "provider_managed" as const,
      modelId: model.upstreamModelId,
      provider: resolution.role.snapshot.providerFamily,
      resources: Object.freeze({
        cpuLogicalCores: null,
        gpuDevice: null,
        scope: "provider_managed" as const
      }),
      revision: `installation-policy-${resolution.policyVersion}-model-${modelRevision}`
    }),
    async rerank(scoringInput) {
      const structured = systemModelRequest(scoringInput, resolution.reasoningEffort);
      const usages: ModelRunUsage[] = [];
      const raw = await input.executeStructuredOutput(
        resolution.role,
        structured.request,
        { onUsage: (usage) => usages.push(usage), timeoutMs: 30_000 }
      );
      const decoded = systemScoresSchema.parse(raw);
      if (decoded.scores.length !== structured.handles.size ||
        new Set(decoded.scores.map((score) => score.handle)).size !== structured.handles.size ||
        decoded.scores.some((score) => !structured.handles.has(score.handle))) {
        throw new Error("knowledge_reranker_system_model_response_invalid");
      }
      const usage = summedUsage(usages, input.pricing);
      return Object.freeze({
        ...usage,
        resourceUsage: null,
        scores: Object.freeze(decoded.scores.map((score) => Object.freeze({
          passageId: structured.handles.get(score.handle)!,
          score: score.score
        })))
      });
    }
  });
  return Object.freeze({ executor, status: "available" });
}
