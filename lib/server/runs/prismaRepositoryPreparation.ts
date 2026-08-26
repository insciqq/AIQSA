import { randomUUID } from "node:crypto";
import {
  Prisma,
  type ModelRunStatus,
  type PrismaClient
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { titleFromMessageContent } from "../chats/titlePolicy";
import {
  ProviderAdmissionError,
  loadProviderAdmissionPlan,
  sameProviderAdmissionPlan,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import type {
  MemoryRunControlCache,
  MemoryRunRetrievalService
} from "../memory/retrieval";
import {
  boundedMemoryAdmissionDeadlineMs,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
} from "../memory/admissionDeadline";
import {
  assertMemoryExecutionBindingLineage,
  MEMORY_EXECUTION_RECOVERY_HORIZON_MS,
  memoryExecutionBindingSelect,
  parseMemoryExecutionSnapshot,
  reauthorizeStoredMemoryExecution,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionBindingRecord,
  type MemorySecretFreeExecutionSnapshot
} from "../memory/execution";
import { resolveMemoryEgressConsentMode } from "../memory/execution/consentMode";
import {
  decodeMemoryActionAnswerResult,
  MEMORY_ACTION_NO_COMMIT_RESULT
} from "../providers/memoryActionAnswer";
import {
  decodeMemoryReadOnlyControlReuseProof,
  type MemoryReadOnlyControlReuseProof
} from "../memory/actions/controlRuntime";
import {
  decodeMemoryActionLifecycleSnapshot,
  memoryActionLifecycleBudgetSnapshot
} from "../memory/actions/lifecycleSnapshot";
import {
  lockMemorySettings,
  type LockedMemorySettings
} from "../memory/persistence/transaction";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat,
  MemorySourceStateConflictError,
  type LockedMemorySourceChat,
  type MemorySourceMutationHooks,
  type MemorySourceSnapshot
} from "../memory/sourceState";
import {
  scheduleTemporaryChatDeletion,
  temporaryRetentionDeadline
} from "../memory/temporaryRetention";
import { MEMORY_DECAY_POLICY_VERSION } from "../../domain/memory/retrieval";
import { scheduleMemoryDecayTouch } from "../memory/retrieval/decayTouch";
import {
  decodeMemoryActionFeedback,
  decodeMemoryInitialChatMode,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
} from "../../contracts/memory";
import type { McpRunPlanBinding } from "../mcp/runPlan";
import {
  KnowledgeRunAdmissionError,
  loadKnowledgeRunAdmissionPlan,
  sameKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
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
  memoryPreparingSettingsSnapshot,
  memoryPreparingTextHash,
  sameMemoryPreparingSettings,
  validateMemoryPreparingAttemptResult,
  type MemoryPreparingAttemptResult,
  type MemoryPreparingItemInput,
  type MemoryPreparingSettingsSnapshot
} from "./preparingRun";
import {
  resolvePreparingMemoryItem,
  samePreparingMemoryItemSnapshot,
  type ResolvedPreparingMemoryItem
} from "./preparingMemoryItems";
import {
  ActiveLeafConflictError,
  AttachmentLinkConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  SkillRunConflictError,
  type PreparingRunAdmissionInput,
  type PreparingRunAdmissionResult,
  type PreparingRunFinalizationInput,
  type PreparingRunMaterializedRequest,
  type PreparingRunRecoveryResult,
  type ProjectRunAdmission
} from "./runRepositoryContract";
import { resolveProjectAccess } from "../projects/access";
import { notifyProjectEvent } from "../projects/events";
import {
  assertAssistantRunProvenance,
  assertProjectAssistantRunProvenance,
  assertCurrentSkillRunBindings,
  insertAcceptedKnowledgeRunBindings,
  insertAcceptedMcpRunBindings,
  insertAcceptedProviderRunBindings,
  insertAcceptedSkillRunBindings,
  lockKnowledgeRunAdmissionSources,
  persistAcceptedRunDefaults,
  repeatableReadTransaction,
  RunTransactionDeadlineError
} from "./prismaRepositoryBindings";
import {
  activeMessageStatuses,
  isRecord,
  json,
  mapActiveRunConflict,
  unique
} from "./prismaRepositoryShared";

type PreparingSettingsRow = MemoryPreparingSettingsSnapshot & LockedMemorySettings;

const MEMORY_PREPARING_ADMISSION_RESERVE_MS = 1_500;
const MEMORY_PREPARING_RETRIEVAL_RESERVE_MS = 1_500;
const MEMORY_PREPARING_COMPLETION_RESERVE_MS = 1_200;
const MEMORY_PREPARING_FINALIZATION_RESERVE_MS = 1_000;

function attachmentLinkReadinessWhere(
  input: PreparingRunAdmissionInput
): Prisma.AttachmentWhereInput {
  if (!input.normalizedRequest.modelCapabilities.nativePdfInput) {
    return { status: "ready" };
  }

  return {
    OR: [
      { status: "ready" },
      {
        kind: "pdf",
        status: { in: ["processing", "failed"] }
      }
    ]
  };
}

type LockedPreparingAttempt = Readonly<{
  acceptedUtilityEgressFingerprint: string | null;
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
  chatMemoryModeSnapshot: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  degradationCode: string | null;
  expiresAt: Date;
  externalRolesUsed: string[];
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
  utilityEgressMode: "CONSENTED_EXTERNAL" | "LOCAL_ONLY";
}>;

const TEMPORARY_PREPARING_SETTINGS: PreparingSettingsRow = Object.freeze({
  acceptedUtilityEgressAt: null,
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  decayEnabled: false,
  decayPolicyVersion: null,
  embeddingProviderModelId: null,
  learnAutomatically: false,
  memoryConsentRevision: 0,
  memoryGeneration: 0,
  memoryRevision: 0,
  referenceChatHistory: false,
  schemaVersion: 2,
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
  settingsRevision: 0,
  synthesisEnabled: false,
  synthesisEnabledAt: null,
  synthesisPolicyVersion: null,
  lastSynthesisAt: null,
  useMemoryFacts: false,
  userId: "temporary"
});

export type LockedPreparingRun = Readonly<{
  assistantId: string | null;
  assistantMessageId: string | null;
  assistantRevisionId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  normalizedRequest: Prisma.JsonValue | null;
  provider: string;
  status: ModelRunStatus;
  userId: string;
  userMessageId: string;
}>;

async function loadPreparingSettings(
  tx: Prisma.TransactionClient,
  userId: string,
  lock = false
): Promise<PreparingSettingsRow> {
  const settings = lock
    ? await lockMemorySettings(tx, userId, true)
    : await tx.userMemorySettings.findUnique({
    select: {
      acceptedUtilityEgressAt: true,
      acceptedUtilityEgressFingerprint: true,
      acceptedUtilityPolicyVersion: true,
      activeIndexGenerationId: true,
      decayEnabled: true,
      decayPolicyVersion: true,
      embeddingProviderModelId: true,
      learnAutomatically: true,
      memoryConsentRevision: true,
      memoryGeneration: true,
      memoryRevision: true,
      referenceChatHistory: true,
      sensitiveAutomaticPolicy: true,
      settingsRevision: true,
      synthesisEnabled: true,
      synthesisEnabledAt: true,
      synthesisPolicyVersion: true,
      lastSynthesisAt: true,
      useMemoryFacts: true,
      userId: true
    },
    where: { userId }
  });
  if (!settings) {
    throw new MemoryPreparingRunConflictError("memory_owner_unavailable", false);
  }
  return {
    ...settings,
    ...memoryPreparingSettingsSnapshot(settings)
  };
}

export async function lockPreparingRun(
  tx: Prisma.TransactionClient,
  runId: string,
  userId: string
): Promise<LockedPreparingRun | null> {
  const [run] = await tx.$queryRaw<LockedPreparingRun[]>(Prisma.sql`
    SELECT
      "assistantId", "assistantMessageId", "assistantRevisionId", "chatId", "id",
      "modelId", "normalizedRequest", "provider",
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
      "acceptedUtilityEgressFingerprint", "admittedAssistantLeafMessageId",
      "admittedUserMessageId",
      "admissionKind"::text AS "admissionKind", "assistantIdSnapshot",
      "attemptOrdinal",
      "baseRequestHash", "boundedPrivateBaseRequestSnapshot",
      "boundedSafeQuerySnapshot", "budgetSnapshot", "chatId", "degradationCode",
      "expiresAt", "externalRolesUsed", "folderIdSnapshot",
      "id", "indexGenerationIdSnapshot", "memoryGenerationSnapshot",
      "modelRunId", "outcome"::text AS "outcome", "preSendActiveLeafMessageId",
      "preparedContextHash", "preparedContextText", "preparedContextTokenCount",
      "queryHash", "retrievalRevisionSnapshot", "settingsSnapshot",
      "chatMemoryModeSnapshot"::text AS "chatMemoryModeSnapshot",
      "state"::text AS "state", "userId",
      "utilityEgressMode"::text AS "utilityEgressMode"
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

function preparingAttemptCarriesProviderContext(
  attempt: Pick<LockedPreparingAttempt, "outcome">
): boolean {
  return attempt.outcome === "USED" || attempt.outcome === "DEGRADED";
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
    chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
    folderIdSnapshot: string | null;
    lifecycleSnapshot: Pick<
      MemorySourceSnapshot,
      "activeLeafMessageId" | "memoryBranchGeneration" | "memorySourceRevision"
    >;
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
      budgetSnapshot: json(memoryActionLifecycleBudgetSnapshot({
        activeLeafMessageId: input.lifecycleSnapshot.activeLeafMessageId!,
        branchGeneration: input.lifecycleSnapshot.memoryBranchGeneration,
        sourceRevision: input.lifecycleSnapshot.memorySourceRevision
      })),
      chatId: input.chatId,
      chatMemoryModeSnapshot: input.chatMemoryMode,
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

type TemporaryPreparingRunAdmissionInput = Readonly<{
  assistantMessageId: string;
  chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  folderId: string | null;
  memoryGeneration: number;
  memoryRevision: number;
  normalizedRequest: PreparingRunAdmissionInput["normalizedRequest"];
  runId: string;
  settingsSnapshot: MemoryPreparingSettingsSnapshot;
  userMessageId: string;
}>;

/**
 * Temporary Chat bypasses the Personal Memory preparation ledger entirely.
 * The ordinary run is made dispatchable in the admission transaction, while
 * no Memory attempt/binding receives the content-bearing base request.
 */
export async function finalizeTemporaryPreparingRunAdmission(
  tx: Pick<Prisma.TransactionClient, "modelRun">,
  input: TemporaryPreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult | null> {
  if (input.chatMemoryMode !== "TEMPORARY") return null;
  await tx.modelRun.update({
    data: {
      normalizedRequest: json(input.normalizedRequest),
      status: "streaming"
    },
    where: { id: input.runId }
  });
  return {
    assistantMessageId: input.assistantMessageId,
    attemptId: "",
    chatMemoryMode: input.chatMemoryMode,
    folderId: input.folderId,
    memoryGeneration: input.memoryGeneration,
    memoryRevision: input.memoryRevision,
    runId: input.runId,
    settingsSnapshot: input.settingsSnapshot,
    userMessageId: input.userMessageId
  };
}

type UnavailablePreparingRunAdmissionInput = Readonly<{
  admissionKind: "NORMAL_SEND" | "REGENERATE";
  assistantIdSnapshot: string | null;
  assistantMessageId: string;
  baseSnapshot: ReturnType<typeof createMemoryPreparingBaseSnapshot>;
  chatId: string;
  chatMemoryMode: "NORMAL" | "EXCLUDED";
  folderId: string | null;
  lifecycleSnapshot: Pick<
    MemorySourceSnapshot,
    "activeLeafMessageId" | "memoryBranchGeneration" | "memorySourceRevision"
  >;
  normalizedRequest: PreparingRunAdmissionInput["normalizedRequest"];
  now: Date;
  preSendActiveLeafMessageId: string | null;
  runId: string;
  userId: string;
  userMessageId: string;
}>;

/**
 * If the bounded Memory-specific portion of initial admission cannot finish,
 * admit the ordinary run with a durable, content-free FAILED_SAFE receipt.
 * This path deliberately avoids UserMemorySettings and index reads while the
 * surrounding admission transaction still proves the ordinary run, DAG,
 * attachment, provider, Knowledge, MCP, and Skill authorities.
 */
export async function finalizeUnavailablePreparingRunAdmission(
  tx: Prisma.TransactionClient,
  input: UnavailablePreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult> {
  const settingsSnapshot = memoryPreparingSettingsSnapshot(
    TEMPORARY_PREPARING_SETTINGS
  );
  const attemptId = await createPreparingAttempt(tx, {
    admissionKind: input.admissionKind,
    assistantIdSnapshot: input.assistantIdSnapshot,
    assistantMessageId: input.assistantMessageId,
    attemptOrdinal: 0,
    baseSnapshot: input.baseSnapshot,
    chatId: input.chatId,
    chatMemoryMode: input.chatMemoryMode,
    folderIdSnapshot: input.folderId,
    lifecycleSnapshot: input.lifecycleSnapshot,
    now: input.now,
    preSendActiveLeafMessageId: input.preSendActiveLeafMessageId,
    runId: input.runId,
    settings: TEMPORARY_PREPARING_SETTINGS,
    userId: input.userId,
    userMessageId: input.userMessageId
  });
  const budgetSnapshot = {
    ...memoryActionLifecycleBudgetSnapshot({
      activeLeafMessageId: input.lifecycleSnapshot.activeLeafMessageId!,
      branchGeneration: input.lifecycleSnapshot.memoryBranchGeneration,
      sourceRevision: input.lifecycleSnapshot.memorySourceRevision
    }),
    itemCount: 0,
    memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
    reason: "memory_admission_deadline_exceeded",
    schemaVersion: 2
  };
  await tx.memoryRetrievalAttempt.update({
    data: {
      budgetSnapshot: json(budgetSnapshot),
      consumedAt: input.now,
      degradationCode: "memory_admission_deadline_exceeded",
      outcome: "FAILED_SAFE",
      state: "CONSUMED",
      updatedAt: input.now
    },
    where: { id: attemptId }
  });
  await tx.modelRunMemoryBinding.create({
    data: {
      boundedSafeQuerySnapshot: null,
      contextTextHash: memoryPreparingTextHash(""),
      contextTokenCount: 0,
      degradationCode: "memory_admission_deadline_exceeded",
      finalizedAt: input.now,
      finalizedRevisionSnapshot: 0,
      indexGenerationId: null,
      memoryGenerationSnapshot: 0,
      modelRunId: input.runId,
      outcome: "FAILED_SAFE",
      queryHash: memoryPreparingTextHash(""),
      queryPlannerVersion: MEMORY_PREPARING_QUERY_PLANNER_VERSION,
      retrievalAttemptId: attemptId,
      retrievalPipelineVersion: MEMORY_PREPARING_RETRIEVAL_PIPELINE_VERSION,
      retrievalRevisionSnapshot: 0,
      settingsSnapshot: json(settingsSnapshot),
      userId: input.userId
    }
  });
  await tx.modelRun.update({
    data: {
      normalizedRequest: json(input.normalizedRequest),
      status: "streaming"
    },
    where: { id: input.runId }
  });
  return {
    assistantMessageId: input.assistantMessageId,
    attemptId,
    chatMemoryMode: input.chatMemoryMode,
    folderId: input.folderId,
    memoryGeneration: 0,
    memoryRevision: 0,
    runId: input.runId,
    settingsSnapshot,
    userMessageId: input.userMessageId
  };
}

function assertPreparingAdmissionInput(input: PreparingRunAdmissionInput): void {
  const initialMode = "initialChatMode" in input ? input.initialChatMode : undefined;
  const requestSkills = input.normalizedRequest.skills ?? [];
  const skillBindings = input.skillBindings ?? [];
  if (requestSkills.length !== skillBindings.length || requestSkills.some((skill, index) =>
    skill.skillId !== skillBindings[index]?.skillId ||
    skill.revisionId !== skillBindings[index]?.revisionId)) {
    throw new SkillRunConflictError();
  }
  if (initialMode !== undefined && !decodeMemoryInitialChatMode(initialMode).ok) {
    throw new MemoryPreparingRunConflictError(
      "memory_temporary_policy_review_required",
      false
    );
  }
  if (
    input.normalizedRequest.chatId !== input.chatId ||
    input.normalizedRequest.modelId !== input.modelId ||
    input.normalizedRequest.provider !== input.provider ||
    input.normalizedRequest.personalContext !== undefined ||
    input.normalizedRequest.memoryActionTools !== undefined ||
    input.normalizedRequest.memoryHistoryTool !== undefined ||
    (input.admissionKind === "REGENERATE" && initialMode !== undefined) ||
    (input.admissionKind === "NORMAL_SEND" &&
      memoryPreparingHash(input.normalizedRequest.content) !== memoryPreparingHash(input.content))
  ) {
    throw new MemoryPreparingRunConflictError("memory_base_request_invalid", false);
  }
}

/**
 * Project runs deliberately bypass the personal Memory preparing pipeline.
 * Admission is still transactional: the project revisions, membership, DAG
 * leaf, attachments, provider bindings, and immutable ProjectRunBinding are
 * fenced before any provider request is allowed to start.
 */
export async function admitProjectRunWithClient(
  prismaClient: PrismaClient,
  input: PreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult> {
  if (!input.project) throw new Error("project_admission_context_required");
  assertPreparingAdmissionInput(input);
  const project = input.project;
  const result = await mapActiveRunConflict(() =>
    repeatableReadTransaction(prismaClient, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Project"
        WHERE "id" = ${project.projectId}
        FOR UPDATE
      `);
      const access = await resolveProjectAccess(tx, {
        minimumRole: "CONTRIBUTOR",
        projectId: project.projectId,
        requireActive: true,
        userId: input.userId
      });
      if (!access || access.accessRevision !== project.accessRevision) {
        throw new ActiveLeafConflictError();
      }
      const currentProject = await tx.project.findUnique({
        select: {
          accessRevision: true,
          instructionsRevision: true,
          memoryRevision: true,
          policyRevision: true,
          status: true
        },
        where: { id: project.projectId }
      });
      if (!currentProject || currentProject.status !== "ACTIVE" ||
        currentProject.accessRevision !== project.accessRevision ||
        currentProject.instructionsRevision !== project.instructionsRevision ||
        currentProject.policyRevision !== project.policyRevision ||
        currentProject.memoryRevision !== project.memoryRevision) {
        throw new ActiveLeafConflictError();
      }
      if (input.assistant) {
        await assertProjectAssistantRunProvenance(tx, {
          assistantId: input.assistant.assistantId,
          projectId: project.projectId,
          revisionId: input.assistant.revisionId,
        });
      }
      const firstProjectSend = input.admissionKind === "NORMAL_SEND"
        ? input.projectChat
        : undefined;
      if (firstProjectSend && input.admissionKind === "NORMAL_SEND") {
        if (input.expectedActiveLeafId !== null ||
          (firstProjectSend.folderId && !(await tx.projectFolder.findUnique({
            select: { id: true },
            where: {
              projectId_id: {
                id: firstProjectSend.folderId,
                projectId: project.projectId
              }
            }
          })))) {
          throw new ActiveLeafConflictError();
        }
        const creator = await tx.user.findUnique({
          select: { displayName: true },
          where: { id: input.userId }
        });
        if (!creator || !project.defaults.providerModelId ||
          !project.modelIds.includes(project.defaults.providerModelId)) {
          throw new ActiveLeafConflictError();
        }
        await tx.chat.create({
          data: {
            createdByDisplayName: creator.displayName,
            createdByUserId: input.userId,
            defaultKnowledgePlan: json(project.defaults.knowledgePlan),
            defaultProviderModelId: project.defaults.providerModelId,
            id: input.chatId,
            memoryMode: "EXCLUDED",
            projectFolderId: firstProjectSend.folderId,
            projectId: project.projectId,
            title: "New Chat",
            userId: null
          }
        });
        await tx.projectAuditEvent.create({
          data: {
            actorDisplayName: creator.displayName,
            actorUserId: input.userId,
            eventType: "project_chat_created",
            metadata: { chatId: input.chatId },
            projectId: project.projectId
          }
        });
      }
      const lockedChats = await tx.$queryRaw<Array<{
        activeLeafMessageId: string | null;
        archived: boolean;
        id: string;
        projectFolderId: string | null;
        projectId: string | null;
      }>>(Prisma.sql`
        SELECT "id", "projectId", "projectFolderId", "activeLeafMessageId", "archived"
        FROM "Chat"
        WHERE "id" = ${input.chatId}
          AND "projectId" = ${project.projectId}
          AND "userId" IS NULL
          AND "memoryMode" = 'EXCLUDED'::"MemoryChatMode"
          AND "permanentDeletionAt" IS NULL
        FOR UPDATE
      `);
      const lockedChat = lockedChats[0];
      if (!lockedChat || lockedChat.archived) throw new ActiveLeafConflictError();

      let assistantMessageId: string;
      let userMessageId: string;
      if (input.admissionKind === "NORMAL_SEND") {
        if (lockedChat.activeLeafMessageId !== input.expectedActiveLeafId) {
          throw new ActiveLeafConflictError();
        }
        const count = await tx.message.count({ where: { chatId: input.chatId } });
        const user = await tx.user.findUnique({ select: { displayName: true }, where: { id: input.userId } });
        if (!user) throw new ActiveLeafConflictError();
        const userMessage = await tx.message.create({
          data: {
            authorDisplayName: user.displayName,
            authorProjectRole: access.effectiveRole,
            authorUserId: input.userId,
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
          const linked = await tx.attachment.updateMany({
            data: { chatId: input.chatId, messageId: userMessage.id },
            where: {
              ...attachmentLinkReadinessWhere(input),
              chatId: null,
              id: { in: attachmentIds },
              messageId: null,
              projectId: project.projectId
            }
          });
          if (linked.count !== attachmentIds.length) throw new AttachmentLinkConflictError();
        }
        assistantMessageId = assistantMessage.id;
        userMessageId = userMessage.id;
        await tx.chat.update({
          data: { activeLeafMessageId: assistantMessage.id },
          where: { id: input.chatId }
        });
        if (count === 0) {
          await tx.chat.updateMany({
            data: { title: titleFromMessageContent(input.content) },
            where: { id: input.chatId, title: { in: ["New Chat", "Untitled QSA"] } }
          });
        }
      } else {
        const sourceLeaf = input.preSendAssistantMessageId ?? input.userMessageId;
        if (!sourceLeaf || lockedChat.activeLeafMessageId !== sourceLeaf) {
          throw new ActiveLeafConflictError();
        }
        const source = await tx.message.findFirst({
          select: { parentMessageId: true, role: true },
          where: { chatId: input.chatId, id: sourceLeaf }
        });
        if (!source || (input.preSendAssistantMessageId && source.role !== "assistant")) {
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
        userMessageId = input.userMessageId;
        await tx.chat.update({
          data: { activeLeafMessageId: assistantMessage.id },
          where: { id: input.chatId }
        });
      }

      await assertCurrentProviderAdmission(tx, { plan: input.providerAdmissionPlan, userId: input.userId });
      await assertCurrentKnowledgeAdmission(tx, { plan: input.knowledgeAdmissionPlan, userId: input.userId });
      if (input.mcpBindings?.some((binding) => !project.mcpServerIds.includes(binding.serverId))) {
        throw new McpRunPlanConflictError();
      }
      if (!project.policy.externalToolsEnabled && input.mcpBindings?.length) {
        throw new McpRunPlanConflictError();
      }
      if (input.mcpBindings?.length) {
        const forbiddenCredentials = await tx.mcpRuntimeGeneration.count({
          where: {
            id: { in: input.mcpBindings.map((binding) => binding.runtimeGenerationId) },
            OR: [
              { credentialSources: { hasSome: ["oauth", "personal"] } },
              { oauthConnectionId: { not: null } },
              { userServer: { personalConfigEnvelope: { not: null } } }
            ]
          }
        });
        if (forbiddenCredentials > 0) throw new McpRunPlanConflictError();
      }
      if (input.skillBindings?.some((binding) => !project.skillIds?.includes(binding.skillId))) {
        throw new SkillRunConflictError();
      }
      if (!input.providerAdmissionPlan) {
        throw new ProviderAdmissionConflictError();
      }
      const run = await tx.modelRun.create({
        data: {
          assistantMessageId,
          ...(input.assistant
            ? { assistantId: input.assistant.assistantId, assistantRevisionId: input.assistant.revisionId }
            : {}),
          chatId: input.chatId,
          modelId: input.modelId,
          normalizedRequest: json(input.normalizedRequest),
          provider: input.provider,
          status: "streaming",
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
        projectId: project.projectId,
        runId: run.id,
        userId: input.userId
      });
      await insertAcceptedProviderRunBindings(tx, {
        nativeBackgroundRequested: input.normalizedRequest.params.background === true,
        plan: input.providerAdmissionPlan,
        runId: run.id,
        userId: input.userId
      });
      await insertAcceptedSkillRunBindings(tx, {
        bindings: input.skillBindings,
        projectId: project.projectId,
        runId: run.id,
        userId: input.userId
      });
      await tx.projectRunBinding.create({
        data: {
          accessRevision: project.accessRevision,
          acceptedRole: access.effectiveRole,
          initiatorUserId: input.userId,
          instructionsRevision: project.instructionsRevision,
          memoryRevision: project.memoryRevision,
          modelRunId: run.id,
          personalMemoryDisabled: true,
          policyRevision: project.policyRevision,
          projectId: project.projectId,
          providerAdmissionFingerprint: input.providerAdmissionPlan.fingerprint,
          providerConnectionId: input.providerAdmissionPlan.selection.providerConnectionId,
          providerModelId: input.providerAdmissionPlan.selection.providerModelId,
          providerRequiresClientTools:
            input.providerAdmissionPlan.requiresClientToolCoexistence === true,
          providerSearchPlan: json(input.providerAdmissionPlan.requestedSearchPlan),
          sharedCredentialVersionIds: [...new Set([
            input.providerAdmissionPlan?.answer.snapshot.credentialVersionId,
            ...(input.providerAdmissionPlan?.searches.flatMap((search) =>
              search.role?.snapshot.credentialVersionId ? [search.role.snapshot.credentialVersionId] : []) ?? []),
            ...(input.knowledgeAdmissionPlan?.bindings.flatMap((binding) =>
              binding.embeddingExecutionSnapshot.credentialVersionId
                ? [binding.embeddingExecutionSnapshot.credentialVersionId]
                : []) ?? [])
          ].filter((value): value is string => Boolean(value)))]
        }
      });
      // Project Memory is intentionally dormant for Personal Memory v1.
      // Existing facts and run-item rows remain intact for compatibility, but
      // new Project runs neither read their text nor create run-item bindings.
      return {
        assistantMessageId,
        attemptId: "",
        chatMemoryMode: "EXCLUDED" as const,
        folderId: lockedChat.projectFolderId,
        memoryGeneration: 0,
        memoryRevision: project.memoryRevision,
        runId: run.id,
        settingsSnapshot: memoryPreparingSettingsSnapshot(TEMPORARY_PREPARING_SETTINGS),
        userMessageId
      };
    })
  );
  notifyProjectEvent(project.projectId);
  return result;
}

export async function admitPreparingRunWithClient(
  prismaClient: PrismaClient,
  input: PreparingRunAdmissionInput,
  memorySourceHooks?: MemorySourceMutationHooks,
  options: Readonly<{
    deadlineAtMs?: number;
    memoryUnavailableFallback?: boolean;
  }> = {}
): Promise<PreparingRunAdmissionResult> {
  assertPreparingAdmissionInput(input);
  const baseSnapshot = createMemoryPreparingBaseSnapshot({
    normalizedRequest: input.normalizedRequest,
    providerRequestPreview: input.providerRequestPreview
  });
  return mapActiveRunConflict(() =>
    repeatableReadTransaction(prismaClient, async (tx) => {
      const admissionNow = new Date();
      const lockedChats = await tx.$queryRaw<LockedMemorySourceChat[]>(Prisma.sql`
        SELECT
          "id", "userId", "activeLeafMessageId", "archived", "folderId",
          "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
          "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline"
        FROM "Chat"
        WHERE "id" = ${input.chatId}
          AND "userId" = ${input.userId}
          AND "permanentDeletionAt" IS NULL
        FOR UPDATE
      `);
      let lockedChat = lockedChats[0];
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

      let assistantMessageId: string;
      let admittedSourceSnapshot: MemorySourceSnapshot;
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
            permanentDeletionAt: null,
            userId: input.userId
          }
        });
        if (!chat) throw new ActiveLeafConflictError();

        const initialChatMode = input.initialChatMode;
        if (initialChatMode) {
          const requestedMode = initialChatMode.chatMode;
          const firstSend = chat._count.messages === 0;
          if (
            requestedMode !== lockedChat.memoryMode &&
            !(requestedMode === "TEMPORARY" &&
              lockedChat.memoryMode === "NORMAL" && firstSend)
          ) {
            throw new MemoryPreparingRunConflictError(
              "memory_temporary_chat_forbidden",
              false
            );
          }
        }

        const convertToTemporary = initialChatMode?.chatMode === "TEMPORARY" &&
          lockedChat.memoryMode === "NORMAL" && chat._count.messages === 0;
        const temporaryAdmission = lockedChat.memoryMode === "TEMPORARY" ||
          convertToTemporary;
        if (temporaryAdmission) {
          if (
            !convertToTemporary &&
            lockedChat.temporaryRetentionDeadline &&
            lockedChat.temporaryRetentionDeadline <= admissionNow
          ) {
            throw new MemoryPreparingRunConflictError(
              "memory_temporary_chat_expired",
              false
            );
          }
          const deadline = temporaryRetentionDeadline(admissionNow);
          if (convertToTemporary) {
            await tx.chat.update({
              data: {
                memoryMode: "TEMPORARY",
                temporaryRetentionDeadline: deadline,
                temporaryRetentionPolicyVersion:
                  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
              },
              where: { id: input.chatId }
            });
          } else {
            await tx.chat.update({
              data: { temporaryRetentionDeadline: deadline },
              where: { id: input.chatId }
            });
          }
          try {
            await scheduleTemporaryChatDeletion(tx, {
              chatId: input.chatId,
              deadline,
              now: admissionNow,
              userId: input.userId
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "memory_temporary_deletion_already_claimed"
            ) {
              throw new MemoryPreparingRunConflictError(
                "memory_temporary_chat_expired",
                false
              );
            }
            throw error;
          }
          lockedChat = {
            ...lockedChat,
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: deadline,
            temporaryRetentionPolicyVersion:
              MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
          };
        }

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
              ...attachmentLinkReadinessWhere(input),
              chatId: null,
              id: { in: attachmentIds },
              messageId: null,
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

        admittedSourceSnapshot = await applyMemorySourceMutations(tx, {
          chat: lockedChat,
          hooks: memorySourceHooks,
          mutations: ["NORMAL_APPEND"],
          patch: { activeLeafMessageId: assistantMessage.id }
        });
        if (chat._count.messages === 0 && input.defaults) {
          await tx.chat.update({
            data: { defaultProviderModelId: input.defaults.modelId },
            where: { id: input.chatId }
          });
        }
        if (chat._count.messages === 0) {
          await tx.chat.updateMany({
            data: { title: titleFromMessageContent(input.content) },
            where: {
              archived: false,
              id: input.chatId,
              permanentDeletionAt: null,
              title: { in: ["New Chat", "Untitled QSA"] },
              userId: input.userId
            }
          });
        }
      } else {
        if (lockedChat.memoryMode === "TEMPORARY") {
          if (
            lockedChat.temporaryRetentionDeadline &&
            lockedChat.temporaryRetentionDeadline <= admissionNow
          ) {
            throw new MemoryPreparingRunConflictError(
              "memory_temporary_chat_expired",
              false
            );
          }
          const deadline = temporaryRetentionDeadline(admissionNow);
          await tx.chat.update({
            data: { temporaryRetentionDeadline: deadline },
            where: { id: input.chatId }
          });
          try {
            await scheduleTemporaryChatDeletion(tx, {
              chatId: input.chatId,
              deadline,
              now: admissionNow,
              userId: input.userId
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "memory_temporary_deletion_already_claimed"
            ) {
              throw new MemoryPreparingRunConflictError(
                "memory_temporary_chat_expired",
                false
              );
            }
            throw error;
          }
          lockedChat = { ...lockedChat, temporaryRetentionDeadline: deadline };
        }
        const userLeafWithoutAssistant = input.preSendAssistantMessageId === null;
        const preSendSourceMessageId = userLeafWithoutAssistant
          ? input.userMessageId
          : input.preSendAssistantMessageId;
        if (!preSendSourceMessageId ||
          lockedChat.activeLeafMessageId !== preSendSourceMessageId) {
          throw new ActiveLeafConflictError();
        }
        if (userLeafWithoutAssistant) {
          const [sourceUser] = await tx.$queryRaw<Array<{
            userContent: Prisma.JsonValue;
            userRole: string;
          }>>(Prisma.sql`
            SELECT
              user_message."content" AS "userContent",
              user_message."role" AS "userRole"
            FROM "Message" AS user_message
            WHERE user_message."chatId" = ${input.chatId}
              AND user_message."id" = ${input.userMessageId}
            FOR SHARE OF user_message
          `);
          if (!sourceUser || sourceUser.userRole !== "user" ||
            memoryPreparingHash(sourceUser.userContent) !==
              memoryPreparingHash(input.normalizedRequest.content)) {
            throw new ActiveLeafConflictError();
          }
        } else {
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
              AND assistant."id" = ${preSendSourceMessageId}
            FOR SHARE OF assistant, user_message
          `);
          if (!source || source.assistantRole !== "assistant" || source.userRole !== "user" ||
            source.assistantParentId !== input.userMessageId ||
            memoryPreparingHash(source.userContent) !==
              memoryPreparingHash(input.normalizedRequest.content)) {
            throw new ActiveLeafConflictError();
          }
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
        preSendActiveLeafMessageId = preSendSourceMessageId;
        userMessageId = input.userMessageId;
        admittedSourceSnapshot = await applyMemorySourceMutations(tx, {
          chat: lockedChat,
          hooks: memorySourceHooks,
          mutations: ["BRANCH_PATH_CHANGE"],
          patch: { activeLeafMessageId: assistantMessage.id }
        });
      }

      const settings = lockedChat.memoryMode === "TEMPORARY" ||
          options.memoryUnavailableFallback
        ? TEMPORARY_PREPARING_SETTINGS
        : await loadPreparingSettings(tx, input.userId);

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
      await insertAcceptedSkillRunBindings(tx, {
        bindings: input.skillBindings,
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

      const temporaryResult = await finalizeTemporaryPreparingRunAdmission(tx, {
        assistantMessageId,
        chatMemoryMode: lockedChat.memoryMode,
        folderId: lockedChat.folderId,
        memoryGeneration: settings.memoryGeneration,
        memoryRevision: settings.memoryRevision,
        normalizedRequest: input.normalizedRequest,
        runId: run.id,
        settingsSnapshot: memoryPreparingSettingsSnapshot(settings),
        userMessageId
      });
      if (temporaryResult) return temporaryResult;

      if (options.memoryUnavailableFallback &&
        lockedChat.memoryMode !== "TEMPORARY") {
        return finalizeUnavailablePreparingRunAdmission(tx, {
          admissionKind: input.admissionKind,
          assistantIdSnapshot: input.assistant?.assistantId ?? null,
          assistantMessageId,
          baseSnapshot,
          chatId: input.chatId,
          chatMemoryMode: lockedChat.memoryMode,
          folderId: lockedChat.folderId,
          lifecycleSnapshot: admittedSourceSnapshot,
          normalizedRequest: input.normalizedRequest,
          now: admissionNow,
          preSendActiveLeafMessageId,
          runId: run.id,
          userId: input.userId,
          userMessageId
        });
      }

      const attemptId = await createPreparingAttempt(tx, {
        admissionKind: input.admissionKind,
        assistantIdSnapshot: input.assistant?.assistantId ?? null,
        assistantMessageId,
        attemptOrdinal: 0,
        baseSnapshot,
        chatId: input.chatId,
        chatMemoryMode: lockedChat.memoryMode,
        folderIdSnapshot: lockedChat.folderId,
        lifecycleSnapshot: admittedSourceSnapshot,
        now: admissionNow,
        preSendActiveLeafMessageId,
        runId: run.id,
        settings,
        userId: input.userId,
        userMessageId
      });

      return {
        assistantMessageId,
        attemptId,
        chatMemoryMode: lockedChat.memoryMode,
        folderId: lockedChat.folderId,
        memoryGeneration: settings.memoryGeneration,
        memoryRevision: settings.memoryRevision,
        runId: run.id,
        settingsSnapshot: memoryPreparingSettingsSnapshot(settings),
        userMessageId
      };
    }, options)
  );
}

export async function beginPreparingRunAttemptWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{
    attemptId: string;
    deadlineAtMs?: number;
    now: Date;
    runId: string;
    userId: string;
  }>
): Promise<boolean> {
  return repeatableReadTransaction(prismaClient, async (tx) => {
    const updated = await tx.memoryRetrievalAttempt.updateMany({
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
  }, { deadlineAtMs: input.deadlineAtMs });
}

async function lockMemoryAttemptTargets(
  tx: Prisma.TransactionClient,
  attempt: Pick<LockedPreparingAttempt, "assistantIdSnapshot" | "chatId" | "folderIdSnapshot" | "userId">
): Promise<void> {
  if (attempt.folderIdSnapshot) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Folder"
      WHERE "id" = ${attempt.folderIdSnapshot} AND "userId" = ${attempt.userId}
      FOR SHARE
    `);
    if (!rows[0]) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
  }
  const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Chat"
    WHERE "id" = ${attempt.chatId}
      AND "userId" = ${attempt.userId}
      AND "memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
      AND "permanentDeletionAt" IS NULL
    FOR SHARE
  `);
  if (!chats[0]) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  if (attempt.assistantIdSnapshot) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "AssistantDefinition"
      WHERE "id" = ${attempt.assistantIdSnapshot}
        AND "ownerUserId" = ${attempt.userId}
        AND "archivedAt" IS NULL
      FOR SHARE
    `);
    if (!rows[0]) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
  }
}

const retrievalExecutionRoles = new Set([
  "MEMORY_CONTROL",
  "MEMORY_QUERY_EMBED",
  "MEMORY_RERANK"
]);

const retrievalExecutionOrdinals = new Map<string, ReadonlySet<number>>([
  ["MEMORY_CONTROL", new Set([0, 1])],
  ["MEMORY_QUERY_EMBED", new Set([1, 3])],
  ["MEMORY_RERANK", new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])]
]);

export function validMemoryRetrievalExecutionSequence(
  bindings: readonly Readonly<{ logicalRole: string; ordinal: number }>[],
  profileRequested = false,
  aggregationRequested = false
): boolean {
  if (profileRequested && aggregationRequested) return false;
  if (bindings.length > (aggregationRequested ? 16 : 6)) return false;
  const positions = bindings.map((binding) =>
    `${binding.logicalRole}:${binding.ordinal}`);
  if (new Set(positions).size !== positions.length || bindings.some((binding) =>
    !retrievalExecutionRoles.has(binding.logicalRole) ||
    !retrievalExecutionOrdinals.get(binding.logicalRole)?.has(binding.ordinal)
  )) return false;
  const present = new Set(positions);
  if (!aggregationRequested && bindings.some((binding) =>
    binding.logicalRole === "MEMORY_RERANK" && binding.ordinal >= 4)) return false;
  if (profileRequested && positions.some((position) =>
    position !== "MEMORY_CONTROL:0" &&
    position !== "MEMORY_RERANK:2" &&
    position !== "MEMORY_RERANK:3")) return false;
  return (
    (!present.has("MEMORY_CONTROL:1") || present.has("MEMORY_CONTROL:0")) &&
    (!present.has("MEMORY_QUERY_EMBED:1") || present.has("MEMORY_CONTROL:0")) &&
    (!present.has("MEMORY_QUERY_EMBED:3") || present.has("MEMORY_CONTROL:0")) &&
    (!present.has("MEMORY_RERANK:2") ||
      (profileRequested
        ? present.has("MEMORY_CONTROL:0")
        : present.has("MEMORY_QUERY_EMBED:1"))) &&
    (!present.has("MEMORY_RERANK:3") || present.has("MEMORY_RERANK:2")) &&
    (!present.has("MEMORY_RERANK:4") || present.has("MEMORY_CONTROL:0")) &&
    (!present.has("MEMORY_RERANK:5") || present.has("MEMORY_RERANK:4")) &&
    (!present.has("MEMORY_RERANK:6") || present.has("MEMORY_CONTROL:0")) &&
    (!present.has("MEMORY_RERANK:7") || present.has("MEMORY_RERANK:6")) &&
    (!present.has("MEMORY_RERANK:8") || present.has("MEMORY_RERANK:2")) &&
    (!present.has("MEMORY_RERANK:9") || present.has("MEMORY_RERANK:8")) &&
    (!present.has("MEMORY_RERANK:10") || present.has("MEMORY_RERANK:6")) &&
    (!present.has("MEMORY_RERANK:11") || present.has("MEMORY_RERANK:10")) &&
    (!present.has("MEMORY_RERANK:12") || present.has("MEMORY_RERANK:10")) &&
    (!present.has("MEMORY_RERANK:13") || present.has("MEMORY_RERANK:12"))
  );
}

function profileInventoryDeclared(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.plan)) return false;
  return value.plan.profileRequested === true;
}

function aggregationInventoryDeclared(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.plan)) return false;
  return value.plan.aggregationRequested === true;
}

export function validMemoryRerankRetrySettlement(
  bindings: readonly Readonly<{
    errorCode: string | null;
    logicalRole: string;
    ordinal: number;
    state: string;
  }>[]
): boolean {
  return [2, 4, 6, 8, 10, 12].every((primaryOrdinal) => {
    const retry = bindings.find((binding) =>
      binding.logicalRole === "MEMORY_RERANK" &&
      binding.ordinal === primaryOrdinal + 1);
    if (!retry) return true;
    const primary = bindings.find((binding) =>
      binding.logicalRole === "MEMORY_RERANK" &&
      binding.ordinal === primaryOrdinal);
    return primary?.state === "FAILED" &&
      primary.errorCode === "memory_run_utility_output_invalid";
  });
}

type PreparingAttemptExecutionEvidence = Readonly<{
  acceptedUtilityEgressFingerprint: string | null;
  externalRolesUsed: readonly string[];
  snapshots: readonly MemorySecretFreeExecutionSnapshot[];
  utilityEgressMode: "CONSENTED_EXTERNAL" | "LOCAL_ONLY";
}>;

type ReadOnlyControlRetryScope = Pick<
  LockedPreparingAttempt,
  | "admissionKind"
  | "admittedAssistantLeafMessageId"
  | "admittedUserMessageId"
  | "assistantIdSnapshot"
  | "attemptOrdinal"
  | "baseRequestHash"
  | "budgetSnapshot"
  | "chatId"
  | "chatMemoryModeSnapshot"
  | "folderIdSnapshot"
  | "id"
  | "indexGenerationIdSnapshot"
  | "memoryGenerationSnapshot"
  | "modelRunId"
  | "preSendActiveLeafMessageId"
  | "settingsSnapshot"
  | "userId"
>;

export function sameMemoryReadOnlyControlRetryScope(
  source: ReadOnlyControlRetryScope,
  current: ReadOnlyControlRetryScope
): boolean {
  const sourceSettings = decodeMemoryPreparingSettingsSnapshot(source.settingsSnapshot);
  const currentSettings = decodeMemoryPreparingSettingsSnapshot(current.settingsSnapshot);
  const sourceLifecycle = decodeMemoryActionLifecycleSnapshot(source.budgetSnapshot);
  const currentLifecycle = decodeMemoryActionLifecycleSnapshot(current.budgetSnapshot);
  return source.id !== current.id &&
    source.attemptOrdinal === 0 &&
    current.attemptOrdinal === 1 &&
    source.userId === current.userId &&
    source.modelRunId === current.modelRunId &&
    source.chatId === current.chatId &&
    source.admissionKind === current.admissionKind &&
    source.admittedAssistantLeafMessageId === current.admittedAssistantLeafMessageId &&
    source.admittedUserMessageId === current.admittedUserMessageId &&
    source.assistantIdSnapshot === current.assistantIdSnapshot &&
    source.folderIdSnapshot === current.folderIdSnapshot &&
    source.chatMemoryModeSnapshot === current.chatMemoryModeSnapshot &&
    source.memoryGenerationSnapshot === current.memoryGenerationSnapshot &&
    source.indexGenerationIdSnapshot === current.indexGenerationIdSnapshot &&
    source.baseRequestHash === current.baseRequestHash &&
    source.preSendActiveLeafMessageId === current.preSendActiveLeafMessageId &&
    sourceSettings !== null &&
    currentSettings !== null &&
    memoryPreparingHash(sourceSettings) === memoryPreparingHash(currentSettings) &&
    sourceLifecycle !== null &&
    currentLifecycle !== null &&
    memoryPreparingHash(sourceLifecycle) === memoryPreparingHash(currentLifecycle);
}

async function loadReadOnlyControlReuseBinding(
  tx: Prisma.TransactionClient,
  attempt: ReadOnlyControlRetryScope,
  proof: MemoryReadOnlyControlReuseProof
): Promise<MemoryExecutionBindingRecord> {
  if (attempt.attemptOrdinal !== 1 || proof.sourceAttemptId === attempt.id) {
    throw new Error("control_reuse_attempt_invalid");
  }
  const [sourceAttempt, sourceBinding] = await Promise.all([
    tx.memoryRetrievalAttempt.findFirst({
      select: {
        admissionKind: true,
        admittedAssistantLeafMessageId: true,
        admittedUserMessageId: true,
        assistantIdSnapshot: true,
        attemptOrdinal: true,
        baseRequestHash: true,
        budgetSnapshot: true,
        chatId: true,
        chatMemoryModeSnapshot: true,
        errorCode: true,
        folderIdSnapshot: true,
        id: true,
        indexGenerationIdSnapshot: true,
        memoryGenerationSnapshot: true,
        modelRunId: true,
        preSendActiveLeafMessageId: true,
        settingsSnapshot: true,
        state: true,
        userId: true
      },
      where: { id: proof.sourceAttemptId, userId: attempt.userId }
    }),
    tx.memoryExecutionBinding.findFirst({
      select: memoryExecutionBindingSelect,
      where: { id: proof.sourceBindingId, userId: attempt.userId }
    })
  ]);
  if (
    !sourceAttempt ||
    sourceAttempt.id !== proof.sourceAttemptId ||
    !sameMemoryReadOnlyControlRetryScope(sourceAttempt, attempt) ||
    sourceAttempt.state !== "STALE" ||
    sourceAttempt.errorCode !== "memory_admission_settings_changed" ||
    !sourceBinding ||
    sourceBinding.ownerType !== "RETRIEVAL_ATTEMPT" ||
    sourceBinding.retrievalAttemptId !== sourceAttempt.id ||
    sourceBinding.userId !== attempt.userId ||
    sourceBinding.logicalRole !== "MEMORY_CONTROL" ||
    sourceBinding.ordinal !== 0 ||
    sourceBinding.state !== "SUCCEEDED" ||
    sourceBinding.inputHash !== proof.inputHash ||
    sourceBinding.acceptedOutputHash !== proof.acceptedOutputHash ||
    sourceBinding.relationsDetachedAt !== null
  ) {
    throw new Error("control_reuse_lineage_invalid");
  }
  return sourceBinding;
}

async function loadPreparingAttemptExecutionEvidence(
  tx: Prisma.TransactionClient,
  attempt: Pick<
    LockedPreparingAttempt,
    | "admissionKind"
    | "admittedAssistantLeafMessageId"
    | "admittedUserMessageId"
    | "assistantIdSnapshot"
    | "attemptOrdinal"
    | "baseRequestHash"
    | "budgetSnapshot"
    | "chatId"
    | "chatMemoryModeSnapshot"
    | "folderIdSnapshot"
    | "id"
    | "indexGenerationIdSnapshot"
    | "memoryGenerationSnapshot"
    | "modelRunId"
    | "preSendActiveLeafMessageId"
    | "settingsSnapshot"
    | "userId"
  >,
  budgetSnapshot: unknown = attempt.budgetSnapshot
): Promise<PreparingAttemptExecutionEvidence> {
  try {
    const budget = isRecord(budgetSnapshot) ? budgetSnapshot : null;
    const rawReuseProof = budget?.readOnlyControlReuse;
    const reuseProof = rawReuseProof === undefined
      ? null
      : decodeMemoryReadOnlyControlReuseProof(rawReuseProof);
    if (rawReuseProof !== undefined && !reuseProof) {
      throw new Error("control_reuse_proof_invalid");
    }
    if (reuseProof) {
      const actionAnswerResult = decodeMemoryActionAnswerResult(
        budget?.memoryActionAnswerResult
      );
      if (
        !actionAnswerResult ||
        memoryPreparingHash(actionAnswerResult) !==
          memoryPreparingHash(MEMORY_ACTION_NO_COMMIT_RESULT) ||
        budget?.memoryActionResult !== undefined
      ) {
        throw new Error("control_reuse_action_evidence_invalid");
      }
    }
    const currentBindings = await tx.memoryExecutionBinding.findMany({
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: memoryExecutionBindingSelect,
      where: {
        ownerType: "RETRIEVAL_ATTEMPT",
        retrievalAttemptId: attempt.id,
        userId: attempt.userId
      }
    });
    let reusedControlBindingId: string | null = null;
    let bindings = currentBindings;
    if (reuseProof) {
      const sourceBinding = await loadReadOnlyControlReuseBinding(
        tx,
        attempt,
        reuseProof
      );
      reusedControlBindingId = sourceBinding.id;
      bindings = [sourceBinding, ...currentBindings]
        .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    }
    if (
      !validMemoryRetrievalExecutionSequence(
        bindings,
        profileInventoryDeclared(budgetSnapshot),
        aggregationInventoryDeclared(budgetSnapshot)
      ) ||
      !validMemoryRerankRetrySettlement(bindings)
    ) {
      throw new Error("binding_count_invalid");
    }
    if (bindings.length === 0) {
      return {
        acceptedUtilityEgressFingerprint: null,
        externalRolesUsed: [],
        snapshots: [],
        utilityEgressMode: "LOCAL_ONLY"
      };
    }
    const snapshots: MemorySecretFreeExecutionSnapshot[] = [];
    const roles: string[] = [];
    const fingerprints = new Set<string>();
    for (const binding of bindings) {
      const bindingAttemptId = binding.id === reusedControlBindingId
        ? reuseProof!.sourceAttemptId
        : attempt.id;
      if (
        binding.ownerType !== "RETRIEVAL_ATTEMPT" ||
        binding.retrievalAttemptId !== bindingAttemptId ||
        binding.userId !== attempt.userId ||
        binding.memoryJobId !== null ||
        binding.modelRunId !== null ||
        binding.modelRunToolCallId !== null ||
        binding.relationsDetachedAt !== null ||
        !retrievalExecutionRoles.has(binding.logicalRole) ||
        !retrievalExecutionOrdinals.get(binding.logicalRole)?.has(binding.ordinal) ||
        (binding.state !== "SUCCEEDED" &&
          binding.state !== "FAILED" &&
          binding.state !== "CANCELLED" &&
          binding.state !== "OUTCOME_UNKNOWN") ||
        binding.completedAt === null ||
        binding.recoverableUntil === null ||
        (binding.state === "SUCCEEDED") !== (binding.acceptedOutputHash !== null)
      ) throw new Error("binding_invalid");
      const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
      assertMemoryExecutionBindingLineage(binding, snapshot);
      snapshots.push(snapshot);
      roles.push(binding.logicalRole);
      fingerprints.add(snapshot.acceptedUtilityEgressFingerprint);
    }
    if (fingerprints.size !== 1) {
      throw new Error("binding_lineage_invalid");
    }
    const usageCount = await tx.usageEvent.count({
      where: {
        memoryExecutionBindingId: { in: bindings.map((binding) => binding.id) },
        userId: attempt.userId
      }
    });
    if (usageCount !== bindings.length) throw new Error("binding_usage_invalid");
    return {
      acceptedUtilityEgressFingerprint: [...fingerprints][0]!,
      externalRolesUsed: roles,
      snapshots,
      utilityEgressMode: "CONSENTED_EXTERNAL"
    };
  } catch (error) {
    if (error instanceof MemoryPreparingRunConflictError) throw error;
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_execution_invalid",
      true
    );
  }
}

function assertAttemptUtilityDeclaration(
  budgetSnapshot: unknown,
  evidence: PreparingAttemptExecutionEvidence
): void {
  const declared = isRecord(budgetSnapshot)
    ? budgetSnapshot.utilityEgressMode
    : undefined;
  if (
    (declared !== undefined && declared !== evidence.utilityEgressMode) ||
    (evidence.utilityEgressMode === "CONSENTED_EXTERNAL" &&
      declared !== "CONSENTED_EXTERNAL")
  ) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_execution_invalid",
      false
    );
  }
}

async function assertCurrentPreparingExecutionEvidence(
  tx: Prisma.TransactionClient,
  attempt: LockedPreparingAttempt,
  settings: LockedMemorySettings,
  authority: MemoryExecutionAuthorityDependencies,
  now: Date
): Promise<void> {
  const evidence = await loadPreparingAttemptExecutionEvidence(tx, attempt);
  if (
    attempt.utilityEgressMode !== evidence.utilityEgressMode ||
    attempt.acceptedUtilityEgressFingerprint !==
      evidence.acceptedUtilityEgressFingerprint ||
    attempt.externalRolesUsed.length !== evidence.externalRolesUsed.length ||
    attempt.externalRolesUsed.some((role, index) =>
      role !== evidence.externalRolesUsed[index])
  ) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_execution_invalid",
      false
    );
  }
  if (evidence.utilityEgressMode === "LOCAL_ONLY") return;
  const consentMode = authority.egressConsentMode ??
    resolveMemoryEgressConsentMode();
  if (consentMode !== "ADMIN" && (
    settings.acceptedUtilityEgressFingerprint !==
      evidence.acceptedUtilityEgressFingerprint ||
    settings.acceptedUtilityPolicyVersion === null ||
    settings.acceptedUtilityEgressAt === null
  )) {
    throw new MemoryPreparingRunConflictError(
      "memory_utility_egress_changed",
      true
    );
  }
  try {
    for (const snapshot of evidence.snapshots) {
      await reauthorizeStoredMemoryExecution(tx, settings, {
        dependencies: authority,
        now,
        snapshot,
        userId: attempt.userId
      });
    }
  } catch {
    throw new MemoryPreparingRunConflictError(
      "memory_utility_egress_changed",
      true
    );
  }
}

export async function completePreparingRunAttemptWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{
    attemptId: string;
    deadlineAtMs?: number;
    result: MemoryPreparingAttemptResult;
    runId: string;
    userId: string;
  }>
): Promise<boolean> {
  validateMemoryPreparingAttemptResult(input.result);
  const now = new Date();
  return repeatableReadTransaction(prismaClient, async (tx) => {
    const run = await lockPreparingRun(tx, input.runId, input.userId);
    const attempt = await lockPreparingAttempt(tx, input);
    if (!run || run.status !== "preparing" || !attempt ||
      (attempt.state !== "PENDING" && attempt.state !== "EXECUTING") ||
      attempt.expiresAt <= now) {
      return false;
    }
    const executionEvidence = await loadPreparingAttemptExecutionEvidence(
      tx,
      attempt,
      input.result.budgetSnapshot
    );
    assertAttemptUtilityDeclaration(input.result.budgetSnapshot, executionEvidence);
    if ((input.result.items?.length ?? 0) > 0) {
      await lockMemoryAttemptTargets(tx, attempt);
    }

    const querySnapshot = input.result.querySnapshot ?? null;
    const authoritativeItems: ResolvedPreparingMemoryItem[] = [];
    for (const item of input.result.items ?? []) {
      authoritativeItems.push(await resolvePreparingMemoryItem(tx, {
        assistantId: attempt.assistantIdSnapshot,
        chatId: attempt.chatId,
        folderId: attempt.folderIdSnapshot,
        indexGenerationId: attempt.indexGenerationIdSnapshot,
        userId: attempt.userId
      }, querySnapshot, item));
    }

    if (authoritativeItems.length > 0) {
      await tx.memoryRetrievalAttemptItem.createMany({
        data: authoritativeItems.map((item, ordinal) => ({
          exactItemId: item.exactItemId,
          exactSafeText: item.exactSafeText,
          factVersionId: item.factVersionId,
          featureSnapshot: json(item.featureSnapshot),
          itemType: item.itemType,
          laneRanks: json(item.laneRanks),
          ordinal,
          recallChunkId: item.recallChunkId,
          selectionReason: item.selectionReason,
          sourceBranchGenerationSnapshot: item.sourceBranchGenerationSnapshot,
          sourceChatIdSnapshot: item.sourceChatIdSnapshot,
          sourceContentHashSnapshot: item.sourceContentHashSnapshot,
          sourceRevisionSnapshot: item.sourceRevisionSnapshot,
          sourceSnapshot: json(item.sourceSnapshot),
          textHash: item.textHash,
          userId: input.userId,
          versionSnapshot: json(item.versionSnapshot),
          attemptId: input.attemptId
        }))
      });
    }

    const context = input.result.preparedContext ?? null;
    const lifecycleSnapshot = decodeMemoryActionLifecycleSnapshot(attempt.budgetSnapshot);
    if (!lifecycleSnapshot) {
      throw new MemoryPreparingRunConflictError("memory_admission_snapshot_invalid", false);
    }
    const updated = await tx.memoryRetrievalAttempt.updateMany({
      data: {
        budgetSnapshot: json({
          ...input.result.budgetSnapshot,
          ...memoryActionLifecycleBudgetSnapshot(lifecycleSnapshot)
        }),
        boundedSafeQuerySnapshot: querySnapshot,
        degradationCode: input.result.degradationCode ?? null,
        externalRolesUsed: [...executionEvidence.externalRolesUsed],
        outcome: input.result.outcome,
        preparedContextHash: context ? memoryPreparingTextHash(context.text) : null,
        preparedContextText: context?.text ?? null,
        preparedContextTokenCount: context?.approxTokens ?? null,
        queryHash: input.result.queryHash ?? memoryPreparingTextHash(querySnapshot ?? ""),
        state: "READY",
        utilityEgressMode: executionEvidence.utilityEgressMode,
        acceptedUtilityEgressFingerprint:
          executionEvidence.acceptedUtilityEgressFingerprint,
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
  }, { deadlineAtMs: input.deadlineAtMs });
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
      ...(input.plan.executionScope ? { executionScope: input.plan.executionScope } : {}),
      ...(input.plan.requiresClientToolCoexistence
        ? { requiresClientToolCoexistence: true }
        : {}),
      searchPlan: input.plan.requestedSearchPlan,
      ...(input.plan.requestedSearchPreferenceSource
        ? {
            searchPreferencePlan: input.plan.requestedSearchPreferencePlan,
            searchPreferenceSource: input.plan.requestedSearchPreferenceSource
          }
        : {}),
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
      ...(input.plan.executionScope ? { executionScope: input.plan.executionScope } : {}),
      knowledgePlan: input.plan.knowledgePlan,
      ...(input.plan.projectId ? { projectId: input.plan.projectId } : {}),
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
    projectId?: string;
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
    const rows = await tx.$queryRaw<Array<{ id: string }>>(input.projectId
      ? Prisma.sql`
      SELECT generation."id"
      FROM "McpRuntimeGeneration" AS generation
      INNER JOIN "McpUserServer" AS preference
        ON preference."id" = generation."userServerId"
      INNER JOIN "McpServer" AS server
        ON server."id" = preference."serverId"
      INNER JOIN "McpRevision" AS revision
        ON revision."id" = generation."revisionId"
      INNER JOIN "ProjectMcpBinding" AS project_binding
        ON project_binding."serverId" = server."id"
       AND project_binding."projectId" = ${input.projectId}
      WHERE server."id" = ${binding.serverId}
        AND server."enabled" = true
        AND server."archivedAt" IS NULL
        AND server."activeRevisionId" = generation."revisionId"
        AND revision."id" = generation."revisionId"
        AND (
          server."sharedConfigEnvelope" IS NOT NULL
          OR revision."configuration" #>> '{auth,mode}' = 'none'
        )
        AND preference."enabled" = true
        AND preference."desiredRuntimeGenerationId" = generation."id"
        AND preference."personalConfigEnvelope" IS NULL
        AND generation."oauthConnectionId" IS NULL
        AND generation."id" = ${binding.runtimeGenerationId}
        AND generation."fingerprint" = ${binding.fingerprint}
        AND generation."state" = 'ready'
        AND generation."inventory" IS NOT NULL
        AND generation."inventoryUpdatedAt" IS NOT NULL
        AND generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND NOT (generation."credentialSources" && ARRAY['oauth', 'personal']::TEXT[])
      FOR SHARE OF generation, preference, server
    `
      : Prisma.sql`
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

type PreparingAttemptItemRow = ResolvedPreparingMemoryItem & Readonly<{
  ordinal: number;
}>;

async function loadAndValidatePreparingAttemptItems(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    attempt: Pick<
      LockedPreparingAttempt,
      "assistantIdSnapshot" | "boundedSafeQuerySnapshot" | "chatId" |
      "folderIdSnapshot" | "indexGenerationIdSnapshot" | "userId"
    >;
    attemptId: string;
    userId: string;
  }>
): Promise<PreparingAttemptItemRow[]> {
  const items = await tx.memoryRetrievalAttemptItem.findMany({
    select: {
      exactItemId: true,
      exactSafeText: true,
      factVersionId: true,
      featureSnapshot: true,
      itemType: true,
      laneRanks: true,
      ordinal: true,
      recallChunkId: true,
      selectionReason: true,
      sourceBranchGenerationSnapshot: true,
      sourceChatIdSnapshot: true,
      sourceContentHashSnapshot: true,
      sourceRevisionSnapshot: true,
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
  const validatedItems: PreparingAttemptItemRow[] = [];
  for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
    const item = items[ordinal]!;
    const featureSnapshot = isRecord(item.featureSnapshot)
      ? item.featureSnapshot
      : null;
    const laneRanks = isRecord(item.laneRanks) ? item.laneRanks : null;
    const finalScore = featureSnapshot?.finalScore;
    if (
      item.ordinal !== ordinal ||
      memoryPreparingTextHash(item.exactSafeText) !== item.textHash ||
      !featureSnapshot ||
      !isRecord(item.sourceSnapshot) ||
      !isRecord(item.versionSnapshot) ||
      !laneRanks ||
      typeof finalScore !== "number" ||
      !Number.isFinite(finalScore) ||
      finalScore < 0 ||
      finalScore > 1
    ) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
    }
    const common = {
      exactItemId: item.exactItemId,
      exactSafeText: item.exactSafeText,
      featureSnapshot,
      finalScore,
      laneRanks,
      selectionReason: item.selectionReason
    } as const;
    let candidate: MemoryPreparingItemInput;
    if (
      item.itemType === "FACT_VERSION" &&
      item.factVersionId !== null &&
      item.recallChunkId === null &&
      item.exactItemId === item.factVersionId
    ) {
      candidate = { ...common, factVersionId: item.factVersionId, itemType: "FACT_VERSION" };
    } else if (
      item.itemType === "RECALL_CHUNK" &&
      item.recallChunkId !== null &&
      item.factVersionId === null &&
      item.exactItemId === item.recallChunkId
    ) {
      candidate = { ...common, itemType: "RECALL_CHUNK", recallChunkId: item.recallChunkId };
    } else {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
    }
    const resolved = await resolvePreparingMemoryItem(tx, {
      assistantId: input.attempt.assistantIdSnapshot,
      chatId: input.attempt.chatId,
      folderId: input.attempt.folderIdSnapshot,
      indexGenerationId: input.attempt.indexGenerationIdSnapshot,
      userId: input.attempt.userId
    }, input.attempt.boundedSafeQuerySnapshot, candidate);
    if (
      !samePreparingMemoryItemSnapshot(item, resolved) ||
      item.exactItemId !== resolved.exactItemId ||
      item.factVersionId !== resolved.factVersionId ||
      item.recallChunkId !== resolved.recallChunkId ||
      item.sourceChatIdSnapshot !== resolved.sourceChatIdSnapshot ||
      item.sourceBranchGenerationSnapshot !== resolved.sourceBranchGenerationSnapshot ||
      item.sourceRevisionSnapshot !== resolved.sourceRevisionSnapshot ||
      item.sourceContentHashSnapshot !== resolved.sourceContentHashSnapshot
    ) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
    validatedItems.push({ ...resolved, ordinal: item.ordinal });
  }
  return validatedItems;
}

function validateFinalPreparingRequest(
  input: PreparingRunFinalizationInput,
  baseSnapshot: ReturnType<typeof decodeMemoryPreparingBaseSnapshot>,
  attempt: LockedPreparingAttempt,
  items: readonly PreparingAttemptItemRow[]
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
  const budget = isRecord(attempt.budgetSnapshot) ? attempt.budgetSnapshot : null;
  const rawActionAnswerResult = budget?.memoryActionAnswerResult;
  const actionAnswerResult = rawActionAnswerResult === undefined
    ? null
    : decodeMemoryActionAnswerResult(rawActionAnswerResult);
  if (rawActionAnswerResult !== undefined && !actionAnswerResult) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  const rawBaseActionAnswerResult = baseSnapshot.normalizedRequest.prompt
    .memoryActionAnswerResult;
  const baseActionAnswerResult = rawBaseActionAnswerResult === undefined
    ? null
    : decodeMemoryActionAnswerResult(rawBaseActionAnswerResult);
  if (
    rawBaseActionAnswerResult !== undefined &&
    (!baseActionAnswerResult || memoryPreparingHash(baseActionAnswerResult) !==
      memoryPreparingHash(MEMORY_ACTION_NO_COMMIT_RESULT))
  ) {
    throw new MemoryPreparingRunConflictError("memory_base_request_invalid", false);
  }
  const contextBearingOutcome = preparingAttemptCarriesProviderContext(attempt);
  if (!contextBearingOutcome && !actionAnswerResult) {
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
    prompt: finalPrompt,
    ...finalRequestRest
  } = input.normalizedRequest;
  const {
    context: baseContext,
    prompt: basePrompt,
    ...baseRequestRest
  } = baseSnapshot.normalizedRequest;
  const {
    memoryActionAnswerResult: finalActionAnswerResult,
    ...finalPromptCore
  } = finalPrompt;
  const { memoryActionAnswerResult: _baseActionAnswerResult, ...basePromptCore } = basePrompt;
  const effectiveActionAnswerResult = actionAnswerResult ?? baseActionAnswerResult;
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
    memoryPreparingHash({ ...finalRequestRest, prompt: finalPromptCore }) !==
      memoryPreparingHash({ ...baseRequestRest, prompt: basePromptCore }) ||
    memoryPreparingHash(finalActionAnswerResult ?? null) !==
      memoryPreparingHash(effectiveActionAnswerResult) ||
    !contextIsDerived ||
    (contextBearingOutcome
      ? !personalContext ||
        personalContext.mode !== "prefetched" ||
        personalContext.text !== attempt.preparedContextText ||
        personalContext.approxTokens !== attempt.preparedContextTokenCount ||
        personalContext.itemCount !== items.length ||
        personalContext.memoryGeneration !== attempt.memoryGenerationSnapshot ||
        personalContext.memoryRevision !== attempt.retrievalRevisionSnapshot
      : personalContext !== undefined)
  ) {
    throw new MemoryPreparingRunConflictError("memory_final_request_invalid", false);
  }
  createMemoryPreparingBaseSnapshot({
    normalizedRequest: input.normalizedRequest,
    providerRequestPreview: input.providerRequestPreview
  });
}

function committedMutationOperation(
  budgetSnapshot: Prisma.JsonValue | null
): "EDIT" | "FORGET" | "SAVE" | null {
  const budget = isRecord(budgetSnapshot) ? budgetSnapshot : null;
  if (budget?.reason !== "memory_not_useful") return null;
  const answerResult = decodeMemoryActionAnswerResult(
    budget.memoryActionAnswerResult
  );
  const actionResult = decodeMemoryActionFeedback(budget.memoryActionResult);
  if (
    !answerResult ||
    answerResult.status !== "COMMITTED" ||
    !actionResult.ok ||
    actionResult.value.status !== "COMMITTED" ||
    actionResult.value.operation !== answerResult.operation
  ) {
    return null;
  }
  switch (answerResult.operation) {
    case "SAVE": return "SAVE";
    case "UPDATE": return "EDIT";
    case "FORGET": return "FORGET";
    default: return null;
  }
}

async function committedMutationOwnsRevisionAdvance(
  tx: Prisma.TransactionClient,
  attempt: Pick<
    LockedPreparingAttempt,
    | "budgetSnapshot"
    | "memoryGenerationSnapshot"
    | "modelRunId"
    | "retrievalRevisionSnapshot"
    | "userId"
  >,
  currentSettings: Pick<LockedMemorySettings, "memoryGeneration" | "memoryRevision">
): Promise<boolean> {
  const operation = committedMutationOperation(attempt.budgetSnapshot);
  if (!operation) return false;
  const authorizations = await tx.memoryMutationAuthorization.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      consumedAt: true,
      requestId: true,
      targetFactId: true
    },
    take: 2,
    where: {
      action: operation,
      modelRunId: attempt.modelRunId,
      persistedToolCallId: null,
      userId: attempt.userId
    }
  });
  const authorization = authorizations.length === 1 ? authorizations[0] : null;
  if (!authorization?.consumedAt) return false;
  const receipts = await tx.memoryOperationReceipt.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      resultSnapshot: true,
      targetFactId: true
    },
    take: 2,
    where: {
      modelRunId: attempt.modelRunId,
      operation,
      outcome: "APPLIED",
      persistedToolCallId: null,
      requestId: authorization.requestId,
      userId: attempt.userId
    }
  });
  const receipt = receipts.length === 1 ? receipts[0] : null;
  const result = receipt && isRecord(receipt.resultSnapshot)
    ? receipt.resultSnapshot
    : null;
  const receiptGeneration = result?.memoryGeneration;
  const receiptRevision = result?.memoryRevision;
  return Boolean(
    receipt?.targetFactId &&
    (operation === "SAVE" || authorization.targetFactId === receipt.targetFactId) &&
    typeof receiptGeneration === "number" &&
    Number.isSafeInteger(receiptGeneration) &&
    receiptGeneration === attempt.memoryGenerationSnapshot &&
    receiptGeneration === currentSettings.memoryGeneration &&
    typeof receiptRevision === "number" &&
    Number.isSafeInteger(receiptRevision) &&
    receiptRevision > attempt.retrievalRevisionSnapshot &&
    receiptRevision <= currentSettings.memoryRevision
  );
}

export async function finalizePreparingRunWithClient(
  prismaClient: PrismaClient,
  input: PreparingRunFinalizationInput & Readonly<{
    deadlineAtMs?: number;
    deadlineFallbackBudget?: Readonly<Record<string, unknown>>;
    failedSafeFallback?: Readonly<{
      budgetSnapshot: Readonly<Record<string, unknown>>;
      degradationCode: "memory_admission_settings_changed";
    }>;
  }>,
  memoryExecutionAuthority: MemoryExecutionAuthorityDependencies
): Promise<boolean> {
  const now = new Date();
  const finalized = await repeatableReadTransaction(prismaClient, async (tx) => {
    const run = await lockPreparingRun(tx, input.runId, input.userId);
    let attempt = await lockPreparingAttempt(tx, {
      attemptId: input.attemptId,
      runId: input.runId,
      userId: input.userId
    });
    if (!run || run.status !== "preparing" || !attempt) {
      return { decayTouch: false, finalized: false };
    }
    const failedSafeFallback = input.failedSafeFallback ??
      (input.deadlineFallbackBudget !== undefined
        ? {
            budgetSnapshot: input.deadlineFallbackBudget,
            degradationCode: "memory_admission_deadline_exceeded"
          }
        : null);
    if (failedSafeFallback) {
      if (!["PENDING", "EXECUTING", "READY"].includes(attempt.state)) {
        return { decayTouch: false, finalized: false };
      }
      const lifecycleSnapshot = decodeMemoryActionLifecycleSnapshot(
        attempt.budgetSnapshot
      );
      if (!lifecycleSnapshot) {
        throw new MemoryPreparingRunConflictError(
          "memory_admission_snapshot_invalid",
          false
        );
      }
      await settlePreparingAttemptExecutions(tx, {
        attemptId: attempt.id,
        cancelled: false,
        now,
        userId: input.userId
      });
      await tx.memoryRetrievalAttemptItem.deleteMany({
        where: { attemptId: attempt.id, userId: input.userId }
      });
      const executionEvidence = await loadPreparingAttemptExecutionEvidence(
        tx,
        attempt,
        failedSafeFallback.budgetSnapshot
      );
      const {
        memoryActionResult: _memoryActionResult,
        ...fallbackBudgetSnapshot
      } = failedSafeFallback.budgetSnapshot;
      const safeBudgetSnapshot = {
        ...fallbackBudgetSnapshot,
        ...memoryActionLifecycleBudgetSnapshot(lifecycleSnapshot),
        itemCount: 0,
        memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
        reason: failedSafeFallback.degradationCode
      };
      assertAttemptUtilityDeclaration(safeBudgetSnapshot, executionEvidence);
      await tx.memoryRetrievalAttempt.update({
        data: {
          acceptedUtilityEgressFingerprint:
            executionEvidence.acceptedUtilityEgressFingerprint,
          boundedSafeQuerySnapshot: null,
          budgetSnapshot: json(safeBudgetSnapshot),
          degradationCode: failedSafeFallback.degradationCode,
          externalRolesUsed: [...executionEvidence.externalRolesUsed],
          outcome: "FAILED_SAFE",
          preparedContextHash: null,
          preparedContextText: null,
          preparedContextTokenCount: null,
          state: "READY",
          updatedAt: now,
          utilityEgressMode: executionEvidence.utilityEgressMode
        },
        where: { id: attempt.id }
      });
      attempt = {
        ...attempt,
        acceptedUtilityEgressFingerprint:
          executionEvidence.acceptedUtilityEgressFingerprint,
        boundedSafeQuerySnapshot: null,
        budgetSnapshot: safeBudgetSnapshot as Prisma.JsonValue,
        degradationCode: failedSafeFallback.degradationCode,
        externalRolesUsed: [...executionEvidence.externalRolesUsed],
        outcome: "FAILED_SAFE",
        preparedContextHash: null,
        preparedContextText: null,
        preparedContextTokenCount: null,
        state: "READY",
        utilityEgressMode: executionEvidence.utilityEgressMode
      };
    } else if (attempt.state !== "READY") {
      return { decayTouch: false, finalized: false };
    }
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

    const itemCount = await tx.memoryRetrievalAttemptItem.count({
      where: { attemptId: attempt.id, userId: input.userId }
    });
    if (itemCount > 0) {
      await lockMemoryAttemptTargets(tx, attempt);
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
      memoryBranchGeneration: number;
      memoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
      memorySourceRevision: number;
    }>>(Prisma.sql`
      SELECT "activeLeafMessageId", "archived", "folderId",
        "memoryBranchGeneration", "memoryMode"::text AS "memoryMode",
        "memorySourceRevision"
      FROM "Chat"
      WHERE "id" = ${run.chatId}
        AND "userId" = ${input.userId}
        AND "permanentDeletionAt" IS NULL
      FOR UPDATE
    `);
    const lifecycleSnapshot = decodeMemoryActionLifecycleSnapshot(attempt.budgetSnapshot);
    if (
      !chat ||
      !lifecycleSnapshot ||
      chat.archived ||
      chat.activeLeafMessageId !== attempt.admittedAssistantLeafMessageId ||
      chat.activeLeafMessageId !== lifecycleSnapshot.activeLeafMessageId ||
      chat.folderId !== attempt.folderIdSnapshot ||
      chat.memoryMode !== attempt.chatMemoryModeSnapshot ||
      chat.memoryBranchGeneration !== lifecycleSnapshot.branchGeneration ||
      chat.memorySourceRevision !== lifecycleSnapshot.sourceRevision
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
      if (attempt.preSendActiveLeafMessageId !== attempt.admittedUserMessageId) {
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
    }

    if (input.assistant) {
      await assertAssistantRunProvenance(tx, {
        assistantId: input.assistant.assistantId,
        revisionId: input.assistant.revisionId,
        userId: input.userId
      });
    }

    const contextRequested = input.normalizedRequest.personalContext !== undefined;
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

    const currentSettings = failedSafeFallback ||
        attempt.chatMemoryModeSnapshot === "TEMPORARY"
      ? null
      : await loadPreparingSettings(tx, input.userId, true);
    if (currentSettings) {
      await assertCurrentPreparingExecutionEvidence(
        tx,
        attempt,
        currentSettings,
        memoryExecutionAuthority,
        now
      );
    }

    const items = await loadAndValidatePreparingAttemptItems(tx, {
      attempt,
      attemptId: attempt.id,
      userId: input.userId
    });
    const visibleOutcome = attempt.outcome === "USED" || attempt.outcome === "DEGRADED";
    const usedContextIsValid = visibleOutcome &&
      items.length > 0 &&
      attempt.preparedContextText !== null &&
      attempt.preparedContextHash === memoryPreparingTextHash(attempt.preparedContextText) &&
      attempt.preparedContextTokenCount !== null &&
      Number.isSafeInteger(attempt.preparedContextTokenCount) &&
      attempt.preparedContextTokenCount >= 0;
    const emptyContextIsValid = !visibleOutcome &&
      items.length === 0 &&
      attempt.preparedContextText === null &&
      attempt.preparedContextHash === null &&
      attempt.preparedContextTokenCount === null;
    if (!usedContextIsValid && !emptyContextIsValid) {
      throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
    }
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
      ...(input.project?.projectId ? { projectId: input.project.projectId } : {}),
      runId: input.runId,
      userId: input.userId
    });
    await assertCurrentSkillRunBindings(tx, {
      bindings: input.skillBindings,
      runId: input.runId,
      userId: input.userId
    });

    if (attempt.chatMemoryModeSnapshot === "TEMPORARY") {
      if (
        attempt.outcome !== "DISABLED" ||
        items.length !== 0 ||
        !sameMemoryPreparingSettings(
          settingsSnapshot,
          memoryPreparingSettingsSnapshot(TEMPORARY_PREPARING_SETTINGS),
          { requireUtilityEgressMatch: false }
        ) ||
        baseSnapshot.normalizedRequest.memoryActionTools !== undefined ||
        input.normalizedRequest.personalContext !== undefined ||
        attempt.utilityEgressMode !== "LOCAL_ONLY" ||
        attempt.acceptedUtilityEgressFingerprint !== null ||
        attempt.externalRolesUsed.length !== 0
      ) {
        throw new MemoryPreparingRunConflictError(
          "memory_temporary_chat_forbidden",
          false
        );
      }
      validateFinalPreparingRequest(input, baseSnapshot, attempt, items);
      await tx.modelRunMemoryBinding.create({
        data: {
          boundedSafeQuerySnapshot: null,
          contextTextHash: memoryPreparingTextHash(""),
          contextTokenCount: 0,
          degradationCode: null,
          finalizedAt: now,
          finalizedRevisionSnapshot: 0,
          indexGenerationId: null,
          memoryGenerationSnapshot: 0,
          modelRunId: run.id,
          outcome: "DISABLED",
          queryHash: attempt.queryHash,
          queryPlannerVersion: MEMORY_PREPARING_QUERY_PLANNER_VERSION,
          retrievalAttemptId: attempt.id,
          retrievalPipelineVersion: MEMORY_PREPARING_RETRIEVAL_PIPELINE_VERSION,
          retrievalRevisionSnapshot: 0,
          settingsSnapshot: json(settingsSnapshot),
          userId: input.userId
        }
      });
      await tx.memoryRetrievalAttempt.update({
        data: { consumedAt: now, state: "CONSUMED", updatedAt: now },
        where: { id: attempt.id }
      });
      await tx.modelRun.update({
        data: {
          normalizedRequest: json(input.normalizedRequest),
          status: "streaming"
        },
        where: { id: run.id }
      });
      return { decayTouch: false, finalized: true };
    }

    if (!failedSafeFallback && !currentSettings) {
      throw new MemoryPreparingRunConflictError("memory_owner_unavailable", false);
    }
    if (currentSettings) {
      const currentSnapshot = memoryPreparingSettingsSnapshot(currentSettings);
      const exactRevisionRequired = attempt.outcome === "EMPTY" && items.length === 0;
      const ownCommittedMutation = exactRevisionRequired &&
        currentSettings.memoryRevision !== attempt.retrievalRevisionSnapshot &&
        await committedMutationOwnsRevisionAdvance(tx, attempt, currentSettings);
      if (
        currentSettings.memoryGeneration !== attempt.memoryGenerationSnapshot ||
        currentSettings.activeIndexGenerationId !== attempt.indexGenerationIdSnapshot ||
        !sameMemoryPreparingSettings(settingsSnapshot, currentSnapshot, {
          requireUtilityEgressMatch: attempt.utilityEgressMode === "CONSENTED_EXTERNAL"
        }) ||
        currentSettings.memoryRevision < attempt.retrievalRevisionSnapshot ||
        (exactRevisionRequired &&
          !ownCommittedMutation &&
          currentSettings.memoryRevision !== attempt.retrievalRevisionSnapshot)
      ) {
        throw new MemoryPreparingRunConflictError("memory_admission_settings_changed", true);
      }
    }
    if (!attempt.outcome) {
      throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
    }
    validateFinalPreparingRequest(
      input,
      baseSnapshot,
      attempt,
      items
    );

    const binding = await tx.modelRunMemoryBinding.create({
      data: {
        boundedSafeQuerySnapshot: attempt.boundedSafeQuerySnapshot,
        contextTextHash: attempt.preparedContextHash ?? memoryPreparingTextHash(""),
        contextTokenCount: attempt.preparedContextTokenCount ?? 0,
        degradationCode: attempt.degradationCode,
        finalizedAt: now,
        finalizedRevisionSnapshot: currentSettings?.memoryRevision ??
          attempt.retrievalRevisionSnapshot,
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
          exactItemId: item.exactItemId,
          factVersionId: item.factVersionId,
          featureSnapshot: json(item.featureSnapshot),
          finalScore: item.finalScore,
          includedText: item.exactSafeText,
          includedTextHash: item.textHash,
          itemStateAtAdmission: item.itemStateAtAdmission,
          itemType: item.itemType,
          laneRanks: json(item.laneRanks),
          ordinal: item.ordinal,
          recallChunkId: item.recallChunkId,
          selectionReason: item.selectionReason,
          sourceBranchGenerationSnapshot: item.sourceBranchGenerationSnapshot,
          sourceChatIdSnapshot: item.sourceChatIdSnapshot,
          sourceContentHashSnapshot: item.sourceContentHashSnapshot,
          sourceMessageIdsSnapshot: [...item.sourceMessageIdsSnapshot],
          sourceRevisionSnapshot: item.sourceRevisionSnapshot,
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
        status: "streaming"
      },
      where: { id: run.id }
    });
    return {
      decayTouch: settingsSnapshot.decayEnabled &&
        settingsSnapshot.decayPolicyVersion === MEMORY_DECAY_POLICY_VERSION &&
        items.some((item) => item.itemType === "FACT_VERSION"),
      finalized: true
    };
  }, { deadlineAtMs: input.deadlineAtMs });
  if (finalized.decayTouch) {
    scheduleMemoryDecayTouch(prismaClient, {
      retrievalAttemptId: input.attemptId,
      userId: input.userId
    });
  }
  return finalized.finalized;
}

export async function retryPreparingRunAttemptWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{
    attemptId: string;
    deadlineAtMs?: number;
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
      memoryBranchGeneration: number;
      memoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
      memorySourceRevision: number;
    }>>(Prisma.sql`
      SELECT "activeLeafMessageId", "archived", "folderId",
        "memoryBranchGeneration", "memoryMode"::text AS "memoryMode",
        "memorySourceRevision"
      FROM "Chat"
      WHERE "id" = ${attempt.chatId}
        AND "userId" = ${input.userId}
        AND "permanentDeletionAt" IS NULL
      FOR UPDATE
    `);
    const lifecycleSnapshot = decodeMemoryActionLifecycleSnapshot(attempt.budgetSnapshot);
    if (
      !chat ||
      !lifecycleSnapshot ||
      chat.archived ||
      chat.activeLeafMessageId !== attempt.admittedAssistantLeafMessageId ||
      chat.activeLeafMessageId !== lifecycleSnapshot.activeLeafMessageId ||
      chat.folderId !== attempt.folderIdSnapshot ||
      chat.memoryMode !== attempt.chatMemoryModeSnapshot ||
      chat.memoryBranchGeneration !== lifecycleSnapshot.branchGeneration ||
      chat.memorySourceRevision !== lifecycleSnapshot.sourceRevision
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
    const settings = attempt.chatMemoryModeSnapshot === "TEMPORARY"
      ? TEMPORARY_PREPARING_SETTINGS
      : await loadPreparingSettings(tx, input.userId);
    await settlePreparingAttemptExecutions(tx, {
      attemptId: attempt.id,
      cancelled: false,
      now: input.now,
      userId: input.userId
    });
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
      chatMemoryMode: attempt.chatMemoryModeSnapshot,
      folderIdSnapshot: attempt.folderIdSnapshot,
      lifecycleSnapshot: {
        activeLeafMessageId: lifecycleSnapshot.activeLeafMessageId,
        memoryBranchGeneration: lifecycleSnapshot.branchGeneration,
        memorySourceRevision: lifecycleSnapshot.sourceRevision
      },
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
  }, { deadlineAtMs: input.deadlineAtMs });
}

async function settlePreparingAttemptExecutions(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    attemptId: string;
    cancelled: boolean;
    now: Date;
    userId: string;
  }>
): Promise<void> {
  const bindings = await tx.memoryExecutionBinding.findMany({
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    select: memoryExecutionBindingSelect,
    where: {
      ownerType: "RETRIEVAL_ATTEMPT",
      retrievalAttemptId: input.attemptId,
      userId: input.userId
    }
  });
  for (const binding of bindings) {
    const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
    assertMemoryExecutionBindingLineage(binding, snapshot);
    const existingUsage = await tx.usageEvent.findUnique({
      select: { id: true },
      where: { memoryExecutionBindingId: binding.id }
    });
    const open = binding.state === "PENDING" || binding.state === "RUNNING";
    if (open && existingUsage) {
      throw new MemoryPreparingRunConflictError(
        "memory_attempt_execution_invalid",
        false
      );
    }
    if (open) {
      const uncertain = binding.state === "RUNNING";
      const state = uncertain
        ? "OUTCOME_UNKNOWN" as const
        : input.cancelled ? "CANCELLED" as const : "FAILED" as const;
      // Database defaults retain sub-millisecond precision that a Prisma Date
      // cannot round-trip. Move at least one millisecond past every stored
      // lower bound so the terminal timestamp remains monotonic.
      const terminalAt = new Date(Math.max(
        input.now.getTime(),
        binding.createdAt.getTime() + 1,
        (binding.startedAt?.getTime() ?? 0) + 1
      ));
      const updated = await tx.memoryExecutionBinding.updateMany({
        data: {
          acceptedOutputHash: null,
          cachedInputTokens: null,
          completedAt: terminalAt,
          errorCode: uncertain
            ? "memory_preparing_execution_uncertain"
            : input.cancelled
              ? "memory_preparing_execution_cancelled"
              : "memory_preparing_execution_abandoned",
          estimatedCostMicros: null,
          inputTokens: null,
          outputTokens: null,
          providerResponseId: null,
          reasoningTokens: null,
          recoverableUntil: uncertain
            ? new Date(terminalAt.getTime() + MEMORY_EXECUTION_RECOVERY_HORIZON_MS)
            : terminalAt,
          state,
          totalTokens: null,
          usageCompleteness: "UNAVAILABLE"
        },
        where: {
          id: binding.id,
          state: binding.state,
          userId: input.userId
        }
      });
      if (updated.count !== 1) {
        throw new MemoryPreparingRunConflictError(
          "memory_attempt_execution_invalid",
          true
        );
      }
    }
    if (!existingUsage) {
      const provider = snapshot.providerExecutionSnapshot;
      await tx.usageEvent.create({
        data: {
          cachedInputTokens: open ? null : binding.cachedInputTokens,
          cacheWriteInputTokens: null,
          estimatedCostMicros: open ? null : binding.estimatedCostMicros,
          inputTokens: open ? null : binding.inputTokens,
          memoryExecutionBindingId: binding.id,
          modelId: provider.model.upstreamModelId,
          outputTokens: open ? null : binding.outputTokens,
          provider: provider.providerFamily,
          providerModelId: provider.providerModelId,
          reasoningTokens: open ? null : binding.reasoningTokens,
          totalTokens: open ? null : binding.totalTokens,
          userId: input.userId
        }
      });
    }
  }
}

export type PreparingSettlementInput = Readonly<{
  attemptId?: string;
  errorCode: string;
  message: string;
  now?: Date;
  runId: string;
  state: "CANCELLED" | "EXPIRED" | "FAILED" | "STALE";
  userId: string;
}>;

export async function settleTerminalMemorySource(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    assistantMessageId: string | null;
    chatId: string;
    runId: string;
    status: "cancelled" | "complete" | "error";
    userId: string;
  }>,
  memorySourceHooks?: MemorySourceMutationHooks
): Promise<void> {
  const ownership = await tx.chat.findUnique({
    select: { projectId: true, userId: true },
    where: { id: input.chatId }
  });
  if (ownership?.projectId && ownership.userId === null) {
    // Project chats never enter the personal Memory source state machine.
    return;
  }
  const chat = await lockMemorySourceChat(tx, {
    chatId: input.chatId,
    lock: "UPDATE",
    userId: input.userId
  });
  if (!chat) throw new MemorySourceStateConflictError();
  await applyMemorySourceMutations(tx, {
    chat,
    hooks: memorySourceHooks,
    mutations: ["TERMINAL_SETTLEMENT"],
    terminalSettlement: {
      assistantMessageId: input.assistantMessageId,
      runId: input.runId,
      status: input.status
    }
  });
}

export async function settlePreparingRunInTransaction(
  tx: Prisma.TransactionClient,
  input: PreparingSettlementInput,
  memorySourceHooks?: MemorySourceMutationHooks
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
  const now = input.now ?? new Date();
  const errorCode = /^[a-z][a-z0-9_]{0,63}$/u.test(input.errorCode)
    ? input.errorCode
    : "memory_preparing_failed";
  const cancelled = input.state === "CANCELLED";
  await settlePreparingAttemptExecutions(tx, {
    attemptId: attempt.id,
    cancelled,
    now,
    userId: input.userId
  });
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
  await settleTerminalMemorySource(tx, {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    runId: run.id,
    status: cancelled ? "cancelled" : "error",
    userId: input.userId
  }, memorySourceHooks);
  return true;
}

export async function settlePreparingRunFailureWithClient(
  prismaClient: PrismaClient,
  input: PreparingSettlementInput,
  memorySourceHooks?: MemorySourceMutationHooks
): Promise<boolean> {
  return prismaClient.$transaction((tx) =>
    settlePreparingRunInTransaction(tx, input, memorySourceHooks));
}

export async function recoverPreparingRunWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{ now: Date; runId: string; userId: string }>,
  memorySourceHooks?: MemorySourceMutationHooks
): Promise<PreparingRunRecoveryResult> {
  const recovered = await prismaClient.$transaction(async (tx) => {
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
    }, memorySourceHooks);
    return settled ? "settled" : "not_preparing";
  });
  if (recovered === "finalized") {
    scheduleMemoryDecayTouch(prismaClient, {
      modelRunId: input.runId,
      userId: input.userId
    });
  }
  return recovered;
}

export async function createDormantPreparingRun(
  prismaClient: PrismaClient,
  admission: PreparingRunAdmissionInput,
  memoryRetrieval: MemoryRunRetrievalService,
  memoryExecutionAuthority: MemoryExecutionAuthorityDependencies,
  memorySourceHooks?: MemorySourceMutationHooks,
  memoryAdmissionDeadlineMs = MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
): Promise<PreparingRunAdmissionResult & Readonly<{
  materializedRequest?: PreparingRunMaterializedRequest;
}>> {
  if (admission.project) {
    return admitProjectRunWithClient(prismaClient, admission);
  }
  const memoryAdmissionDeadlineAtMs =
    Date.now() + boundedMemoryAdmissionDeadlineMs(memoryAdmissionDeadlineMs);
  let created: PreparingRunAdmissionResult;
  try {
    created = await admitPreparingRunWithClient(
      prismaClient,
      admission,
      memorySourceHooks,
      {
        deadlineAtMs: memoryAdmissionDeadlineAtMs -
          MEMORY_PREPARING_ADMISSION_RESERVE_MS
      }
    );
  } catch (error) {
    if (!(error instanceof RunTransactionDeadlineError)) throw error;
    // The timed-out transaction rolled back atomically. Retry only the
    // ordinary admission shape and persist a zero-item FAILED_SAFE receipt;
    // no Memory settings, index, utility, or model decision is consulted.
    return admitPreparingRunWithClient(
      prismaClient,
      admission,
      memorySourceHooks,
      {
        memoryUnavailableFallback: true
      }
    );
  }
  if (created.chatMemoryMode === "TEMPORARY") {
    return created;
  }
  let currentAttemptId = created.attemptId;
  let currentSettings = {
    memoryGeneration: created.memoryGeneration,
    memoryRevision: created.memoryRevision,
    settingsSnapshot: created.settingsSnapshot
  };
  const memoryControlCache: MemoryRunControlCache = {
    admissionDeadlineAtMs: memoryAdmissionDeadlineAtMs -
      MEMORY_PREPARING_RETRIEVAL_RESERVE_MS
  };
  let deadlineFallbackBudget: Readonly<Record<string, unknown>> = {
    itemCount: 0,
    memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
    reason: "memory_admission_deadline_exceeded",
    schemaVersion: 2
  };
  const currentStageFallbackBudget = (): Readonly<Record<string, unknown>> =>
    memoryControlCache.settingsDriftFailedSafeAttemptId === currentAttemptId
      ? memoryControlCache.settingsDriftFailedSafeBudget ?? deadlineFallbackBudget
      : deadlineFallbackBudget;
  const finalizeDeadlineFallback = async (): Promise<PreparingRunAdmissionResult> => {
    const fallbackFinalized = await finalizePreparingRunWithClient(
      prismaClient,
      {
        ...(admission.assistant ? { assistant: admission.assistant } : {}),
        attemptId: currentAttemptId,
        deadlineFallbackBudget: {
          ...currentStageFallbackBudget(),
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
        },
        ...(admission.knowledgeAdmissionPlan
          ? { knowledgeAdmissionPlan: admission.knowledgeAdmissionPlan }
          : {}),
        ...(admission.mcpBindings ? { mcpBindings: admission.mcpBindings } : {}),
        normalizedRequest: admission.normalizedRequest,
        providerAdmissionPlan: admission.providerAdmissionPlan,
        providerRequestPreview: admission.providerRequestPreview,
        runId: created.runId,
        ...(admission.skillBindings ? { skillBindings: admission.skillBindings } : {}),
        userId: admission.userId
      },
      memoryExecutionAuthority
    );
    if (!fallbackFinalized) {
      throw new MemoryPreparingRunConflictError(
        "memory_preparing_deadline_fallback_unavailable",
        false
      );
    }
    return {
      ...created,
      attemptId: currentAttemptId,
      memoryGeneration: currentSettings.memoryGeneration,
      memoryRevision: currentSettings.memoryRevision,
      settingsSnapshot: currentSettings.settingsSnapshot
    };
  };
  const finalizeSettingsDriftFallback = async (
    budgetSnapshot: Readonly<Record<string, unknown>>
  ): Promise<PreparingRunAdmissionResult> => {
    const fallbackFinalized = await finalizePreparingRunWithClient(
      prismaClient,
      {
        ...(admission.assistant ? { assistant: admission.assistant } : {}),
        attemptId: currentAttemptId,
        failedSafeFallback: {
          budgetSnapshot,
          degradationCode: "memory_admission_settings_changed"
        },
        ...(admission.knowledgeAdmissionPlan
          ? { knowledgeAdmissionPlan: admission.knowledgeAdmissionPlan }
          : {}),
        ...(admission.mcpBindings ? { mcpBindings: admission.mcpBindings } : {}),
        normalizedRequest: admission.normalizedRequest,
        providerAdmissionPlan: admission.providerAdmissionPlan,
        providerRequestPreview: admission.providerRequestPreview,
        runId: created.runId,
        ...(admission.skillBindings ? { skillBindings: admission.skillBindings } : {}),
        userId: admission.userId
      },
      memoryExecutionAuthority
    );
    if (!fallbackFinalized) {
      throw new MemoryPreparingRunConflictError(
        "memory_preparing_settings_fallback_unavailable",
        false
      );
    }
    return {
      ...created,
      attemptId: currentAttemptId,
      memoryGeneration: currentSettings.memoryGeneration,
      memoryRevision: currentSettings.memoryRevision,
      settingsSnapshot: currentSettings.settingsSnapshot
    };
  };
  try {
    for (let attemptOrdinal = 0; attemptOrdinal < 2; attemptOrdinal += 1) {
      try {
        const began = await beginPreparingRunAttemptWithClient(prismaClient, {
          attemptId: currentAttemptId,
          deadlineAtMs: memoryAdmissionDeadlineAtMs -
            MEMORY_PREPARING_RETRIEVAL_RESERVE_MS,
          now: new Date(),
          runId: created.runId,
          userId: admission.userId
        });
        if (!began) {
          throw new MemoryPreparingRunConflictError("memory_preparing_attempt_unavailable", false);
        }
        let attemptResult = admission.memoryMaterializer
          ? await memoryRetrieval.retrieve({
                attemptId: currentAttemptId,
                chatId: admission.chatId,
                controlCache: memoryControlCache,
                expected: {
                  activeIndexGenerationId:
                    currentSettings.settingsSnapshot.activeIndexGenerationId,
                  assistantId: admission.assistant?.assistantId ?? null,
                  chatMemoryMode: created.chatMemoryMode,
                  folderId: created.folderId,
                  memoryGeneration: currentSettings.memoryGeneration,
                  memoryRevision: currentSettings.memoryRevision,
                  settings: currentSettings.settingsSnapshot
                },
                normalizedRequest: admission.normalizedRequest,
                modelRunId: created.runId,
                now: new Date(),
                ...(admission.signal ? { signal: admission.signal } : {}),
                userId: admission.userId
              })
          : dormantMemoryAttemptResult(currentSettings.settingsSnapshot);
        deadlineFallbackBudget = attemptResult.budgetSnapshot;
        const rawActionAnswerResult = attemptResult.budgetSnapshot.memoryActionAnswerResult;
        const actionAnswerResult = rawActionAnswerResult === undefined
          ? null
          : decodeMemoryActionAnswerResult(rawActionAnswerResult);
        if (rawActionAnswerResult !== undefined && !actionAnswerResult) {
          throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
        }
        let materializedRequest: PreparingRunMaterializedRequest | undefined;
        if (attemptResult.preparedContext || actionAnswerResult) {
          const personalContext = attemptResult.preparedContext
            ? {
                approxTokens: attemptResult.preparedContext.approxTokens,
                itemCount: attemptResult.items?.length ?? 0,
                memoryGeneration: currentSettings.memoryGeneration,
                memoryRevision: currentSettings.memoryRevision,
                mode: "prefetched" as const,
                text: attemptResult.preparedContext.text
              }
            : null;
          materializedRequest = admission.memoryMaterializer?.(
            personalContext,
            actionAnswerResult ?? undefined
          ) ?? undefined;
          if (!materializedRequest) {
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
            materializedRequest = actionAnswerResult
              ? admission.memoryMaterializer?.(null, actionAnswerResult) ?? undefined
              : undefined;
            if (actionAnswerResult && !materializedRequest) {
              attemptResult = {
                ...attemptResult,
                budgetSnapshot: {
                  ...attemptResult.budgetSnapshot,
                  memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT
                }
              };
              // The already-admitted ordinary request carries this same
              // no-commit result. If even a fresh materialization declines,
              // Phase B safely dispatches that base request instead of making
              // an optional Memory contract fail the answer.
              materializedRequest = admission.memoryMaterializer?.(
                null,
                MEMORY_ACTION_NO_COMMIT_RESULT
              ) ?? undefined;
            }
          }
        }
        deadlineFallbackBudget = attemptResult.budgetSnapshot;
        const completed = await completePreparingRunAttemptWithClient(prismaClient, {
          attemptId: currentAttemptId,
          deadlineAtMs: memoryAdmissionDeadlineAtMs -
            MEMORY_PREPARING_COMPLETION_RESERVE_MS,
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
          ...(admission.project ? { project: admission.project } : {}),
          ...(admission.skillBindings ? { skillBindings: admission.skillBindings } : {}),
          deadlineAtMs: memoryAdmissionDeadlineAtMs -
            MEMORY_PREPARING_FINALIZATION_RESERVE_MS,
          normalizedRequest: materializedRequest?.normalizedRequest ?? admission.normalizedRequest,
          providerAdmissionPlan: admission.providerAdmissionPlan,
          providerRequestPreview:
            materializedRequest?.providerRequestPreview ?? admission.providerRequestPreview,
          runId: created.runId,
          userId: admission.userId
        }, memoryExecutionAuthority);
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
        if (error instanceof RunTransactionDeadlineError) {
          return await finalizeDeadlineFallback();
        }
        if (
          error instanceof MemoryPreparingRunConflictError &&
          error.code === "memory_admission_settings_changed" &&
          error.retryable &&
          attemptOrdinal === 1
        ) {
          return await finalizeSettingsDriftFallback(
            currentStageFallbackBudget()
          );
        }
        if (
          !(error instanceof MemoryPreparingRunConflictError) ||
          !error.retryable ||
          attemptOrdinal !== 0
        ) {
          throw error;
        }
        let retry;
        try {
          retry = await retryPreparingRunAttemptWithClient(prismaClient, {
            attemptId: currentAttemptId,
            deadlineAtMs: memoryAdmissionDeadlineAtMs -
              MEMORY_PREPARING_RETRIEVAL_RESERVE_MS,
            now: new Date(),
            runId: created.runId,
            userId: admission.userId
          });
        } catch (retryError) {
          if (retryError instanceof RunTransactionDeadlineError) {
            return await finalizeDeadlineFallback();
          }
          throw retryError;
        }
        if (!retry) throw error;
        currentAttemptId = retry.attemptId;
        currentSettings = retry;
      }
    }
    throw new MemoryPreparingRunConflictError("memory_preparing_retry_conflict", false);
  } catch (error) {
    await settlePreparingRunFailureWithClient(prismaClient, {
      attemptId: currentAttemptId,
      errorCode: error instanceof MemoryPreparingRunConflictError
        ? error.code
        : "memory_preparing_failed",
      message: "Memory preparation failed before provider dispatch.",
      runId: created.runId,
      state: "FAILED",
      userId: admission.userId
    }, memorySourceHooks).catch(() => false);
    throw error;
  }
}
