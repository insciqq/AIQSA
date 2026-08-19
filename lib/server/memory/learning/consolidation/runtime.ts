import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../../../domain/modelRunEvents";
import type { ProviderConnectionConfiguration } from "../../../providers/providerConfiguration";
import type { ProviderExecutionSnapshot } from "../../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../../providers/types";
import type { MemorySecretFreeExecutionSnapshot } from "../../execution";
import {
  createAcceptedMemoryLearningProvider,
  type MemoryLearningProviderResult
} from "../providerRuntime";
import type {
  MemoryFactConsolidationInput,
  MemoryFactVerificationInput
} from "./contract";
import {
  MEMORY_FACT_CONSOLIDATION_SYSTEM_PROMPT,
  MEMORY_FACT_VERIFICATION_SYSTEM_PROMPT,
  memoryFactConsolidationPromptPayload,
  memoryFactConsolidationTool,
  memoryFactVerificationPromptPayload,
  memoryFactVerificationTool
} from "./prompt";

export const MEMORY_FACT_VERIFICATION_MAX_OUTPUT_TOKENS = 800;

export type MemoryFactDecisionProviderEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  logicalRole: "MEMORY_CONSOLIDATE" | "MEMORY_VERIFY";
  providerModelId: string;
}>;

export type MemoryFactDecisionProviderRequest =
  | Readonly<{ input: MemoryFactConsolidationInput; kind: "CONSOLIDATE" }>
  | Readonly<{ input: MemoryFactVerificationInput; kind: "VERIFY" }>;

export type MemoryFactDecisionProviderResult = MemoryLearningProviderResult;

export type MemoryFactDecisionProvider = Readonly<{
  run(
    evidence: MemoryFactDecisionProviderEvidence,
    request: MemoryFactDecisionProviderRequest,
    signal: AbortSignal
  ): Promise<MemoryFactDecisionProviderResult>;
}>;

export class MemoryFactDecisionProviderCallError extends Error {
  constructor(
    readonly usage: ModelRunUsage | null,
    options: Readonly<{ cause?: unknown }> = {}
  ) {
    super("memory_fact_decision_provider_outcome_unknown", options);
    this.name = "MemoryFactDecisionProviderCallError";
  }
}

export function memoryFactDecisionToolChoice(
  kind: MemoryFactDecisionProviderRequest["kind"]
): NonNullable<ProviderRunRequest["toolChoice"]> {
  return kind === "VERIFY" ? "required" : "auto";
}

function providerRequest(
  snapshot: ProviderExecutionSnapshot,
  request: MemoryFactDecisionProviderRequest
): ProviderRunRequest {
  const model = snapshot.model;
  if (model.adapterKind === "fake" || model.modelClass !== "answer") {
    throw new Error("memory_fact_decision_runtime_invalid");
  }
  const maxOutputTokens = Math.min(
    model.capabilities.defaultMaxOutputTokens ?? 1_200,
    request.kind === "VERIFY" ? MEMORY_FACT_VERIFICATION_MAX_OUTPUT_TOKENS : 1_200
  );
  const input = request.input;
  return {
    attachmentIds: [],
    attachments: [],
    chatId: input.candidate.chatId,
    content: {
      blocks: [{
        text: request.kind === "CONSOLIDATE"
          ? memoryFactConsolidationPromptPayload(request.input)
          : memoryFactVerificationPromptPayload(request.input),
        type: "text"
      }]
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
      system: request.kind === "CONSOLIDATE"
        ? MEMORY_FACT_CONSOLIDATION_SYSTEM_PROMPT
        : MEMORY_FACT_VERIFICATION_SYSTEM_PROMPT
    },
    provider: snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: memoryFactDecisionToolChoice(request.kind),
    tools: [request.kind === "CONSOLIDATE"
      ? memoryFactConsolidationTool
      : memoryFactVerificationTool]
  };
}

export function memoryFactDecisionProviderEvidence(
  snapshot: MemorySecretFreeExecutionSnapshot
): MemoryFactDecisionProviderEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (
    !provider.credentialId || !provider.credentialVersionId ||
    (snapshot.logicalRole !== "MEMORY_CONSOLIDATE" &&
      snapshot.logicalRole !== "MEMORY_VERIFY")
  ) throw new Error("memory_fact_decision_binding_invalid");
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    logicalRole: snapshot.logicalRole,
    providerModelId: provider.providerModelId
  };
}

type RuntimeClient = Pick<PrismaClient, "$transaction">;

/** Dispatches only through the immutable target accepted by execution admission. */
export function createAcceptedMemoryFactDecisionProvider(
  client: RuntimeClient,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): MemoryFactDecisionProvider {
  const run = createAcceptedMemoryLearningProvider<
    MemoryFactDecisionProviderEvidence,
    MemoryFactDecisionProviderRequest
  >(client, {
    ...options,
    buildRequest: providerRequest,
    callError: (usage, cause) =>
      new MemoryFactDecisionProviderCallError(usage, { cause }),
    invalidRuntimeError: "memory_fact_decision_runtime_invalid",
    validate: (evidence, _snapshot, request) =>
      evidence.logicalRole === (request.kind === "CONSOLIDATE"
        ? "MEMORY_CONSOLIDATE"
        : "MEMORY_VERIFY")
  });
  return Object.freeze({
    run
  });
}
