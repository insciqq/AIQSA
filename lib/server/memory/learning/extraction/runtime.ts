import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../../../domain/modelRunEvents";
import type { ProviderConnectionConfiguration } from "../../../providers/providerConfiguration";
import type { ProviderExecutionSnapshot } from "../../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../../providers/types";
import type { MemorySecretFreeExecutionSnapshot } from "../../execution";
import {
  createAcceptedMemoryLearningProvider,
  type MemoryLearningProviderFailure,
  type MemoryLearningProviderFailureClassification,
  type MemoryLearningProviderResult
} from "../providerRuntime";
import type { MemoryFactExtractionInput } from "./contract";
import {
  MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT,
  memoryFactExtractionPromptPayload,
  memoryFactExtractionTool
} from "./prompt";

export type MemoryFactProviderEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;

export type MemoryFactProviderResult = MemoryLearningProviderResult;

export type MemoryFactProvider = Readonly<{
  run(
    evidence: MemoryFactProviderEvidence,
    input: MemoryFactExtractionInput,
    signal: AbortSignal
  ): Promise<MemoryFactProviderResult>;
}>;

export class MemoryFactProviderCallError extends Error {
  readonly classification: MemoryLearningProviderFailureClassification;
  readonly usage: ModelRunUsage | null;

  constructor(
    failure: MemoryLearningProviderFailure
  ) {
    super(
      failure.classification === "UNKNOWN"
        ? "memory_fact_provider_outcome_unknown"
        : failure.classification === "REPLAY_SAFE_TRANSIENT"
          ? "memory_fact_provider_transient"
          : "memory_fact_provider_unavailable",
      { cause: failure.cause }
    );
    this.name = "MemoryFactProviderCallError";
    this.classification = failure.classification;
    this.usage = failure.usage;
  }
}

function providerRequest(
  snapshot: ProviderExecutionSnapshot,
  input: MemoryFactExtractionInput
): ProviderRunRequest {
  const model = snapshot.model;
  if (model.adapterKind === "fake" || model.modelClass !== "answer") {
    throw new Error("memory_fact_runtime_invalid");
  }
  const maxOutputTokens = Math.min(
    model.capabilities.defaultMaxOutputTokens ?? 2_400,
    2_400
  );
  return {
    attachmentIds: [],
    attachments: [],
    chatId: input.source.chatId,
    content: {
      blocks: [{ text: memoryFactExtractionPromptPayload(input), type: "text" }]
    },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: model.capabilities,
    modelId: model.upstreamModelId,
    parallelToolCalls: false,
    params: {
      ...model.defaultParams,
      background: false,
      maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      store: false,
      stream: false
    },
    prompt: {
      developer: null,
      system: MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT
    },
    provider: snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    // The extraction contract is one forced strict System Model call.  A
    // free-form answer or an omitted tool call is not an extraction result.
    toolChoice: "required",
    tools: [memoryFactExtractionTool]
  };
}

export function memoryFactProviderEvidence(
  snapshot: MemorySecretFreeExecutionSnapshot
): MemoryFactProviderEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (!provider.credentialId || !provider.credentialVersionId) {
    throw new Error("memory_fact_binding_invalid");
  }
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    providerModelId: provider.providerModelId
  };
}

type RuntimeClient = Pick<PrismaClient, "$transaction">;

/** Resolves only the immutable target accepted by Memory execution admission.
 * The exact credential version is share-locked and rechecked on every request. */
export function createAcceptedMemoryFactProvider(
  client: RuntimeClient,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): MemoryFactProvider {
  const run = createAcceptedMemoryLearningProvider<
    MemoryFactProviderEvidence,
    MemoryFactExtractionInput
  >(client, {
    ...options,
    buildRequest: providerRequest,
    callError: (usage, cause, classification) => new MemoryFactProviderCallError({
      cause,
      classification,
      usage
    }),
    invalidRuntimeError: "memory_fact_runtime_invalid"
  });
  return Object.freeze({
    run
  });
}
