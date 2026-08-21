import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryActionFeedback,
  type MemoryActionFeedback,
  type MemorySourceActionInput,
  type MemorySourceActionResponse
} from "../../../contracts/memoryClient";
import { prisma } from "../../prisma";
import {
  defaultMemoryClientRefService,
  type MemoryClientRefOperation,
  type MemoryClientRefService
} from "../actions/clientRef";
import { defaultExplicitMemoryService } from "../explicit/defaultExplicit";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import {
  ExplicitMemoryServiceError,
  type ExplicitMemoryService
} from "../explicit/service";
import { defaultMemoryLifecycleService } from "../lifecycle/defaultLifecycle";
import type { MemoryLifecycleService } from "../lifecycle/service";
import {
  MEMORY_MUTATION_AUTHORIZATION_TTL_MS,
  memoryMutationNonceHash,
  memoryTargetAuthorizationPayloadHash,
  createPrismaMemoryMutationAuthorizationRepository,
  type MemoryMutationAuthorizationMint,
  type MemoryMutationAuthorizationSnapshot
} from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";
import { createMemorySuppressionInTransaction } from "../persistence/suppressions";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  loadPersonalEligibleFactVersionIds,
  loadPersonalMemoryEvidenceSnapshots,
  loadPersonalMemoryRunIds
} from "../persistence/eligibility";
import { canonicalGlobalMemoryScopeWhere } from "../persistence/scopes";
import {
  loadMemorySuppressionKeyring,
  type MemorySuppressionKeyring
} from "../suppressionKeyring";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";

type SourceActionClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$transaction"
  | "chat"
  | "chatMemoryCheckpoint"
  | "memoryFact"
  | "memoryFactVersion"
  | "memoryEvent"
  | "memoryScope"
  | "memoryRecallChunk"
  | "memoryRecallChunkMessage"
  | "memorySuppression"
  | "message"
  | "memoryRetrievalAttempt"
  | "modelRunMemoryBinding"
  | "modelRunMemoryItem"
  | "modelRun"
>;

type AuthorizationRepository = Readonly<{
  mint(
    userId: string,
    input: MemoryMutationAuthorizationMint,
    now?: Date
  ): Promise<MemoryMutationAuthorizationSnapshot>;
}>;

export type MemoryRecallSourceMutationInput = Readonly<{
  branchGeneration: number;
  chatId: string;
  chunkId: string;
  contentHash: string;
  messageIds: readonly string[];
  requestNonce: string;
  sourceRevision: number;
}>;

export type MemoryRecallSourceMutationRepository = Readonly<{
  suppress(
    userId: string,
    input: MemoryRecallSourceMutationInput
  ): Promise<void>;
}>;

export class MemorySourceActionError extends Error {
  constructor(readonly code:
    | "memory_action_failed"
    | "memory_contract_invalid"
    | "memory_not_found"
    | "memory_secret_rejected"
    | "memory_version_stale") {
    super(code);
    this.name = "MemorySourceActionError";
  }
}

function operation(action: MemorySourceActionInput["action"]) {
  if (action === "CORRECT") return "EDIT" as const;
  return action;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recallSourceSuppressionId(input: Readonly<{
  chunkId: string;
  messageId: string;
  requestNonce: string;
  userId: string;
}>): string {
  return memorySha256({
    chunkId: input.chunkId,
    domain: "aiqsa.memory.source-recall-forget",
    messageId: input.messageId,
    requestNonce: input.requestNonce,
    userId: input.userId,
    version: 1
  });
}

export function createPrismaMemoryRecallSourceMutationRepository(
  keyring: MemorySuppressionKeyring,
  client: PrismaClient = prisma
): MemoryRecallSourceMutationRepository {
  return Object.freeze({
    async suppress(userId, mutation) {
      if (mutation.messageIds.length < 1 || mutation.messageIds.length > 50 ||
        new Set(mutation.messageIds).size !== mutation.messageIds.length) {
        throw new MemorySourceActionError("memory_contract_invalid");
      }
      await withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "Chat" AS chat
          WHERE chat."userId" = ${userId}
            AND chat."id" = ${mutation.chatId}
            AND chat."projectId" IS NULL
            AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
            AND chat."permanentDeletionAt" IS NULL
            AND chat."memoryBranchGeneration" = ${mutation.branchGeneration}
            AND chat."memorySourceRevision" = ${mutation.sourceRevision}
          FOR UPDATE OF chat
        `);
        if (!locked[0]) throw new MemorySourceActionError("memory_not_found");
        const [chunk, checkpoint, joins, messageCount] = await Promise.all([
          tx.memoryRecallChunk.findFirst({
            select: { id: true },
            where: {
              branchGeneration: mutation.branchGeneration,
              chatId: mutation.chatId,
              chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
              contentHash: mutation.contentHash,
              id: mutation.chunkId,
              redactionState: { not: "EXCLUDED" },
              safetyClass: { in: ["NORMAL", "SENSITIVE"] },
              sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
              sourceRevisionAtCreation: mutation.sourceRevision,
              state: "ACTIVE",
              userId
            }
          }),
          tx.chatMemoryCheckpoint.findUnique({
            select: { pipelineVersion: true },
            where: { userId_chatId: { chatId: mutation.chatId, userId } }
          }),
          tx.memoryRecallChunkMessage.findMany({
            orderBy: { ordinal: "asc" },
            select: { chatId: true, messageId: true },
            where: { chunkId: mutation.chunkId, userId }
          }),
          tx.message.count({
            where: {
              chatId: mutation.chatId,
              id: { in: [...mutation.messageIds] }
            }
          })
        ]);
        if (!chunk || checkpoint?.pipelineVersion !== MEMORY_HISTORY_INDEX_PIPELINE_VERSION ||
          joins.some((join) => join.chatId !== mutation.chatId) ||
          !sameStrings(joins.map(({ messageId }) => messageId), mutation.messageIds) ||
          messageCount !== mutation.messageIds.length) {
          throw new MemorySourceActionError("memory_not_found");
        }
        let counterAdvanced = false;
        for (const messageId of mutation.messageIds) {
          const created = await createMemorySuppressionInTransaction(
            tx,
            settings,
            keyring,
            {
              branchGeneration: mutation.branchGeneration,
              chatId: mutation.chatId,
              explicitOverrideAllowed: true,
              expiresAt: null,
              messageId,
              scope: "SOURCE_MESSAGE",
              suppressionId: recallSourceSuppressionId({
                chunkId: mutation.chunkId,
                messageId,
                requestNonce: mutation.requestNonce,
                userId
              })
            },
            { advanceMemory: !counterAdvanced }
          );
          if (created.created) counterAdvanced = true;
        }
      });
    }
  });
}

type ActionResultRefProof = Readonly<{
  frozenReplacementStatement: string | null;
}>;

function actionResultRefProof(
  result: MemoryActionFeedback,
  memoryRef: string,
  requestedOperation: "EDIT" | "FORGET"
): ActionResultRefProof | null {
  if (result.status === "COMMITTED" &&
    (result.operation === "SAVE" || result.operation === "UPDATE") &&
    result.memoryRef === memoryRef) {
    return { frozenReplacementStatement: null };
  }
  if (result.status === "COMPLETE" &&
    result.items?.some((item) => item.memoryRef === memoryRef)) {
    return { frozenReplacementStatement: null };
  }
  if (result.status !== "AMBIGUOUS" ||
    !result.candidates?.some((candidate) => candidate.memoryRef === memoryRef)) {
    return null;
  }
  if (result.operation === "FORGET") {
    return requestedOperation === "FORGET"
      ? { frozenReplacementStatement: null }
      : null;
  }
  return requestedOperation === "EDIT" && result.operation === "UPDATE" && result.statement
    ? { frozenReplacementStatement: result.statement }
    : null;
}

export function createMemorySourceActionService(input: Readonly<{
  authorizationRepository: AuthorizationRepository;
  client: SourceActionClient;
  clientRefs?: MemoryClientRefService;
  explicitService: ExplicitMemoryService;
  lifecycleService: MemoryLifecycleService;
  recallMutationRepository?: MemoryRecallSourceMutationRepository;
}>) {
  const refs = input.clientRefs ?? defaultMemoryClientRefService;

  async function resolveBoundTarget(
    userId: string,
    memoryRef: string,
    requestedOperation: MemoryClientRefOperation,
    now: Date,
    requestNonce?: string
  ) {
    const ref = refs.resolve(userId, memoryRef, requestedOperation, now);
    if (!ref) throw new MemorySourceActionError("memory_not_found");
    const personalRunIds = await loadPersonalMemoryRunIds(
      input.client,
      userId,
      [ref.originatingRunId]
    );
    if (!personalRunIds.has(ref.originatingRunId)) {
      throw new MemorySourceActionError("memory_not_found");
    }
    const binding = await input.client.modelRunMemoryBinding.findFirst({
      select: { id: true },
      where: { modelRunId: ref.originatingRunId, userId }
    });
    const item = binding ? await input.client.modelRunMemoryItem.findFirst({
      select: {
        factVersionId: true,
        id: true,
        itemType: true,
        recallChunkId: true,
        sourceBranchGenerationSnapshot: true,
        sourceChatIdSnapshot: true,
        sourceContentHashSnapshot: true,
        sourceMessageIdsSnapshot: true,
        sourceRevisionSnapshot: true
      },
      where: {
        bindingId: binding.id,
        exactItemId: ref.target.exactItemId,
        itemType: ref.target.itemType,
        userId
      }
    }) : null;
    if (!binding) throw new MemorySourceActionError("memory_not_found");
    if (item && (item.itemType !== ref.target.itemType ||
      item.factVersionId !== ref.target.factVersionId ||
      item.recallChunkId !== ref.target.recallChunkId ||
      item.sourceChatIdSnapshot !== ref.target.sourceChatId ||
      !sameStrings(item.sourceMessageIdsSnapshot, ref.target.sourceMessageIds))) {
      throw new MemorySourceActionError("memory_not_found");
    }

    let actionResultProof: ActionResultRefProof | null = null;
    if (!item) {
      if (ref.target.itemType !== "FACT_VERSION" ||
        (requestedOperation !== "EDIT" && requestedOperation !== "FORGET")) {
        throw new MemorySourceActionError("memory_not_found");
      }
      const attempt = await input.client.memoryRetrievalAttempt.findFirst({
        orderBy: { attemptOrdinal: "desc" },
        select: { budgetSnapshot: true },
        where: {
          modelRunId: ref.originatingRunId,
          state: "CONSUMED",
          userId
        }
      });
      const decoded = decodeMemoryActionFeedback(
        attempt && typeof attempt.budgetSnapshot === "object" &&
          attempt.budgetSnapshot !== null && !Array.isArray(attempt.budgetSnapshot)
          ? (attempt.budgetSnapshot as Record<string, unknown>).memoryActionResult
          : undefined
      );
      actionResultProof = decoded.ok
        ? actionResultRefProof(decoded.value, memoryRef, requestedOperation)
        : null;
      if (!actionResultProof) throw new MemorySourceActionError("memory_not_found");
    }

    if (ref.target.itemType === "FACT_VERSION") {
      if (!ref.target.factId || !ref.target.factVersionId) {
        throw new MemorySourceActionError("memory_not_found");
      }
      const [fact, version] = await Promise.all([
        input.client.memoryFact.findFirst({
          select: { currentVersionId: true, scopeId: true, state: true },
          where: { id: ref.target.factId, userId }
        }),
        input.client.memoryFactVersion.findFirst({
          select: {
            contentPurgedAt: true,
            id: true,
            safetyClassificationState: true,
            sensitivityClass: true,
            sourceMode: true,
            state: true
          },
          where: { factId: ref.target.factId, id: ref.target.factVersionId, userId }
        })
      ]);
      if (!fact || !version) throw new MemorySourceActionError("memory_not_found");
      const scope = await input.client.memoryScope.findFirst({
        select: { id: true },
        where: {
          ...canonicalGlobalMemoryScopeWhere(),
          id: fact.scopeId,
          userId
        }
      });
      if (!scope) throw new MemorySourceActionError("memory_not_found");
      const eligibleVersionIds = await loadPersonalEligibleFactVersionIds(
        input.client,
        userId,
        [version.id]
      );
      if (fact.state !== "ACTIVE" || fact.currentVersionId !== version.id ||
        version.state !== "ACTIVE" || version.contentPurgedAt !== null ||
        version.safetyClassificationState !== "CLASSIFIED" ||
        !eligibleVersionIds.has(version.id) ||
        (version.sensitivityClass !== "NORMAL" &&
          version.sensitivityClass !== "SENSITIVE")) {
        throw new MemorySourceActionError("memory_version_stale");
      }
      let sourceNavigation: Readonly<{ chatId: string; messageId: string }> | null = null;
      if (version.sourceMode === "AUTOMATIC" && item && ref.target.sourceChatId &&
        item.sourceBranchGenerationSnapshot !== null &&
        ref.target.sourceMessageIds.length > 0) {
        const [evidence, sourceChat, sourceMessages] = await Promise.all([
          loadPersonalMemoryEvidenceSnapshots(input.client, userId, [version.id]),
          input.client.chat.findFirst({
            select: { id: true, memoryBranchGeneration: true },
            where: {
              id: ref.target.sourceChatId,
              memoryMode: "NORMAL",
              permanentDeletionAt: null,
              projectId: null,
              userId
            }
          }),
          input.client.message.findMany({
            select: { id: true },
            where: {
              chatId: ref.target.sourceChatId,
              id: { in: [...ref.target.sourceMessageIds] }
            }
          })
        ]);
        const evidenceMessageIds = new Set(evidence.flatMap((candidate) =>
          candidate.chatId === ref.target.sourceChatId &&
            candidate.branchGeneration === item.sourceBranchGenerationSnapshot
            ? [candidate.messageId]
            : []));
        const currentMessageIds = new Set(sourceMessages.map(({ id }) => id));
        if (sourceChat &&
          sourceChat.memoryBranchGeneration === item.sourceBranchGenerationSnapshot &&
          ref.target.sourceMessageIds.every((messageId) =>
            evidenceMessageIds.has(messageId) && currentMessageIds.has(messageId))) {
          sourceNavigation = {
            chatId: sourceChat.id,
            messageId: ref.target.sourceMessageIds[0]!
          };
        }
      }
      if (requestedOperation === "OPEN_SOURCE" && !sourceNavigation) {
        throw new MemorySourceActionError("memory_not_found");
      }
      return { actionResultProof, item, ref, sourceNavigation, version };
    }

    if (!item) throw new MemorySourceActionError("memory_not_found");
    if (!ref.target.recallChunkId || !ref.target.sourceChatId ||
      item.sourceBranchGenerationSnapshot === null || item.sourceContentHashSnapshot === null ||
      item.sourceRevisionSnapshot === null || ref.target.sourceMessageIds.length === 0) {
      throw new MemorySourceActionError("memory_not_found");
    }
    const [chunk, chat, checkpoint, joins, messages, sourceSuppressions] = await Promise.all([
      input.client.memoryRecallChunk.findFirst({
        select: {
          branchGeneration: true,
          chatId: true,
          chunkingVersion: true,
          contentHash: true,
          sourceProjectionVersion: true,
          sourceRevisionAtCreation: true,
          state: true
        },
        where: { id: ref.target.recallChunkId, userId }
      }),
      input.client.chat.findFirst({
        select: {
          id: true,
          memoryBranchGeneration: true,
          memoryMode: true,
          memorySourceRevision: true
        },
        where: {
          id: ref.target.sourceChatId,
          permanentDeletionAt: null,
          projectId: null,
          userId
        }
      }),
      input.client.chatMemoryCheckpoint.findUnique({
        select: { pipelineVersion: true },
        where: {
          userId_chatId: { chatId: ref.target.sourceChatId, userId }
        }
      }),
      input.client.memoryRecallChunkMessage.findMany({
        orderBy: { ordinal: "asc" },
        select: { chatId: true, messageId: true },
        where: { chunkId: ref.target.recallChunkId, userId }
      }),
      input.client.message.findMany({
        select: { id: true },
        where: {
          chatId: ref.target.sourceChatId,
          id: { in: [...ref.target.sourceMessageIds] }
        }
      }),
      input.client.memorySuppression.findMany({
        select: { id: true, sourceMessageId: true },
        where: {
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            {
              OR: [
                { sourceBranchGeneration: null },
                { sourceBranchGeneration: item.sourceBranchGenerationSnapshot }
              ]
            }
          ],
          scope: "SOURCE_MESSAGE",
          sourceChatId: ref.target.sourceChatId,
          sourceMessageId: { in: [...ref.target.sourceMessageIds] },
          userId
        }
      })
    ]);
    const joinedMessageIds = joins.map((join) => join.messageId);
    const currentMessageIds = new Set(messages.map((message) => message.id));
    const exactForgetReplay = requestedOperation === "FORGET" && requestNonce !== undefined &&
      ref.target.sourceMessageIds.every((messageId) => sourceSuppressions.some((suppression) =>
        suppression.sourceMessageId === messageId && suppression.id === recallSourceSuppressionId({
          chunkId: ref.target.recallChunkId!,
          messageId,
          requestNonce,
          userId
        })));
    if (!chunk || !chat || !checkpoint ||
      (sourceSuppressions.length > 0 && !exactForgetReplay) || chunk.chatId !== chat.id ||
      checkpoint.pipelineVersion !== MEMORY_HISTORY_INDEX_PIPELINE_VERSION ||
      chunk.state !== "ACTIVE" ||
      chunk.chunkingVersion !== MEMORY_HISTORY_CHUNKING_VERSION ||
      chunk.sourceProjectionVersion !== MEMORY_HISTORY_SOURCE_PROJECTION_VERSION ||
      chunk.branchGeneration !== item.sourceBranchGenerationSnapshot ||
      chunk.contentHash !== item.sourceContentHashSnapshot ||
      chunk.sourceRevisionAtCreation !== item.sourceRevisionSnapshot ||
      chat.memoryMode !== "NORMAL" ||
      chat.memoryBranchGeneration !== item.sourceBranchGenerationSnapshot ||
      chat.memorySourceRevision !== item.sourceRevisionSnapshot ||
      joins.some((join) => join.chatId !== chat.id) ||
      !sameStrings(joinedMessageIds, ref.target.sourceMessageIds) ||
      ref.target.sourceMessageIds.some((messageId) => !currentMessageIds.has(messageId))) {
      throw new MemorySourceActionError("memory_not_found");
    }
    return {
      actionResultProof,
      item,
      ref,
      sourceNavigation: {
        chatId: chat.id,
        messageId: ref.target.sourceMessageIds[0]!
      },
      version: null
    };
  }

  return Object.freeze({
    async resolveOpenSource(
      userId: string,
      memoryRef: string,
      now = new Date()
    ): Promise<Readonly<{ chatId: string; messageId: string }>> {
      const target = await resolveBoundTarget(userId, memoryRef, "OPEN_SOURCE", now);
      if (!target.sourceNavigation) throw new MemorySourceActionError("memory_not_found");
      return target.sourceNavigation;
    },

    async execute(
      userId: string,
      actionInput: MemorySourceActionInput,
      now = new Date()
    ): Promise<MemorySourceActionResponse> {
      const target = await resolveBoundTarget(
        userId,
        actionInput.memoryRef,
        operation(actionInput.action),
        now,
        actionInput.requestNonce
      );
      const { item, ref, version } = target;

      if (actionInput.action === "OPEN_SOURCE") {
        if (!target.sourceNavigation) throw new MemorySourceActionError("memory_not_found");
        const query = new URLSearchParams({ memoryRef: actionInput.memoryRef });
        return {
          href: `/api/me/memory/source-actions/open?${query.toString()}`,
          status: "READY"
        };
      }

      if (actionInput.action === "NOT_RELEVANT") {
        if (!item) throw new MemorySourceActionError("memory_not_found");
        const idempotencyFingerprint = memorySha256({
          action: actionInput.action,
          domain: "aiqsa.memory.source-action",
          requestNonce: actionInput.requestNonce,
          userId,
          version: 1
        });
        await input.client.$transaction(async (tx) => {
          const lockedConversation = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT chat."id"
            FROM "ModelRun" AS run
            INNER JOIN "Chat" AS chat
              ON chat."userId" = run."userId" AND chat."id" = run."chatId"
            WHERE run."userId" = ${userId}
              AND run."id" = ${ref.originatingRunId}
              AND chat."projectId" IS NULL
              AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
              AND chat."permanentDeletionAt" IS NULL
            FOR UPDATE OF chat
          `);
          if (!lockedConversation[0]) {
            throw new MemorySourceActionError("memory_not_found");
          }
          const existing = await tx.memoryFeedback.findUnique({
            select: { feedbackType: true, modelRunMemoryItemId: true },
            where: { userId_idempotencyFingerprint: { idempotencyFingerprint, userId } }
          });
          if (existing) {
            if (existing.feedbackType !== "NOT_USEFUL" ||
              existing.modelRunMemoryItemId !== item.id) {
              throw new MemorySourceActionError("memory_action_failed");
            }
            return;
          }
          const eventId = randomUUID();
          const feedbackId = randomUUID();
          await tx.memoryEvent.create({
            data: {
              actorType: "USER",
              actorUserId: userId,
              factId: ref.target.factId,
              factVersionId: ref.target.factVersionId,
              id: eventId,
              metadata: {
                feedbackId,
                feedbackType: "NOT_USEFUL",
                schemaVersion: "memory-feedback-event-v1"
              },
              operation: "USER_FEEDBACK",
              userId
            }
          });
          await tx.memoryFeedback.create({
            data: {
              feedbackType: "NOT_USEFUL",
              id: feedbackId,
              idempotencyFingerprint,
              memoryFactId: ref.target.factId,
              memoryFactVersionId: ref.target.factVersionId,
              memoryEventId: eventId,
              modelRunId: ref.originatingRunId,
              modelRunMemoryItemId: item.id,
              recallChunkId: ref.target.recallChunkId,
              requestId: actionInput.requestNonce,
              sourceChatIdSnapshot: ref.target.sourceChatId,
              targetKind: ref.target.itemType,
              userId
            }
          });
        });
        return { status: "COMMITTED" };
      }

      if (ref.target.itemType === "RECALL_CHUNK") {
        if (!item || !ref.target.recallChunkId || !ref.target.sourceChatId ||
          item.sourceBranchGenerationSnapshot === null ||
          item.sourceContentHashSnapshot === null ||
          item.sourceRevisionSnapshot === null ||
          ref.target.sourceMessageIds.length === 0) {
          throw new MemorySourceActionError("memory_not_found");
        }
        if (actionInput.action === "CORRECT") {
          if (memoryExplicitStatementContainsSecret(actionInput.statement)) {
            throw new MemorySourceActionError("memory_secret_rejected");
          }
          try {
            const authorization = await input.explicitService.mintAuthorization(userId, {
              action: "SAVE",
              confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
              exactStatementHash: memorySha256(actionInput.statement),
              requestNonce: memorySha256({
                domain: "aiqsa.memory.source-recall-correction",
                requestNonce: actionInput.requestNonce,
                userId,
                version: 1
              })
            });
            await input.explicitService.create(userId, {
              mutationAuthorizationId: authorization.mutationAuthorizationId,
              scope: { type: "GLOBAL_USER" },
              statement: actionInput.statement
            });
          } catch (error) {
            if (error instanceof ExplicitMemoryServiceError) {
              throw new MemorySourceActionError(error.code === "memory_secret_rejected"
                ? "memory_secret_rejected"
                : error.code === "memory_contract_invalid" ||
                    error.code === "memory_statement_invalid"
                  ? "memory_contract_invalid"
                  : "memory_action_failed");
            }
            throw error;
          }
          return { status: "COMMITTED" };
        }
        if (actionInput.action === "FORGET") {
          if (!input.recallMutationRepository) {
            throw new MemorySourceActionError("memory_action_failed");
          }
          await input.recallMutationRepository.suppress(userId, {
            branchGeneration: item.sourceBranchGenerationSnapshot,
            chatId: ref.target.sourceChatId,
            chunkId: ref.target.recallChunkId,
            contentHash: item.sourceContentHashSnapshot,
            messageIds: ref.target.sourceMessageIds,
            requestNonce: actionInput.requestNonce,
            sourceRevision: item.sourceRevisionSnapshot
          });
          return { status: "COMMITTED" };
        }
        throw new MemorySourceActionError("memory_contract_invalid");
      }

      if (!ref.target.factId || !ref.target.factVersionId || !version) {
        throw new MemorySourceActionError("memory_not_found");
      }
      if (typeof target.actionResultProof?.frozenReplacementStatement === "string" &&
        (actionInput.action !== "CORRECT" ||
          actionInput.statement !== target.actionResultProof.frozenReplacementStatement)) {
        throw new MemorySourceActionError("memory_contract_invalid");
      }
      if (actionInput.action === "CORRECT" &&
        memoryExplicitStatementContainsSecret(actionInput.statement)) {
        throw new MemorySourceActionError("memory_secret_rejected");
      }
      const mutationAction = actionInput.action === "CORRECT" ? "EDIT" as const : "FORGET" as const;
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: mutationAction,
        expectedTargetVersionId: version.id,
        targetFactId: ref.target.factId
      });
      const authorization = await input.authorizationRepository.mint(userId, {
        action: mutationAction,
        authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: version.id,
        expiresAt: new Date(now.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
        nonceHash: memoryMutationNonceHash(
          userId,
          `source:${actionInput.requestNonce}:${memorySha256(actionInput.memoryRef)}`
        ),
        requestId: randomUUID(),
        targetFactId: ref.target.factId
      }, now);
      if (actionInput.action === "CORRECT") {
        try {
          await input.explicitService.update(userId, ref.target.factId, {
            expectedVersionId: version.id,
            mutationAuthorizationId: authorization.id,
            statement: actionInput.statement
          });
        } catch (error) {
          if (error instanceof ExplicitMemoryServiceError &&
            error.code === "memory_secret_rejected") {
            throw new MemorySourceActionError("memory_secret_rejected");
          }
          throw error;
        }
      } else {
        await input.lifecycleService.forget(userId, ref.target.factId, {
          expectedVersionId: version.id,
          mutationAuthorizationId: authorization.id
        });
      }
      return { status: "COMMITTED" };
    }
  });
}

const defaultRecallMutationRepository: MemoryRecallSourceMutationRepository = Object.freeze({
  suppress(userId, input) {
    const configured = loadMemorySuppressionKeyring();
    if (configured.status !== "ready") {
      throw new MemorySourceActionError("memory_action_failed");
    }
    return createPrismaMemoryRecallSourceMutationRepository(configured.keyring, prisma)
      .suppress(userId, input);
  }
});

export const defaultMemorySourceActionService = createMemorySourceActionService({
  authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
  client: prisma,
  explicitService: defaultExplicitMemoryService,
  lifecycleService: defaultMemoryLifecycleService,
  recallMutationRepository: defaultRecallMutationRepository
});

export type MemorySourceActionService = ReturnType<typeof createMemorySourceActionService>;
