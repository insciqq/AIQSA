import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../../../domain/modelRunEvents";
import type { ProviderConnectionConfiguration } from "../../../providers/providerConfiguration";
import type { ProviderExecutionSnapshot } from "../../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../../providers/types";
import type {
  MemoryExecutionRole,
  MemoryLegacyExecutionRole,
  MemorySecretFreeExecutionSnapshot
} from "../../execution";
import {
  createAcceptedMemoryLearningProvider,
  type MemoryLearningProviderFailure,
  type MemoryLearningProviderFailureClassification,
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
  logicalRole: MemoryExecutionRole | MemoryLegacyExecutionRole;
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
  readonly classification: MemoryLearningProviderFailureClassification;
  readonly usage: ModelRunUsage | null;

  constructor(
    failure: MemoryLearningProviderFailure
  ) {
    super(
      failure.classification === "UNKNOWN"
        ? "memory_fact_decision_provider_outcome_unknown"
        : failure.classification === "REPLAY_SAFE_TRANSIENT"
          ? "memory_fact_decision_provider_transient"
          : "memory_fact_decision_provider_unavailable",
      { cause: failure.cause }
    );
    this.name = "MemoryFactDecisionProviderCallError";
    this.classification = failure.classification;
    this.usage = failure.usage;
  }
}

export function memoryFactDecisionToolChoice(
  _kind: MemoryFactDecisionProviderRequest["kind"]
): NonNullable<ProviderRunRequest["toolChoice"]> {
  // Keep the legacy diagnostic helper stable for persisted v2 callers. The
  // active v1 provider request below is unconditionally forced-required.
  return _kind === "VERIFY" ? "required" : "auto";
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
    toolChoice: "required",
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
    (snapshot.logicalRole as string) !== "MEMORY_CONSOLIDATE" &&
      (snapshot.logicalRole as string) !== "MEMORY_VERIFY"
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
    callError: (usage, cause, classification) =>
      new MemoryFactDecisionProviderCallError({ cause, classification, usage }),
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
