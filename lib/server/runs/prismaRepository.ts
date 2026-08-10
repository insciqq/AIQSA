import { randomUUID } from "node:crypto";
import {
  Prisma,
  type MessageStatus,
  type ModelRunStatus,
  type ModelRunToolCallState,
  type PrismaClient
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import {
  groundedLiveOnlyMessageContent,
  groundedLiveOnlyProviderPreview
} from "../../domain/grounding";
import {
  isGroundingDisplaySseEvent,
  textFromContentBlocks,
  type ModelRunSseEvent
} from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import {
  loadChatBranchSnapshotStats,
  summarizeMessageRunArtifacts
} from "../chats/prismaRepository";
import { titleFromMessageContent } from "../chats/titlePolicy";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import {
  ProviderAdmissionError,
  loadProviderAdmissionPlan,
  sameProviderAdmissionPlan,
  type ProviderAdmissionPlan,
  type ProviderAdmissionRole
} from "../providerRuntime/admission";
import { prisma } from "../prisma";
import type { ProviderConversationMessage } from "../providers/types";
import { normalizedRequestHasExternalToolCapability } from "../providers/personalContext";
import {
  applySettingsUpdateInTransaction,
  type SettingsTransactionClient
} from "../settings/settingsTransaction";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AssistantRunConflictError,
  AttachmentLinkConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  type AcceptedRunDefaults,
  type DurableRunControlRecord,
  type PreparingRunAdmissionInput,
  type PreparingRunAdmissionResult,
  type PreparingRunFinalizationInput,
  type PreparingRunMaterializedRequest,
  type PreparingRunRecoveryResult,
  type RunAttachmentRecord,
  type RunRepository
} from "./runRepositoryContract";
import { decodeMemoryActionPlan } from "../memory/actions/intent";
import {
  MemoryRunActionAuthorizationError,
  authorizeRunMemoryAction
} from "../memory/actions/runAuthorization";
import {
  ExplicitRunMemoryManagementError,
  explicitRunSafeFactText,
  retrieveExplicitRunMemory
} from "../memory/retrieval/explicitRun";
import {
  decodeAssistantAvatarRecipe,
  type AssistantAvatarRecipe
} from "../../contracts/assistants";
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { decodeKnowledgeRunProjection } from "../../contracts/runs";
import { projectKnowledgeInspectionEvents } from "./knowledgeInspectionEvents";
import type { McpRunPlanBinding } from "../mcp/runPlan";
import {
  KnowledgeRunAdmissionError,
  loadKnowledgeRunAdmissionPlan,
  sameKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import { persistedToolCallActivity } from "./toolInspection";
import {
  isToolLoopJsonValue,
  parseToolLoopCheckpoint,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits,
  upsertAnswerRoundUsage,
  type CheckpointedToolLoopRun,
  type PersistedToolLoopCall,
  type PersistToolLoopCallBatchInput,
  type ToolLoopCheckpoint,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import {
  MEMORY_PREPARING_ATTEMPT_TTL_MS,
  MEMORY_PREPARING_QUERY_PLANNER_VERSION,
  MEMORY_PREPARING_RETRIEVAL_PIPELINE_VERSION,
  MemoryPreparingRunConflictError,
  createMemoryPreparingBaseSnapshot,
  decodeMemoryPreparingBaseSnapshot,
  decodeMemoryPreparingSettingsSnapshot,
  dormantMemoryAttemptResult,
  memoryPreparingHash,
  memoryPreparingHasAuthoritativeEmptyList,
  memoryPreparingSettingsSnapshot,
  memoryPreparingTextHash,
  sameMemoryPreparingSettings,
  validateMemoryPreparingAttemptResult,
  type MemoryPreparingAttemptResult,
  type MemoryPreparingSettingsSnapshot
} from "./preparingRun";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knowledgePlanFromNormalizedRequest(value: unknown): KnowledgePlan {
  const candidate = isRecord(value) ? value.knowledgePlan : undefined;
  const decoded = decodeKnowledgePlan(candidate);
  if (!decoded.ok) throw new Error("knowledge_plan_integrity_invalid");
  return decoded.plan;
}

function knowledgeDefaultFromJson(value: unknown): KnowledgePlan | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeKnowledgePlan(value);
  if (!decoded.ok) throw new Error("knowledge_default_integrity_invalid");
  return decoded.plan;
}

function canonicalJson(value: ToolLoopJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolLoopArguments(value: unknown): Readonly<Record<string, ToolLoopJsonValue>> | null {
  const snapshot = snapshotToolLoopJson(value, toolLoopPersistenceLimits.argumentsBytes);
  return snapshot && isRecord(snapshot)
    ? snapshot as Readonly<Record<string, ToolLoopJsonValue>>
    : null;
}

type ToolLoopCallRecord = {
  arguments: Prisma.JsonValue;
  completedAt: Date | null;
  id: string;
  mcpRunBinding: {
    id: string;
    runtimeGenerationFingerprint: string;
    runtimeGenerationId: string | null;
  } | null;
  ordinal: number;
  providerCallId: string;
  result: Prisma.JsonValue | null;
  roundIndex: number;
  startedAt: Date | null;
  state: ModelRunToolCallState;
  toolName: string;
};

const toolLoopCallInclude = {
  mcpRunBinding: {
    select: {
      id: true,
      runtimeGenerationFingerprint: true,
      runtimeGenerationId: true
    }
  }
} satisfies Prisma.ModelRunToolCallInclude;

function persistedToolLoopCall(call: ToolLoopCallRecord): PersistedToolLoopCall {
  const argumentsValue = toolLoopArguments(call.arguments);
  const result = call.result === null
    ? null
    : snapshotToolLoopJson(call.result, toolLoopPersistenceLimits.resultBytes);
  if (!argumentsValue || (call.result !== null && result === null)) {
    throw new Error("tool_loop_call_invalid_in_storage");
  }
  return {
    arguments: argumentsValue,
    completedAt: call.completedAt?.toISOString() ?? null,
    id: call.id,
    mcpBinding: call.mcpRunBinding,
    ordinal: call.ordinal,
    providerCallId: call.providerCallId,
    result,
    roundIndex: call.roundIndex,
    startedAt: call.startedAt?.toISOString() ?? null,
    state: call.state,
    toolName: call.toolName
  };
}

function sameCheckpoint(left: ToolLoopCheckpoint, right: ToolLoopCheckpoint): boolean {
  return canonicalJson(left as unknown as ToolLoopJsonValue) ===
    canonicalJson(right as unknown as ToolLoopJsonValue);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function defaultMaxOutputTokens(defaultParams: unknown): number | undefined {
  if (!isRecord(defaultParams)) {
    return undefined;
  }

  return (
    numberValue(defaultParams.maxOutputTokens) ??
    numberValue(defaultParams.maxTokens) ??
    numberValue(defaultParams.max_output_tokens) ??
    numberValue(defaultParams.max_tokens) ??
    numberValue(defaultParams.max_completion_tokens) ??
    undefined
  );
}

function modelControlKey(input: { modelId: string; provider: string }): string {
  return `${input.provider}:${input.modelId}`;
}

function acceptedRunStatus(status: ModelRunStatus): DurableRunControlRecord["status"] {
  if (status === "preparing") {
    throw new Error("memory_preparing_run_not_finalized");
  }
  return status;
}

function runControlRecord(run: {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  status: ModelRunStatus;
}): DurableRunControlRecord {
  return {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    id: run.id,
    modelId: run.modelId,
    provider: run.provider,
    providerResponseId: run.providerResponseId,
    status: acceptedRunStatus(run.status)
  };
}

async function persistAcceptedRunDefaults(
  tx: SettingsTransactionClient,
  userId: string,
  defaults: AcceptedRunDefaults
): Promise<void> {
  if (defaults.userId !== userId) {
    throw new Error("Run defaults user does not match run owner");
  }

  const updatesSearchPreference = Object.prototype.hasOwnProperty.call(
    defaults,
    "searchPreferencePlan"
  );
  const preferredSearchStrategyId = defaults.searchPreferencePlan?.optionIds[0] ?? "search-disabled";
  const result = await applySettingsUpdateInTransaction(
    tx,
    userId,
    {
      defaultControlValues: {
        [modelControlKey(defaults)]: { ...defaults.controlDefaults }
      },
      ...(updatesSearchPreference
        ? {
            defaultSearchPlan: defaults.searchPreferencePlan ?? null,
            ...(defaults.searchPreferencePlan
              ? { defaultSearchStrategyId: preferredSearchStrategyId }
              : {})
          }
        : {})
    },
    [
      {
        modelId: defaults.modelId,
        provider: defaults.provider,
        searchStrategyIds: defaults.searchPreferencePlan?.optionIds.length
          ? [...defaults.searchPreferencePlan.optionIds]
          : []
      }
    ]
  );

  if (result.kind !== "updated") {
    throw new Error(`Run defaults persistence failed: ${result.kind}`);
  }
}

class AssistantProvenanceSerializationError extends Error {
  constructor() {
    super("assistant_provenance_serialization_conflict");
    this.name = "AssistantProvenanceSerializationError";
  }
}

function isPrismaSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" &&
        isRecord(error.meta) &&
        error.meta.code === "40001"));
}

/**
 * In-transaction Assistant acceptance recheck: the definition must still exist
 * unarchived, the revision must belong to it, and the runner must currently be
 * the owner or hold an active group/installation publication for that exact
 * revision. The locking reads serialize archive, publication, active-group, and
 * membership changes with acceptance. A concurrent revision advance is not a
 * conflict — the run records the revision resolved at admission — but access
 * loss, archive, and publication revocation fail with a stable privacy-safe
 * conflict.
 */
async function assertAssistantRunProvenance(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    assistantId: string;
    revisionId: string;
    userId: string;
  }
): Promise<void> {
  try {
    const definitions = await tx.$queryRaw<Array<{ ownerUserId: string }>>`
      SELECT definition."ownerUserId"
      FROM "AssistantDefinition" AS definition
      INNER JOIN "AssistantRevision" AS revision
        ON revision."assistantId" = definition."id"
       AND revision."id" = ${input.revisionId}
      WHERE definition."id" = ${input.assistantId}
        AND definition."archivedAt" IS NULL
      FOR SHARE OF definition
    `;
    const definition = definitions[0];
    if (!definition) throw new AssistantRunConflictError();
    if (definition.ownerUserId === input.userId) return;

    const installationPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "AssistantPublication" AS publication
      WHERE publication."assistantId" = ${input.assistantId}
        AND publication."revisionId" = ${input.revisionId}
        AND publication."scope" = 'installation'
      ORDER BY publication."id"
      FOR SHARE OF publication
    `;
    if (installationPublications[0]) return;

    const groupPublications = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "AssistantPublication" AS publication
      INNER JOIN "UserGroup" AS membership
        ON membership."groupId" = publication."groupId"
       AND membership."userId" = ${input.userId}
      INNER JOIN "Group" AS member_group
        ON member_group."id" = membership."groupId"
       AND member_group."archivedAt" IS NULL
      WHERE publication."assistantId" = ${input.assistantId}
        AND publication."revisionId" = ${input.revisionId}
        AND publication."scope" = 'group'
      ORDER BY publication."id"
      FOR SHARE OF publication, membership, member_group
    `;
    if (!groupPublications[0]) throw new AssistantRunConflictError();
  } catch (error) {
    if (isPrismaSerializationConflict(error)) {
      throw new AssistantProvenanceSerializationError();
    }
    throw error;
  }
}

function serializeRunAssistantIdentity(modelRun: {
  assistantRevision?: { avatar: unknown; name: string; revisionNumber: number } | null;
} | undefined): { avatar: AssistantAvatarRecipe; name: string; revisionNumber: number } | null {
  const revision = modelRun?.assistantRevision;
  if (!revision) return null;
  const avatar = decodeAssistantAvatarRecipe(revision.avatar);
  if (!avatar) return null;
  return {
    avatar,
    name: revision.name,
    revisionNumber: revision.revisionNumber
  };
}

export async function insertAcceptedMcpRunBindings(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  input: {
    bindings: McpRunPlanBinding[] | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  const bindings = input.bindings ?? [];
  const serverIds = new Set<string>();
  const generationIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const binding of bindings) {
    if (!binding.serverId || !binding.runtimeGenerationId || !binding.fingerprint ||
      serverIds.has(binding.serverId) || generationIds.has(binding.runtimeGenerationId) ||
      fingerprints.has(binding.fingerprint)) {
      throw new McpRunPlanConflictError();
    }
    serverIds.add(binding.serverId);
    generationIds.add(binding.runtimeGenerationId);
    fingerprints.add(binding.fingerprint);
  }

  for (const binding of bindings) {
    const inserted = await tx.$executeRaw`
      INSERT INTO "McpRunBinding" (
        "id",
        "modelRunId",
        "runtimeGenerationId",
        "runtimeGenerationFingerprint"
      )
      SELECT
        ${randomUUID()},
        ${input.runId},
        generation."id",
        generation."fingerprint"
      FROM "McpRuntimeGeneration" AS generation
      INNER JOIN "McpUserServer" AS preference
        ON preference."id" = generation."userServerId"
      INNER JOIN "McpServer" AS server
        ON server."id" = preference."serverId"
      INNER JOIN "User" AS owner
        ON owner."id" = preference."userId"
      WHERE owner."id" = ${input.userId}
        AND owner."status" = 'active'
        AND preference."enabled" = true
        AND preference."desiredRuntimeGenerationId" = generation."id"
        AND server."id" = ${binding.serverId}
        AND server."enabled" = true
        AND server."archivedAt" IS NULL
        AND server."activeRevisionId" = generation."revisionId"
        AND generation."id" = ${binding.runtimeGenerationId}
        AND generation."fingerprint" = ${binding.fingerprint}
        AND generation."state" = 'ready'
        AND generation."inventory" IS NOT NULL
        AND generation."inventoryUpdatedAt" IS NOT NULL
        AND generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND EXISTS (
          SELECT 1
          FROM "McpGrant" AS mcp_grant
          WHERE mcp_grant."serverId" = server."id"
            AND mcp_grant."canUse" = true
            AND (
              mcp_grant."userId" = ${input.userId}
              OR mcp_grant."groupId" IN (
                SELECT membership."groupId"
                FROM "UserGroup" AS membership
                INNER JOIN "Group" AS member_group
                  ON member_group."id" = membership."groupId"
                  AND member_group."archivedAt" IS NULL
                WHERE membership."userId" = ${input.userId}
              )
            )
        )
    `;
    if (inserted !== 1) throw new McpRunPlanConflictError();
  }
}

async function lockKnowledgeRunAdmissionSources(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: Readonly<{ plan: KnowledgeRunAdmissionPlan; userId: string }>
): Promise<void> {
  for (const knowledgeBaseId of input.plan.knowledgePlan.baseIds) {
    const bases = await tx.$queryRaw<Array<{
      indexGenerationId: string;
      ownerUserId: string;
    }>>`
      SELECT
        base."ownerUserId",
        generation."id" AS "indexGenerationId"
      FROM "KnowledgeBase" AS base
      INNER JOIN "KnowledgeIndexGeneration" AS generation
        ON generation."knowledgeBaseId" = base."id"
       AND generation."id" = base."activeIndexGenerationId"
       AND generation."status" = 'active'
      WHERE base."id" = ${knowledgeBaseId}
        AND base."archivedAt" IS NULL
      FOR SHARE OF base, generation
    `;
    const base = bases[0];
    if (!base) throw new KnowledgeRunPlanConflictError();
    if (base.ownerUserId === input.userId) continue;

    const installation = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "KnowledgeBasePublication" AS publication
      WHERE publication."knowledgeBaseId" = ${knowledgeBaseId}
        AND publication."scope" = 'installation'
      FOR SHARE OF publication
    `;
    if (installation[0]) continue;

    const group = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT publication."id"
      FROM "KnowledgeBasePublication" AS publication
      INNER JOIN "UserGroup" AS membership
        ON membership."groupId" = publication."groupId"
       AND membership."userId" = ${input.userId}
      INNER JOIN "Group" AS member_group
        ON member_group."id" = membership."groupId"
       AND member_group."archivedAt" IS NULL
      WHERE publication."knowledgeBaseId" = ${knowledgeBaseId}
        AND publication."scope" = 'group'
      ORDER BY publication."id"
      FOR SHARE OF publication, membership, member_group
    `;
    if (!group[0]) throw new KnowledgeRunPlanConflictError();
  }
}

async function insertAcceptedKnowledgeRunBindings(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    plan: KnowledgeRunAdmissionPlan | undefined;
    runId: string;
    userId: string;
  }>
): Promise<void> {
  if (!input.plan) return;
  await lockKnowledgeRunAdmissionSources(tx, {
    plan: input.plan,
    userId: input.userId
  });
  let current: KnowledgeRunAdmissionPlan;
  try {
    current = await loadKnowledgeRunAdmissionPlan(tx, {
      knowledgePlan: input.plan.knowledgePlan,
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof KnowledgeRunAdmissionError || error instanceof ProviderAdmissionError) {
      throw new KnowledgeRunPlanConflictError();
    }
    throw error;
  }
  if (!sameKnowledgeRunAdmissionPlan(input.plan, current)) {
    throw new KnowledgeRunPlanConflictError();
  }
  for (const binding of current.bindings) {
    const snapshot = binding.embeddingExecutionSnapshot;
    if (!snapshot.credentialId || !snapshot.credentialVersionId) {
      throw new KnowledgeRunPlanConflictError();
    }
    await tx.knowledgeRunBinding.create({
      data: {
        baseContentRevision: binding.baseContentRevision,
        embeddingConnectionId: snapshot.connectionId,
        embeddingCredentialId: snapshot.credentialId,
        embeddingCredentialSource: binding.embeddingCredentialSource,
        embeddingCredentialVersionId: snapshot.credentialVersionId,
        embeddingExecutionSnapshot: json(snapshot),
        embeddingProviderModelId: binding.embeddingProviderModelId,
        indexedContentRevision: binding.indexedContentRevision,
        indexGenerationId: binding.indexGenerationId,
        knowledgeBaseId: binding.knowledgeBaseId,
        modelRunId: input.runId,
        ordinal: binding.ordinal,
        targetDimension: binding.targetDimension,
        vectorSpaceFingerprint: binding.vectorSpaceFingerprint
      }
    });
  }
}

function providerRecoveryHorizon(
  role: ProviderAdmissionRole,
  nativeBackgroundRequested: boolean
): Date | null {
  if (
    role.snapshot.model.adapterKind !== "openai_responses_native" ||
    !nativeBackgroundRequested
  ) {
    return null;
  }
  return new Date(Date.now() + 24 * 60 * 60 * 1_000);
}

async function insertAcceptedProviderRunBindings(
  tx: Prisma.TransactionClient,
  input: {
    nativeBackgroundRequested: boolean;
    plan: ProviderAdmissionPlan | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  if (!input.plan) return;
  let current: ProviderAdmissionPlan;
  try {
    current = await loadProviderAdmissionPlan(tx, {
      providerConnectionId: input.plan.selection.providerConnectionId,
      providerModelId: input.plan.selection.providerModelId,
      ...(input.plan.requiresClientToolCoexistence
        ? { requiresClientToolCoexistence: true }
        : {}),
      ...(input.plan.requestedSearchPlan
        ? { searchPlan: input.plan.requestedSearchPlan }
        : {}),
      ...(input.plan.requestedSearchPreferenceSource
        ? {
            searchPreferencePlan: input.plan.requestedSearchPreferencePlan,
            searchPreferenceSource: input.plan.requestedSearchPreferenceSource
          }
        : {}),
      searchStrategyId: input.plan.requestedSearchStrategyId,
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof ProviderAdmissionError) {
      throw new ProviderAdmissionConflictError();
    }
    throw error;
  }
  if (!sameProviderAdmissionPlan(input.plan, current)) {
    throw new ProviderAdmissionConflictError();
  }

  const roles: Array<{
    bindingKey: string;
    role: "answer" | "search";
    value: ProviderAdmissionRole;
  }> = [
    { bindingKey: "answer", role: "answer", value: current.answer },
    ...(current.searches ?? []).flatMap((search) =>
      search.role && search.bindingKey
        ? [{ bindingKey: search.bindingKey, role: "search" as const, value: search.role }]
        : [])
  ];
  await tx.providerRunBinding.createMany({
    data: roles.map(({ bindingKey, role, value }) => ({
      bindingKey,
      connectionId: value.snapshot.connectionId,
      credentialId: value.snapshot.credentialId,
      credentialSource: value.credentialSource,
      credentialVersionId: value.snapshot.credentialVersionId,
      executionSnapshot: json(value.snapshot),
      modelRunId: input.runId,
      providerModelId: value.snapshot.providerModelId,
      recoverableUntil: role === "answer"
        ? providerRecoveryHorizon(value, input.nativeBackgroundRequested)
        : null,
      role
    }))
  });
  if ((current.searches?.length ?? 0) > 0) {
    await tx.searchRunBinding.createMany({
      data: current.searches!.map((search) => ({
        mode: current.requestedSearchPlan?.mode ?? "all_selected",
        modelRunId: input.runId,
        optionId: search.optionId,
        ordinal: search.ordinal,
        revisionId: search.revisionId,
        searchStrategyId: search.integrationId,
        technicalBindingKey: search.bindingKey
      }))
    });
  }
}

async function repeatableReadTransaction<Value>(
  prismaClient: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<Value>
): Promise<Value> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prismaClient.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 120_000
      });
    } catch (error) {
      const assistantSerializationConflict =
        error instanceof AssistantProvenanceSerializationError;
      const serializationConflict = assistantSerializationConflict ||
        isPrismaSerializationConflict(error);
      if (serializationConflict) {
        if (attempt < 2) continue;
        if (assistantSerializationConflict) throw new AssistantRunConflictError();
        throw new ProviderAdmissionConflictError();
      }
      throw error;
    }
  }
  throw new ProviderAdmissionConflictError();
}

const dispatchableModelRunStatuses: ModelRunStatus[] = ["streaming", "queued", "in_progress"];
const activeModelRunStatuses: ModelRunStatus[] = [
  "preparing",
  ...dispatchableModelRunStatuses
];
const activeMessageStatuses: MessageStatus[] = ["streaming", "queued"];
const recoveredRunTerminalMarker = "recoveryTerminal";

type LockedToolLoopRun = {
  assistantMessageId: string | null;
  errorPayload: Prisma.JsonValue | null;
  providerResponseId: string | null;
  status: ModelRunStatus;
  toolLoopState: Prisma.JsonValue | null;
};

async function lockToolLoopRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; userId?: string }
): Promise<LockedToolLoopRun | null> {
  const ownerPredicate = input.userId
    ? Prisma.sql`AND "userId" = ${input.userId}`
    : Prisma.empty;
  const [run] = await tx.$queryRaw<LockedToolLoopRun[]>(Prisma.sql`
    SELECT
      "assistantMessageId",
      "errorPayload",
      "providerResponseId",
      "status",
      "toolLoopState"
    FROM "ModelRun"
    WHERE "id" = ${input.runId}
      ${ownerPredicate}
    FOR UPDATE
  `);
  return run ?? null;
}

function activeToolLoopRun(run: LockedToolLoopRun): boolean {
  return dispatchableModelRunStatuses.includes(run.status) ||
    (run.status === "error" && !isRecoveredRunTerminalPayload(run.errorPayload));
}

function isRecoveredRunTerminalPayload(value: unknown): boolean {
  return isRecord(value) && value[recoveredRunTerminalMarker] === true;
}

function recoveredRunErrorPayload(error: { code: string; message: string }) {
  return {
    ...error,
    [recoveredRunTerminalMarker]: true
  };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("ModelRun_one_active_per_chat_idx") ||
    error.message.includes("ModelRun_one_active_per_user_idx") ||
    error.message.includes("Unique constraint failed") ||
    error.message.includes("duplicate key value violates unique constraint")
  );
}

async function mapActiveRunConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ActiveRunConflictError();
    }

    throw error;
  }
}

type ConversationPathSelector =
  | { kind: "active" }
  | { kind: "expected"; leafMessageId: string | null }
  | { kind: "explicit"; leafMessageId: string };

type ConversationPathRow = {
  chatId: string;
  messageGroundedAt: Date | null;
  messageContent: Prisma.JsonValue | null;
  messageId: string | null;
  messageParentId?: string | null;
  messageRole: string | null;
  messageStatus: string | null;
};

export function conversationMessagesFromPathRows(rows: ConversationPathRow[]): ProviderConversationMessage[] {
  const failedWithoutAnswer = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const parent = rows[index - 1]!;
    if (
      row.messageRole === "assistant" &&
      row.messageStatus === "error" &&
      (!isRecord(row.messageContent) || !textFromContentBlocks(row.messageContent).trim()) &&
      parent.messageId &&
      parent.messageRole === "user" &&
      parent.messageStatus === "complete" &&
      (row.messageParentId === undefined || row.messageParentId === parent.messageId)
    ) {
      failedWithoutAnswer.add(parent.messageId);
    }
  }

  return rows.flatMap((row) => {
    if (
      !row.messageId ||
      failedWithoutAnswer.has(row.messageId) ||
      (row.messageRole !== "user" && row.messageRole !== "assistant") ||
      (row.messageStatus !== "complete" && row.messageStatus !== "streaming")
    ) {
      return [];
    }

    return [
      {
        content: row.messageGroundedAt
          ? groundedLiveOnlyMessageContent()
          : row.messageContent as { blocks: unknown[] },
        id: row.messageId,
        role: row.messageRole
      }
    ];
  });
}

type PreparingSettingsRow = MemoryPreparingSettingsSnapshot & Readonly<{
  memoryGeneration: number;
  memoryRevision: number;
}>;

type LockedPreparingAttempt = Readonly<{
  admittedAssistantLeafMessageId: string;
  admittedUserMessageId: string;
  admissionKind: "NORMAL_SEND" | "REGENERATE";
  assistantIdSnapshot: string | null;
  attemptOrdinal: number;
  baseRequestHash: string;
  boundedPrivateBaseRequestSnapshot: Prisma.JsonValue | null;
  boundedSafeQuerySnapshot: string | null;
  budgetSnapshot: Prisma.JsonValue | null;
  chatId: string;
  degradationCode: string | null;
  expiresAt: Date;
  folderIdSnapshot: string | null;
  id: string;
  indexGenerationIdSnapshot: string | null;
  memoryGenerationSnapshot: number;
  modelRunId: string;
  outcome: "USED" | "EMPTY" | "DISABLED" | "DEGRADED" | "FAILED_SAFE" | null;
  preSendActiveLeafMessageId: string | null;
  preparedContextHash: string | null;
  preparedContextText: string | null;
  preparedContextTokenCount: number | null;
  queryHash: string;
  retrievalRevisionSnapshot: number;
  settingsSnapshot: Prisma.JsonValue;
  state: "PENDING" | "EXECUTING" | "READY" | "CONSUMED" | "STALE" | "FAILED" | "CANCELLED" | "EXPIRED";
  userId: string;
}>;

type LockedPreparingRun = Readonly<{
  assistantId: string | null;
  assistantMessageId: string | null;
  assistantRevisionId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  normalizedRequest: Prisma.JsonValue | null;
  provider: string;
  providerRequestPreview: Prisma.JsonValue | null;
  status: ModelRunStatus;
  userId: string;
  userMessageId: string;
}>;

async function loadPreparingSettings(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<PreparingSettingsRow> {
  const settings = await tx.userMemorySettings.findUnique({
    select: {
      acceptedUtilityEgressFingerprint: true,
      acceptedUtilityPolicyVersion: true,
      activeIndexGenerationId: true,
      learnAutomatically: true,
      memoryConsentRevision: true,
      memoryGeneration: true,
      memoryRevision: true,
      referenceChatHistory: true,
      settingsRevision: true,
      useMemoryFacts: true
    },
    where: { userId }
  });
  if (!settings) {
    throw new MemoryPreparingRunConflictError("memory_owner_unavailable", false);
  }
  return {
    ...memoryPreparingSettingsSnapshot(settings),
    memoryGeneration: settings.memoryGeneration,
    memoryRevision: settings.memoryRevision
  };
}

async function lockPreparingRun(
  tx: Prisma.TransactionClient,
  runId: string,
  userId: string
): Promise<LockedPreparingRun | null> {
  const [run] = await tx.$queryRaw<LockedPreparingRun[]>(Prisma.sql`
    SELECT
      "assistantId", "assistantMessageId", "assistantRevisionId", "chatId", "id",
      "modelId", "normalizedRequest", "provider", "providerRequestPreview",
      "status", "userId", "userMessageId"
    FROM "ModelRun"
    WHERE "id" = ${runId} AND "userId" = ${userId}
    FOR UPDATE
  `);
  return run ?? null;
}

async function lockPreparingAttempt(
  tx: Prisma.TransactionClient,
  input: Readonly<{ attemptId?: string; runId: string; userId: string }>
): Promise<LockedPreparingAttempt | null> {
  const attemptPredicate = input.attemptId
    ? Prisma.sql`AND "id" = ${input.attemptId}`
    : Prisma.sql`AND "state" IN (
        'PENDING'::"MemoryRetrievalAttemptState",
        'EXECUTING'::"MemoryRetrievalAttemptState",
        'READY'::"MemoryRetrievalAttemptState"
      )`;
  const [attempt] = await tx.$queryRaw<LockedPreparingAttempt[]>(Prisma.sql`
    SELECT
      "admittedAssistantLeafMessageId", "admittedUserMessageId",
      "admissionKind"::text AS "admissionKind", "assistantIdSnapshot",
      "attemptOrdinal",
      "baseRequestHash", "boundedPrivateBaseRequestSnapshot",
      "boundedSafeQuerySnapshot", "budgetSnapshot", "chatId", "degradationCode", "expiresAt", "folderIdSnapshot",
      "id", "indexGenerationIdSnapshot", "memoryGenerationSnapshot",
      "modelRunId", "outcome"::text AS "outcome", "preSendActiveLeafMessageId",
      "preparedContextHash", "preparedContextText", "preparedContextTokenCount",
      "queryHash", "retrievalRevisionSnapshot", "settingsSnapshot",
      "state"::text AS "state", "userId"
    FROM "MemoryRetrievalAttempt"
    WHERE "modelRunId" = ${input.runId}
      AND "userId" = ${input.userId}
      ${attemptPredicate}
    ORDER BY "attemptOrdinal" DESC
    LIMIT 1
    FOR UPDATE
  `);
  return attempt ?? null;
}

function baseRequestUsesNonToolMemoryList(
  baseSnapshot: NonNullable<ReturnType<typeof decodeMemoryPreparingBaseSnapshot>>
): boolean {
  const request = baseSnapshot.normalizedRequest;
  const plan = decodeMemoryActionPlan(request.memoryActionPlan);
  return plan?.kind === "LIST" && !(
    request.toolMode !== "none" && request.modelCapabilities.toolCalling === true
  );
}

function preparingAttemptIsAuthoritativeEmptyList(
  attempt: Pick<LockedPreparingAttempt, "budgetSnapshot" | "outcome">,
  baseSnapshot: NonNullable<ReturnType<typeof decodeMemoryPreparingBaseSnapshot>>
): boolean {
  return attempt.outcome === "EMPTY" &&
    memoryPreparingHasAuthoritativeEmptyList(attempt.budgetSnapshot) &&
    baseRequestUsesNonToolMemoryList(baseSnapshot);
}

function preparingAttemptCarriesProviderContext(
  attempt: Pick<LockedPreparingAttempt, "budgetSnapshot" | "outcome">,
  baseSnapshot: NonNullable<ReturnType<typeof decodeMemoryPreparingBaseSnapshot>>
): boolean {
  return attempt.outcome === "USED" || attempt.outcome === "DEGRADED" ||
    preparingAttemptIsAuthoritativeEmptyList(attempt, baseSnapshot);
}

async function createPreparingAttempt(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    admissionKind: "NORMAL_SEND" | "REGENERATE";
    assistantIdSnapshot: string | null;
    assistantMessageId: string;
    attemptOrdinal: number;
    baseSnapshot: ReturnType<typeof createMemoryPreparingBaseSnapshot>;
    chatId: string;
    folderIdSnapshot: string | null;
    now: Date;
    preSendActiveLeafMessageId: string | null;
    runId: string;
    settings: PreparingSettingsRow;
    userId: string;
    userMessageId: string;
  }>
): Promise<string> {
  const attemptId = randomUUID();
  await tx.memoryRetrievalAttempt.create({
    data: {
      admissionKind: input.admissionKind,
      admittedAssistantLeafMessageId: input.assistantMessageId,
      admittedUserMessageId: input.userMessageId,
      assistantIdSnapshot: input.assistantIdSnapshot,
      attemptOrdinal: input.attemptOrdinal,
      baseRequestHash: memoryPreparingHash(input.baseSnapshot),
      boundedPrivateBaseRequestSnapshot: json(input.baseSnapshot),
      chatId: input.chatId,
      chatMemoryModeSnapshot: "NORMAL",
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + MEMORY_PREPARING_ATTEMPT_TTL_MS),
      externalRolesUsed: [],
      folderIdSnapshot: input.folderIdSnapshot,
      id: attemptId,
      indexGenerationIdSnapshot: input.settings.activeIndexGenerationId,
      memoryGenerationSnapshot: input.settings.memoryGeneration,
      modelRunId: input.runId,
      preSendActiveLeafMessageId: input.preSendActiveLeafMessageId,
      queryHash: memoryPreparingTextHash(""),
      retrievalRevisionSnapshot: input.settings.memoryRevision,
      settingsSnapshot: json(memoryPreparingSettingsSnapshot(input.settings)),
      state: "PENDING",
      userId: input.userId,
      utilityEgressMode: "LOCAL_ONLY"
    }
  });
  return attemptId;
}

function assertPreparingAdmissionInput(input: PreparingRunAdmissionInput): void {
  if (
    input.normalizedRequest.chatId !== input.chatId ||
    input.normalizedRequest.modelId !== input.modelId ||
    input.normalizedRequest.provider !== input.provider ||
    input.normalizedRequest.personalContext !== undefined ||
    (input.admissionKind === "NORMAL_SEND" &&
      memoryPreparingHash(input.normalizedRequest.content) !== memoryPreparingHash(input.content))
  ) {
    throw new MemoryPreparingRunConflictError("memory_base_request_invalid", false);
  }
}

async function admitPreparingRunWithClient(
  prismaClient: PrismaClient,
  input: PreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult> {
  assertPreparingAdmissionInput(input);
  const baseSnapshot = createMemoryPreparingBaseSnapshot({
    normalizedRequest: input.normalizedRequest,
    providerRequestPreview: input.providerRequestPreview
  });
  return mapActiveRunConflict(() =>
    repeatableReadTransaction(prismaClient, async (tx) => {
      const lockedChats = await tx.$queryRaw<Array<{
        activeLeafMessageId: string | null;
        archived: boolean;
        folderId: string | null;
        id: string;
      }>>(Prisma.sql`
        SELECT "id", "activeLeafMessageId", "archived", "folderId"
        FROM "Chat"
        WHERE "id" = ${input.chatId} AND "userId" = ${input.userId}
        FOR UPDATE
      `);
      const lockedChat = lockedChats[0];
      if (!lockedChat || lockedChat.archived) {
        throw new ActiveLeafConflictError();
      }

      if (input.assistant) {
        await assertAssistantRunProvenance(tx, {
          assistantId: input.assistant.assistantId,
          revisionId: input.assistant.revisionId,
          userId: input.userId
        });
      }

      const settings = await loadPreparingSettings(tx, input.userId);
      let assistantMessageId: string;
      let preSendActiveLeafMessageId: string | null;
      let userMessageId: string;

      if (input.admissionKind === "NORMAL_SEND") {
        if (lockedChat.activeLeafMessageId !== input.expectedActiveLeafId) {
          throw new ActiveLeafConflictError();
        }
        const chat = await tx.chat.findFirst({
          select: {
            _count: { select: { messages: true } },
            id: true,
            title: true
          },
          where: {
            archived: false,
            id: input.chatId,
            userId: input.userId
          }
        });
        if (!chat) throw new ActiveLeafConflictError();

        const userMessage = await tx.message.create({
          data: {
            chatId: input.chatId,
            content: json(input.content),
            modelId: input.modelId,
            parentMessageId: input.expectedActiveLeafId,
            provider: input.provider,
            role: "user",
            status: "complete"
          }
        });
        const assistantMessage = await tx.message.create({
          data: {
            chatId: input.chatId,
            content: json(textMessageContent("")),
            modelId: input.modelId,
            parentMessageId: userMessage.id,
            provider: input.provider,
            role: "assistant",
            status: "streaming"
          }
        });
        const attachmentIds = unique(input.normalizedRequest.attachmentIds);
        if (attachmentIds.length > 0) {
          const linkedAttachments = await tx.attachment.updateMany({
            data: { chatId: input.chatId, messageId: userMessage.id },
            where: {
              chatId: null,
              id: { in: attachmentIds },
              messageId: null,
              status: "ready",
              userId: input.userId
            }
          });
          if (linkedAttachments.count !== attachmentIds.length) {
            throw new AttachmentLinkConflictError();
          }
        }
        assistantMessageId = assistantMessage.id;
        preSendActiveLeafMessageId = input.expectedActiveLeafId;
        userMessageId = userMessage.id;

        await tx.chat.update({
          data: {
            activeLeafMessageId: assistantMessage.id,
            ...(chat._count.messages === 0 && input.defaults
              ? { defaultProviderModelId: input.defaults.modelId }
              : {})
          },
          where: { id: input.chatId }
        });
        if (chat._count.messages === 0) {
          await tx.chat.updateMany({
            data: { title: titleFromMessageContent(input.content) },
            where: {
              archived: false,
              id: input.chatId,
              title: { in: ["New Chat", "Untitled QSA"] },
              userId: input.userId
            }
          });
        }
      } else {
        const preSendAssistantMessageId = input.preSendAssistantMessageId ??
          lockedChat.activeLeafMessageId;
        if (!preSendAssistantMessageId ||
          lockedChat.activeLeafMessageId !== preSendAssistantMessageId) {
          throw new ActiveLeafConflictError();
        }
        const [source] = await tx.$queryRaw<Array<{
          assistantParentId: string | null;
          assistantRole: string;
          userContent: Prisma.JsonValue;
          userRole: string;
        }>>(Prisma.sql`
          SELECT
            assistant."parentMessageId" AS "assistantParentId",
            assistant."role" AS "assistantRole",
            user_message."content" AS "userContent",
            user_message."role" AS "userRole"
          FROM "Message" AS assistant
          INNER JOIN "Message" AS user_message
            ON user_message."chatId" = assistant."chatId"
           AND user_message."id" = ${input.userMessageId}
          WHERE assistant."chatId" = ${input.chatId}
            AND assistant."id" = ${preSendAssistantMessageId}
          FOR SHARE OF assistant, user_message
        `);
        if (!source || source.assistantRole !== "assistant" || source.userRole !== "user" ||
          source.assistantParentId !== input.userMessageId ||
          memoryPreparingHash(source.userContent) !==
            memoryPreparingHash(input.normalizedRequest.content)) {
          throw new ActiveLeafConflictError();
        }
        const assistantMessage = await tx.message.create({
          data: {
            chatId: input.chatId,
            content: json(textMessageContent("")),
            modelId: input.modelId,
            parentMessageId: input.userMessageId,
            provider: input.provider,
            role: "assistant",
            status: "streaming"
          }
        });
        assistantMessageId = assistantMessage.id;
        preSendActiveLeafMessageId = preSendAssistantMessageId;
        userMessageId = input.userMessageId;
        await tx.chat.update({
          data: { activeLeafMessageId: assistantMessage.id },
          where: { id: input.chatId }
        });
      }

      const run = await tx.modelRun.create({
        data: {
          assistantMessageId,
          ...(input.assistant
            ? {
                assistantId: input.assistant.assistantId,
                assistantRevisionId: input.assistant.revisionId
              }
            : {}),
          chatId: input.chatId,
          modelId: input.modelId,
          provider: input.provider,
          status: "preparing",
          userId: input.userId,
          userMessageId
        }
      });

      await insertAcceptedKnowledgeRunBindings(tx, {
        plan: input.knowledgeAdmissionPlan,
        runId: run.id,
        userId: input.userId
      });
      await insertAcceptedMcpRunBindings(tx, {
        bindings: input.mcpBindings ? [...input.mcpBindings] : undefined,
        runId: run.id,
        userId: input.userId
      });
      await insertAcceptedProviderRunBindings(tx, {
        nativeBackgroundRequested: input.normalizedRequest.params.background === true,
        plan: input.providerAdmissionPlan,
        runId: run.id,
        userId: input.userId
      });
      if (input.defaults) {
        await persistAcceptedRunDefaults(tx, input.userId, input.defaults);
      }

      const attemptId = await createPreparingAttempt(tx, {
        admissionKind: input.admissionKind,
        assistantIdSnapshot: input.assistant?.assistantId ?? null,
        assistantMessageId,
        attemptOrdinal: 0,
        baseSnapshot,
        chatId: input.chatId,
        folderIdSnapshot: lockedChat.folderId,
        now: new Date(),
        preSendActiveLeafMessageId,
        runId: run.id,
        settings,
        userId: input.userId,
        userMessageId
      });

      return {
        assistantMessageId,
        attemptId,
        memoryGeneration: settings.memoryGeneration,
        memoryRevision: settings.memoryRevision,
        runId: run.id,
        settingsSnapshot: memoryPreparingSettingsSnapshot(settings),
        userMessageId
      };
    })
  );
}

async function beginPreparingRunAttemptWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{ attemptId: string; now: Date; runId: string; userId: string }>
): Promise<boolean> {
  const updated = await prismaClient.memoryRetrievalAttempt.updateMany({
    data: { state: "EXECUTING", updatedAt: input.now },
    where: {
      expiresAt: { gt: input.now },
      id: input.attemptId,
      modelRunId: input.runId,
      state: "PENDING",
      userId: input.userId
    }
  });
  return updated.count === 1;
}

async function completePreparingRunAttemptWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{
    attemptId: string;
    result: MemoryPreparingAttemptResult;
    runId: string;
    userId: string;
  }>
): Promise<boolean> {
  validateMemoryPreparingAttemptResult(input.result);
  const now = new Date();
  return prismaClient.$transaction(async (tx) => {
    const run = await lockPreparingRun(tx, input.runId, input.userId);
    const attempt = await lockPreparingAttempt(tx, input);
    if (!run || run.status !== "preparing" || !attempt ||
      (attempt.state !== "PENDING" && attempt.state !== "EXECUTING") ||
      attempt.expiresAt <= now) {
      return false;
    }
    if (memoryPreparingHasAuthoritativeEmptyList(input.result.budgetSnapshot)) {
      const baseSnapshot = decodeMemoryPreparingBaseSnapshot(
        attempt.boundedPrivateBaseRequestSnapshot
      );
      if (!baseSnapshot || !baseRequestUsesNonToolMemoryList(baseSnapshot)) {
        throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
      }
    }

    const authoritativeItems: Array<{
      exactSafeText: string;
      createdByEventId: string;
      factCategory: string;
      factCanonicalKey: string;
      factId: string;
      factVersionId: string;
      featureSnapshot: Record<string, unknown>;
      finalScore: number;
      languageCode: string;
      laneRanks: Readonly<Record<string, unknown>>;
      scopeAssistantId: string | null;
      scopeChatId: string | null;
      scopeFolderId: string | null;
      scopeId: string;
      scopeTargetIdSnapshot: string | null;
      scopeType: string;
      selectionReason: string;
      sensitivityClass: string;
      sourceMode: string;
    }> = [];
    for (const item of input.result.items ?? []) {
      const [version] = await tx.$queryRaw<Array<{
        createdByEventId: string;
        displayText: string | null;
        factCanonicalKey: string;
        factCategory: string;
        factId: string;
        languageCode: string;
        scopeAssistantId: string | null;
        scopeChatId: string | null;
        scopeFolderId: string | null;
        scopeId: string;
        scopeTargetIdSnapshot: string | null;
        scopeType: string;
        sensitivityClass: string;
        sourceMode: string;
      }>>(Prisma.sql`
        SELECT
          version."createdByEventId", version."displayText",
          version."factId", version."languageCode",
          version."sensitivityClass"::text AS "sensitivityClass",
          version."sourceMode"::text AS "sourceMode",
          fact."canonicalKey" AS "factCanonicalKey",
          fact."category" AS "factCategory", fact."scopeId",
          scope."assistantId" AS "scopeAssistantId",
          scope."chatId" AS "scopeChatId", scope."folderId" AS "scopeFolderId",
          scope."scopeType"::text AS "scopeType",
          scope."targetIdSnapshot" AS "scopeTargetIdSnapshot"
        FROM "MemoryFactVersion" AS version
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId" AND fact."id" = version."factId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        WHERE version."userId" = ${input.userId}
          AND version."id" = ${item.factVersionId}
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
          AND version."sensitivityClass" IN (
            'NORMAL'::"MemorySensitivityClass",
            'SENSITIVE'::"MemorySensitivityClass"
          )
          AND version."contentPurgedAt" IS NULL
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id"
          AND scope."state" = 'ACTIVE'::"MemoryScopeState"
          AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
        FOR SHARE OF version, fact, scope
      `);
      if (!version || version.displayText === null ||
        explicitRunSafeFactText(version.displayText) !== item.exactSafeText) {
        throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
      }
      authoritativeItems.push({
        createdByEventId: version.createdByEventId,
        exactSafeText: item.exactSafeText,
        factCanonicalKey: version.factCanonicalKey,
        factCategory: version.factCategory,
        factId: version.factId,
        factVersionId: item.factVersionId,
        featureSnapshot: {
          ...(item.featureSnapshot ?? {}),
          finalScore: item.finalScore
        },
        finalScore: item.finalScore,
        languageCode: version.languageCode,
        laneRanks: item.laneRanks ?? {},
        scopeAssistantId: version.scopeAssistantId,
        scopeChatId: version.scopeChatId,
        scopeFolderId: version.scopeFolderId,
        scopeId: version.scopeId,
        scopeTargetIdSnapshot: version.scopeTargetIdSnapshot,
        scopeType: version.scopeType,
        selectionReason: item.selectionReason,
        sensitivityClass: version.sensitivityClass,
        sourceMode: version.sourceMode
      });
    }

    if (authoritativeItems.length > 0) {
      await tx.memoryRetrievalAttemptItem.createMany({
        data: authoritativeItems.map((item, ordinal) => ({
          exactItemId: item.factVersionId,
          exactSafeText: item.exactSafeText,
          factVersionId: item.factVersionId,
          featureSnapshot: json(item.featureSnapshot),
          laneRanks: json(item.laneRanks),
          ordinal,
          selectionReason: item.selectionReason,
          sourceSnapshot: json({
            createdByEventId: item.createdByEventId,
            schemaVersion: 1,
            sourceMode: item.sourceMode
          }),
          textHash: memoryPreparingTextHash(item.exactSafeText),
          userId: input.userId,
          versionSnapshot: json({
            factCanonicalKey: item.factCanonicalKey,
            factCategory: item.factCategory,
            factId: item.factId,
            factState: "ACTIVE",
            factVersionId: item.factVersionId,
            languageCode: item.languageCode,
            scopeAssistantId: item.scopeAssistantId,
            scopeChatId: item.scopeChatId,
            scopeFolderId: item.scopeFolderId,
            scopeId: item.scopeId,
            scopeState: "ACTIVE",
            scopeTargetIdSnapshot: item.scopeTargetIdSnapshot,
            scopeType: item.scopeType,
            schemaVersion: 1,
            sensitivityClass: item.sensitivityClass,
            versionState: "ACTIVE"
          }),
          attemptId: input.attemptId,
          itemType: "FACT_VERSION"
        }))
      });
    }

    const context = input.result.preparedContext ?? null;
    const querySnapshot = input.result.querySnapshot ?? null;
    const updated = await tx.memoryRetrievalAttempt.updateMany({
      data: {
        budgetSnapshot: json(input.result.budgetSnapshot),
        boundedSafeQuerySnapshot: querySnapshot,
        degradationCode: input.result.degradationCode ?? null,
        outcome: input.result.outcome,
        preparedContextHash: context ? memoryPreparingTextHash(context.text) : null,
        preparedContextText: context?.text ?? null,
        preparedContextTokenCount: context?.approxTokens ?? null,
        queryHash: input.result.queryHash ?? memoryPreparingTextHash(querySnapshot ?? ""),
        state: "READY",
        updatedAt: now
      },
      where: {
        id: input.attemptId,
        modelRunId: input.runId,
        state: { in: ["PENDING", "EXECUTING"] },
        userId: input.userId
      }
    });
    return updated.count === 1;
  });
}

async function assertCurrentProviderAdmission(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    plan: ProviderAdmissionPlan | undefined;
    userId: string;
  }>
): Promise<void> {
  if (!input.plan) return;
  let current: ProviderAdmissionPlan;
  try {
    current = await loadProviderAdmissionPlan(tx, {
      providerConnectionId: input.plan.selection.providerConnectionId,
      providerModelId: input.plan.selection.providerModelId,
      ...(input.plan.requiresClientToolCoexistence
        ? { requiresClientToolCoexistence: true }
        : {}),
      ...(input.plan.requestedSearchPlan
        ? { searchPlan: input.plan.requestedSearchPlan }
        : {}),
      ...(input.plan.requestedSearchPreferenceSource
        ? {
            searchPreferencePlan: input.plan.requestedSearchPreferencePlan,
            searchPreferenceSource: input.plan.requestedSearchPreferenceSource
          }
        : {}),
      searchStrategyId: input.plan.requestedSearchStrategyId,
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof ProviderAdmissionError) {
      throw new ProviderAdmissionConflictError();
    }
    throw error;
  }
  if (!sameProviderAdmissionPlan(input.plan, current)) {
    throw new ProviderAdmissionConflictError();
  }
}

async function assertCurrentKnowledgeAdmission(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    plan: KnowledgeRunAdmissionPlan | undefined;
    userId: string;
  }>
): Promise<void> {
  if (!input.plan) return;
  await lockKnowledgeRunAdmissionSources(tx, {
    plan: input.plan,
    userId: input.userId
  });
  let current: KnowledgeRunAdmissionPlan;
  try {
    current = await loadKnowledgeRunAdmissionPlan(tx, {
      knowledgePlan: input.plan.knowledgePlan,
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof KnowledgeRunAdmissionError || error instanceof ProviderAdmissionError) {
      throw new KnowledgeRunPlanConflictError();
    }
    throw error;
  }
  if (!sameKnowledgeRunAdmissionPlan(input.plan, current)) {
    throw new KnowledgeRunPlanConflictError();
  }
}

async function assertCurrentMcpAdmission(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    bindings: readonly McpRunPlanBinding[] | undefined;
    runId: string;
    userId: string;
  }>
): Promise<void> {
  if (input.bindings === undefined) return;
  const persisted = await tx.mcpRunBinding.findMany({
    select: {
      runtimeGenerationFingerprint: true,
      runtimeGenerationId: true
    },
    where: { modelRunId: input.runId },
    orderBy: { runtimeGenerationId: "asc" }
  });
  const expected = [...input.bindings].sort((left, right) =>
    left.runtimeGenerationId.localeCompare(right.runtimeGenerationId));
  if (persisted.length !== expected.length || persisted.some((binding, index) =>
    binding.runtimeGenerationId !== expected[index]?.runtimeGenerationId ||
    binding.runtimeGenerationFingerprint !== expected[index]?.fingerprint)) {
    throw new McpRunPlanConflictError();
  }
  for (const binding of expected) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT generation."id"
      FROM "McpRuntimeGeneration" AS generation
      INNER JOIN "McpUserServer" AS preference
        ON preference."id" = generation."userServerId"
      INNER JOIN "McpServer" AS server
        ON server."id" = preference."serverId"
      INNER JOIN "User" AS owner ON owner."id" = preference."userId"
      WHERE owner."id" = ${input.userId}
        AND owner."status" = 'active'
        AND preference."enabled" = true
        AND preference."desiredRuntimeGenerationId" = generation."id"
        AND server."id" = ${binding.serverId}
        AND server."enabled" = true
        AND server."archivedAt" IS NULL
        AND server."activeRevisionId" = generation."revisionId"
        AND generation."id" = ${binding.runtimeGenerationId}
        AND generation."fingerprint" = ${binding.fingerprint}
        AND generation."state" = 'ready'
        AND generation."inventory" IS NOT NULL
        AND generation."inventoryUpdatedAt" IS NOT NULL
        AND generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND EXISTS (
          SELECT 1 FROM "McpGrant" AS mcp_grant
          WHERE mcp_grant."serverId" = server."id" AND mcp_grant."canUse" = true
            AND (
              mcp_grant."userId" = ${input.userId}
              OR mcp_grant."groupId" IN (
                SELECT membership."groupId"
                FROM "UserGroup" AS membership
                INNER JOIN "Group" AS member_group
                  ON member_group."id" = membership."groupId"
                 AND member_group."archivedAt" IS NULL
                WHERE membership."userId" = ${input.userId}
              )
            )
        )
      FOR SHARE OF generation, preference, server, owner
    `);
    if (!rows[0]) throw new McpRunPlanConflictError();
  }
}

type PreparingAttemptItemRow = Readonly<{
  exactSafeText: string;
  factVersionId: string;
  featureSnapshot: Prisma.JsonValue;
  laneRanks: Prisma.JsonValue;
  ordinal: number;
  selectionReason: string;
  sourceSnapshot: Prisma.JsonValue;
  textHash: string;
  versionSnapshot: Prisma.JsonValue;
}>;

async function loadAndValidatePreparingAttemptItems(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    attemptId: string;
    userId: string;
  }>
): Promise<PreparingAttemptItemRow[]> {
  const items = await tx.memoryRetrievalAttemptItem.findMany({
    select: {
      exactSafeText: true,
      factVersionId: true,
      featureSnapshot: true,
      laneRanks: true,
      ordinal: true,
      selectionReason: true,
      sourceSnapshot: true,
      textHash: true,
      versionSnapshot: true
    },
    where: {
      attemptId: input.attemptId,
      userId: input.userId
    },
    orderBy: { ordinal: "asc" }
  });
  for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
    const item = items[ordinal]!;
    const featureSnapshot = isRecord(item.featureSnapshot)
      ? item.featureSnapshot
      : null;
    const versionSnapshot = isRecord(item.versionSnapshot)
      ? item.versionSnapshot
      : null;
    const sourceSnapshot = isRecord(item.sourceSnapshot)
      ? item.sourceSnapshot
      : null;
    const finalScore = featureSnapshot?.finalScore;
    if (
      item.ordinal !== ordinal ||
      memoryPreparingTextHash(item.exactSafeText) !== item.textHash ||
      typeof finalScore !== "number" ||
      !Number.isFinite(finalScore) ||
      finalScore < 0 ||
      finalScore > 1 ||
      sourceSnapshot?.schemaVersion !== 1 ||
      typeof sourceSnapshot.createdByEventId !== "string" ||
      typeof sourceSnapshot.sourceMode !== "string" ||
      versionSnapshot?.schemaVersion !== 1 ||
      versionSnapshot.factVersionId !== item.factVersionId ||
      versionSnapshot.versionState !== "ACTIVE" ||
      versionSnapshot.factState !== "ACTIVE" ||
      versionSnapshot.scopeState !== "ACTIVE"
    ) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
    }
    const [current] = await tx.$queryRaw<Array<{
      createdByEventId: string;
      displayText: string | null;
      factCanonicalKey: string;
      factCategory: string;
      factId: string;
      languageCode: string;
      scopeAssistantId: string | null;
      scopeChatId: string | null;
      scopeFolderId: string | null;
      scopeId: string;
      scopeTargetIdSnapshot: string | null;
      scopeType: string;
      sensitivityClass: string;
      sourceMode: string;
    }>>(Prisma.sql`
      SELECT
        version."createdByEventId", version."displayText",
        version."factId", version."languageCode",
        version."sensitivityClass"::text AS "sensitivityClass",
        version."sourceMode"::text AS "sourceMode",
        fact."canonicalKey" AS "factCanonicalKey",
        fact."category" AS "factCategory", fact."scopeId",
        scope."assistantId" AS "scopeAssistantId",
        scope."chatId" AS "scopeChatId", scope."folderId" AS "scopeFolderId",
        scope."scopeType"::text AS "scopeType",
        scope."targetIdSnapshot" AS "scopeTargetIdSnapshot"
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId" AND fact."id" = version."factId"
      INNER JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      WHERE version."userId" = ${input.userId}
        AND version."id" = ${item.factVersionId}
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND version."sensitivityClass" IN (
          'NORMAL'::"MemorySensitivityClass",
          'SENSITIVE'::"MemorySensitivityClass"
        )
        AND version."contentPurgedAt" IS NULL
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."currentVersionId" = version."id"
        AND scope."state" = 'ACTIVE'::"MemoryScopeState"
        AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      FOR SHARE OF version, fact, scope
    `);
    if (
      !current ||
      current.displayText === null ||
      explicitRunSafeFactText(current.displayText) !== item.exactSafeText ||
      memoryPreparingHash(sourceSnapshot) !== memoryPreparingHash({
        createdByEventId: current.createdByEventId,
        schemaVersion: 1,
        sourceMode: current.sourceMode
      }) ||
      memoryPreparingHash(versionSnapshot) !== memoryPreparingHash({
        factCanonicalKey: current.factCanonicalKey,
        factCategory: current.factCategory,
        factId: current.factId,
        factState: "ACTIVE",
        factVersionId: item.factVersionId,
        languageCode: current.languageCode,
        scopeAssistantId: current.scopeAssistantId,
        scopeChatId: current.scopeChatId,
        scopeFolderId: current.scopeFolderId,
        scopeId: current.scopeId,
        scopeState: "ACTIVE",
        scopeTargetIdSnapshot: current.scopeTargetIdSnapshot,
        scopeType: current.scopeType,
        schemaVersion: 1,
        sensitivityClass: current.sensitivityClass,
        versionState: "ACTIVE"
      })
    ) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
  }
  return items;
}

async function assertCurrentMemoryActionAuthorization(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    attempt: LockedPreparingAttempt;
    baseRequest: NonNullable<ReturnType<typeof decodeMemoryPreparingBaseSnapshot>>;
    now: Date;
    runId: string;
    userId: string;
  }>
): Promise<void> {
  const value = input.baseRequest.normalizedRequest.memoryActionPlan;
  if (value === undefined) return;
  const plan = decodeMemoryActionPlan(value);
  if (!plan) {
    throw new MemoryPreparingRunConflictError("memory_action_plan_invalid", false);
  }
  if (plan.kind === "LIST") return;
  const action = plan.kind === "SAVE" ? "SAVE" : plan.kind === "UPDATE" ? "EDIT" : "FORGET";
  const authorizations = await tx.memoryMutationAuthorization.findMany({
    select: {
      consumedAt: true,
      exactSourceEnd: true,
      exactSourceStart: true,
      expectedTargetVersionId: true,
      expiresAt: true,
      persistedToolCallId: true,
      sourceChatId: true,
      sourceMessageId: true,
      targetFactId: true
    },
    take: 2,
    where: {
      action,
      modelRunId: input.runId,
      userId: input.userId
    }
  });
  const authorization = authorizations[0];
  const sourceText = textFromContentBlocks(input.baseRequest.normalizedRequest.content);
  const expectedSpan = plan.kind === "SAVE" ? plan.statement : plan.targetQuery;
  const span = authorization?.exactSourceStart !== null &&
    authorization?.exactSourceStart !== undefined &&
    authorization.exactSourceEnd !== null
    ? sourceText.slice(authorization.exactSourceStart, authorization.exactSourceEnd)
    : null;
  if (
    authorizations.length !== 1 ||
    !authorization ||
    authorization.consumedAt !== null ||
    authorization.expiresAt <= input.now ||
    authorization.persistedToolCallId !== null ||
    authorization.sourceChatId !== input.attempt.chatId ||
    authorization.sourceMessageId !== input.attempt.admittedUserMessageId ||
    authorization.exactSourceStart !== plan.sourceStart ||
    authorization.exactSourceEnd !== plan.sourceEnd ||
    span !== expectedSpan
  ) {
    throw new MemoryPreparingRunConflictError(
      "memory_intent_confirmation_required",
      false
    );
  }
  if (action === "SAVE") {
    if (authorization.targetFactId !== null ||
      authorization.expectedTargetVersionId !== null) {
      throw new MemoryPreparingRunConflictError("memory_action_authorization_invalid", false);
    }
    return;
  }
  const target = await tx.memoryFact.findFirst({
    select: { currentVersionId: true, state: true },
    where: { id: authorization.targetFactId ?? "", userId: input.userId }
  });
  if (!target || target.state !== "ACTIVE" ||
    target.currentVersionId !== authorization.expectedTargetVersionId) {
    throw new MemoryPreparingRunConflictError("memory_version_stale", false);
  }
}

function validateFinalPreparingRequest(
  input: PreparingRunFinalizationInput,
  baseSnapshot: ReturnType<typeof decodeMemoryPreparingBaseSnapshot>,
  attempt: LockedPreparingAttempt,
  items: readonly PreparingAttemptItemRow[],
  finalizedRevision: number
): void {
  if (!baseSnapshot) {
    throw new MemoryPreparingRunConflictError("memory_base_request_invalid", false);
  }
  if (
    input.normalizedRequest.chatId !== baseSnapshot.normalizedRequest.chatId ||
    input.normalizedRequest.modelId !== baseSnapshot.normalizedRequest.modelId ||
    input.normalizedRequest.provider !== baseSnapshot.normalizedRequest.provider
  ) {
    throw new MemoryPreparingRunConflictError("memory_final_request_invalid", false);
  }
  const contextBearingOutcome = preparingAttemptCarriesProviderContext(
    attempt,
    baseSnapshot
  );
  if (!contextBearingOutcome) {
    if (
      input.normalizedRequest.personalContext !== undefined ||
      memoryPreparingHash(input.normalizedRequest) !==
        memoryPreparingHash(baseSnapshot.normalizedRequest) ||
      memoryPreparingHash(input.providerRequestPreview) !==
        memoryPreparingHash(baseSnapshot.providerRequestPreview)
    ) {
      throw new MemoryPreparingRunConflictError("memory_final_request_invalid", false);
    }
    return;
  }

  const {
    context: finalContext,
    personalContext,
    ...finalRequestCore
  } = input.normalizedRequest;
  const { context: baseContext, ...baseRequestCore } = baseSnapshot.normalizedRequest;
  const baseMessages = baseContext?.messages ?? [];
  const finalMessages = finalContext?.messages ?? [];
  let priorIndex = -1;
  const contextIsDerived = Boolean(baseContext && finalContext) &&
    finalContext?.mode === "branch_path" &&
    finalMessages.length > 0 &&
    finalMessages.every((message) => {
      const nextIndex = baseMessages.findIndex((candidate, index) =>
        index > priorIndex && memoryPreparingHash(candidate) === memoryPreparingHash(message));
      if (nextIndex < 0) return false;
      priorIndex = nextIndex;
      return true;
    }) &&
    priorIndex === baseMessages.length - 1;
  if (
    !personalContext ||
    memoryPreparingHash(finalRequestCore) !== memoryPreparingHash(baseRequestCore) ||
    !contextIsDerived ||
    personalContext.mode !== "prefetched" ||
    personalContext.text !== attempt.preparedContextText ||
    personalContext.approxTokens !== attempt.preparedContextTokenCount ||
    personalContext.itemCount !== items.length ||
    personalContext.memoryGeneration !== attempt.memoryGenerationSnapshot ||
    personalContext.memoryRevision !== finalizedRevision
  ) {
    throw new MemoryPreparingRunConflictError("memory_final_request_invalid", false);
  }
  createMemoryPreparingBaseSnapshot({
    normalizedRequest: input.normalizedRequest,
    providerRequestPreview: input.providerRequestPreview
  });
}

async function finalizePreparingRunWithClient(
  prismaClient: PrismaClient,
  input: PreparingRunFinalizationInput
): Promise<boolean> {
  const now = new Date();
  return repeatableReadTransaction(prismaClient, async (tx) => {
    const run = await lockPreparingRun(tx, input.runId, input.userId);
    const attempt = await lockPreparingAttempt(tx, {
      attemptId: input.attemptId,
      runId: input.runId,
      userId: input.userId
    });
    if (!run || run.status !== "preparing" || !attempt) return false;
    if (attempt.state !== "READY") return false;
    if (attempt.expiresAt <= now) {
      throw new MemoryPreparingRunConflictError("memory_preparing_attempt_expired", false);
    }
    if (
      run.chatId !== attempt.chatId ||
      run.userMessageId !== attempt.admittedUserMessageId ||
      run.assistantMessageId !== attempt.admittedAssistantLeafMessageId ||
      run.assistantId !== attempt.assistantIdSnapshot ||
      run.assistantId !== (input.assistant?.assistantId ?? null) ||
      run.assistantRevisionId !== (input.assistant?.revisionId ?? null)
    ) {
      throw new MemoryPreparingRunConflictError("memory_admission_shape_changed", false);
    }

    const baseSnapshot = decodeMemoryPreparingBaseSnapshot(
      attempt.boundedPrivateBaseRequestSnapshot
    );
    const settingsSnapshot = decodeMemoryPreparingSettingsSnapshot(attempt.settingsSnapshot);
    if (
      !baseSnapshot ||
      memoryPreparingHash(baseSnapshot) !== attempt.baseRequestHash ||
      !settingsSnapshot
    ) {
      throw new MemoryPreparingRunConflictError("memory_admission_snapshot_invalid", false);
    }

    const [chat] = await tx.$queryRaw<Array<{
      activeLeafMessageId: string | null;
      archived: boolean;
      folderId: string | null;
    }>>(Prisma.sql`
      SELECT "activeLeafMessageId", "archived", "folderId"
      FROM "Chat"
      WHERE "id" = ${run.chatId} AND "userId" = ${input.userId}
      FOR UPDATE
    `);
    if (
      !chat ||
      chat.archived ||
      chat.activeLeafMessageId !== attempt.admittedAssistantLeafMessageId ||
      chat.folderId !== attempt.folderIdSnapshot
    ) {
      throw new MemoryPreparingRunConflictError("memory_admission_dag_changed", false);
    }

    const [messages] = await tx.$queryRaw<Array<{
      assistantParentId: string | null;
      assistantRole: string;
      assistantStatus: string;
      userContent: Prisma.JsonValue;
      userParentId: string | null;
      userRole: string;
      userStatus: string;
    }>>(Prisma.sql`
      SELECT
        assistant."parentMessageId" AS "assistantParentId",
        assistant."role" AS "assistantRole",
        assistant."status"::text AS "assistantStatus",
        user_message."content" AS "userContent",
        user_message."parentMessageId" AS "userParentId",
        user_message."role" AS "userRole",
        user_message."status"::text AS "userStatus"
      FROM "Message" AS user_message
      INNER JOIN "Message" AS assistant
        ON assistant."chatId" = user_message."chatId"
       AND assistant."id" = ${attempt.admittedAssistantLeafMessageId}
      WHERE user_message."chatId" = ${run.chatId}
        AND user_message."id" = ${attempt.admittedUserMessageId}
      FOR SHARE OF user_message, assistant
    `);
    const expectedUserParent = attempt.admissionKind === "NORMAL_SEND"
      ? attempt.preSendActiveLeafMessageId
      : messages?.userParentId;
    if (
      !messages ||
      messages.userRole !== "user" ||
      messages.userStatus !== "complete" ||
      messages.assistantRole !== "assistant" ||
      messages.assistantStatus !== "streaming" ||
      messages.assistantParentId !== attempt.admittedUserMessageId ||
      memoryPreparingHash(messages.userContent) !==
        memoryPreparingHash(baseSnapshot.normalizedRequest.content) ||
      messages.userParentId !== expectedUserParent
    ) {
      throw new MemoryPreparingRunConflictError("memory_admission_dag_changed", false);
    }
    if (attempt.admissionKind === "REGENERATE") {
      if (!attempt.preSendActiveLeafMessageId) {
        throw new MemoryPreparingRunConflictError("memory_admission_dag_changed", false);
      }
      const source = await tx.message.findFirst({
        select: { id: true },
        where: {
          chatId: run.chatId,
          id: attempt.preSendActiveLeafMessageId,
          parentMessageId: attempt.admittedUserMessageId,
          role: "assistant"
        }
      });
      if (!source) {
        throw new MemoryPreparingRunConflictError("memory_admission_dag_changed", false);
      }
    }

    await assertCurrentMemoryActionAuthorization(tx, {
      attempt,
      baseRequest: baseSnapshot,
      now,
      runId: run.id,
      userId: input.userId
    });

    if (input.assistant) {
      await assertAssistantRunProvenance(tx, {
        assistantId: input.assistant.assistantId,
        revisionId: input.assistant.revisionId,
        userId: input.userId
      });
    }

    const contextRequested = input.normalizedRequest.personalContext !== undefined;
    if (contextRequested && normalizedRequestHasExternalToolCapability(input.normalizedRequest)) {
      throw new MemoryPreparingRunConflictError("memory_tool_egress_forbidden", false);
    }
    if (contextRequested && run.assistantId) {
      const ownedAssistant = await tx.assistantDefinition.findFirst({
        select: { id: true },
        where: {
          archivedAt: null,
          id: run.assistantId,
          ownerUserId: input.userId
        }
      });
      if (!ownedAssistant) {
        throw new MemoryPreparingRunConflictError("memory_assistant_grant_required", false);
      }
    }

    const items = await loadAndValidatePreparingAttemptItems(tx, {
      attemptId: attempt.id,
      userId: input.userId
    });
    const authoritativeEmptyList = preparingAttemptIsAuthoritativeEmptyList(
      attempt,
      baseSnapshot
    );
    if (memoryPreparingHasAuthoritativeEmptyList(attempt.budgetSnapshot) &&
      !authoritativeEmptyList) {
      throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
    }
    const visibleOutcome = attempt.outcome === "USED" || attempt.outcome === "DEGRADED";
    const contextBearingOutcome = visibleOutcome || authoritativeEmptyList;
    const usedContextIsValid = contextBearingOutcome &&
      (visibleOutcome ? items.length > 0 : items.length === 0) &&
      attempt.preparedContextText !== null &&
      attempt.preparedContextHash === memoryPreparingTextHash(attempt.preparedContextText) &&
      attempt.preparedContextTokenCount !== null &&
      Number.isSafeInteger(attempt.preparedContextTokenCount) &&
      attempt.preparedContextTokenCount >= 0;
    const emptyContextIsValid = !contextBearingOutcome &&
      items.length === 0 &&
      attempt.preparedContextText === null &&
      attempt.preparedContextHash === null &&
      attempt.preparedContextTokenCount === null;
    if (!usedContextIsValid && !emptyContextIsValid) {
      throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
    }
    const currentSettings = await loadPreparingSettings(tx, input.userId);
    const currentSnapshot = memoryPreparingSettingsSnapshot(currentSettings);
    if (
      currentSettings.memoryGeneration !== attempt.memoryGenerationSnapshot ||
      currentSettings.activeIndexGenerationId !== attempt.indexGenerationIdSnapshot ||
      !sameMemoryPreparingSettings(settingsSnapshot, currentSnapshot) ||
      currentSettings.memoryRevision < attempt.retrievalRevisionSnapshot ||
      ((items.length > 0 || authoritativeEmptyList) &&
        currentSettings.memoryRevision !== attempt.retrievalRevisionSnapshot)
    ) {
      throw new MemoryPreparingRunConflictError("memory_admission_settings_changed", true);
    }
    if (!attempt.outcome) {
      throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
    }
    validateFinalPreparingRequest(
      input,
      baseSnapshot,
      attempt,
      items,
      currentSettings.memoryRevision
    );

    await assertCurrentProviderAdmission(tx, {
      plan: input.providerAdmissionPlan,
      userId: input.userId
    });
    await assertCurrentKnowledgeAdmission(tx, {
      plan: input.knowledgeAdmissionPlan,
      userId: input.userId
    });
    await assertCurrentMcpAdmission(tx, {
      bindings: input.mcpBindings,
      runId: input.runId,
      userId: input.userId
    });

    const binding = await tx.modelRunMemoryBinding.create({
      data: {
        boundedSafeQuerySnapshot: attempt.boundedSafeQuerySnapshot,
        contextTextHash: attempt.preparedContextHash ?? memoryPreparingTextHash(""),
        contextTokenCount: attempt.preparedContextTokenCount ?? 0,
        degradationCode: attempt.degradationCode,
        finalizedAt: now,
        finalizedRevisionSnapshot: currentSettings.memoryRevision,
        indexGenerationId: attempt.indexGenerationIdSnapshot,
        memoryGenerationSnapshot: attempt.memoryGenerationSnapshot,
        modelRunId: run.id,
        outcome: attempt.outcome,
        queryHash: attempt.queryHash,
        queryPlannerVersion: MEMORY_PREPARING_QUERY_PLANNER_VERSION,
        retrievalAttemptId: attempt.id,
        retrievalPipelineVersion: MEMORY_PREPARING_RETRIEVAL_PIPELINE_VERSION,
        retrievalRevisionSnapshot: attempt.retrievalRevisionSnapshot,
        settingsSnapshot: json(settingsSnapshot),
        userId: input.userId
      }
    });
    if (items.length > 0) {
      await tx.modelRunMemoryItem.createMany({
        data: items.map((item) => ({
          bindingId: binding.id,
          factVersionId: item.factVersionId,
          featureSnapshot: json(item.featureSnapshot),
          finalScore: (item.featureSnapshot as Record<string, unknown>).finalScore as number,
          includedText: item.exactSafeText,
          includedTextHash: item.textHash,
          itemStateAtAdmission: "ACTIVE",
          itemType: "FACT_VERSION",
          laneRanks: json(item.laneRanks),
          ordinal: item.ordinal,
          selectionReason: item.selectionReason,
          sourceMessageIdsSnapshot: [],
          userId: input.userId
        }))
      });
    }
    await tx.memoryRetrievalAttempt.update({
      data: {
        consumedAt: now,
        state: "CONSUMED",
        updatedAt: now
      },
      where: { id: attempt.id }
    });
    await tx.modelRun.update({
      data: {
        normalizedRequest: json(input.normalizedRequest),
        providerRequestPreview: json(input.providerRequestPreview),
        status: "streaming"
      },
      where: { id: run.id }
    });
    return true;
  });
}

async function retryPreparingRunAttemptWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{
    attemptId: string;
    now: Date;
    runId: string;
    userId: string;
  }>
): Promise<Readonly<{
  attemptId: string;
  memoryGeneration: number;
  memoryRevision: number;
  settingsSnapshot: MemoryPreparingSettingsSnapshot;
}> | null> {
  return repeatableReadTransaction(prismaClient, async (tx) => {
    const run = await lockPreparingRun(tx, input.runId, input.userId);
    const attempt = await lockPreparingAttempt(tx, input);
    if (
      !run ||
      run.status !== "preparing" ||
      !attempt ||
      attempt.attemptOrdinal !== 0 ||
      !["PENDING", "EXECUTING", "READY"].includes(attempt.state)
    ) {
      return null;
    }
    const baseSnapshot = decodeMemoryPreparingBaseSnapshot(
      attempt.boundedPrivateBaseRequestSnapshot
    );
    if (!baseSnapshot || memoryPreparingHash(baseSnapshot) !== attempt.baseRequestHash) {
      throw new MemoryPreparingRunConflictError("memory_admission_snapshot_invalid", false);
    }
    const [chat] = await tx.$queryRaw<Array<{
      activeLeafMessageId: string | null;
      archived: boolean;
      folderId: string | null;
    }>>(Prisma.sql`
      SELECT "activeLeafMessageId", "archived", "folderId"
      FROM "Chat"
      WHERE "id" = ${attempt.chatId} AND "userId" = ${input.userId}
      FOR UPDATE
    `);
    if (
      !chat ||
      chat.archived ||
      chat.activeLeafMessageId !== attempt.admittedAssistantLeafMessageId ||
      chat.folderId !== attempt.folderIdSnapshot
    ) {
      throw new MemoryPreparingRunConflictError("memory_admission_dag_changed", false);
    }
    if (run.assistantId && run.assistantRevisionId) {
      await assertAssistantRunProvenance(tx, {
        assistantId: run.assistantId,
        revisionId: run.assistantRevisionId,
        userId: input.userId
      });
    } else if (run.assistantId || run.assistantRevisionId) {
      throw new MemoryPreparingRunConflictError("memory_admission_shape_changed", false);
    }
    const settings = await loadPreparingSettings(tx, input.userId);
    await tx.memoryRetrievalAttempt.update({
      data: {
        errorCode: "memory_admission_settings_changed",
        state: "STALE",
        updatedAt: input.now
      },
      where: { id: attempt.id }
    });
    const nextAttemptId = await createPreparingAttempt(tx, {
      admissionKind: attempt.admissionKind,
      assistantIdSnapshot: attempt.assistantIdSnapshot,
      assistantMessageId: attempt.admittedAssistantLeafMessageId,
      attemptOrdinal: 1,
      baseSnapshot,
      chatId: attempt.chatId,
      folderIdSnapshot: attempt.folderIdSnapshot,
      now: input.now,
      preSendActiveLeafMessageId: attempt.preSendActiveLeafMessageId,
      runId: attempt.modelRunId,
      settings,
      userId: input.userId,
      userMessageId: attempt.admittedUserMessageId
    });
    return {
      attemptId: nextAttemptId,
      memoryGeneration: settings.memoryGeneration,
      memoryRevision: settings.memoryRevision,
      settingsSnapshot: memoryPreparingSettingsSnapshot(settings)
    };
  });
}

type PreparingSettlementInput = Readonly<{
  attemptId?: string;
  errorCode: string;
  message: string;
  now?: Date;
  runId: string;
  state: "CANCELLED" | "EXPIRED" | "FAILED" | "STALE";
  userId: string;
}>;

async function settlePreparingRunInTransaction(
  tx: Prisma.TransactionClient,
  input: PreparingSettlementInput
): Promise<boolean> {
  const run = await lockPreparingRun(tx, input.runId, input.userId);
  if (!run || run.status !== "preparing") return false;
  const attempt = await lockPreparingAttempt(tx, {
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    runId: input.runId,
    userId: input.userId
  });
  if (!attempt || !["PENDING", "EXECUTING", "READY"].includes(attempt.state)) {
    return false;
  }
  const baseSnapshot = decodeMemoryPreparingBaseSnapshot(
    attempt.boundedPrivateBaseRequestSnapshot
  );
  const normalizedRequest = baseSnapshot?.normalizedRequest ?? {};
  const providerRequestPreview = baseSnapshot?.providerRequestPreview ?? {};
  const now = input.now ?? new Date();
  const errorCode = /^[a-z][a-z0-9_]{0,63}$/u.test(input.errorCode)
    ? input.errorCode
    : "memory_preparing_failed";
  const cancelled = input.state === "CANCELLED";
  await tx.memoryRetrievalAttempt.update({
    data: {
      errorCode,
      state: input.state,
      updatedAt: now
    },
    where: { id: attempt.id }
  });
  await tx.modelRun.update({
    data: {
      errorPayload: json({ code: errorCode, message: input.message }),
      normalizedRequest: json(normalizedRequest),
      providerRequestPreview: json(providerRequestPreview),
      status: cancelled ? "cancelled" : "error"
    },
    where: { id: run.id }
  });
  if (run.assistantMessageId) {
    await tx.message.updateMany({
      data: {
        errorMessage: input.message,
        status: cancelled ? "cancelled" : "error"
      },
      where: {
        id: run.assistantMessageId,
        status: { in: activeMessageStatuses }
      }
    });
  }
  return true;
}

async function settlePreparingRunFailureWithClient(
  prismaClient: PrismaClient,
  input: PreparingSettlementInput
): Promise<boolean> {
  return prismaClient.$transaction((tx) => settlePreparingRunInTransaction(tx, input));
}

async function recoverPreparingRunWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{ now: Date; runId: string; userId: string }>
): Promise<PreparingRunRecoveryResult> {
  return prismaClient.$transaction(async (tx) => {
    const run = await lockPreparingRun(tx, input.runId, input.userId);
    if (!run) return "not_preparing";
    if (run.status !== "preparing") {
      const binding = await tx.modelRunMemoryBinding.findUnique({
        select: { id: true },
        where: { modelRunId: input.runId }
      });
      return binding ? "finalized" : "not_preparing";
    }
    const attempt = await lockPreparingAttempt(tx, {
      runId: input.runId,
      userId: input.userId
    });
    if (!attempt) return "not_preparing";
    const expired = attempt.expiresAt <= input.now;
    const settled = await settlePreparingRunInTransaction(tx, {
      attemptId: attempt.id,
      errorCode: expired
        ? "memory_preparing_attempt_expired"
        : "memory_preparing_recovery_required",
      message: expired
        ? "Memory preparation expired before dispatch."
        : "Memory preparation was interrupted before dispatch.",
      now: input.now,
      runId: input.runId,
      state: expired ? "EXPIRED" : "FAILED",
      userId: input.userId
    });
    return settled ? "settled" : "not_preparing";
  });
}

async function createDormantPreparingRun(
  prismaClient: PrismaClient,
  admission: PreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult & Readonly<{
  materializedRequest?: PreparingRunMaterializedRequest;
}>> {
  const created = await admitPreparingRunWithClient(prismaClient, admission);
  let currentAttemptId = created.attemptId;
  let currentSettings = {
    memoryGeneration: created.memoryGeneration,
    memoryRevision: created.memoryRevision,
    settingsSnapshot: created.settingsSnapshot
  };
  try {
    const actionPlanValue = admission.normalizedRequest.memoryActionPlan;
    const actionPlan = actionPlanValue === undefined
      ? undefined
      : decodeMemoryActionPlan(actionPlanValue);
    if (actionPlanValue !== undefined && !actionPlan) {
      throw new MemoryPreparingRunConflictError("memory_action_plan_invalid", false);
    }
    if (actionPlan) {
      await authorizeRunMemoryAction(prismaClient, {
        admissionKind: admission.admissionKind,
        chatId: admission.chatId,
        modelRunId: created.runId,
        normalizedRequest: admission.normalizedRequest,
        plan: actionPlan,
        sourceMessageId: created.userMessageId,
        userId: admission.userId
      });
    }

    for (let attemptOrdinal = 0; attemptOrdinal < 2; attemptOrdinal += 1) {
      try {
        const began = await beginPreparingRunAttemptWithClient(prismaClient, {
          attemptId: currentAttemptId,
          now: new Date(),
          runId: created.runId,
          userId: admission.userId
        });
        if (!began) {
          throw new MemoryPreparingRunConflictError("memory_preparing_attempt_unavailable", false);
        }
        let attemptResult = admission.memoryMaterializer
          ? await retrieveExplicitRunMemory(prismaClient, {
              ...(actionPlan ? { actionPlan } : {}),
              ...(admission.assistant
                ? { assistantId: admission.assistant.assistantId }
                : {}),
              normalizedRequest: admission.normalizedRequest,
              settings: currentSettings.settingsSnapshot,
              userId: admission.userId
            })
          : dormantMemoryAttemptResult(currentSettings.settingsSnapshot);
        let materializedRequest: PreparingRunMaterializedRequest | undefined;
        if (attemptResult.preparedContext) {
          materializedRequest = admission.memoryMaterializer?.({
            approxTokens: attemptResult.preparedContext.approxTokens,
            itemCount: attemptResult.items?.length ?? 0,
            memoryGeneration: currentSettings.memoryGeneration,
            memoryRevision: currentSettings.memoryRevision,
            mode: "prefetched",
            text: attemptResult.preparedContext.text
          }) ?? undefined;
          if (!materializedRequest) {
            if (actionPlan) {
              throw new ExplicitRunMemoryManagementError("memory_action_failed");
            }
            attemptResult = {
              budgetSnapshot: {
                ...attemptResult.budgetSnapshot,
                itemCount: 0,
                reason: "final_context_budget_unavailable"
              },
              items: [],
              outcome: "FAILED_SAFE",
              preparedContext: null,
              querySnapshot: attemptResult.querySnapshot ?? null
            };
          }
        }
        const completed = await completePreparingRunAttemptWithClient(prismaClient, {
          attemptId: currentAttemptId,
          result: attemptResult,
          runId: created.runId,
          userId: admission.userId
        });
        if (!completed) {
          throw new MemoryPreparingRunConflictError("memory_preparing_attempt_unavailable", false);
        }
        const finalized = await finalizePreparingRunWithClient(prismaClient, {
          ...(admission.assistant ? { assistant: admission.assistant } : {}),
          attemptId: currentAttemptId,
          ...(admission.knowledgeAdmissionPlan
            ? { knowledgeAdmissionPlan: admission.knowledgeAdmissionPlan }
            : {}),
          ...(admission.mcpBindings ? { mcpBindings: admission.mcpBindings } : {}),
          normalizedRequest: materializedRequest?.normalizedRequest ?? admission.normalizedRequest,
          ...(admission.providerAdmissionPlan
            ? { providerAdmissionPlan: admission.providerAdmissionPlan }
            : {}),
          providerRequestPreview:
            materializedRequest?.providerRequestPreview ?? admission.providerRequestPreview,
          runId: created.runId,
          userId: admission.userId
        });
        if (!finalized) {
          throw new MemoryPreparingRunConflictError("memory_preparing_finalize_conflict", false);
        }
        return {
          ...created,
          attemptId: currentAttemptId,
          memoryGeneration: currentSettings.memoryGeneration,
          memoryRevision: currentSettings.memoryRevision,
          settingsSnapshot: currentSettings.settingsSnapshot,
          ...(materializedRequest ? { materializedRequest } : {})
        };
      } catch (error) {
        if (
          !(error instanceof MemoryPreparingRunConflictError) ||
          !error.retryable ||
          attemptOrdinal !== 0
        ) {
          throw error;
        }
        const retry = await retryPreparingRunAttemptWithClient(prismaClient, {
          attemptId: currentAttemptId,
          now: new Date(),
          runId: created.runId,
          userId: admission.userId
        });
        if (!retry) throw error;
        currentAttemptId = retry.attemptId;
        currentSettings = retry;
      }
    }
    throw new MemoryPreparingRunConflictError("memory_preparing_retry_conflict", false);
  } catch (error) {
    await settlePreparingRunFailureWithClient(prismaClient, {
      attemptId: currentAttemptId,
      errorCode: error instanceof MemoryPreparingRunConflictError ||
        error instanceof ExplicitRunMemoryManagementError ||
        error instanceof MemoryRunActionAuthorizationError
        ? error.code
        : "memory_preparing_failed",
      message: "Memory preparation failed before provider dispatch.",
      runId: created.runId,
      state: "FAILED",
      userId: admission.userId
    }).catch(() => false);
    if (error instanceof ExplicitRunMemoryManagementError ||
      error instanceof MemoryRunActionAuthorizationError) {
      throw new MemoryPreparingRunConflictError(error.code, false);
    }
    throw error;
  }
}

export function createPrismaRunRepository(prismaClient = prisma): RunRepository {
  async function loadConversationPath(
    chatId: string,
    userId: string,
    selector: ConversationPathSelector
  ): Promise<{ chatMatched: boolean; messages: ProviderConversationMessage[] }> {
    const selectedLeaf =
      selector.kind === "active"
        ? Prisma.sql`chat."activeLeafMessageId"`
        : Prisma.sql`${selector.leafMessageId}::text`;
    const expectedLeafPredicate =
      selector.kind === "expected"
        ? Prisma.sql`AND chat."activeLeafMessageId" IS NOT DISTINCT FROM ${selector.leafMessageId}`
        : Prisma.empty;
    const rows = await prismaClient.$queryRaw<ConversationPathRow[]>(Prisma.sql`
      WITH RECURSIVE "selected_chat" AS (
        SELECT
          chat."id",
          ${selectedLeaf} AS "selectedLeafMessageId"
        FROM "Chat" AS chat
        WHERE chat."id" = ${chatId}
          AND chat."userId" = ${userId}
          AND chat."archived" = false
          ${expectedLeafPredicate}
      ),
      "ancestor_path" AS (
        SELECT
          message."chatId",
          message."content",
          message."groundedAt",
          message."id",
          message."parentMessageId",
          message."role",
          message."status"::text AS "status",
          ARRAY[message."id"]::text[] AS "visitedIds",
          0 AS "depth"
        FROM "selected_chat" AS chat
        INNER JOIN "Message" AS message
          ON message."chatId" = chat."id"
          AND message."id" = chat."selectedLeafMessageId"

        UNION ALL

        SELECT
          parent."chatId",
          parent."content",
          parent."groundedAt",
          parent."id",
          parent."parentMessageId",
          parent."role",
          parent."status"::text AS "status",
          path."visitedIds" || parent."id",
          path."depth" + 1
        FROM "ancestor_path" AS path
        INNER JOIN "Message" AS parent
          ON parent."chatId" = path."chatId"
          AND parent."id" = path."parentMessageId"
        WHERE NOT parent."id" = ANY(path."visitedIds")
      )
      SELECT
        chat."id" AS "chatId",
        path."content" AS "messageContent",
        path."groundedAt" AS "messageGroundedAt",
        path."id" AS "messageId",
        path."parentMessageId" AS "messageParentId",
        path."role" AS "messageRole",
        path."status" AS "messageStatus"
      FROM "selected_chat" AS chat
      LEFT JOIN "ancestor_path" AS path ON true
      ORDER BY path."depth" DESC NULLS LAST
    `);

    return {
      chatMatched: rows.length > 0,
      messages: conversationMessagesFromPathRows(rows)
    };
  }

  return {
    admitPreparingRun: (input) => admitPreparingRunWithClient(prismaClient, input),
    beginPreparingRunAttempt: (input) =>
      beginPreparingRunAttemptWithClient(prismaClient, input),
    completePreparingRunAttempt: (input) =>
      completePreparingRunAttemptWithClient(prismaClient, input),
    finalizePreparingRun: (input) =>
      finalizePreparingRunWithClient(prismaClient, input),
    recoverPreparingRun: (input) =>
      recoverPreparingRunWithClient(prismaClient, input),
    retryPreparingRunAttempt: (input) =>
      retryPreparingRunAttemptWithClient(prismaClient, input),
    settlePreparingRunFailure: (input) =>
      settlePreparingRunFailureWithClient(prismaClient, input),
    advanceToolLoopCallBatch: async (input) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex) return "conflict";
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return "not_found" as const;
        if (run.status === "cancelled") return "cancelled" as const;
        if (!activeToolLoopRun(run)) return "conflict" as const;
        const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
        if (!checkpoint || checkpoint.roundIndex !== input.roundIndex ||
          (checkpoint.phase !== "tools_pending" && checkpoint.phase !== "tools_running")) {
          return "conflict" as const;
        }
        const calls = await tx.modelRunToolCall.findMany({
          select: { state: true },
          where: { modelRunId: input.runId, roundIndex: input.roundIndex }
        });
        if (calls.length === 0) return "conflict" as const;
        if (calls.some((call) => call.state !== "complete" && call.state !== "error")) {
          return "incomplete" as const;
        }
        const next = toolLoopCheckpoint({
          answerRoundUsage: checkpoint.version === 2 ? checkpoint.answerRoundUsage : [],
          phase: "provider_running",
          providerContinuation: checkpoint.providerContinuation,
          providerCursor: checkpoint.providerCursor,
          roundIndex: checkpoint.roundIndex + 1
        });
        if (!next) return "conflict" as const;
        await tx.modelRun.update({
          data: {
            providerResponseId: null,
            toolLoopState: json(next)
          },
          where: { id: input.runId }
        });
        return "advanced" as const;
      });
    },
    appendAssistantText: async (assistantMessageId, text, options) => {
      await prismaClient.message.updateMany({
        data: {
          content: json(textMessageContent(text)),
          ...(options?.allowErrored ? {} : { status: "streaming" as const })
        },
        where: {
          groundedAt: null,
          id: assistantMessageId,
          status: options?.allowErrored
            ? { in: ["streaming", "error"] }
            : "streaming"
        }
      });
    },
    beginToolLoopProviderRound: async (input) => {
      const checkpoint = toolLoopCheckpoint({
        phase: "provider_running",
        providerContinuation: input.providerContinuation,
        providerCursor: input.providerCursor,
        roundIndex: input.roundIndex
      });
      if (!checkpoint) return "conflict";
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return "not_found" as const;
        if (run.status === "cancelled") return "cancelled" as const;
        if (!activeToolLoopRun(run)) return "conflict" as const;
        if (run.toolLoopState !== null) {
          const current = parseToolLoopCheckpoint(run.toolLoopState);
          return current && sameCheckpoint(current, checkpoint)
            ? "reused" as const
            : "conflict" as const;
        }
        await tx.modelRun.update({
          data: {
            providerResponseId: null,
            toolLoopState: json(checkpoint)
          },
          where: { id: input.runId }
        });
        return "started" as const;
      });
    },
    cancelPendingToolLoopCalls: async (input) => {
      const cancelled = await prismaClient.modelRunToolCall.updateMany({
        data: {
          completedAt: new Date(),
          state: "cancelled"
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId },
          state: "pending"
        }
      });
      return cancelled.count;
    },
    claimToolLoopCall: async (input) => prismaClient.$transaction(async (tx) => {
      const run = await lockToolLoopRun(tx, input);
      if (!run) return { kind: "not_found" as const };
      let call = await tx.modelRunToolCall.findFirst({
        include: toolLoopCallInclude,
        where: { id: input.callId, modelRunId: input.runId }
      });
      if (!call) return { kind: "not_found" as const };
      if (call.state === "complete" || call.state === "error") {
        return { call: persistedToolLoopCall(call), kind: "settled" as const };
      }
      if (call.state === "running") {
        return { call: persistedToolLoopCall(call), kind: "ambiguous" as const };
      }
      if (call.state === "cancelled") {
        return { call: persistedToolLoopCall(call), kind: "cancelled" as const };
      }
      if (!activeToolLoopRun(run)) {
        call = await tx.modelRunToolCall.update({
          data: { completedAt: new Date(), state: "cancelled" },
          include: toolLoopCallInclude,
          where: { id: call.id }
        });
        return { call: persistedToolLoopCall(call), kind: "cancelled" as const };
      }
      const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
      if (!checkpoint || checkpoint.roundIndex !== call.roundIndex ||
        (checkpoint.phase !== "tools_pending" && checkpoint.phase !== "tools_running")) {
        return { kind: "not_found" as const };
      }
      const runningCheckpoint = toolLoopCheckpoint({
        ...checkpoint,
        phase: "tools_running"
      });
      if (!runningCheckpoint) return { kind: "not_found" as const };
      call = await tx.modelRunToolCall.update({
        data: { startedAt: new Date(), state: "running" },
        include: toolLoopCallInclude,
        where: { id: call.id }
      });
      if (checkpoint.phase !== "tools_running") {
        await tx.modelRun.update({
          data: { toolLoopState: json(runningCheckpoint) },
          where: { id: input.runId }
        });
      }
      return { call: persistedToolLoopCall(call), kind: "claimed" as const };
    }),
    appendRunEvent: async (runId, sequence, event) => {
      if (isGroundingDisplaySseEvent(event)) {
        throw new Error("grounding_display_event_is_transient");
      }
      await prismaClient.$transaction(async (tx) => {
        await tx.modelRunEvent.create({
          data: {
            eventType: event.type,
            modelRunId: runId,
            payload: json(event.data),
            sequence
          }
        });
        await tx.modelRun.update({
          data: {
            updatedAt: new Date()
          },
          where: {
            id: runId
          }
        });
      });
    },
    sweepBootOrphanedRuns: async ({ createdBefore, liveRunIds }) => {
      const liveRunIdFilter = unique(liveRunIds);
      const payload = {
        code: "run_orphaned_on_boot",
        message: "Run was active when this server process started and was marked failed."
      };

      return prismaClient.$transaction(async (tx) => {
        const runs = await tx.modelRun.findMany({
          select: {
            assistantMessageId: true,
            id: true,
            status: true,
            userId: true
          },
          where: {
            createdAt: {
              lt: createdBefore
            },
            ...(liveRunIdFilter.length > 0
              ? {
                  id: {
                    notIn: liveRunIdFilter
                  }
                }
              : {}),
            status: {
              in: activeModelRunStatuses
            },
            providerResponseId: null,
            toolLoopState: { equals: Prisma.DbNull }
          }
        });

        if (runs.length === 0) {
          return 0;
        }

        let preparedSettled = 0;
        for (const run of runs) {
          if (run.status !== "preparing") continue;
          if (await settlePreparingRunInTransaction(tx, {
            errorCode: payload.code,
            message: payload.message,
            runId: run.id,
            state: "FAILED",
            userId: run.userId
          })) preparedSettled += 1;
        }
        const runIds = runs
          .filter((run) => run.status !== "preparing")
          .map((run) => run.id);
        const updatedRuns = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(payload),
            status: "error"
          },
          where: {
            id: {
              in: runIds
            },
            status: {
              in: dispatchableModelRunStatuses
            },
            providerResponseId: null,
            toolLoopState: { equals: Prisma.DbNull }
          }
        });
        const assistantMessageIds = unique(
          runs.flatMap((run) =>
            run.status !== "preparing" && run.assistantMessageId
              ? [run.assistantMessageId]
              : [])
        );

        if (assistantMessageIds.length > 0) {
          await tx.message.updateMany({
            data: {
              errorMessage: payload.message,
              status: "error"
            },
            where: {
              id: {
                in: assistantMessageIds
              },
              status: {
                in: activeMessageStatuses
              }
            }
          });
        }

        return preparedSettled + updatedRuns.count;
      });
    },
    cancelRun: async (input) => {
      return prismaClient.$transaction(async (tx) => {
        const lockedRun = await lockPreparingRun(tx, input.runId, input.userId);
        const updatedCount = lockedRun?.status === "preparing"
          ? Number(await settlePreparingRunInTransaction(tx, {
              errorCode: input.payload.code,
              message: input.payload.message,
              runId: input.runId,
              state: "CANCELLED",
              userId: input.userId
            }))
          : (await tx.modelRun.updateMany({
              data: {
                errorPayload: json(input.payload),
                status: "cancelled"
              },
              where: {
                id: input.runId,
                status: { in: dispatchableModelRunStatuses },
                userId: input.userId
              }
            })).count;
        const run = await tx.modelRun.findFirst({
          select: {
            assistantMessageId: true,
            chatId: true,
            id: true,
            modelId: true,
            provider: true,
            providerResponseId: true,
            status: true
          },
          where: {
            id: input.runId,
            userId: input.userId
          }
        });

        if (!run) {
          if (updatedCount > 0) {
            throw new Error("Cancelled run disappeared before transaction commit");
          }

          return { kind: "not_found" } as const;
        }

        if (updatedCount === 0) {
          if (run.status === "preparing") {
            throw new Error("PREPARING run could not be cancelled safely");
          }
          return {
            kind: "current",
            run: runControlRecord(run)
          } as const;
        }

        await tx.modelRunToolCall.updateMany({
          data: {
            completedAt: new Date(),
            state: "cancelled"
          },
          where: {
            modelRunId: input.runId,
            state: "pending"
          }
        });

        if (run.assistantMessageId) {
          await tx.message.updateMany({
            data: {
              errorMessage: input.payload.message,
              status: "cancelled"
            },
            where: {
              id: run.assistantMessageId,
              status: {
                in: activeMessageStatuses
              }
            }
          });
        }

        return {
          kind: "cancelled",
          run: {
            ...runControlRecord(run),
            status: "cancelled"
          }
        } as const;
      });
    },
    completeRun: async (input) => {
      const usage = normalizeTokenUsage(input.usage);
      const usageAttributions = (
        input.usageAttributions?.length
          ? input.usageAttributions
          : [
              {
                estimatedCostMicros: input.estimatedCostMicros,
                modelId: input.modelId,
                provider: input.provider,
                usage
              }
            ]
      ).map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));

      return prismaClient.$transaction(async (tx) => {
        const [existingRun] = await tx.$queryRaw<
          Array<{
            assistantMessageId: string | null;
            chatId: string;
            errorPayload: Prisma.JsonValue | null;
            modelId: string;
            provider: string;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            "assistantMessageId",
            "chatId",
            "errorPayload",
            "modelId",
            "provider",
            "providerResponseId",
            "status",
            "userId"
          FROM "ModelRun"
          WHERE "id" = ${input.runId}
            AND "userId" = ${input.userId}
          FOR UPDATE
        `);
        const activeCompletion = Boolean(
          existingRun && dispatchableModelRunStatuses.includes(existingRun.status)
        );
        const recoveredCompletion = Boolean(
          existingRun &&
            existingRun.status === "error" &&
            existingRun.providerResponseId === (input.providerResponseId ?? null) &&
            !isRecoveredRunTerminalPayload(existingRun.errorPayload)
        );
        if (
          !existingRun ||
          (!activeCompletion && !recoveredCompletion) ||
          existingRun.assistantMessageId !== input.assistantMessageId ||
          existingRun.chatId !== input.chatId ||
          existingRun.modelId !== input.modelId ||
          existingRun.provider !== input.provider
        ) {
          return false;
        }

        const assistantMessage = await tx.message.findUnique({
          select: { groundedAt: true },
          where: { id: input.assistantMessageId }
        });
        const groundedLiveOnly = Boolean(assistantMessage?.groundedAt);

        await tx.modelRun.update({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            errorPayload: Prisma.JsonNull,
            estimatedCostMicros: input.estimatedCostMicros ?? 0,
            finalProviderResponsePreview: json(
              groundedLiveOnly ? groundedLiveOnlyProviderPreview() : input.finalProviderResponsePreview
            ),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            providerResponseId: input.providerResponseId ?? existingRun?.providerResponseId ?? null,
            reasoningTokens: usage.reasoningTokens,
            status: "complete",
            totalTokens: usage.totalTokens
          },
          where: {
            id: input.runId
          }
        });

        await tx.message.updateMany({
          data: {
            content: json(
              groundedLiveOnly ? groundedLiveOnlyMessageContent() : textMessageContent(input.finalText)
            ),
            errorMessage: null,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            status: "complete"
          },
          where: {
            id: input.assistantMessageId,
            OR: [
              {
                status: {
                  in: activeMessageStatuses
                }
              },
              {
                status: "error"
              }
            ]
          }
        });
        await tx.usageEvent.deleteMany({
          where: {
            modelRunId: input.runId
          }
        });
        await tx.usageEvent.createMany({
          data: usageAttributions.map((attribution) => ({
            chatId: input.chatId,
            cachedInputTokens: attribution.usage.cachedInputTokens,
            cacheWriteInputTokens: attribution.usage.cacheWriteInputTokens,
            estimatedCostMicros: attribution.estimatedCostMicros ?? 0,
            inputTokens: attribution.usage.inputTokens,
            modelId: attribution.modelId,
            modelRunId: input.runId,
            outputTokens: attribution.usage.outputTokens,
            provider: attribution.provider,
            reasoningTokens: attribution.usage.reasoningTokens,
            totalTokens: attribution.usage.totalTokens,
            userId: input.userId
          }))
        });
        await tx.chat.update({
          data: {
            totalInputTokens: {
              increment: usage.inputTokens
            },
            totalOutputTokens: {
              increment: usage.outputTokens
            },
            totalReasoningTokens: {
              increment: usage.reasoningTokens
            }
          },
          where: {
            id: input.chatId
          }
        });
        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: input.runId
          }
        });
        const firstTerminalSequence = (latestEvent._max.sequence ?? -1) + 1;
        const terminalEvents: ModelRunSseEvent[] = [
          ...(groundedLiveOnly ? [] : input.eventsBeforeTerminal ?? []),
          {
            data: usage,
            type: "usage"
          },
          {
            data: {
              runId: input.runId,
              status: "complete"
            },
            type: "done"
          }
        ];
        await tx.modelRunEvent.createMany({
          data: terminalEvents.map((event, offset) => ({
            eventType: event.type,
            modelRunId: input.runId,
            payload: json(event.data),
            sequence: firstTerminalSequence + offset
          }))
        });
        return true;
      });
    },
    createRun: async (input) => {
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "NORMAL_SEND"
      });
      return {
        assistantMessageId: created.assistantMessageId,
        ...(created.materializedRequest
          ? { materializedRequest: created.materializedRequest }
          : {}),
        runId: created.runId,
        userMessageId: created.userMessageId
      };
    },
    createRegenerationRun: async (input) => {
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "REGENERATE"
      });
      return {
        assistantMessageId: created.assistantMessageId,
        ...(created.materializedRequest
          ? { materializedRequest: created.materializedRequest }
          : {}),
        runId: created.runId,
        userMessageId: created.userMessageId
      };
    },
    createSearchRun: async (input) => {
      if (input.invocationId) {
        const existingInvocation = await prismaClient.searchRun.findUnique({
          select: { id: true },
          where: {
            modelRunId_invocationId: {
              invocationId: input.invocationId,
              modelRunId: input.modelRunId
            }
          }
        });
        if (existingInvocation) return;
      }
      const artifacts = isRecord(input.artifacts) ? input.artifacts : null;
      const toolCall = artifacts && isRecord(artifacts.toolCall) ? artifacts.toolCall : null;
      const providerCallId = toolCall && typeof toolCall.id === "string" ? toolCall.id : null;
      if (providerCallId) {
        const existing = await prismaClient.searchRun.findFirst({
          select: { id: true },
          where: {
            artifacts: { path: ["toolCall", "id"], equals: providerCallId },
            modelRunId: input.modelRunId,
            provider: input.provider,
            strategyId: input.strategyId
          }
        });
        if (existing) return;
      }
      await prismaClient.searchRun.create({
        data: {
          artifacts: json(input.artifacts),
          durationMs: input.durationMs,
          invocationId: input.invocationId,
          modelId: input.modelId,
          modelRunId: input.modelRunId,
          provider: input.provider,
          query: input.query,
          requestPreview: json(input.requestPreview),
          searchRevisionId: input.searchRevisionId,
          status: input.status,
          strategyId: input.strategyId
        }
      });
    },
    failRun: async (runId, assistantMessageId, error, options) => {
      return prismaClient.$transaction(async (tx) => {
        const [lockedRun] = await tx.$queryRaw<Array<{
          status: ModelRunStatus;
          userId: string;
        }>>(Prisma.sql`
          SELECT "status", "userId"
          FROM "ModelRun"
          WHERE "id" = ${runId}
          FOR UPDATE
        `);
        if (!lockedRun) return false;
        const assistantMessage = await tx.message.findUnique({
          select: { groundedAt: true },
          where: { id: assistantMessageId }
        });
        const groundedLiveOnly = Boolean(assistantMessage?.groundedAt);
        const durableError = groundedLiveOnly
          ? { code: error.code, message: "Grounded live-only run failed." }
          : error;
        const updatedCount = lockedRun.status === "preparing"
          ? Number(await settlePreparingRunInTransaction(tx, {
              errorCode: durableError.code,
              message: durableError.message,
              runId,
              state: "FAILED",
              userId: lockedRun.userId
            }))
          : (await tx.modelRun.updateMany({
              data: {
                errorPayload: json(
                  options?.recoveryTerminal
                    ? recoveredRunErrorPayload(durableError)
                    : durableError
                ),
                ...(groundedLiveOnly
                  ? { finalProviderResponsePreview: json(groundedLiveOnlyProviderPreview()) }
                  : {}),
                status: "error"
              },
              where: {
                id: runId,
                status: { in: dispatchableModelRunStatuses }
              }
            })).count;

        if (updatedCount === 0) {
          return false;
        }

        await tx.modelRunToolCall.updateMany({
          data: {
            completedAt: new Date(),
            state: "cancelled"
          },
          where: {
            modelRunId: runId,
            state: "pending"
          }
        });

        if (groundedLiveOnly) {
          await tx.modelRunEvent.deleteMany({
            where: {
              eventType: { in: ["artifact", "token"] },
              modelRunId: runId
            }
          });
        }

        await tx.message.updateMany({
          data: {
            ...(groundedLiveOnly
              ? { content: json(groundedLiveOnlyMessageContent()) }
              : {}),
            errorMessage: durableError.message,
            status: "error"
          },
          where: {
            id: assistantMessageId,
            status: {
              in: activeMessageStatuses
            }
          }
        });
        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: runId
          }
        });
        await tx.modelRunEvent.create({
          data: {
            eventType: "error",
            modelRunId: runId,
            payload: json(durableError),
            sequence: (latestEvent._max.sequence ?? -1) + 1
          }
        });
        return true;
      });
    },
    findOwnedChat: (chatId, userId) =>
	      prismaClient.chat.findFirst({
	        select: {
	          _count: {
	            select: {
	              messages: true
	            }
	          },
	          activeLeafMessageId: true,
	          defaultKnowledgePlan: true,
	          defaultProviderModel: {
	            select: {
	              connectionId: true,
	              id: true
	            }
	          },
	          folder: {
	            select: {
	              defaultKnowledgePlan: true,
	              projectMemory: true
	            }
	          },
	          id: true,
	          title: true
	        },
        where: {
          archived: false,
          id: chatId,
          userId
        }
      }).then((chat) =>
        chat
	          ? {
	              activeLeafMessageId: chat.activeLeafMessageId,
	              defaultKnowledgePlan: chat.defaultKnowledgePlan,
	              defaultModelId: chat.defaultProviderModel?.id ?? "",
	              defaultProvider: chat.defaultProviderModel?.connectionId ?? "",
	              folderDefaultKnowledgePlan: chat.folder?.defaultKnowledgePlan ?? null,
	              id: chat.id,
	              messageCount: chat._count.messages,
	              projectMemory: chat.folder?.projectMemory ?? null,
	              title: chat.title
	            }
          : null
      ),
    findRecentActiveRunForChat: ({ chatId, since, userId }) =>
      prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true
        },
        orderBy: {
          updatedAt: "desc"
        },
        where: {
          chatId,
          userId,
          status: {
            in: activeModelRunStatuses
          },
          updatedAt: {
            gt: since
          }
        }
      }),
    findStaleActiveRunsForUser: (input) =>
      prismaClient.modelRun.findMany({
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true,
          updatedAt: true
        },
        where: {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.runId ? { id: input.runId } : {}),
          userId: input.userId,
          status: {
            in: activeModelRunStatuses
          },
          updatedAt: {
            lt: input.staleBefore
          }
        }
      }),
    findInstallationRecoverableRuns: (input) =>
      prismaClient.modelRun.findMany({
        orderBy: { updatedAt: "asc" },
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true,
          updatedAt: true,
          userId: true
        },
        take: input.limit,
        where: {
          OR: [
            {
              createdAt: { lt: input.bootedBefore },
              OR: [
                { providerResponseId: { not: null } },
                { toolLoopState: { not: Prisma.DbNull } }
              ]
            },
            { updatedAt: { lt: input.staleBefore } }
          ],
          status: { in: activeModelRunStatuses }
        }
      }),
    findRegenerationSource: async (sourceMessageId, userId) => {
      const sourceMessage = await prismaClient.message.findFirst({
        include: {
          chat: {
            select: {
              defaultKnowledgePlan: true,
              defaultProviderModel: {
                select: {
                  connectionId: true,
                  id: true
                }
              },
              folder: {
                select: {
                  defaultKnowledgePlan: true,
                  projectMemory: true
                }
              },
              id: true
            }
          },
          parent: {
            select: {
              content: true,
              id: true,
              role: true
            }
          }
        },
        where: {
          chat: {
            archived: false,
            userId
          },
          id: sourceMessageId,
          role: { in: ["assistant", "user"] }
        }
      });

      if (!sourceMessage) {
        return null;
      }

      const chat = {
        defaultKnowledgePlan: sourceMessage.chat.defaultKnowledgePlan,
        defaultModelId: sourceMessage.chat.defaultProviderModel?.id ?? "",
        defaultProvider: sourceMessage.chat.defaultProviderModel?.connectionId ?? "",
        folderDefaultKnowledgePlan: sourceMessage.chat.folder?.defaultKnowledgePlan ?? null,
        id: sourceMessage.chat.id,
        projectMemory: sourceMessage.chat.folder?.projectMemory ?? null
      };

      if (sourceMessage.role === "user") {
        return {
          assistantMessage: null,
          chat,
          userMessage: {
            content: sourceMessage.content,
            id: sourceMessage.id
          }
        };
      }

      if (!sourceMessage.parent || sourceMessage.parent.role !== "user") {
        return null;
      }

      const sourceRun = await prismaClient.modelRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          providerRunBindings: {
            select: {
              connectionId: true,
              providerModelId: true
            },
            where: { role: "answer" }
          }
        },
        where: {
          assistantMessageId: sourceMessage.id,
          userId
        }
      });
      const answerBinding = sourceRun?.providerRunBindings[0];

      return {
        assistantMessage: {
          id: sourceMessage.id,
          modelId: answerBinding?.providerModelId ?? null,
          provider: answerBinding?.connectionId ?? null
        },
        chat,
        userMessage: {
          content: sourceMessage.parent.content,
          id: sourceMessage.parent.id
        }
      };
    },
    getRunControlForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true,
          chatId: true,
          errorPayload: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true
        },
        where: {
          id: runId,
          userId
        }
      });

      return run
        ? {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            id: run.id,
            modelId: run.modelId,
            provider: run.provider,
            providerResponseId: run.providerResponseId,
            recoverySettled: isRecoveredRunTerminalPayload(run.errorPayload),
            status: run.status
          }
        : null;
    },
    getRunForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        include: {
          assistantRevision: {
            select: {
              name: true,
              revisionNumber: true
            }
          },
          events: {
            orderBy: {
              sequence: "asc"
            }
          },
          knowledgeRunBindings: {
            orderBy: { ordinal: "asc" }
          },
          knowledgeRuns: {
            orderBy: { invocationOrdinal: "asc" }
          },
          searchRuns: {
            orderBy: {
              createdAt: "asc"
            }
          },
          toolCalls: {
            orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }]
          }
        },
        where: {
          id: runId,
          userId
        }
      });

      if (!run) {
        return null;
      }
      const publicRunStatus = acceptedRunStatus(run.status);

      const knowledgeRuns = run.knowledgeRuns.map((receipt) => {
        const projection = decodeKnowledgeRunProjection({
          baseEvidence: Array.isArray(receipt.baseEvidence) ? receipt.baseEvidence : [],
          candidateCount: receipt.candidateCount,
          candidateLimit: receipt.candidateLimit,
          createdAt: receipt.createdAt.toISOString(),
          durationMs: receipt.durationMs,
          embeddingUsage: Array.isArray(receipt.embeddingUsage) ? receipt.embeddingUsage : [],
          failureCode: receipt.failureCode,
          fusion: receipt.fusion,
          id: receipt.id,
          invocationOrdinal: receipt.invocationOrdinal,
          modelRunToolCallId: receipt.modelRunToolCallId,
          outcome: receipt.outcome,
          postRerankOrder: receipt.postRerankOrder,
          preRerankOrder: receipt.preRerankOrder,
          providerText: receipt.providerText,
          query: receipt.query,
          rerankerBinding: receipt.rerankerBinding,
          resultLimit: receipt.resultLimit,
          results: Array.isArray(receipt.results) ? receipt.results : [],
          threshold: receipt.threshold
        });
        if (!projection) throw new Error("knowledge_run_receipt_invalid");
        return projection;
      });
      const events = projectKnowledgeInspectionEvents({
        events: run.events.map((event) => ({
          createdAt: event.createdAt.toISOString(),
          eventType: event.eventType,
          payload: event.payload,
          sequence: event.sequence
        })),
        knowledgeRuns,
        toolCalls: run.toolCalls
      });

      return {
        assistant: run.assistantId && run.assistantRevision
          ? {
              assistantId: run.assistantId,
              name: run.assistantRevision.name,
              revisionNumber: run.assistantRevision.revisionNumber
            }
          : null,
        assistantMessageId: run.assistantMessageId,
        chatId: run.chatId,
        createdAt: run.createdAt.toISOString(),
        errorPayload: run.errorPayload,
        estimatedCostMicros: run.estimatedCostMicros > 0 ? run.estimatedCostMicros : null,
        events,
        finalProviderResponsePreview: run.finalProviderResponsePreview,
        id: run.id,
        cachedInputTokens: run.cachedInputTokens,
        cacheWriteInputTokens: run.cacheWriteInputTokens,
        inputTokens: run.inputTokens,
        knowledgeBindings: run.knowledgeRunBindings.map((binding) => ({
          baseContentRevision: binding.baseContentRevision,
          embeddingConnectionId: binding.embeddingConnectionId,
          embeddingCredentialSource: binding.embeddingCredentialSource,
          embeddingProviderModelId: binding.embeddingProviderModelId,
          indexedContentRevision: binding.indexedContentRevision,
          indexGenerationId: binding.indexGenerationId,
          knowledgeBaseId: binding.knowledgeBaseId,
          ordinal: binding.ordinal,
          targetDimension: binding.targetDimension,
          vectorSpaceFingerprint: binding.vectorSpaceFingerprint.trim()
        })),
        knowledgePlan: knowledgePlanFromNormalizedRequest(run.normalizedRequest),
        knowledgeRuns,
        modelId: run.modelId,
        normalizedRequest: run.normalizedRequest,
        outputTokens: run.outputTokens,
        provider: run.provider,
        providerRequestPreview: run.providerRequestPreview,
        providerResponseId: run.providerResponseId,
        reasoningTokens: run.reasoningTokens,
        totalTokens: run.totalTokens,
        searchRuns: run.searchRuns.map((searchRun) => ({
          artifacts: searchRun.artifacts,
          createdAt: searchRun.createdAt.toISOString(),
          id: searchRun.id,
          modelId: searchRun.modelId,
          provider: searchRun.provider,
          query: searchRun.query,
          requestPreview: searchRun.requestPreview,
          status: searchRun.status,
          strategyId: searchRun.strategyId,
          updatedAt: searchRun.updatedAt.toISOString()
        })),
        status: publicRunStatus,
        toolCalls: run.toolCalls.flatMap((call) => {
          const activity = persistedToolCallActivity({
            call,
            normalizedRequest: run.normalizedRequest,
            runStatus: publicRunStatus
          });
          return activity ? [activity] : [];
        }),
        updatedAt: run.updatedAt.toISOString(),
        userMessageId: run.userMessageId
      };
    },
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) => {
      return prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
        select: {
          _count: {
            select: {
              messages: true
            }
          },
          activeLeafMessageId: true,
          createdAt: true,
          defaultKnowledgePlan: true,
          defaultProviderModel: {
            select: {
              connectionId: true,
              id: true
            }
          },
          folderId: true,
          id: true,
          messages: {
            include: {
              assistantModelRuns: {
                orderBy: {
                  createdAt: "desc"
                },
                select: {
                  assistantId: true,
                  assistantRevision: {
                    select: {
                      avatar: true,
                      name: true,
                      revisionNumber: true
                    }
                  },
                  events: {
                    orderBy: {
                      sequence: "asc"
                    },
                    select: {
                      payload: true
                    },
                    where: {
                      eventType: "artifact"
                    }
                  },
                  id: true,
                  inputTokens: true,
                  knowledgeRuns: {
                    orderBy: { invocationOrdinal: "asc" },
                    select: {
                      invocationOrdinal: true,
                      outcome: true,
                      results: true
                    }
                  },
                  normalizedRequest: true,
                  outputTokens: true,
                  searchRuns: {
                    orderBy: {
                      createdAt: "asc"
                    },
                    select: {
                      artifacts: true,
                      modelId: true,
                      provider: true,
                      query: true,
                      requestPreview: true,
                      status: true,
                      strategyId: true
                    }
                  },
                  status: true,
                  toolCalls: {
                    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
                    select: {
                      arguments: true,
                      completedAt: true,
                      mcpRunBindingId: true,
                      ordinal: true,
                      providerCallId: true,
                      result: true,
                      roundIndex: true,
                      startedAt: true,
                      state: true,
                      toolName: true
                    }
                  },
                  totalTokens: true
                },
                take: 1
              }
            },
            orderBy: {
              createdAt: "asc"
            },
            where: {
              id: {
                in: [userMessageId, assistantMessageId]
              }
            }
          },
          pinned: true,
          title: true,
          updatedAt: true
        },
        where: {
          archived: false,
          id: chatId,
          userId
        }
        });

        if (!chat) {
          return null;
        }

        const { contextStats, usageStats } = await loadChatBranchSnapshotStats(tx, {
          activeLeafMessageId: chat.activeLeafMessageId,
          chatId
        });

        return {
          chat: {
            activeLeafMessageId: chat.activeLeafMessageId,
            contextStats,
            createdAt: chat.createdAt,
            defaultKnowledgePlan: knowledgeDefaultFromJson(chat.defaultKnowledgePlan),
            defaultModelId: chat.defaultProviderModel?.id ?? null,
            defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
            folderId: chat.folderId,
            id: chat.id,
            messageCount: chat._count.messages,
            pinned: chat.pinned,
            title: chat.title,
            updatedAt: chat.updatedAt,
            usageStats
          },
          messages: chat.messages.map((message) => {
            const modelRun = message.assistantModelRuns[0];

            return {
              artifactSummary: modelRun ? summarizeMessageRunArtifacts(modelRun, message.content) : null,
              assistantIdentity: serializeRunAssistantIdentity(modelRun),
              content: message.content,
              createdAt: message.createdAt,
              errorMessage: message.errorMessage,
              id: message.id,
              modelId: message.modelId,
              modelRunId: modelRun?.id ?? null,
              parentMessageId: message.parentMessageId,
              provider: message.provider,
              role: message.role,
              runUsage: modelRun
                ? {
                    totalTokens: normalizeTokenUsage({
                      inputTokens: modelRun.inputTokens,
                      outputTokens: modelRun.outputTokens,
                      reasoningTokens: 0,
                      totalTokens: modelRun.totalTokens
                    }).totalTokens
                  }
                : null,
              status: message.status
            };
          })
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    isSearchStrategyEnabled: async (searchStrategyId) => {
      const strategy = await prismaClient.searchStrategy.findFirst({
        select: {
          strategyId: true
        },
        where: {
          enabled: true,
          strategyId: searchStrategyId
        }
      });

      return Boolean(strategy);
    },
    loadSearchStrategyConfiguration: async (searchStrategyId) => {
      const strategy = await prismaClient.searchStrategy.findFirst({
        select: {
          config: true,
          kind: true,
          modelId: true,
          provider: true,
          strategyId: true
        },
        where: {
          enabled: true,
          strategyId: searchStrategyId
        }
      });

      if (!strategy) {
        return null;
      }

      return {
        config: isRecord(strategy.config)
          ? { ...(strategy.config as Record<string, unknown>) }
          : {},
        kind: strategy.kind,
        modelId: strategy.modelId,
        provider: strategy.provider,
        strategyId: strategy.strategyId
      };
    },
    loadConversationContext: async (chatId, userId) => {
      const context = await loadConversationPath(chatId, userId, { kind: "active" });
      return context.messages;
    },
    loadConversationContextForExpectedLeaf: async (
      chatId,
      userId,
      expectedActiveLeafMessageId
    ) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "expected",
        leafMessageId: expectedActiveLeafMessageId
      });
      return context.chatMatched ? context.messages : null;
    },
    loadConversationContextForLeaf: async (chatId, userId, leafMessageId) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "explicit",
        leafMessageId
      });
      return context.messages;
    },
    loadAttachments: async (userId, attachmentIds) => {
      if (attachmentIds.length === 0) {
        return [];
      }

      const attachments = await prismaClient.attachment.findMany({
        where: {
          id: {
            in: attachmentIds
          },
          userId
        }
      });

      return attachments.map(
        (attachment): RunAttachmentRecord => ({
          byteSize: attachment.byteSize,
          extractedText: attachment.extractedText,
          fileName: attachment.fileName,
          id: attachment.id,
          kind: attachment.kind,
          metadata: attachment.metadata,
          mimeType: attachment.mimeType,
          status: attachment.status,
          storageKey: attachment.storageKey
        })
      );
    },
    loadEntitlements: (userId) => loadEntitlementsForUser(userId),
    loadModelConfiguration: async (provider, modelId) => {
      const model = await prismaClient.providerModel.findFirst({
        select: {
          capabilities: true,
          contextWindow: true,
          defaultParams: true,
          supportsNativeSearch: true,
          supportsPdf: true,
          supportsReasoning: true,
          supportsVision: true
        },
        where: {
          enabled: true,
          modelId,
          modelClass: "answer",
          provider
        }
      });

      if (!model) {
        return null;
      }
      const defaultCapabilities =
        typeof model.capabilities === "object" && model.capabilities !== null && !Array.isArray(model.capabilities)
          ? (model.capabilities as Record<string, unknown>)
          : {};

      return {
        capabilities: {
          backgroundStreaming:
            typeof defaultCapabilities.backgroundStreaming === "boolean"
              ? defaultCapabilities.backgroundStreaming
              : false,
          contextWindow: model.contextWindow,
          defaultMaxOutputTokens: defaultMaxOutputTokens(model.defaultParams),
          nativeBackground:
            typeof defaultCapabilities.nativeBackground === "boolean"
              ? defaultCapabilities.nativeBackground
              : false,
          nativePdfInput:
            typeof defaultCapabilities.nativePdfInput === "boolean" ? defaultCapabilities.nativePdfInput : false,
          nativeSearch: model.supportsNativeSearch,
          parallelToolCalls:
            typeof defaultCapabilities.parallelToolCalls === "boolean"
              ? defaultCapabilities.parallelToolCalls
              : false,
          pdf: model.supportsPdf,
          reasoning: model.supportsReasoning,
          streaming: typeof defaultCapabilities.streaming === "boolean" ? defaultCapabilities.streaming : false,
          toolCalling:
            typeof defaultCapabilities.toolCalling === "boolean" ? defaultCapabilities.toolCalling : false,
          vision: model.supportsVision
        },
        defaultParams: isRecord(model.defaultParams)
          ? { ...(model.defaultParams as Record<string, unknown>) }
          : {}
      };
    },
    loadModelPricing: async (provider, modelId) => {
      const models = await prismaClient.providerModel.findMany({
        select: {
          inputTokenPriceMicros: true,
          outputTokenPriceMicros: true
        },
        take: 2,
        where: { modelClass: "answer", modelId, provider }
      });

      return models.length === 1
        ? {
            inputTokenPriceMicros: models[0].inputTokenPriceMicros,
            outputTokenPriceMicros: models[0].outputTokenPriceMicros
          }
        : null;
    },
    loadRunUsageAttributions: async (input) => {
      const rows = await prismaClient.usageEvent.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          createdAt: true,
          estimatedCostMicros: true,
          inputTokens: true,
          modelId: true,
          outputTokens: true,
          provider: true,
          reasoningTokens: true,
          totalTokens: true
        },
        where: { modelRunId: input.runId, userId: input.userId }
      });
      return rows.map((row) => ({
        estimatedCostMicros: row.estimatedCostMicros,
        modelId: row.modelId,
        provider: row.provider,
        recordedAt: row.createdAt.toISOString(),
        usage: {
          cachedInputTokens: row.cachedInputTokens ?? 0,
          cacheWriteInputTokens: row.cacheWriteInputTokens ?? 0,
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          reasoningTokens: row.reasoningTokens ?? 0,
          totalTokens: row.totalTokens ?? 0
        }
      }));
    },
    loadCheckpointedToolLoopRun: async (input) => {
      const run = await prismaClient.modelRun.findFirst({
        include: {
          assistantMessage: {
            select: {
              content: true,
              groundedAt: true
            }
          },
          toolCalls: {
            include: toolLoopCallInclude,
            orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }]
          }
        },
        where: { id: input.runId, userId: input.userId }
      });
      if (!run || run.toolLoopState === null) return null;
      const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
      if (!checkpoint) throw new Error("tool_loop_checkpoint_invalid_in_storage");
      return {
        assistantMessageId: run.assistantMessageId,
        assistantText: run.assistantMessage && !run.assistantMessage.groundedAt
          ? textFromContentBlocks(
              isRecord(run.assistantMessage.content) ? run.assistantMessage.content : {}
            )
          : null,
        calls: run.toolCalls.map(persistedToolLoopCall),
        chatId: run.chatId,
        checkpoint,
        id: run.id,
        modelId: run.modelId,
        normalizedRequest: run.normalizedRequest as unknown as CheckpointedToolLoopRun["normalizedRequest"],
        provider: run.provider,
        providerResponseId: run.providerResponseId,
        status: run.status,
        userId: run.userId
      };
    },
    persistToolLoopCallBatch: async (input: PersistToolLoopCallBatchInput) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex || input.calls.length === 0 ||
        input.calls.length > toolLoopPersistenceLimits.batchCalls) {
        return { kind: "conflict" as const };
      }
      const providerCallIds = new Set<string>();
      const preparedCalls: Array<{
        arguments: Readonly<Record<string, ToolLoopJsonValue>>;
        ordinal: number;
        providerCallId: string;
        runtimeGenerationFingerprint: string | null;
        toolName: string;
      }> = [];
      for (const [index, call] of input.calls.entries()) {
        const argumentsValue = toolLoopArguments(call.arguments);
        const runtimeFingerprint = call.runtimeGenerationFingerprint ?? null;
        if (!argumentsValue || call.ordinal !== index || !call.providerCallId.trim() ||
          call.providerCallId.length > toolLoopPersistenceLimits.providerCallIdLength ||
          providerCallIds.has(call.providerCallId) || !call.toolName.trim() ||
          call.toolName.length > toolLoopPersistenceLimits.toolNameLength ||
          (runtimeFingerprint !== null && !/^[a-f0-9]{64}$/u.test(runtimeFingerprint))) {
          return { kind: "conflict" as const };
        }
        providerCallIds.add(call.providerCallId);
        preparedCalls.push({
          arguments: argumentsValue,
          ordinal: call.ordinal,
          providerCallId: call.providerCallId,
          runtimeGenerationFingerprint: runtimeFingerprint,
          toolName: call.toolName
        });
      }
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return { kind: "not_found" as const };
        if (run.status === "cancelled") return { kind: "cancelled" as const };
        if (!activeToolLoopRun(run)) return { kind: "conflict" as const };
        const current = parseToolLoopCheckpoint(run.toolLoopState);
        if (!current) return { kind: "conflict" as const };
        const pendingCheckpoint = toolLoopCheckpoint({
          answerRoundUsage: current.version === 2 ? current.answerRoundUsage : [],
          phase: "tools_pending",
          providerContinuation: input.providerContinuation,
          providerCursor: input.providerCursor,
          roundIndex: input.roundIndex
        });
        if (!pendingCheckpoint) return { kind: "conflict" as const };

        const existing = await tx.modelRunToolCall.findMany({
          include: toolLoopCallInclude,
          orderBy: { ordinal: "asc" },
          where: { modelRunId: input.runId, roundIndex: input.roundIndex }
        });
        if (existing.length > 0) {
          const sameContinuation = current.roundIndex === pendingCheckpoint.roundIndex &&
            (current.phase === "tools_pending" || current.phase === "tools_running") &&
            canonicalJson(current.providerContinuation) ===
              canonicalJson(pendingCheckpoint.providerContinuation) &&
            canonicalJson(current.providerCursor) === canonicalJson(pendingCheckpoint.providerCursor);
          const sameCalls = existing.length === preparedCalls.length && existing.every((call, index) => {
            const expected = preparedCalls[index];
            const argumentsValue = toolLoopArguments(call.arguments);
            return Boolean(expected && argumentsValue && call.ordinal === expected.ordinal &&
              call.providerCallId === expected.providerCallId && call.toolName === expected.toolName &&
              (call.mcpRunBinding?.runtimeGenerationFingerprint ?? null) ===
                expected.runtimeGenerationFingerprint &&
              canonicalJson(argumentsValue!) === canonicalJson(expected.arguments as Record<string, ToolLoopJsonValue>));
          });
          return sameContinuation && sameCalls
            ? { calls: existing.map(persistedToolLoopCall), kind: "reused" as const }
            : { kind: "conflict" as const };
        }
        if (current.phase !== "provider_running" || current.roundIndex !== input.roundIndex) {
          return { kind: "conflict" as const };
        }

        const fingerprints = [...new Set(preparedCalls.flatMap((call) =>
          call.runtimeGenerationFingerprint ? [call.runtimeGenerationFingerprint] : []))];
        const bindings = fingerprints.length
          ? await tx.mcpRunBinding.findMany({
              select: { id: true, runtimeGenerationFingerprint: true },
              where: {
                modelRunId: input.runId,
                runtimeGenerationFingerprint: { in: fingerprints }
              }
            })
          : [];
        const bindingsByFingerprint = new Map(bindings.map((binding) =>
          [binding.runtimeGenerationFingerprint, binding.id]));
        if (bindingsByFingerprint.size !== fingerprints.length) {
          return { kind: "conflict" as const };
        }

        for (const call of preparedCalls) {
          await tx.modelRunToolCall.create({
            data: {
              arguments: json(call.arguments),
              mcpRunBindingId: call.runtimeGenerationFingerprint
                ? bindingsByFingerprint.get(call.runtimeGenerationFingerprint)!
                : null,
              modelRunId: input.runId,
              ordinal: call.ordinal,
              providerCallId: call.providerCallId,
              roundIndex: input.roundIndex,
              state: "pending",
              toolName: call.toolName
            }
          });
        }
        await tx.modelRun.update({
          data: { toolLoopState: json(pendingCheckpoint) },
          where: { id: input.runId }
        });
        const persisted = await tx.modelRunToolCall.findMany({
          include: toolLoopCallInclude,
          orderBy: { ordinal: "asc" },
          where: { modelRunId: input.runId, roundIndex: input.roundIndex }
        });
        return { calls: persisted.map(persistedToolLoopCall), kind: "persisted" as const };
      });
    },
    recordRunUsageEvents: async (input) => {
      if (input.usageAttributions.length === 0 && !input.answerRoundUsage) {
        return false;
      }

      const usageAttributions = input.usageAttributions.map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));
      const usage = sumTokenUsage(usageAttributions.map((attribution) => attribution.usage));
      const estimatedCostMicros = usageAttributions.reduce(
        (total, attribution) => total + (attribution.estimatedCostMicros ?? 0),
        0
      );

      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return false;
        const nextCheckpoint = input.answerRoundUsage
          ? (() => {
              const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
              return checkpoint
                ? upsertAnswerRoundUsage(checkpoint, input.answerRoundUsage)
                : null;
            })()
          : undefined;
        if (input.answerRoundUsage && !nextCheckpoint) return false;

        const updatedRun = await tx.modelRun.updateMany({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            estimatedCostMicros,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            ...(nextCheckpoint ? { toolLoopState: json(nextCheckpoint) } : {}),
            totalTokens: usage.totalTokens
          },
          where: {
            chatId: input.chatId,
            id: input.runId,
            status: {
              not: "complete"
            },
            userId: input.userId
          }
        });
        if (updatedRun.count === 0) {
          return false;
        }

        await tx.usageEvent.deleteMany({
          where: {
            modelRunId: input.runId
          }
        });
        if (usageAttributions.length > 0) {
          await tx.usageEvent.createMany({
            data: usageAttributions.map((attribution) => ({
              chatId: input.chatId,
              cachedInputTokens: attribution.usage.cachedInputTokens,
              cacheWriteInputTokens: attribution.usage.cacheWriteInputTokens,
              estimatedCostMicros: attribution.estimatedCostMicros ?? 0,
              inputTokens: attribution.usage.inputTokens,
              modelId: attribution.modelId,
              modelRunId: input.runId,
              outputTokens: attribution.usage.outputTokens,
              provider: attribution.provider,
              reasoningTokens: attribution.usage.reasoningTokens,
              totalTokens: attribution.usage.totalTokens,
              userId: input.userId
            }))
          });
        }
        return true;
      });
    },
    resetToolLoopAssistantDraft: async (input) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex ||
        !Number.isInteger(input.sequence) || input.sequence < 0) return false;
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run || !activeToolLoopRun(run) || !run.assistantMessageId) return false;
        const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
        if (!checkpoint || checkpoint.roundIndex !== input.roundIndex ||
          (checkpoint.phase !== "tools_pending" && checkpoint.phase !== "tools_running")) {
          return false;
        }
        const reset = await tx.message.updateMany({
          data: {
            content: json(textMessageContent("")),
            errorMessage: null,
            status: "streaming"
          },
          where: {
            id: run.assistantMessageId,
              status: { in: [...activeMessageStatuses, "error"] }
          }
        });
        if (reset.count !== 1) return false;
        await tx.modelRunEvent.create({
          data: {
            eventType: "message_reset",
            modelRunId: input.runId,
            payload: json({ round: input.roundIndex }),
            sequence: input.sequence
          }
        });
        await tx.modelRun.update({
          data: { updatedAt: new Date() },
          where: { id: input.runId }
        });
        return true;
      });
    },
    settleRecoveredRunError: async (input) => {
      const usageAttributions = input.usageAttributions.map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));
      const usage =
        usageAttributions.length > 0
          ? sumTokenUsage(usageAttributions.map((attribution) => attribution.usage))
          : null;
      const estimatedCostMicros = usageAttributions.reduce(
        (total, attribution) => total + (attribution.estimatedCostMicros ?? 0),
        0
      );

      return prismaClient.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<
          Array<{
            assistantMessageId: string | null;
            chatId: string;
            errorPayload: Prisma.JsonValue | null;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            "assistantMessageId",
            "chatId",
            "errorPayload",
            "providerResponseId",
            "status",
            "userId"
          FROM "ModelRun"
          WHERE "id" = ${input.runId}
            AND "userId" = ${input.userId}
          FOR UPDATE
        `);

        if (
          !run ||
          (!dispatchableModelRunStatuses.includes(run.status) && run.status !== "error") ||
          isRecoveredRunTerminalPayload(run.errorPayload)
        ) {
          return false;
        }

        await tx.modelRun.update({
          data: {
            errorPayload: json(recoveredRunErrorPayload(input.error)),
            ...(input.providerResponseId
              ? { providerResponseId: input.providerResponseId }
              : {}),
            status: "error",
            ...(usage
              ? {
                  cachedInputTokens: usage.cachedInputTokens,
                  cacheWriteInputTokens: usage.cacheWriteInputTokens,
                  estimatedCostMicros,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  reasoningTokens: usage.reasoningTokens,
                  totalTokens: usage.totalTokens
                }
              : {})
          },
          where: {
            id: input.runId
          }
        });

        if (run.assistantMessageId) {
          await tx.message.updateMany({
            data: {
              errorMessage: input.error.message,
              status: "error"
            },
            where: {
              chatId: run.chatId,
              id: run.assistantMessageId,
              status: {
                in: [...activeMessageStatuses, "error"]
              }
            }
          });
        }

        if (usageAttributions.length > 0) {
          await tx.usageEvent.deleteMany({
            where: {
              modelRunId: input.runId
            }
          });
          await tx.usageEvent.createMany({
            data: usageAttributions.map((attribution) => ({
              chatId: run.chatId,
              cachedInputTokens: attribution.usage.cachedInputTokens,
              cacheWriteInputTokens: attribution.usage.cacheWriteInputTokens,
              estimatedCostMicros: attribution.estimatedCostMicros ?? 0,
              inputTokens: attribution.usage.inputTokens,
              modelId: attribution.modelId,
              modelRunId: input.runId,
              outputTokens: attribution.usage.outputTokens,
              provider: attribution.provider,
              reasoningTokens: attribution.usage.reasoningTokens,
              totalTokens: attribution.usage.totalTokens,
              userId: run.userId
            }))
          });
        }

        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: input.runId
          }
        });
        const firstSequence = (latestEvent._max.sequence ?? -1) + 1;
        const events: ModelRunSseEvent[] = [
          ...input.events,
          {
            data: input.error,
            type: "error"
          }
        ];
        await tx.modelRunEvent.createMany({
          data: events.map((event, offset) => ({
            eventType: event.type,
            modelRunId: input.runId,
            payload: json(event.data),
            sequence: firstSequence + offset
          }))
        });

        return true;
      });
    },
    settleToolLoopCall: async (input) => {
      const result = snapshotToolLoopJson(input.result, toolLoopPersistenceLimits.resultBytes);
      if (result === null && input.result !== null) return "conflict";
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return "not_found" as const;
        const call = await tx.modelRunToolCall.findFirst({
          select: { id: true, result: true, state: true },
          where: { id: input.callId, modelRunId: input.runId }
        });
        if (!call) return "not_found" as const;
        if (call.state === "complete" || call.state === "error") {
          const existing = call.result === null
            ? null
            : snapshotToolLoopJson(call.result, toolLoopPersistenceLimits.resultBytes);
          return call.state === input.state &&
            (call.result === null || existing !== null) &&
            canonicalJson(existing) === canonicalJson(result)
            ? "reused" as const
            : "conflict" as const;
        }
        if (call.state !== "running") return "conflict" as const;
        await tx.modelRunToolCall.update({
          data: {
            completedAt: new Date(),
            result: result === null ? Prisma.JsonNull : json(result),
            state: input.state
          },
          where: { id: call.id }
        });
        return "settled" as const;
      });
    },
    markAssistantMessageGroundedLiveOnly: async (input) => {
      const provider = input.provider.trim().slice(0, 128);
      const strategy = input.strategy.trim().slice(0, 128);
      if (provider !== "gemini" || strategy !== "gemini-google-search") return false;

      return prismaClient.$transaction(async (tx) => {
        const run = await tx.modelRun.findUnique({
          select: { assistantMessageId: true, status: true },
          where: { id: input.runId }
        });
        if (
          run?.assistantMessageId !== input.assistantMessageId ||
          !dispatchableModelRunStatuses.includes(run.status)
        ) return false;

        const updated = await tx.message.updateMany({
          data: {
            content: json(groundedLiveOnlyMessageContent()),
            groundedAt: input.groundedAt,
            groundingProvider: provider,
            groundingStrategy: strategy
          },
          where: { id: input.assistantMessageId }
        });
        if (updated.count !== 1) return false;

        await tx.modelRunEvent.deleteMany({
          where: {
            eventType: { in: ["artifact", "token"] },
            modelRunId: input.runId
          }
        });
        await tx.modelRun.update({
          data: {
            finalProviderResponsePreview: json(groundedLiveOnlyProviderPreview())
          },
          where: { id: input.runId }
        });
        return true;
      });
    },
    nextRunEventSequence: async (runId) => {
      const aggregate = await prismaClient.modelRunEvent.aggregate({
        _max: {
          sequence: true
        },
        where: {
          modelRunId: runId
        }
      });

      return (aggregate._max.sequence ?? -1) + 1;
    },
    updateRunProviderResponseId: async (runId, providerResponseId) => {
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, { runId });
        if (!run) return "terminal" as const;
        if (run.status === "cancelled") return "cancelled" as const;
        if (!activeToolLoopRun(run)) return "terminal" as const;

        await tx.modelRun.update({
          data: { providerResponseId },
          where: { id: runId }
        });
        return "published" as const;
      });
    },
    updateRunProviderRequestPreview: async (runId, providerRequestPreview) => {
      await prismaClient.modelRun.update({
        data: {
          providerRequestPreview: json(providerRequestPreview)
        },
        where: {
          id: runId
        }
      });
    },
    updateCancelledRunProviderPreview: async (input) => {
      const preview = JSON.stringify(input.providerCancelPreview);
      const updated = await prismaClient.$executeRaw`
        UPDATE "ModelRun"
        SET
          "errorPayload" = COALESCE("errorPayload", '{}'::jsonb) ||
            jsonb_build_object('providerCancelPreview', ${preview}::jsonb),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.runId}
          AND "userId" = ${input.userId}
          AND "status" = 'cancelled'::"ModelRunStatus"
      `;

      return updated === 1;
    }
  };
}
