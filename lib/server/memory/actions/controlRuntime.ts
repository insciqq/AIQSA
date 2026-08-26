import type { PrismaClient } from "@prisma/client";
import {
  MEMORY_ACTION_INTENT_JSON_SCHEMA,
  MEMORY_ACTION_INTENT_NAME,
  MEMORY_ACTION_INTENT_SCHEMA_VERSION,
  decodeMemoryActionIntent,
  type MemoryActionIntent
} from "../../../contracts/memoryActionIntent";
import { normalizeTokenUsage } from "../../../domain/usage";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import { prisma } from "../../prisma";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderRunRequest } from "../../providers/types";
import type { RunTool } from "../../tools/types";
import {
  createPrismaMemoryExecutionService,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionVersions,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import type { MemorySecretFreeExecutionSnapshot } from "../execution/snapshot";
import {
  createAcceptedMemoryLearningProvider,
  type MemoryLearningProviderEvidence,
  type MemoryLearningProviderResult
} from "../learning/providerRuntime";
import { memorySha256 } from "../persistence/lexical";
import {
  buildMemoryActionIntentRequest,
  preserveUniqueQuotedUpdateReplacement,
  type MemoryActionIntentContext
} from "./intentService";

export const MEMORY_CONTROL_PIPELINE_VERSION = "memory-control-v13";

export const MEMORY_CONTROL_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_CONTROL_PIPELINE_VERSION,
  policyVersion: "memory-control-policy-v13",
  promptVersion: "memory-control-prompt-v18",
  retrievalConfigFingerprint: memoryExecutionSha256({
    actionIntentSchema: MEMORY_ACTION_INTENT_NAME,
    maxCalls: 1,
    version: 11
  }),
  schemaVersion: MEMORY_ACTION_INTENT_SCHEMA_VERSION
});

export type MemoryControlResult =
  | Readonly<{
      bindingId: string;
      intent: MemoryActionIntent;
      status: "READY";
    }>
  | Readonly<{
      bindingId?: string;
      reason: string;
      status: "UNAVAILABLE";
    }>;

export type MemoryControlService = Readonly<{
  decide(input: Readonly<{
    attemptId: string;
    context: MemoryActionIntentContext;
    signal: AbortSignal;
    userId: string;
  }>): Promise<MemoryControlResult>;
}>;

type ControlProviderEvidence = MemoryLearningProviderEvidence;

type ControlProvider = Readonly<{
  run(
    evidence: ControlProviderEvidence,
    request: ReturnType<typeof buildMemoryActionIntentRequest>,
    signal: AbortSignal
  ): Promise<MemoryLearningProviderResult>;
}>;

const unavailableUsage: MemoryReportedUsage = Object.freeze({
  cachedInputTokens: null,
  completeness: "UNAVAILABLE",
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
});

function reportedUsage(usage: ModelRunUsage): MemoryReportedUsage {
  const normalized = normalizeTokenUsage(usage);
  return {
    cachedInputTokens: normalized.cachedInputTokens,
    completeness: "COMPLETE",
    estimatedCostMicros: null,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
    totalTokens: normalized.totalTokens
  };
}

function controlTool(): RunTool {
  return {
    capability: "memory",
    description: "Return the one strict Personal Memory control decision for this turn.",
    inputSchema: MEMORY_ACTION_INTENT_JSON_SCHEMA,
    name: MEMORY_ACTION_INTENT_NAME,
    strict: true
  };
}

function providerRequest(
  snapshot: ProviderExecutionSnapshot,
  request: ReturnType<typeof buildMemoryActionIntentRequest>
): ProviderRunRequest {
  const model = snapshot.model;
  if (model.adapterKind === "fake" || model.modelClass !== "answer" ||
    model.capabilities.toolCalling !== true) {
    throw new Error("memory_control_runtime_invalid");
  }
  const maxOutputTokens = Math.min(
    request.maxOutputTokens ?? 1_024,
    model.capabilities.defaultMaxOutputTokens ?? 1_024
  );
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "memory-control",
    content: { blocks: [{ text: request.userPrompt, type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: model.capabilities,
    modelId: model.upstreamModelId,
    parallelToolCalls: false,
    params: {
      ...model.defaultParams,
      ...(model.adapterKind === "openrouter_chat_completions"
        ? { reasoning: { enabled: false, exclude: true } }
        : {}),
      background: false,
      maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      store: false,
      stream: false
    },
    prompt: { developer: null, system: request.systemPrompt },
    provider: snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "required",
    toolMode: "auto",
    tools: [controlTool()]
  };
}

function providerEvidence(
  snapshot: MemorySecretFreeExecutionSnapshot
): ControlProviderEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (snapshot.logicalRole !== "MEMORY_CONTROL" ||
    !provider.credentialId || !provider.credentialVersionId) {
    throw new Error("memory_control_binding_invalid");
  }
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    providerModelId: provider.providerModelId
  };
}

function decodeProviderResult(result: MemoryLearningProviderResult): MemoryActionIntent | null {
  const call = result.toolCalls?.[0];
  if (result.toolCalls?.length !== 1 || call?.name !== MEMORY_ACTION_INTENT_NAME) return null;
  const decoded = decodeMemoryActionIntent(call.arguments);
  return decoded.ok ? decoded.value : null;
}

export function memoryControlIntentHash(intent: MemoryActionIntent): string {
  return memoryExecutionSha256({ intent, version: 5 });
}

export function memoryControlInputHash(context: MemoryActionIntentContext): string {
  return memoryExecutionSha256({
    capabilities: context.capabilities,
    currentUserMessageHash: memorySha256(context.currentUserMessage),
    memoryRefHashes: (context.memoryRefs ?? []).map(memorySha256),
    recentMessageHashes: (context.recentMessages ?? []).map((message) => ({
      role: message.role,
      textHash: memorySha256(message.text)
    })),
    version: 1
  });
}

export function memoryControlAcceptedOutputHash(
  inputHash: string,
  intentHash: string
): string {
  return memoryExecutionSha256({ inputHash, intentHash, version: 3 });
}

export const MEMORY_READ_ONLY_CONTROL_REUSE_VERSION = 6 as const;

export type MemoryReadOnlyControlReuseProof = Readonly<{
  acceptedOutputHash: string;
  inputHash: string;
  intent: MemoryActionIntent;
  sourceAttemptId: string;
  sourceBindingId: string;
  version: typeof MEMORY_READ_ONLY_CONTROL_REUSE_VERSION;
}>;

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

export function createMemoryReadOnlyControlReuseProof(input: Readonly<{
  inputHash: string;
  result: Extract<MemoryControlResult, { status: "READY" }>;
  sourceAttemptId: string;
}>): MemoryReadOnlyControlReuseProof | null {
  const { intent } = input.result;
  if (
    !/^[a-f0-9]{64}$/u.test(input.inputHash) ||
    !boundedIdentifier(input.sourceAttemptId) ||
    !boundedIdentifier(input.result.bindingId) ||
    intent.action !== "NONE"
  ) return null;
  return Object.freeze({
    acceptedOutputHash: memoryControlAcceptedOutputHash(
      input.inputHash,
      memoryControlIntentHash(intent)
    ),
    inputHash: input.inputHash,
    intent,
    sourceAttemptId: input.sourceAttemptId,
    sourceBindingId: input.result.bindingId,
    version: MEMORY_READ_ONLY_CONTROL_REUSE_VERSION
  });
}

export function decodeMemoryReadOnlyControlReuseProof(
  value: unknown
): MemoryReadOnlyControlReuseProof | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 6 ||
    record.version !== MEMORY_READ_ONLY_CONTROL_REUSE_VERSION ||
    typeof record.acceptedOutputHash !== "string" ||
    typeof record.inputHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.acceptedOutputHash) ||
    !/^[a-f0-9]{64}$/u.test(record.inputHash) ||
    !boundedIdentifier(record.sourceAttemptId) ||
    !boundedIdentifier(record.sourceBindingId)
  ) return null;
  const decodedIntent = decodeMemoryActionIntent(record.intent);
  if (!decodedIntent.ok) return null;
  const proof = createMemoryReadOnlyControlReuseProof({
    inputHash: record.inputHash,
    result: {
      bindingId: record.sourceBindingId,
      intent: decodedIntent.value,
      status: "READY"
    },
    sourceAttemptId: record.sourceAttemptId
  });
  return proof?.acceptedOutputHash === record.acceptedOutputHash ? proof : null;
}

export function createMemoryControlService(input: Readonly<{
  execution: PrismaMemoryExecutionService;
  provider: ControlProvider;
}>): MemoryControlService {
  return Object.freeze({
    async decide(requestInput) {
      const inputHash = memoryControlInputHash(requestInput.context);
      let bindingId: string | undefined;
      try {
        const binding = await input.execution.admission.bind(requestInput.userId, {
          inputHash,
          ordinal: 0,
          owner: { retrievalAttemptId: requestInput.attemptId, type: "RETRIEVAL_ATTEMPT" },
          role: "MEMORY_CONTROL",
          versions: MEMORY_CONTROL_VERSIONS
        });
        bindingId = binding.id;
        const started = await input.execution.admission.start(requestInput.userId, binding.id);
        if (started.snapshot.logicalRole !== "MEMORY_CONTROL" ||
          !started.snapshot.requiresStrictStructuredOutput) {
          throw new Error("memory_control_binding_invalid");
        }
        const result = await input.provider.run(
          providerEvidence(started.snapshot),
          buildMemoryActionIntentRequest(requestInput.context),
          requestInput.signal
        );
        const decodedIntent = decodeProviderResult(result);
        if (!decodedIntent) {
          await input.execution.lifecycle.settle(requestInput.userId, binding.id, {
            acceptedOutputHash: null,
            errorCode: "memory_action_intent_invalid",
            providerResponseId: result.providerResponseId,
            state: "FAILED",
            usage: reportedUsage(result.usage)
          });
          return { bindingId: binding.id, reason: "memory_action_intent_invalid", status: "UNAVAILABLE" };
        }
        const intent = preserveUniqueQuotedUpdateReplacement(
          decodedIntent,
          requestInput.context.currentUserMessage
        );
        const outputHash = memoryControlAcceptedOutputHash(
          inputHash,
          memoryControlIntentHash(intent)
        );
        await input.execution.lifecycle.settle(requestInput.userId, binding.id, {
          acceptedOutputHash: outputHash,
          errorCode: null,
          providerResponseId: result.providerResponseId,
          state: "SUCCEEDED",
          usage: reportedUsage(result.usage)
        });
        await input.execution.lifecycle.withAuthorizedResultCommit(
          requestInput.userId,
          { acceptedOutputHash: outputHash, bindingId: binding.id },
          async () => true
        );
        return { bindingId: binding.id, intent, status: "READY" };
      } catch {
        if (bindingId) {
          await input.execution.lifecycle.settle(requestInput.userId, bindingId, {
            acceptedOutputHash: null,
            errorCode: "memory_action_intent_unavailable",
            providerResponseId: null,
            state: requestInput.signal.aborted ? "CANCELLED" : "FAILED",
            usage: unavailableUsage
          }).catch(() => undefined);
        }
        return {
          ...(bindingId ? { bindingId } : {}),
          reason: "memory_action_intent_unavailable",
          status: "UNAVAILABLE"
        };
      }
    }
  });
}

export function createAcceptedMemoryControlProvider(
  client: PrismaClient = prisma
): ControlProvider {
  const run = createAcceptedMemoryLearningProvider<
    ControlProviderEvidence,
    ReturnType<typeof buildMemoryActionIntentRequest>
  >(client, {
    buildRequest: providerRequest,
    callError: (_usage, cause) => new Error("memory_control_provider_failed", { cause }),
    invalidRuntimeError: "memory_control_runtime_invalid"
  });
  return Object.freeze({ run });
}

export function createPrismaMemoryControlService(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma
): MemoryControlService {
  return createMemoryControlService({
    execution: createPrismaMemoryExecutionService(authority, client),
    provider: createAcceptedMemoryControlProvider(client)
  });
}
