import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ModelRunSseEvent,
  ModelRunUsage
} from "../../../../domain/modelRunEvents";
import { decryptProviderCredentialSecret } from "../../../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "../../../providers/providerConfiguration";
import { createProviderSafeFetch } from "../../../providers/providerSafeFetch";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../../providers/runtimeFactory";
import type { ProviderRunRequest, ProviderRunResult } from "../../../providers/types";
import { getSecretEncryptionKey } from "../../../secrets/envelope";
import type { ModelToolCall } from "../../../tools/types";
import type { MemorySecretFreeExecutionSnapshot } from "../../execution";
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

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

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

export type MemoryFactDecisionProviderResult = Readonly<{
  outputKind:
    | "message_without_text"
    | "no_output_items"
    | "other_nontext"
    | "reasoning_only"
    | "text_and_tool_calls"
    | "text_only"
    | "tool_calls_only";
  providerResponseId: string | null;
  toolCalls: readonly ModelToolCall[] | undefined;
  usage: ModelRunUsage;
}>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

function boundedProviderResponseId(value: string | undefined): string | null {
  return value && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(value)
    ? value
    : null;
}

export function memoryFactDecisionOutputKind(
  result: Pick<
    ProviderRunResult,
    "finalProviderResponsePreview" | "finalText" | "toolCalls"
  >
): MemoryFactDecisionProviderResult["outputKind"] {
  const hasText = result.finalText.trim().length > 0;
  const hasToolCalls = (result.toolCalls?.length ?? 0) > 0;
  if (hasText) return hasToolCalls ? "text_and_tool_calls" : "text_only";
  if (hasToolCalls) return "tool_calls_only";

  const previewOutput = result.finalProviderResponsePreview.output;
  if (!Array.isArray(previewOutput) || previewOutput.length === 0) {
    return "no_output_items";
  }
  const itemTypes = previewOutput.map((item) =>
    isRecord(item) && typeof item.type === "string" ? item.type : null);
  if (itemTypes.every((type) => type === "reasoning")) return "reasoning_only";
  if (itemTypes.some((type) => type === "message")) return "message_without_text";
  return "other_nontext";
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
    knowledgePlan: { baseIds: [] },
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

async function collectProviderResult(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<ProviderRunResult> {
  let lastUsage: ModelRunUsage | null = null;
  try {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "usage") lastUsage = next.value.data;
      next = await stream.next();
    }
    return next.value;
  } catch (error) {
    throw new MemoryFactDecisionProviderCallError(lastUsage, { cause: error });
  }
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
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  return Object.freeze({
    async run(evidence, request, signal) {
      const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
      const expectedRole = request.kind === "CONSOLIDATE"
        ? "MEMORY_CONSOLIDATE"
        : "MEMORY_VERIFY";
      if (
        evidence.logicalRole !== expectedRole ||
        snapshot.connectionId !== evidence.connectionId ||
        snapshot.providerModelId !== evidence.providerModelId ||
        snapshot.credentialId !== evidence.credentialId ||
        snapshot.credentialVersionId !== evidence.credentialVersionId ||
        snapshot.model.adapterKind === "fake" ||
        snapshot.model.modelClass !== "answer" ||
        snapshot.model.capabilities.toolCalling !== true
      ) throw new Error("memory_fact_decision_runtime_invalid");
      const authenticationMode = providerAuthenticationMode(snapshot.connection);
      const lockCredential = async (expectNoAuth: boolean): Promise<string | null> =>
        client.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<LockedCredentialVersion[]>(Prisma.sql`
            SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
            FROM "ProviderCredentialVersion"
            WHERE "credentialId" = ${evidence.credentialId}
              AND "id" = ${evidence.credentialVersionId}
            FOR SHARE
          `);
          const version = rows[0];
          if (
            !version || version.revokedAt ||
            version.credentialId !== evidence.credentialId ||
            version.id !== evidence.credentialVersionId ||
            expectNoAuth !== noAuthEvidence(version.testEvidence) ||
            expectNoAuth !== (version.secretEnvelope === null)
          ) throw new Error("credential_revoked");
          return version.secretEnvelope === null
            ? null
            : decryptProviderCredentialSecret({
                credentialId: version.credentialId,
                envelope: version.secretEnvelope,
                key: encryptionKey(),
                valueId: version.id
              });
        });
      const baseFetch = options.createFetch?.(snapshot.connection) ??
        createProviderSafeFetch({ configuration: snapshot.connection });
      const fetchFn: typeof fetch = authenticationMode === "none"
        ? async (fetchRequest, init) => {
            await lockCredential(true);
            return baseFetch(fetchRequest, init);
          }
        : baseFetch;
      const runtime = createProviderRuntimeBinding({
        options: { allowFake: false, fetchFn },
        secret: authenticationMode === "none"
          ? null
          : async () => {
              const secret = await lockCredential(false);
              if (secret === null) throw new Error("credential_revoked");
              return secret;
            },
        snapshot
      });
      if (!runtime.toolBridge?.supportsToolCalling({
        modelId: snapshot.model.upstreamModelId,
        provider: snapshot.providerFamily
      })) throw new Error("memory_fact_decision_runtime_invalid");
      const result = await collectProviderResult(
        runtime.adapter.stream(providerRequest(snapshot, request), { signal })
      );
      return {
        outputKind: memoryFactDecisionOutputKind(result),
        providerResponseId: boundedProviderResponseId(result.providerResponseId),
        toolCalls: result.toolCalls,
        usage: result.usage
      };
    }
  });
}
