import type { PrismaClient } from "@prisma/client";
import type { ProviderConnectionConfiguration } from "../../../providers/providerConfiguration";
import type { ProviderExecutionSnapshot } from "../../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../../providers/types";
import {
  createAcceptedMemoryLearningProvider,
  type MemoryLearningProviderResult
} from "../providerRuntime";
import {
  MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT,
  memorySemanticAdjudicationPromptPayload,
  memorySemanticAdjudicationTool,
  type MemorySemanticAdjudicationInput
} from "./adjudication";
import {
  MemoryFactProviderCallError,
  type MemoryFactProviderEvidence
} from "./runtime";

export type MemorySemanticAdjudicationProvider = Readonly<{
  run(
    evidence: MemoryFactProviderEvidence,
    input: MemorySemanticAdjudicationInput,
    signal: AbortSignal
  ): Promise<MemoryLearningProviderResult>;
}>;

function providerRequest(
  snapshot: ProviderExecutionSnapshot,
  input: MemorySemanticAdjudicationInput
): ProviderRunRequest {
  const model = snapshot.model;
  if (model.adapterKind === "fake" || model.modelClass !== "answer") {
    throw new Error("memory_semantic_adjudication_runtime_invalid");
  }
  const maxOutputTokens = Math.min(
    model.capabilities.defaultMaxOutputTokens ?? 1_600,
    1_600
  );
  return {
    attachmentIds: [],
    attachments: [],
    chatId: input.plan.input.source.chatId,
    content: {
      blocks: [{ text: memorySemanticAdjudicationPromptPayload(input), type: "text" }]
    },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
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
      system: MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT
    },
    provider: snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "required",
    toolMode: "auto",
    tools: [memorySemanticAdjudicationTool]
  };
}

type RuntimeClient = Pick<PrismaClient, "$transaction">;

export function createAcceptedMemorySemanticAdjudicationProvider(
  client: RuntimeClient,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): MemorySemanticAdjudicationProvider {
  const run = createAcceptedMemoryLearningProvider<
    MemoryFactProviderEvidence,
    MemorySemanticAdjudicationInput
  >(client, {
    ...options,
    buildRequest: providerRequest,
    callError: (usage, cause, classification) => new MemoryFactProviderCallError({
      cause,
      classification,
      usage
    }),
    invalidRuntimeError: "memory_semantic_adjudication_runtime_invalid"
  });
  return Object.freeze({ run });
}
