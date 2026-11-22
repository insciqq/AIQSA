import { assertInstructionPresetSelection } from "../instructions/store";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { keepChatListTime, monitoringAdmissionChatTime, monitoringCheckChatTime } from "./chatListTime";
import { admittedFollowupFields, insertAdmittedRunFollowups } from "./prismaRepositoryFollowups";
import { claimSubagentCallbacksForRun } from "./subagentBackground/store";
import { assertChatPdfClaim, insertChatPdfAdmissions, storeChatPdfAdmissionResult } from "../uploads/chatPdfPersistence";
import { ChatPdfPreparationError } from "../uploads/chatPdfCore";
import { clearChatSearch, markChatSearchDirty } from "../chatSearch/index/dirty";
import { temporaryChatRetentionDeadline } from "../chats/temporaryRetention";
import {
  assertWorkspaceFollowupClaim, predecessorReleasesSuccessor, prepareWorkspaceFollowupAdmission,
  storeWorkspaceFollowupAdmission, WorkspaceFollowupError
} from "./workspaceFollowupPersistence";
import { logEvent } from "../observability";
import {
  Prisma,
  type ModelRunStatus,
  type PrismaClient
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { titleFromMessageContent } from "../chats/titlePolicy";
import { loadChatCreationDefaults } from "../chats/chatCreationDefaults";
import {
  decodeMemoryInitialChatMode,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
} from "../../contracts/memoryClient";
import {
  ActiveLeafConflictError,
  AttachmentLinkConflictError,
  ProviderAdmissionConflictError,
  RunAdmissionConflictError,
  SkillRunConflictError,
  WorkspaceRunConflictError,
  type PreparingRunAdmissionInput,
  type PreparingRunAdmissionResult
} from "./runRepositoryContract";
import { linkScheduledTaskOccurrence } from "../scheduledTasks/occurrenceLink";
import { loadAnswerReviewPathView, type AnswerReviewPathView } from "../chats/legacyAnswerReviews";
import { quietCheckStandIn } from "../chats/quietScheduledChecks";
import { recordUsageMessageAdmission } from "../usageLimits/repository";
import type { WorkspaceRunAdmissionPlan } from "../workspace/admission";
import { UNREGISTERED_WORKSPACE_COMMAND_FILTER, WORKSPACE_EXECUTION_OPEN_STATES } from "../workspace/executionRegistry";
import { workspaceRunOperationOwner } from "../workspace/sessionOperation";
import { joinWorkspaceRunOperation, recordWorkspaceAttachment, workspaceJoinRefusal } from "../workspace/attachments";
import {
  WORKSPACE_POLICY_ID,
  workspaceRunOutputDirectory
} from "../../domain/workspace";
import { acceptWorkspaceBrowserSequence, bindWorkspaceSecrets, lockWorkspaceSecretOwner } from "../workspace/secrets/store";
import {
  applyAcceptedChatAssistant,
  assertAssistantRunProvenance,
  insertAcceptedMcpRunBindings,
  insertAcceptedProviderRunBindings,
  insertAcceptedSkillRunBindings,
  persistAcceptedRunDefaults,
  repeatableReadTransaction
} from "./prismaRepositoryBindings";
import {
  activeModelRunStatuses,
  activeMessageStatuses,
  json,
  lockRunSettlementScope,
  mapActiveRunConflict,
  unique
} from "./prismaRepositoryShared";


function assertWorkspaceAdmissionShape(
  input: PreparingRunAdmissionInput,
  plan: WorkspaceRunAdmissionPlan
): void {
  const workspace = input.normalizedRequest.workspace;
  if (
    !workspace?.enabled ||
    plan.chatId !== input.chatId ||
    plan.normalized.sessionId !== plan.sessionId ||
    plan.normalized.outputDirectory !== workspaceRunOutputDirectory(plan.runId) ||
    JSON.stringify(plan.normalized) !== JSON.stringify(workspace) ||
    plan.toolDefinitions.length === 0 ||
    new Set(plan.toolDefinitions.map((tool) => tool.namespacedName)).size !==
      plan.toolDefinitions.length ||
    plan.toolDefinitions.some((tool) =>
      tool.namespacedName.length > 256 ||
      !tool.namespacedName.trim() ||
      !tool.description.trim()
    )
  ) {
    throw new WorkspaceRunConflictError("workspace_runtime_incompatible");
  }
}

/**
 * The chat's Workspace is busy for this run: the public code stays `workspace_busy`, and the content-free log names
 * which rule refused it, so a refusal beside attached background runs can be told apart (`run_preparation`).
 */
function workspaceBusy(plan: Pick<WorkspaceRunAdmissionPlan, "runId">, reason: string): WorkspaceRunConflictError {
  logEvent("run_preparation", { code: reason, outcome: "failed", run_id: plan.runId, stage: "preparing" });
  return new WorkspaceRunConflictError("workspace_busy", reason);
}

export async function reserveAcceptedWorkspaceSession(
  tx: Prisma.TransactionClient, plan: WorkspaceRunAdmissionPlan
): Promise<void> {
  // Background sub-agent runs share the chat's Workspace: they are attached runs this run joins, never a conflict.
  const active = await tx.modelRun.count({
    where: {
      chatId: plan.chatId,
      id: { not: plan.runId },
      status: { in: activeModelRunStatuses },
      subagentTurnId: null,
      workspaceRunBinding: { isNot: null }
    }
  });
  if (active > 0) throw workspaceBusy(plan, "workspace_busy_main_run_active");

  const expiresAt = new Date(plan.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new WorkspaceRunConflictError("workspace_runtime_incompatible");
  }
  await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "chatId" = ${plan.chatId} FOR UPDATE`;
  const existing = await tx.workspaceSession.findUnique({
    where: { chatId: plan.chatId }
  });
  if (existing) {
    // A session without a guest disk adopts the admitted image, as admission
    // chose it; a disk keeps the image it was created from. Busy states stay
    // refused below.
    const adoptsImage = existing.imageRef !== plan.normalized.imageRef && existing.runtimeSandboxId === null;
    if (
      existing.id !== plan.sessionId ||
      existing.sandboxName !== plan.sandboxName ||
      (existing.imageRef !== plan.normalized.imageRef && !adoptsImage) ||
      existing.internetEnabled !== plan.normalized.internetEnabled
    ) {
      throw workspaceBusy(plan, "workspace_busy_session_mismatch");
    }
    // Sub-agent runs of the chat hold a live run operation: this run attaches to that same VM and operation.
    if (existing.operationOwner !== null) {
      if (adoptsImage) throw workspaceBusy(plan, "workspace_busy_session_mismatch");
      if (!(await joinWorkspaceRunOperation(tx, existing, plan.runId))) {
        throw workspaceBusy(plan, await workspaceJoinRefusal(tx, existing));
      }
      return;
    }
    if (
      existing.state === "FAILED" ||
      existing.state === "RUNNING" ||
      existing.state === "CREATING" ||
      existing.state === "DELETING"
    ) {
      throw workspaceBusy(plan, existing.state === "FAILED" ? "workspace_busy_session_failed" : "workspace_busy_session_state");
    }
    // Session-operation fence: background export recovery claims its lease
    // under this same row lock only while the chat has no active run, and a
    // new run must not mutate the sandbox while such a lease streams outputs.
    const openExecutions = await tx.workspaceExecution.count({
      where: { workspaceSessionId: existing.id, state: { in: [...WORKSPACE_EXECUTION_OPEN_STATES] } }
    });
    const unregisteredCommands = await tx.modelRunToolCall.count({ where: {
      ...UNREGISTERED_WORKSPACE_COMMAND_FILTER,
      workspaceRunBinding: { workspaceSessionId: existing.id }
    } });
    if (openExecutions > 0 || unregisteredCommands > 0) throw workspaceBusy(plan, "workspace_busy_open_work");
    const liveExports = await tx.workspaceRunBinding.count({
      where: {
        exportLeaseExpiresAt: { gt: new Date() },
        exportState: "EXPORTING",
        workspaceSessionId: existing.id
      }
    });
    if (liveExports > 0) throw workspaceBusy(plan, "workspace_busy_live_export");
    await tx.workspaceSession.update({
      data: {
        ...(adoptsImage ? { imageRef: plan.normalized.imageRef } : {}),
        operationOwner: workspaceRunOperationOwner(plan.runId),
        operationExpiresAt: null, version: { increment: 1 }
      },
      where: { id: existing.id }
    });
    await recordWorkspaceAttachment(tx, { chatId: plan.chatId, generation: existing.version + 1, runId: plan.runId });
  } else {
    await tx.workspaceSession.create({
      data: {
        chatId: plan.chatId,
        expiresAt,
        id: plan.sessionId,
        imageRef: plan.normalized.imageRef,
        internetEnabled: plan.normalized.internetEnabled,
        operationOwner: workspaceRunOperationOwner(plan.runId),
        policyRevision: plan.policyRevision,
        sandboxName: plan.sandboxName,
        state: "PENDING"
      }
    });
    await recordWorkspaceAttachment(tx, { chatId: plan.chatId, generation: 1, runId: plan.runId });
  }
}

export async function insertAcceptedWorkspaceRunBinding(
  tx: Prisma.TransactionClient,
  input: PreparingRunAdmissionInput,
  ids: Readonly<{
    assistantMessageId: string;
    runId: string;
    userMessageId: string;
  }>,
  deferSessionClaim = false
): Promise<void> {
  const plan = input.workspaceAdmissionPlan;
  // An accepted run writes its Workspace choice back to the chat's switch,
  // except a scheduled task's run: it never changes an existing chat's switch,
  // and a chat it creates already starts with the task's setting.
  const writesChatSwitch = !(input.admissionKind === "NORMAL_SEND" && input.scheduledOccurrence);
  if (!plan) {
    if (input.normalizedRequest.workspace || input.workspaceEnabled === true) {
      throw new WorkspaceRunConflictError("workspace_runtime_incompatible");
    }
    if (input.workspaceEnabled !== undefined && writesChatSwitch) {
      await tx.chat.update({
        data: { workspaceEnabled: false },
        where: { id: input.chatId }
      });
    }
    return;
  }
  assertWorkspaceAdmissionShape(input, plan);
  if (
    plan.runId !== ids.runId ||
    plan.userMessageId !== ids.userMessageId ||
    plan.assistantMessageId !== ids.assistantMessageId
  ) {
    throw new WorkspaceRunConflictError("workspace_runtime_incompatible");
  }
  const policy = await tx.workspacePolicy.findUnique({
    select: { enabled: true, version: true },
    where: { id: WORKSPACE_POLICY_ID }
  });
  if (!policy?.enabled || policy.version !== plan.policyRevision) {
    throw new WorkspaceRunConflictError("workspace_disabled");
  }
  if (deferSessionClaim) {
    await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "chatId" = ${input.chatId} FOR UPDATE`;
    const existing = await tx.workspaceSession.findUnique({ where: { chatId: input.chatId } });
    if (!input.workspaceFollowup || !existing || existing.id !== plan.sessionId ||
      existing.sandboxName !== plan.sandboxName || existing.imageRef !== plan.normalized.imageRef ||
      existing.internetEnabled !== plan.normalized.internetEnabled) {
      throw new WorkspaceRunConflictError("workspace_busy");
    }
  } else {
    await reserveAcceptedWorkspaceSession(tx, plan);
  }
  await tx.workspaceRunBinding.create({
    data: {
      guestUsedAt: null,
      browserSessionSequence: await acceptWorkspaceBrowserSequence(tx, input.userId, input.chatId),
      imageRef: plan.normalized.imageRef,
      internetEnabled: plan.normalized.internetEnabled,
      mcpVersion: plan.normalized.mcpVersion,
      modelRunId: ids.runId,
      outputDirectory: plan.normalized.outputDirectory,
      policyRevision: plan.policyRevision,
      runtimeVersion: plan.normalized.runtimeVersion,
      toolCatalogHash: plan.normalized.toolCatalogHash,
      toolDefinitions: json(plan.toolDefinitions),
      workspaceSessionId: plan.sessionId
    }
  });
  await bindWorkspaceSecrets(tx, { runId: ids.runId, userId: input.userId, chatId: input.chatId });
  if (writesChatSwitch) {
    await tx.chat.update({
      data: { workspaceEnabled: true },
      where: { id: input.chatId }
    });
  }
}

async function insertRunPdfAdmissions(
  tx: Prisma.TransactionClient, input: PreparingRunAdmissionInput, runId: string
): Promise<void> {
  if (!input.chatPdfAdmissions?.length) {
    if (input.deferredPdf) throw new ChatPdfPreparationError("pdf_preparation_invalid");
    return;
  }
  if (!input.providerAdmissionPlan) throw new ProviderAdmissionConflictError();
  const originals = await tx.attachment.findMany({ select: { id: true }, where: {
    id: { in: input.normalizedRequest.attachmentIds }, kind: "pdf"
  } });
  if (originals.length !== input.chatPdfAdmissions.length ||
    new Set(input.chatPdfAdmissions.map(({ attachmentId }) => attachmentId)).size !== originals.length ||
    originals.some(({ id }) => !input.chatPdfAdmissions!.some(({ attachmentId }) => attachmentId === id))) {
    throw new AttachmentLinkConflictError();
  }
  await insertChatPdfAdmissions(tx, {
    admissions: input.chatPdfAdmissions, answer: input.providerAdmissionPlan.answer,
    deferred: input.deferredPdf, runId
  });
}

function attachmentLinkReadinessWhere(
  input: PreparingRunAdmissionInput
): Prisma.AttachmentWhereInput {
  if (input.normalizedRequest.workspace?.enabled === true) {
    return {};
  }
  if (!input.chatPdfAdmissions?.length && !input.normalizedRequest.modelCapabilities.nativePdfInput) {
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

export type LockedPreparingRun = Readonly<{
  pdfPreparationRequired?: boolean;
  workspacePreparationRequired?: boolean;
  workspaceWaitPending: boolean;
  assistantId: string | null;
  assistantMessageId: string | null;
  assistantIdentity: Prisma.JsonValue | null;
  chatId: string;
  id: string;
  modelId: string;
  normalizedRequest: Prisma.JsonValue | null;
  provider: string;
  status: ModelRunStatus;
  userId: string;
  userMessageId: string;
}>;

/** The chat row an admission locks `FOR UPDATE` before it writes the chat, its messages and its run. */
type LockedAdmissionChat = Readonly<{
  activeLeafMessageId: string | null;
  archived: boolean;
  folderId: string | null;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  temporaryRetentionDeadline: Date | null;
}>;

export async function lockPreparingRun(
  tx: Prisma.TransactionClient,
  runId: string,
  userId: string
): Promise<LockedPreparingRun | null> {
  await lockRunSettlementScope(tx, runId);
  const [run] = await tx.$queryRaw<LockedPreparingRun[]>(Prisma.sql`
    SELECT
      "assistantId", "assistantMessageId", "assistantIdentity", "chatId", "id",
      "modelId", "normalizedRequest", "provider",
      "status", "userId", "userMessageId", "workspaceWaitPending",
      EXISTS (SELECT 1 FROM "WorkspaceFollowup" f
        WHERE f."modelRunId" = "ModelRun"."id" AND f."state" IN ('waiting','preparing'))
        AS "workspacePreparationRequired",
      EXISTS (SELECT 1 FROM "ChatPdfRunPreparation" p
        WHERE p."modelRunId" = "ModelRun"."id" AND p."state" IN ('pending','preparing','answer_ready'))
        AS "pdfPreparationRequired"
    FROM "ModelRun"
    WHERE "id" = ${runId} AND "userId" = ${userId}
    FOR UPDATE
  `);
  return run ?? null;
}

/**
 * The owner's row, before any chat row: the order account deletion and the memory note's writers take, so an admission
 * racing either waits instead of deadlocking.
 */
async function lockAdmissionOwner(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<boolean> {
  const owners = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE
  `);
  return owners.length === 1;
}

/** Canonical JSON (keys sorted, undefined members left out), so equal content compares equal whatever its key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameContent(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

type DispatchablePreparingRunAdmissionInput = Readonly<{
  assistantMessageId: string;
  chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  folderId: string | null;
  normalizedRequest: PreparingRunAdmissionInput["normalizedRequest"];
  runId: string;
  /** An answer to a scheduled task's prompt (its scheduled run or a later one), whatever its chat's Memory mode. */
  scheduledPrompt?: true;
  userMessageId: string;
}>;

/**
 * Every run is dispatchable in its admission transaction (operator decision 2026-11-22: Personal Memory's preparation is
 * removed). What a run reads of the memory note was frozen into its request before admission
 * (`lib/server/runs/runPreparation.ts`), so no Memory attempt or binding receives the content-bearing base request.
 */
export async function finalizeDispatchablePreparingRunAdmission(
  tx: Pick<Prisma.TransactionClient, "modelRun">,
  input: DispatchablePreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult> {
  await tx.modelRun.update({
    data: {
      normalizedRequest: json(input.normalizedRequest),
      status: "streaming"
    },
    where: { id: input.runId }
  });
  return {
    assistantMessageId: input.assistantMessageId,
    chatMemoryMode: input.chatMemoryMode,
    folderId: input.folderId,
    runId: input.runId,
    ...(input.scheduledPrompt ? { scheduledPrompt: true as const } : {}),
    userMessageId: input.userMessageId
  };
}

function assertPreparingAdmissionInput(input: PreparingRunAdmissionInput): void {
  const initialMode = "initialChatMode" in input ? input.initialChatMode : undefined;
  const manifest = decodeFrozenSkillManifest(input.normalizedRequest.skills);
  if (!manifest) throw new SkillRunConflictError();
  const requestSkills = manifest.pinned;
  const skillBindings = input.skillBindings ?? [];
  if (requestSkills.length !== skillBindings.length || requestSkills.some((skill, index) =>
    skill.skillId !== skillBindings[index]?.skillId ||
    skill.revisionId !== skillBindings[index]?.revisionId)) {
    throw new SkillRunConflictError();
  }
  if (initialMode !== undefined && !decodeMemoryInitialChatMode(initialMode).ok) {
    throw new RunAdmissionConflictError("memory_temporary_policy_review_required");
  }
  if (
    input.normalizedRequest.chatId !== input.chatId ||
    input.normalizedRequest.modelId !== input.modelId ||
    input.normalizedRequest.provider !== input.provider ||
    (input.admissionKind === "REGENERATE" && initialMode !== undefined) ||
    (input.admissionKind === "NORMAL_SEND" && input.personalChat !== undefined && (
      input.expectedActiveLeafId !== null ||
      (input.personalChat.memoryMode === "TEMPORARY") !==
        (initialMode?.chatMode === "TEMPORARY")
    )) ||
    (input.admissionKind === "NORMAL_SEND" &&
      !sameContent(input.normalizedRequest.content, input.content))
  ) {
    throw new RunAdmissionConflictError("memory_base_request_invalid");
  }
}

export async function admitPreparingRunWithClient(
  prismaClient: PrismaClient,
  input: PreparingRunAdmissionInput,
  options: Readonly<{ deadlineAtMs?: number }> = {}
): Promise<PreparingRunAdmissionResult> {
  assertPreparingAdmissionInput(input);
  return mapActiveRunConflict(() =>
    repeatableReadTransaction(prismaClient, async (tx) => {
      // Match account/settings owner -> chat lock order before freezing secrets.
      if (input.workspaceAdmissionPlan) await lockWorkspaceSecretOwner(tx, input.userId);
      else if (input.workspaceFollowup && !await lockAdmissionOwner(tx, input.userId)) {
        throw new WorkspaceFollowupError("workspace_followup_unavailable");
      }
      // The owner before any chat row, in the order account deletion and the memory note's writers take.
      if (!await lockAdmissionOwner(tx, input.userId)) {
        throw new RunAdmissionConflictError("memory_owner_unavailable");
      }
      if (input.normalizedRequest.instructionPreset) await assertInstructionPresetSelection(
        tx, input.userId, input.normalizedRequest.instructionPreset);
      // The definition is locked before the chat, in the order Assistant
      // deletion uses (definition, then its bound chats), so a send racing a
      // deletion waits instead of deadlocking; a remaining serialization
      // failure retries and then ends as the neutral conflict.
      if (input.assistant) {
        await assertAssistantRunProvenance(tx, {
          assistantId: input.assistant.assistantId,
          definitionVersion: input.assistant.definitionVersion,
          userId: input.userId
        });
      }
      const admissionNow = new Date();
      if (input.admissionKind === "NORMAL_SEND" && input.personalChat) {
        const defaults = await loadChatCreationDefaults(tx, input.userId);
        if (
          !defaults ||
          defaults.defaultProviderModelId !== input.personalChat.defaultProviderModelId ||
          (input.personalChat.folderId && !(await tx.folder.findFirst({
            select: { id: true },
            where: { id: input.personalChat.folderId, userId: input.userId }
          })))
        ) {
          throw new ActiveLeafConflictError();
        }
        try {
          await tx.chat.create({
            data: {
              defaultProviderModelId: input.personalChat.defaultProviderModelId,
              folderId: input.personalChat.folderId,
              id: input.chatId,
              memoryMode: input.personalChat.memoryMode === "TEMPORARY"
                ? "NORMAL"
                : input.personalChat.memoryMode,
              // A scheduled task's chat keeps its task as origin and starts with its final title.
              ...(input.scheduledOccurrence ? { scheduledTaskId: input.scheduledOccurrence.taskId } : {}),
              title: input.scheduledOccurrence?.newChat?.title ?? "New Chat",
              userId: input.userId,
              workspaceEnabled: input.workspaceEnabled === true,
              // A first message with an Assistant creates the chat bound.
              ...(input.chatAssistant?.bind ? { assistantId: input.chatAssistant.assistantId } : {})
            }
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new ActiveLeafConflictError();
          }
          throw error;
        }
      }
      const lockedChats = await tx.$queryRaw<LockedAdmissionChat[]>(Prisma.sql`
        SELECT
          "activeLeafMessageId", "archived", "folderId", "memoryMode", "temporaryRetentionDeadline"
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
      // A monitoring check keeps its chat's place in the chat list until its settlement shows a result
      // (`chatListTime.ts`): this transaction's writes to the chat put that time back once they are done.
      const keptChatTime = input.admissionKind === "NORMAL_SEND" && input.scheduledOccurrence &&
        input.normalizedRequest.monitoringVerdictTool === true
        ? await monitoringAdmissionChatTime(tx, { chatId: input.chatId,
          rotatedFromChatId: input.scheduledOccurrence.rotation?.fromChatId ?? null, userId: input.userId })
        : null;
      if (input.chatAssistant) await applyAcceptedChatAssistant(tx, input.chatId, input.chatAssistant);
      // The owner's computer choice for the chat's next messages, stored with the message that made it (`computerAdmission.ts`).
      if (input.chatComputer !== undefined) {
        await tx.chat.update({ data: { computerCwd: input.chatComputer?.cwd ?? null, computerDeviceId: input.chatComputer?.deviceId ?? null },
          where: { id: input.chatId } });
      }
      const workspaceFollowup = await prepareWorkspaceFollowupAdmission(tx, input);

      let assistantMessageId: string;
      let userMessageId: string;
      // The run answers a scheduled task's prompt: the prompt its scheduled run
      // posts now, or a stored one marked so (in its chat or a branch copy).
      let scheduledPrompt: boolean;

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
            throw new RunAdmissionConflictError("memory_temporary_chat_forbidden");
          }
        }

        const convertToTemporary = initialChatMode?.chatMode === "TEMPORARY" &&
          lockedChat.memoryMode === "NORMAL" && chat._count.messages === 0;
        const temporaryAdmission = lockedChat.memoryMode === "TEMPORARY" ||
          convertToTemporary;
        if (temporaryAdmission) {
          // A deadline already passed means the background worker may be deleting the chat
          // (`lib/server/chats/temporaryDeletion.ts`): it is gone for new messages.
          if (
            !convertToTemporary &&
            lockedChat.temporaryRetentionDeadline &&
            lockedChat.temporaryRetentionDeadline <= admissionNow
          ) {
            throw new RunAdmissionConflictError("memory_temporary_chat_expired");
          }
          // The deadline on the chat row is the deletion obligation; each admission and settlement moves it a day on.
          const deadline = temporaryChatRetentionDeadline(admissionNow);
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
            // A Temporary chat is never searched: whatever the empty chat was marked for (a rename) goes with it.
            await clearChatSearch(tx, { chatId: input.chatId });
          } else {
            await tx.chat.update({
              data: { temporaryRetentionDeadline: deadline },
              where: { id: input.chatId }
            });
          }
          lockedChat = { ...lockedChat, memoryMode: "TEMPORARY", temporaryRetentionDeadline: deadline };
        }

        // The prompt a scheduled run posts keeps that fact on the message
        // itself, committed with the run's scheduled origin.
        scheduledPrompt = input.scheduledOccurrence !== undefined;
        // Any other message continues the latest turn its user was shown, never a quiet check that turn's history
        // leaves out (operator decision 2026-11-11): the chat's leaf compared above stays the one the send expected,
        // and only the parent skips past the quiet checks that end the branch, settled and so fixed under the chat's
        // lock. Its context reads the branch without any quiet check (`withoutQuietChecks` in
        // `lib/server/runs/prismaRepository.ts`).
        const parentMessageId = !scheduledPrompt && input.expectedActiveLeafId
          ? await quietCheckStandIn(tx, input.chatId, input.expectedActiveLeafId) : input.expectedActiveLeafId;
        const userMessage = await tx.message.create({
          data: {
            chatId: input.chatId,
            content: json(input.content),
            ...(input.workspaceAdmissionPlan
              ? { id: input.workspaceAdmissionPlan.userMessageId }
              : input.normalizedRequest.mcpApproval?.guard?.version === 2 && input.normalizedRequest.mcpApproval.guard.currentMessageId
                ? { id: input.normalizedRequest.mcpApproval.guard.currentMessageId } : {}),
            modelId: input.modelId,
            parentMessageId,
            provider: input.provider,
            role: "user",
            ...(scheduledPrompt ? { scheduledTaskPrompt: true } : {}),
            // A continuation after an MCP approval: the server's turn, never the user's speech.
            ...(input.systemTurnKind ? { systemTurnKind: input.systemTurnKind } : {}),
            status: "complete"
          }
        });
        const assistantMessage = await tx.message.create({
          data: {
            chatId: input.chatId,
            content: json(textMessageContent("")),
            ...(input.workspaceAdmissionPlan
              ? { id: input.workspaceAdmissionPlan.assistantMessageId }
              : {}),
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
              savedAt: null,
              userId: input.userId
            }
          });
          if (linkedAttachments.count !== attachmentIds.length) {
            throw new AttachmentLinkConflictError();
          }
        }
        assistantMessageId = assistantMessage.id;
        userMessageId = userMessage.id;
        // The new answer becomes the chat's leaf; its settlement marks the chat for past-chat search
        // (`settleTerminalChatSource`), whatever its outcome.
        await tx.chat.update({ data: { activeLeafMessageId: assistantMessage.id }, select: { id: true },
          where: { id: input.chatId } });
        if (chat._count.messages === 0 && input.defaults) {
          await tx.chat.update({
            // Chats keep no Search plan of their own (operator decision
            // 2026-10-24); the column stays for compatibility, unwritten.
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
            throw new RunAdmissionConflictError("memory_temporary_chat_expired");
          }
          await tx.chat.update({
            data: { temporaryRetentionDeadline: temporaryChatRetentionDeadline(admissionNow) },
            where: { id: input.chatId }
          });
        }
        const userLeafWithoutAssistant = input.preSendAssistantMessageId === null;
        const preSendSourceMessageId = userLeafWithoutAssistant
          ? input.userMessageId
          : input.preSendAssistantMessageId;
        // An answer review recorded before the feature's removal reads as its question and latest
        // version: the chat's leaf may be a step that version stands for, and the version's stored
        // parent is the revision request, while it answers the source question.
        const leafMessageId = lockedChat.activeLeafMessageId;
        let reviewedPath: AnswerReviewPathView | null | undefined;
        const reviewed = async (): Promise<AnswerReviewPathView | null> => {
          if (reviewedPath === undefined) {
            reviewedPath = leafMessageId ? await loadAnswerReviewPathView(tx, input.chatId, leafMessageId) : null;
          }
          return reviewedPath;
        };
        // Quiet checks that end the branch leave its history (`lib/server/chats/quietScheduledChecks.ts`), so the
        // latest answer the user was shown is the leaf they read; its new version leaves them on the old branch.
        if (!preSendSourceMessageId || (leafMessageId !== preSendSourceMessageId &&
          (userLeafWithoutAssistant || ((await reviewed())?.standInId !== preSendSourceMessageId &&
            (!leafMessageId || await quietCheckStandIn(tx, input.chatId, leafMessageId) !== preSendSourceMessageId))))) {
          throw new ActiveLeafConflictError();
        }
        let reviewedVersion = false;
        if (userLeafWithoutAssistant) {
          const [sourceUser] = await tx.$queryRaw<Array<{
            scheduledTaskPrompt: boolean;
            userContent: Prisma.JsonValue;
            userRole: string;
          }>>(Prisma.sql`
            SELECT
              user_message."content" AS "userContent",
              user_message."role" AS "userRole",
              user_message."scheduledTaskPrompt" AS "scheduledTaskPrompt"
            FROM "Message" AS user_message
            WHERE user_message."chatId" = ${input.chatId}
              AND user_message."id" = ${input.userMessageId}
            FOR SHARE OF user_message
          `);
          if (!sourceUser || sourceUser.userRole !== "user" ||
            !sameContent(sourceUser.userContent, input.normalizedRequest.content)) {
            throw new ActiveLeafConflictError();
          }
          scheduledPrompt = sourceUser.scheduledTaskPrompt === true;
        } else {
          const [source] = await tx.$queryRaw<Array<{
            assistantParentId: string | null;
            assistantRole: string;
            scheduledTaskPrompt: boolean;
            userContent: Prisma.JsonValue;
            userRole: string;
          }>>(Prisma.sql`
            SELECT
              assistant."parentMessageId" AS "assistantParentId",
              assistant."role" AS "assistantRole",
              user_message."content" AS "userContent",
              user_message."role" AS "userRole",
              user_message."scheduledTaskPrompt" AS "scheduledTaskPrompt"
            FROM "Message" AS assistant
            INNER JOIN "Message" AS user_message
              ON user_message."chatId" = assistant."chatId"
             AND user_message."id" = ${input.userMessageId}
            WHERE assistant."chatId" = ${input.chatId}
              AND assistant."id" = ${preSendSourceMessageId}
            FOR SHARE OF assistant, user_message
          `);
          reviewedVersion = source !== undefined && source.assistantParentId !== input.userMessageId &&
            (await reviewed())?.parentOf(preSendSourceMessageId) === input.userMessageId;
          if (!source || source.assistantRole !== "assistant" || source.userRole !== "user" ||
            (source.assistantParentId !== input.userMessageId && !reviewedVersion) ||
            !sameContent(source.userContent, input.normalizedRequest.content)) {
            throw new ActiveLeafConflictError();
          }
          scheduledPrompt = source.scheduledTaskPrompt === true;
        }
        const assistantMessage = await tx.message.create({
          data: {
            chatId: input.chatId,
            content: json(textMessageContent("")),
            ...(input.workspaceAdmissionPlan
              ? { id: input.workspaceAdmissionPlan.assistantMessageId }
              : {}),
            modelId: input.modelId,
            parentMessageId: input.userMessageId,
            provider: input.provider,
            role: "assistant",
            status: "streaming"
          }
        });
        assistantMessageId = assistantMessage.id;
        userMessageId = input.userMessageId;
        // The new version becomes the chat's leaf, a branch change its settlement marks for past-chat search
        // (`settleTerminalChatSource`), whatever its outcome.
        await tx.chat.update({ data: { activeLeafMessageId: assistantMessage.id }, select: { id: true },
          where: { id: input.chatId } });
      }

      // No admission reads Personal Memory's settings (operator decision 2026-11-22): the run's frozen request carries
      // what it reads of the memory note, decided for the chat's mode at preparation. A chat another tab excluded,
      // resumed or otherwise changed since is no longer that chat, so the message is refused as stale, to send again in
      // the chat as it is now; nothing of it is written. An answer to a scheduled task's prompt reads by its task's
      // switch, whatever its chat's mode, so it goes on.
      if (input.preparedChatMode !== undefined && !scheduledPrompt && lockedChat.memoryMode !== input.preparedChatMode) {
        throw new ActiveLeafConflictError();
      }
      const scheduledOccurrence = input.admissionKind === "NORMAL_SEND" ? input.scheduledOccurrence : undefined;

      const run = await tx.modelRun.create({
        data: {
          ...(scheduledOccurrence ? {
            scheduledOccurrenceId: scheduledOccurrence.occurrenceId,
            scheduledTaskGeneration: scheduledOccurrence.taskGeneration,
            scheduledTaskId: scheduledOccurrence.taskId
          } : {}),
          ...admittedFollowupFields(input),
          assistantMessageId,
          ...(input.assistant
            ? {
                assistantId: input.assistant.assistantId,
                assistantIdentity: input.assistant.identity as unknown as Prisma.InputJsonValue
              }
            : {}),
          chatId: input.chatId,
          // Written explicitly: the column's default names the old core.
          engine: "native",
          ...(input.workspaceAdmissionPlan ? { id: input.workspaceAdmissionPlan.runId } : {}),
          modelId: input.modelId,
          provider: input.provider,
          status: "preparing",
          workspaceWaitPending: Boolean(workspaceFollowup),
          userId: input.userId,
          userMessageId
        }
      });
      if (scheduledOccurrence) {
        await linkScheduledTaskOccurrence(tx, { chatId: input.chatId, chatPeriod: scheduledOccurrence.chatPeriod ?? null,
          now: admissionNow, occurrenceId: scheduledOccurrence.occurrenceId,
          ...(scheduledOccurrence.previousResultCopy ? { previousResultCopy: scheduledOccurrence.previousResultCopy } : {}),
          ...(scheduledOccurrence.rotation ? { rotation: scheduledOccurrence.rotation } : {}),
          runId: run.id, taskChatEpoch: scheduledOccurrence.taskChatEpoch ?? 0, taskGeneration: scheduledOccurrence.taskGeneration,
          taskId: scheduledOccurrence.taskId, taskRevision: scheduledOccurrence.taskRevision,
          unavailableSources: input.admissionKind === "NORMAL_SEND" ? input.scheduledUnavailableSources ?? [] : [],
          userId: input.userId, userMessageId });
      } else if (input.admissionKind === "NORMAL_SEND" && input.subagentCallbackClaim) {
        // A wake-up turn is the server's, never a message of the user's: it takes its callbacks or is not created.
        await claimSubagentCallbacksForRun(tx, { chatId: input.chatId, runId: run.id, turns: input.subagentCallbackClaim.turns, userMessageId });
      } else if (input.admissionKind !== "NORMAL_SEND" || !input.messageLimitExempt) {
        // Message limits count interactive admissions in a log that outlives the chat; a Discord turn counts toward none.
        await recordUsageMessageAdmission(tx, { at: run.createdAt, userId: input.userId });
      }
      await insertAdmittedRunFollowups(tx, input, run.id);
      await insertAcceptedWorkspaceRunBinding(tx, input, {
        assistantMessageId,
        runId: run.id,
        userMessageId
      }, Boolean(workspaceFollowup));

      await insertAcceptedMcpRunBindings(tx, {
        bindings: input.mcpBindings ? [...input.mcpBindings] : undefined,
        tools: input.normalizedRequest.mcp?.tools ?? [],
        runId: run.id,
        userId: input.userId
      });
      await insertAcceptedSkillRunBindings(tx, {
        bindings: input.skillBindings,
        runId: run.id,
        userId: input.userId
      });
      await insertAcceptedProviderRunBindings(tx, {
        imagePlan: input.normalizedRequest.imagePlan,
        visionAnalysis: input.normalizedRequest.visionAnalysis,
        mcpGuard: input.normalizedRequest.mcpApproval?.guard?.plan,
        nativeBackgroundRequested: input.normalizedRequest.params.background === true,
        plan: input.providerAdmissionPlan,
        runId: run.id,
        userId: input.userId
      });
      await insertRunPdfAdmissions(tx, input, run.id);
      // An unattended scheduled send is not a composer choice of the owner.
      if (input.defaults && !scheduledOccurrence) {
        await persistAcceptedRunDefaults(tx, input.userId, input.defaults);
      }
      // Every write this admission makes to the chat is above, so a check's kept time goes back now.
      if (keptChatTime) await keepChatListTime(tx, input.chatId, keptChatTime);
      if (input.deferredPdf || workspaceFollowup) {
        // The deferred gate continues the run only while the chat still has this answer as its leaf, in this mode and
        // folder (`continueDeferredPreparedRunWithClient`, `activateWorkspaceFollowupWithClient`).
        const admitted: PreparingRunAdmissionResult = {
          assistantMessageId, chatMemoryMode: lockedChat.memoryMode,
          ...(input.deferredPdf ? { deferredPdf: true as const } : {}),
          ...(workspaceFollowup ? { deferredWorkspace: true as const } : {}),
          folderId: lockedChat.folderId,
          runId: run.id, userMessageId
        };
        if (input.deferredPdf) await storeChatPdfAdmissionResult(tx, run.id, admitted);
        if (workspaceFollowup) await storeWorkspaceFollowupAdmission(tx, workspaceFollowup, input.chatId, admitted);
        return admitted;
      }

      return finalizeDispatchablePreparingRunAdmission(tx, {
        assistantMessageId,
        chatMemoryMode: lockedChat.memoryMode,
        folderId: lockedChat.folderId,
        normalizedRequest: input.normalizedRequest,
        runId: run.id,
        ...(scheduledPrompt ? { scheduledPrompt: true as const } : {}),
        userMessageId
      });
    }, options)
  );
}

export type PreparingSettlementInput = Readonly<{
  workspaceClaimToken?: string;
  retryable?: boolean;
  errorCode: string;
  message: string;
  now?: Date;
  runId: string;
  state: "CANCELLED" | "EXPIRED" | "FAILED" | "STALE";
  userId: string;
}>;

export type TerminalChatSourceInput = Readonly<{
  assistantMessageId: string | null;
  chatId: string;
  runId: string;
  status: "cancelled" | "complete" | "error";
  userId: string;
}>;

/**
 * A run's terminal write to its chat, inside the transaction that settles the run: the chat moves to the top of the
 * chat list (a monitoring check keeps its place, `chatListTime.ts`), a Temporary chat's deletion deadline moves to a
 * day after this answer, and a main-agent answer marks the chat for past-chat search, whatever its outcome, since the
 * pass reconciles the passages with the active branch (`lib/server/chatSearch/index/dirty.ts`). The chat row is
 * locked before the mark, in the order the index pass takes it. A chat that is gone, fenced for permanent deletion or
 * has no personal owner (a legacy Project chat) is left alone; its runs still settle.
 */
export async function settleTerminalChatSource(
  tx: Prisma.TransactionClient,
  input: TerminalChatSourceInput
): Promise<void> {
  const [chat] = await tx.$queryRaw<Array<{ memoryMode: string }>>(Prisma.sql`
    SELECT "memoryMode"::text AS "memoryMode"
    FROM "Chat"
    WHERE "id" = ${input.chatId} AND "userId" = ${input.userId} AND "permanentDeletionAt" IS NULL
    FOR UPDATE
  `);
  if (!chat) return;
  const keptChatTime = await monitoringCheckChatTime(tx, { chatId: input.chatId, runId: input.runId });
  const now = new Date();
  await tx.chat.update({
    data: chat.memoryMode === "TEMPORARY"
      ? { temporaryRetentionDeadline: temporaryChatRetentionDeadline(now), updatedAt: now }
      : { updatedAt: now },
    select: { id: true },
    where: { id: input.chatId }
  });
  if (keptChatTime) await keepChatListTime(tx, input.chatId, keptChatTime);
  if (input.assistantMessageId) await markChatSearchDirty(tx, { chatId: input.chatId, userId: input.userId });
}

/**
 * Settles a run still waiting at its PDF or Workspace gate, the only runs left `preparing` once admission commits
 * (every other run is dispatchable at once, operator decision 2026-11-22); false for any other run.
 */
export async function settlePreparingRunInTransaction(
  tx: Prisma.TransactionClient,
  input: PreparingSettlementInput
): Promise<boolean> {
  const run = await lockPreparingRun(tx, input.runId, input.userId);
  if (!run || run.status !== "preparing") return false;
  if (input.workspaceClaimToken) await assertWorkspaceFollowupClaim(tx, {
    claimToken: input.workspaceClaimToken, runId: input.runId, userId: input.userId
  }, "settlement");
  if (!run.pdfPreparationRequired && !run.workspacePreparationRequired) return false;
  const errorCode = /^[a-z][a-z0-9_]{0,63}$/u.test(input.errorCode)
    ? input.errorCode
    : "memory_preparing_failed";
  const cancelled = input.state === "CANCELLED";
  await tx.modelRun.update({
    data: {
      errorPayload: json({ code: errorCode, message: input.message,
        ...(input.retryable !== undefined ? { retryable: input.retryable } : {}) }),
      // A gated run's request was never written (it is written when its gate continues it).
      normalizedRequest: json({}),
      status: cancelled ? "cancelled" : "error",
      workspaceWaitPending: false
    },
    where: { id: run.id }
  });
  if (run.workspacePreparationRequired) await tx.workspaceFollowup.updateMany({
    where: { modelRunId: run.id, state: { in: ["waiting", "preparing"] } },
    data: { state: cancelled ? "cancelled" : "failed", errorCode,
      snapshot: Prisma.DbNull, admissionResult: Prisma.DbNull, claimToken: null, leaseExpiresAt: null }
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
  await settleTerminalChatSource(tx, {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    runId: run.id,
    status: cancelled ? "cancelled" : "error",
    userId: input.userId
  });
  return true;
}

export async function settlePreparingRunFailureWithClient(
  prismaClient: PrismaClient,
  input: PreparingSettlementInput
): Promise<boolean> {
  return prismaClient.$transaction((tx) => settlePreparingRunInTransaction(tx, input));
}

/** Whether the run asked for Workspace and, when not, the request's closed reason (`run_accepted`). */
function runAcceptedWorkspaceFields(admission: PreparingRunAdmissionInput) {
  return admission.workspaceEnabled === true
    ? { workspace_requested: true }
    : { workspace_requested: false, workspace_reason: admission.workspaceNotRequestedReason ?? "unknown" as const };
}

export async function createDormantPreparingRun(
  prismaClient: PrismaClient,
  admission: PreparingRunAdmissionInput
): Promise<PreparingRunAdmissionResult & Readonly<{ acceptedAt: Date }>> {
  const created = await admitPreparingRunWithClient(prismaClient, admission);
  logEvent("run_accepted", { run_id: created.runId,
    kind: admission.admissionKind === "NORMAL_SEND" ? "send" : "regenerate",
    preparation: created.deferredPdf ? "pdf" : "ready", ...runAcceptedWorkspaceFields(admission) });
  return { ...created, acceptedAt: new Date() };
}

async function continueDeferredPreparedRunWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{
    admission: PreparingRunAdmissionInput;
    claimToken: string;
    created: PreparingRunAdmissionResult;
  }>,
  gate: "pdf" | "workspace" = "pdf"
): Promise<PreparingRunAdmissionResult> {
  const { admission, created } = input;
  const failure = (kind: "unavailable" | "invalid" | "ambiguous") => gate === "pdf"
    ? new ChatPdfPreparationError(`pdf_preparation_${kind}`, kind === "ambiguous")
    : new WorkspaceFollowupError(kind === "ambiguous" ? "workspace_followup_interrupted" :
      kind === "invalid" ? "workspace_followup_invalid" : "workspace_followup_unavailable");
  return repeatableReadTransaction(prismaClient, async (tx) => {
    if (!(await lockAdmissionOwner(tx, admission.userId))) {
      throw failure("unavailable");
    }
    await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${admission.chatId} FOR UPDATE`;
    const chat = await tx.chat.findFirst({ where: {
      id: admission.chatId, archived: false, permanentDeletionAt: null
    } });
    const run = await lockPreparingRun(tx, created.runId, admission.userId);
    const claim = { claimToken: input.claimToken, runId: created.runId, userId: admission.userId };
    if (gate === "pdf") await assertChatPdfClaim(tx, claim);
    else await assertWorkspaceFollowupClaim(tx, claim);
    const pending = await tx.chatPdfAttachmentPreparation.count({ where: {
      modelRunId: created.runId, state: { notIn: ["ready", "original_only"] }
    } });
    if (!chat || !run || run.status !== "preparing" || run.workspaceWaitPending || pending ||
      chat.activeLeafMessageId !== created.assistantMessageId) {
      throw failure("unavailable");
    }
    // The run's frozen request decided what it reads of the memory note for the chat's mode at admission: a chat whose
    // mode changed since (now Temporary, or excluded from Memory) is no longer the one it was admitted in.
    if (chat.userId !== admission.userId || chat.memoryMode !== created.chatMemoryMode) {
      throw failure("unavailable");
    }
    await tx.modelRun.update({ where: { id: created.runId }, data: {
      normalizedRequest: json(admission.normalizedRequest), status: "streaming"
    } });
    return created;
  });
}

export const continuePdfPreparedRunWithClient = continueDeferredPreparedRunWithClient;

/** Transfer execution ownership only after the predecessor's terminal commit.
 * No guest, provider or Memory I/O is performed inside this transaction. */
export async function activateWorkspaceFollowupWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{ admission: PreparingRunAdmissionInput; claimToken: string; created: PreparingRunAdmissionResult }>
): Promise<PreparingRunAdmissionResult> {
  const { admission } = input;
  return repeatableReadTransaction(prismaClient, async (tx) => {
    if (!await lockAdmissionOwner(tx, admission.userId)) throw new WorkspaceFollowupError("workspace_followup_unavailable");
    await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${admission.chatId} FOR UPDATE`;
    const run = await lockPreparingRun(tx, input.created.runId, admission.userId);
    await assertWorkspaceFollowupClaim(tx, { claimToken: input.claimToken, runId: input.created.runId, userId: admission.userId });
    const job = await tx.workspaceFollowup.findUniqueOrThrow({ where: { modelRunId: input.created.runId },
      include: { predecessor: { select: { errorPayload: true, status: true } } } });
    const created = job.admissionResult as unknown as PreparingRunAdmissionResult;
    if (!run || created?.runId !== run.id || created.assistantMessageId !== run.assistantMessageId ||
      created.userMessageId !== run.userMessageId || run.chatId !== admission.chatId) {
      throw new WorkspaceFollowupError("workspace_followup_invalid");
    }
    if (!run.workspaceWaitPending) return created;
    if (job.deadlineAt <= new Date()) throw new WorkspaceFollowupError("workspace_followup_expired");
    if (!predecessorReleasesSuccessor(job.predecessor)) throw new WorkspaceFollowupError("workspace_followup_predecessor_failed");
    // The successor continues only the chat it was admitted in: any branch change moves the leaf off its answer.
    const chat = await tx.chat.findUniqueOrThrow({
      select: { activeLeafMessageId: true, folderId: true, memoryMode: true, userId: true },
      where: { id: admission.chatId }
    });
    if (chat.activeLeafMessageId !== created.assistantMessageId ||
      chat.userId !== admission.userId ||
      chat.memoryMode !== created.chatMemoryMode ||
      chat.folderId !== created.folderId) {
      throw new WorkspaceFollowupError("workspace_followup_unavailable");
    }
    if (admission.workspaceAdmissionPlan) {
      assertWorkspaceAdmissionShape(admission, admission.workspaceAdmissionPlan);
      if (admission.workspaceAdmissionPlan.runId !== run.id) throw new WorkspaceFollowupError("workspace_followup_invalid");
      await reserveAcceptedWorkspaceSession(tx, admission.workspaceAdmissionPlan);
    }
    const activated: PreparingRunAdmissionResult = { ...created, deferredWorkspace: undefined };
    await tx.modelRun.update({ where: { id: run.id }, data: { workspaceWaitPending: false } });
    if (created.deferredPdf) {
      await storeChatPdfAdmissionResult(tx, run.id, activated);
      await tx.workspaceFollowup.update({ where: { modelRunId: run.id }, data: {
        state: "released", snapshot: Prisma.DbNull, admissionResult: Prisma.DbNull, claimToken: null, leaseExpiresAt: null
      } });
    } else {
      await tx.workspaceFollowup.update({ where: { modelRunId: run.id }, data: { admissionResult: json(activated) } });
    }
    return activated;
  });
}

export async function continueWorkspacePreparedRunWithClient(
  prismaClient: PrismaClient,
  input: Readonly<{ admission: PreparingRunAdmissionInput; claimToken: string; created: PreparingRunAdmissionResult }>
): Promise<PreparingRunAdmissionResult> {
  const created = await activateWorkspaceFollowupWithClient(prismaClient, input);
  if (created.deferredPdf) return created;
  return continueDeferredPreparedRunWithClient(prismaClient, { ...input, created }, "workspace");
}
