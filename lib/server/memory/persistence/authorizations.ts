import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryMutationAuthorizationInput
} from "../../../contracts/memory";
import type { MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { prisma } from "../../prisma";
import { MEMORY_ADMISSION_MAX_TIMEOUT_MS } from "../admissionDeadline";
import { decodeMemoryActionLifecycleSnapshot } from "../actions/lifecycleSnapshot";
import {
  memoryControlAcceptedOutputHash,
  memoryControlIntentHash
} from "../actions/controlRuntime";
import { memoryTargetSelectionAcceptedOutputHash } from "../actions/targetSelector";
import { parseMemoryExecutionSnapshot } from "../execution/snapshot";
import { memoryPersistenceFailure } from "./errors";
import { memorySha256 } from "./lexical";
import { memoryCanonicalGlobalScopePredicate } from "./scopes";
import {
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export const MEMORY_MUTATION_AUTHORIZATION_TTL_MS = 5 * 60 * 1_000;

type MemoryMutationAction = MemoryMutationAuthorizationInput["action"];

export type MemoryMutationAuthorizationUse = Readonly<{
  action: MemoryMutationAction;
  admissionDeadlineAtMs?: number;
  authorizationId: string;
  authorizedPayloadHash: string;
  expectedTargetVersionId?: string | null;
  targetFactId?: string | null;
}>;

export type MemoryMutationAuthorizationMint = Readonly<{
  action: MemoryMutationAction;
  admissionDeadlineAtMs?: number;
  authorizedPayloadHash: string;
  confirmationCopyVersion: typeof MEMORY_CONFIRMATION_COPY_VERSION;
  expectedTargetVersionId?: string | null;
  expiresAt: Date;
  exactSourceEnd?: number | null;
  exactSourceStart?: number | null;
  modelRunId?: string | null;
  nonceHash: string;
  persistedToolCallId?: string | null;
  requestId: string;
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
  targetFactId?: string | null;
}>;

export type MemoryMutationAuthorizationSnapshot = Readonly<{
  action: MemoryMutationAction;
  authorizedPayloadHash: string;
  confirmationCopyVersion: string;
  consumedAt: Date | null;
  createdAt: Date;
  expectedTargetVersionId: string | null;
  expiresAt: Date;
  exactSourceEnd: number | null;
  exactSourceStart: number | null;
  id: string;
  modelRunId: string | null;
  nonceHash: string;
  persistedToolCallId: string | null;
  requestId: string;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  targetFactId: string | null;
}>;

export type MemoryMutationToolAuthorizationMint = Readonly<{
  action: MemoryMutationAction;
  authorizedPayloadHash: string;
  chatId: string;
  expectedTargetVersionId?: string | null;
  modelRunId: string;
  persistedToolCallId: string;
  sourceText: string;
  targetFactId?: string | null;
  toolName: string;
}>;

export type MemoryMutationControlAuthorizationMint = Readonly<{
  action: MemoryMutationAction;
  admissionDeadlineAtMs: number;
  authorizedPayloadHash: string;
  bindingId: string;
  chatId: string;
  controlIntent: MemoryActionIntent;
  expectedTargetVersionId?: string | null;
  modelRunId: string;
  sourceText: string;
  targetSelectionBindingId?: string;
  targetSelectionCandidateMapHash?: string;
  targetSelectionOutputHash?: string;
  targetSelectionSelectedHandle?: string;
  targetFactId?: string | null;
}>;

const authorizationSelect = {
  action: true,
  authorizedPayloadHash: true,
  confirmationCopyVersion: true,
  consumedAt: true,
  createdAt: true,
  expectedTargetVersionId: true,
  expiresAt: true,
  exactSourceEnd: true,
  exactSourceStart: true,
  id: true,
  modelRunId: true,
  nonceHash: true,
  persistedToolCallId: true,
  requestId: true,
  sourceChatId: true,
  sourceMessageId: true,
  targetFactId: true
} satisfies Prisma.MemoryMutationAuthorizationSelect;

function bounded(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function targetAction(action: MemoryMutationAction): boolean {
  return action === "EDIT" || action === "FORGET" || action === "MOVE_SCOPE";
}

function validTargetShape(input: Readonly<{
  action: MemoryMutationAction;
  expectedTargetVersionId?: string | null;
  targetFactId?: string | null;
}>): boolean {
  const hasTarget = input.targetFactId != null || input.expectedTargetVersionId != null;
  return targetAction(input.action)
    ? input.targetFactId != null && input.expectedTargetVersionId != null
    : !hasTarget;
}

function sameMemoryExecutionTarget(left: unknown, right: unknown): boolean {
  try {
    const leftSnapshot = parseMemoryExecutionSnapshot(left);
    const rightSnapshot = parseMemoryExecutionSnapshot(right);
    return leftSnapshot.logicalRole === "MEMORY_CONTROL" &&
      rightSnapshot.logicalRole === "MEMORY_CONTROL" &&
      leftSnapshot.acceptedUtilityEgressFingerprint ===
        rightSnapshot.acceptedUtilityEgressFingerprint &&
      leftSnapshot.destinationFingerprint === rightSnapshot.destinationFingerprint &&
      leftSnapshot.executionTargetFingerprint === rightSnapshot.executionTargetFingerprint &&
      leftSnapshot.utilityPolicyVersion === rightSnapshot.utilityPolicyVersion;
  } catch {
    return false;
  }
}

function validateMint(input: MemoryMutationAuthorizationMint, now: Date): void {
  const provenanceValues = [
    input.modelRunId,
    input.sourceChatId,
    input.sourceMessageId,
    input.exactSourceStart,
    input.exactSourceEnd
  ];
  const hasProvenance = provenanceValues.some((value) => value !== undefined && value !== null);
  const validProvenance = !hasProvenance || (
    typeof input.modelRunId === "string" && bounded(input.modelRunId, 256) &&
    typeof input.sourceChatId === "string" && bounded(input.sourceChatId, 256) &&
    typeof input.sourceMessageId === "string" && bounded(input.sourceMessageId, 256) &&
    Number.isSafeInteger(input.exactSourceStart) && input.exactSourceStart! >= 0 &&
    Number.isSafeInteger(input.exactSourceEnd) && input.exactSourceEnd! > input.exactSourceStart!
  );
  if (
    !bounded(input.authorizedPayloadHash, 128) ||
    (input.admissionDeadlineAtMs !== undefined && (
      !Number.isFinite(input.admissionDeadlineAtMs) ||
      input.admissionDeadlineAtMs <= now.getTime()
    )) ||
    input.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION ||
    !bounded(input.nonceHash, 128) ||
    !bounded(input.requestId, 256) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= now ||
    input.expiresAt.getTime() - now.getTime() > MEMORY_MUTATION_AUTHORIZATION_TTL_MS ||
    !validTargetShape(input) ||
    !validProvenance ||
    (input.persistedToolCallId != null && !bounded(input.persistedToolCallId, 256)) ||
    (input.targetFactId != null && !bounded(input.targetFactId, 256)) ||
    (input.expectedTargetVersionId != null &&
      !bounded(input.expectedTargetVersionId, 256))
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

async function mintAuthorizationInTransaction(
  tx: MemoryTransaction,
  userId: string,
  input: MemoryMutationAuthorizationMint,
  now: Date
): Promise<MemoryMutationAuthorizationSnapshot> {
  validateMint(input, now);
  await requireCurrentTarget(tx, userId, input);
  const existing = await tx.memoryMutationAuthorization.findUnique({
    select: authorizationSelect,
    where: {
      userId_nonceHash: { nonceHash: input.nonceHash, userId }
    }
  });
  if (existing) {
    if (
      !matchesUse(existing, {
        action: input.action,
        authorizationId: existing.id,
        authorizedPayloadHash: input.authorizedPayloadHash,
        expectedTargetVersionId: input.expectedTargetVersionId,
        targetFactId: input.targetFactId
      }) ||
      existing.consumedAt !== null ||
      existing.expiresAt <= now
    ) {
      return memoryPersistenceFailure("memory_mutation_authorization_invalid");
    }
    return existing;
  }
  return tx.memoryMutationAuthorization.create({
    data: {
      action: input.action,
      authorizedPayloadHash: input.authorizedPayloadHash,
      confirmationCopyVersion: input.confirmationCopyVersion,
      createdAt: now,
      expectedTargetVersionId: input.expectedTargetVersionId,
      expiresAt: input.expiresAt,
      exactSourceEnd: input.exactSourceEnd,
      exactSourceStart: input.exactSourceStart,
      id: randomUUID(),
      modelRunId: input.modelRunId,
      nonceHash: input.nonceHash,
      persistedToolCallId: input.persistedToolCallId,
      requestId: input.requestId,
      sourceChatId: input.sourceChatId,
      sourceMessageId: input.sourceMessageId,
      targetFactId: input.targetFactId,
      userId
    },
    select: authorizationSelect
  });
}

function matchesUse(
  row: MemoryMutationAuthorizationSnapshot,
  input: MemoryMutationAuthorizationUse,
  requestId?: string
): boolean {
  return row.action === input.action &&
    row.authorizedPayloadHash === input.authorizedPayloadHash &&
    row.confirmationCopyVersion === MEMORY_CONFIRMATION_COPY_VERSION &&
    row.targetFactId === (input.targetFactId ?? null) &&
    row.expectedTargetVersionId === (input.expectedTargetVersionId ?? null) &&
    (requestId === undefined || row.requestId === requestId);
}

function controlBackedMutation(row: MemoryMutationAuthorizationSnapshot): boolean {
  return row.modelRunId !== null && row.persistedToolCallId === null &&
    row.sourceChatId !== null && row.sourceMessageId !== null &&
    (row.action === "SAVE" || row.action === "EDIT" || row.action === "FORGET");
}

type ControlMutationLifecycleRow = Readonly<{
  admittedAssistantLeafMessageId: string;
  admittedUserMessageId: string;
  attemptState: string;
  bindingAcceptedOutputHash: string;
  bindingInputHash: string;
  budgetSnapshot: Prisma.JsonValue | null;
  chatActiveLeafMessageId: string | null;
  chatBranchGeneration: number;
  chatMemoryMode: string;
  chatProjectId: string | null;
  chatSourceRevision: number;
  memoryGeneration: number;
  memoryGenerationSnapshot: number;
  runStatus: string;
  runUserMessageId: string;
  useMemoryFacts: boolean;
}>;

const controlEvidencePrefix = "control-v2";

type ControlMutationEvidence = Readonly<{
  candidateMapHash: string | null;
  intentHash: string;
  mutationHash: string;
  selectedHandle: string | null;
}>;

function controlMutationHash(input: Readonly<{
  action: MemoryMutationAction;
  authorizedPayloadHash: string;
  expectedTargetVersionId?: string | null;
  targetFactId?: string | null;
}>): string {
  return memorySha256({
    action: input.action,
    authorizedPayloadHash: input.authorizedPayloadHash,
    domain: "aiqsa.memory.control-mutation",
    expectedTargetVersionId: input.expectedTargetVersionId ?? null,
    targetFactId: input.targetFactId ?? null,
    version: 2
  });
}

function encodeControlMutationEvidence(evidence: ControlMutationEvidence): string {
  return [
    controlEvidencePrefix,
    evidence.intentHash,
    evidence.mutationHash,
    evidence.candidateMapHash ?? "-",
    evidence.selectedHandle ?? "-"
  ].join(":");
}

function decodeControlMutationEvidence(value: string): ControlMutationEvidence | null {
  const [prefix, intentHash, mutationHash, candidateMapHash, selectedHandle, extra] =
    value.split(":");
  if (extra !== undefined || prefix !== controlEvidencePrefix ||
    !intentHash || !/^[a-f0-9]{64}$/u.test(intentHash) ||
    !mutationHash || !/^[a-f0-9]{64}$/u.test(mutationHash) ||
    !candidateMapHash || (candidateMapHash !== "-" &&
      !/^[a-f0-9]{64}$/u.test(candidateMapHash)) ||
    !selectedHandle || (selectedHandle !== "-" && !/^c[0-4]$/u.test(selectedHandle)) ||
    (candidateMapHash === "-") !== (selectedHandle === "-")) {
    return null;
  }
  return {
    candidateMapHash: candidateMapHash === "-" ? null : candidateMapHash,
    intentHash,
    mutationHash,
    selectedHandle: selectedHandle === "-" ? null : selectedHandle
  };
}

function controlIntentMatchesMutation(
  intent: MemoryActionIntent,
  input: Pick<MemoryMutationControlAuthorizationMint,
    "action" | "authorizedPayloadHash" | "expectedTargetVersionId" | "targetFactId">
): boolean {
  if (intent.confidenceBand !== "HIGH" || intent.sensitivity === "SECRET" ||
    intent.sensitivity === "UNCERTAIN") return false;
  if (input.action === "SAVE") {
    return intent.action === "SAVE" && intent.statement !== null && !intent.thisChatOnly &&
      input.authorizedPayloadHash === memorySha256(intent.statement) &&
      input.targetFactId == null && input.expectedTargetVersionId == null;
  }
  if (input.action === "EDIT") {
    return intent.action === "UPDATE" && intent.replacementStatement !== null &&
      input.targetFactId != null && input.expectedTargetVersionId != null &&
      input.authorizedPayloadHash === memoryTargetAuthorizationPayloadHash({
        action: "EDIT",
        expectedTargetVersionId: input.expectedTargetVersionId,
        replacementStatementHash: memorySha256(intent.replacementStatement),
        targetFactId: input.targetFactId
      });
  }
  if (input.action === "FORGET") {
    return intent.action === "FORGET" && input.targetFactId != null &&
      input.expectedTargetVersionId != null &&
      input.authorizedPayloadHash === memoryTargetAuthorizationPayloadHash({
        action: "FORGET",
        expectedTargetVersionId: input.expectedTargetVersionId,
        targetFactId: input.targetFactId
      });
  }
  return false;
}

async function requireCurrentControlMutationLifecycle(
  tx: MemoryTransaction,
  userId: string,
  row: MemoryMutationAuthorizationSnapshot
): Promise<void> {
  if (!controlBackedMutation(row)) return;
  const rows = await tx.$queryRaw<ControlMutationLifecycleRow[]>(Prisma.sql`
    SELECT
      attempt."admittedAssistantLeafMessageId",
      attempt."admittedUserMessageId",
      attempt."state"::text AS "attemptState",
      binding."acceptedOutputHash" AS "bindingAcceptedOutputHash",
      binding."inputHash" AS "bindingInputHash",
      attempt."budgetSnapshot",
      chat."activeLeafMessageId" AS "chatActiveLeafMessageId",
      chat."memoryBranchGeneration" AS "chatBranchGeneration",
      chat."memoryMode"::text AS "chatMemoryMode",
      chat."projectId" AS "chatProjectId",
      chat."memorySourceRevision" AS "chatSourceRevision",
      settings."memoryGeneration",
      attempt."memoryGenerationSnapshot",
      run."status"::text AS "runStatus",
      run."userMessageId" AS "runUserMessageId",
      settings."useMemoryFacts"
    FROM "MemoryRetrievalAttempt" AS attempt
    INNER JOIN "MemoryExecutionBinding" AS binding
      ON binding."userId" = attempt."userId"
     AND binding."retrievalAttemptId" = attempt."id"
     AND binding."ownerType" = 'RETRIEVAL_ATTEMPT'::"MemoryExecutionOwnerType"
     AND binding."logicalRole" = 'MEMORY_CONTROL'
     AND binding."ordinal" = 0
     AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
     AND binding."acceptedOutputHash" IS NOT NULL
     AND binding."relationsDetachedAt" IS NULL
    INNER JOIN "ModelRun" AS run
      ON run."id" = attempt."modelRunId"
     AND run."userId" = attempt."userId"
     AND run."chatId" = attempt."chatId"
    INNER JOIN "Chat" AS chat
      ON chat."id" = attempt."chatId"
     AND chat."userId" = attempt."userId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = attempt."userId"
    WHERE attempt."userId" = ${userId}
      AND attempt."modelRunId" = ${row.modelRunId!}
      AND attempt."chatId" = ${row.sourceChatId!}
      AND attempt."admittedUserMessageId" = ${row.sourceMessageId!}
    ORDER BY attempt."attemptOrdinal" DESC
    LIMIT 2
    FOR UPDATE OF attempt, binding, chat, run, settings
  `);
  const current = rows[0];
  const evidence = decodeControlMutationEvidence(row.requestId);
  const lifecycle = current
    ? decodeMemoryActionLifecycleSnapshot(current.budgetSnapshot)
    : null;
  // An unrelated fact, history, or index settlement may advance memoryRevision
  // while the strict control call is in flight. Generation/settings and the
  // exact source/branch remain the global fences; target mutations are also
  // revalidated against their exact current version below.
  if (
    rows.length !== 1 || !current || !lifecycle || !evidence ||
    evidence.mutationHash !== controlMutationHash(row) ||
    current.bindingAcceptedOutputHash !== memoryControlAcceptedOutputHash(
      current.bindingInputHash,
      evidence.intentHash
    ) ||
    current.attemptState !== "EXECUTING" || current.runStatus !== "preparing" ||
    !current.useMemoryFacts ||
    current.memoryGeneration !== current.memoryGenerationSnapshot ||
    current.chatProjectId !== null || current.chatMemoryMode !== "NORMAL" ||
    current.runUserMessageId !== current.admittedUserMessageId ||
    current.chatActiveLeafMessageId !== current.admittedAssistantLeafMessageId ||
    current.chatActiveLeafMessageId !== lifecycle.activeLeafMessageId ||
    current.chatBranchGeneration !== lifecycle.branchGeneration ||
    current.chatSourceRevision !== lifecycle.sourceRevision
  ) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
  if (evidence.selectedHandle !== null && evidence.candidateMapHash !== null) {
    const selectors = await tx.$queryRaw<Array<Readonly<{
      acceptedOutputHash: string;
      inputHash: string;
    }>>>(Prisma.sql`
      SELECT selector."acceptedOutputHash", selector."inputHash"
      FROM "MemoryExecutionBinding" AS selector
      WHERE selector."userId" = ${userId}
        AND selector."retrievalAttemptId" = (
          SELECT attempt."id"
          FROM "MemoryRetrievalAttempt" AS attempt
          WHERE attempt."userId" = ${userId}
            AND attempt."modelRunId" = ${row.modelRunId!}
            AND attempt."chatId" = ${row.sourceChatId!}
            AND attempt."admittedUserMessageId" = ${row.sourceMessageId!}
          ORDER BY attempt."attemptOrdinal" DESC
          LIMIT 1
        )
        AND selector."ownerType" = 'RETRIEVAL_ATTEMPT'::"MemoryExecutionOwnerType"
        AND selector."logicalRole" = 'MEMORY_CONTROL'
        AND selector."ordinal" = 1
        AND selector."state" = 'SUCCEEDED'::"MemoryExecutionState"
        AND selector."acceptedOutputHash" IS NOT NULL
        AND selector."relationsDetachedAt" IS NULL
      FOR UPDATE OF selector
    `);
    const selector = selectors[0];
    if (selectors.length !== 1 || !selector || !row.targetFactId ||
      !row.expectedTargetVersionId || selector.acceptedOutputHash !==
        memoryTargetSelectionAcceptedOutputHash({
          candidateMapHash: evidence.candidateMapHash,
          inputHash: selector.inputHash,
          selectedFactId: row.targetFactId,
          selectedHandle: evidence.selectedHandle,
          selectedVersionId: row.expectedTargetVersionId
        })) {
      return memoryPersistenceFailure("memory_mutation_authorization_invalid");
    }
  }
}

async function requireCurrentTarget(
  tx: MemoryTransaction,
  userId: string,
  input: Pick<
    MemoryMutationAuthorizationMint,
    "action" | "expectedTargetVersionId" | "targetFactId"
  >
): Promise<void> {
  if (!targetAction(input.action)) return;
  const [fact] = await tx.$queryRaw<Array<Readonly<{
    currentVersionId: string | null;
    state: "ACTIVE" | "CONFLICTED" | "ORPHANED" | string;
  }>>>(Prisma.sql`
    SELECT fact."currentVersionId", fact."state"::text AS "state"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE fact."userId" = ${userId}
      AND fact."id" = ${input.targetFactId!}
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND ${memoryCanonicalGlobalScopePredicate()}
    FOR UPDATE OF fact, scope
  `);
  if (!fact) return memoryPersistenceFailure("memory_fact_not_found");
  if (fact.state === "ACTIVE" && fact.currentVersionId === input.expectedTargetVersionId) {
    return;
  }
  if ((input.action === "EDIT" || input.action === "FORGET") &&
    fact.state === "CONFLICTED") {
    const claim = await tx.memoryFactVersion.findFirst({
      select: { id: true },
      where: {
        factId: input.targetFactId!,
        id: input.expectedTargetVersionId!,
        state: "CONFLICTING",
        userId
      }
    });
    if (claim) return;
  }
  if (input.action !== "EDIT" && fact.state === "ORPHANED") {
    const latest = await tx.memoryFactVersion.findFirst({
      orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
      select: { id: true },
      where: {
        factId: input.targetFactId!,
        sourceMode: "EXPLICIT",
        state: "ORPHANED",
        userId
      }
    });
    if (latest?.id === input.expectedTargetVersionId) return;
  }
  return memoryPersistenceFailure("memory_fact_version_stale");
}

export function memoryMutationNonceHash(userId: string, requestNonce: string): string {
  return memorySha256({
    domain: "aiqsa.memory.mutation-authorization.nonce",
    requestNonce,
    userId,
    version: "v1"
  });
}

export function memoryTargetAuthorizationPayloadHash(input: Readonly<{
  action: Exclude<MemoryMutationAction, "SAVE">;
  expectedMemoryRevision?: number;
  expectedSettingsRevision?: number;
  expectedTargetVersionId?: string;
  operation?: string;
  replacementStatementHash?: string;
  targetFactId?: string;
}>): string {
  return memorySha256({
    action: input.action,
    domain: "aiqsa.memory.mutation-authorization.payload",
    expectedMemoryRevision: input.expectedMemoryRevision ?? null,
    expectedSettingsRevision: input.expectedSettingsRevision ?? null,
    expectedTargetVersionId: input.expectedTargetVersionId ?? null,
    operation: input.operation ?? null,
    replacementStatementHash: input.replacementStatementHash ?? null,
    targetFactId: input.targetFactId ?? null,
    version: "v1"
  });
}

export async function consumeMemoryMutationAuthorization(
  tx: MemoryTransaction,
  userId: string,
  input: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>,
  now = new Date()
): Promise<void> {
  const row = await tx.memoryMutationAuthorization.findFirst({
    select: authorizationSelect,
    where: { id: input.authorizationId, userId }
  });
  if (
    !row ||
    !matchesUse(row, input, input.requestId) ||
    row.consumedAt !== null ||
    row.expiresAt <= now
  ) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
  await requireCurrentControlMutationLifecycle(tx, userId, row);
  await requireCurrentTarget(tx, userId, row);
  // Wall clocks can move backwards between mint and consume. Keep the durable
  // timestamp monotonic with the authorization row while retaining the caller's
  // clock for the expiry decision above.
  const consumedAt = now < row.createdAt ? row.createdAt : now;
  const consumed = await tx.memoryMutationAuthorization.updateMany({
    data: { consumedAt },
    where: {
      consumedAt: null,
      expiresAt: { gt: now },
      id: input.authorizationId,
      userId
    }
  });
  if (consumed.count !== 1) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
}

export function createPrismaMemoryMutationAuthorizationRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async mint(
      userId: string,
      input: MemoryMutationAuthorizationMint,
      now = new Date()
    ): Promise<MemoryMutationAuthorizationSnapshot> {
      validateMint(input, now);
      return withLockedMemoryTransaction(
        client,
        userId,
        (tx) => mintAuthorizationInTransaction(tx, userId, input, now),
        { deadlineAtMs: input.admissionDeadlineAtMs }
      );
    },

    async resolveForUse(
      userId: string,
      input: MemoryMutationAuthorizationUse
    ): Promise<Readonly<{ confirmedAt: Date; requestId: string }>> {
      return withLockedMemoryTransaction(client, userId, async (tx) => {
        const row = await tx.memoryMutationAuthorization.findFirst({
          select: authorizationSelect,
          where: { id: input.authorizationId, userId }
        });
        if (
          !row ||
          !matchesUse(row, input) ||
          (row.consumedAt === null && row.expiresAt <= new Date())
        ) {
          return memoryPersistenceFailure("memory_mutation_authorization_invalid");
        }
        return {
          confirmedAt: row.createdAt,
          replayed: row.consumedAt !== null,
          requestId: row.requestId
        };
      }, { deadlineAtMs: input.admissionDeadlineAtMs });
    },

    async mintForTool(
      userId: string,
      input: MemoryMutationToolAuthorizationMint,
      now = new Date()
    ): Promise<MemoryMutationAuthorizationSnapshot> {
      if (
        !bounded(userId, 256) || !bounded(input.chatId, 256) ||
        !bounded(input.modelRunId, 256) || !bounded(input.persistedToolCallId, 256) ||
        !bounded(input.toolName, 128) || !input.sourceText ||
        input.sourceText.length > 2_000 || input.sourceText.includes("\u0000")
      ) return memoryPersistenceFailure("memory_input_invalid");
      const run = await client.modelRun.findFirst({
        select: {
          chatId: true,
          userMessageId: true,
          userMessage: { select: { content: true, role: true } }
        },
        where: {
          chatId: input.chatId,
          id: input.modelRunId,
          toolCalls: {
            some: { id: input.persistedToolCallId, toolName: input.toolName }
          },
          userId
        }
      });
      const stored = run?.userMessage.content;
      const blocks = stored && typeof stored === "object" && !Array.isArray(stored) &&
        Array.isArray((stored as { blocks?: unknown }).blocks)
        ? (stored as { blocks: unknown[] }).blocks
        : null;
      const exactText = blocks ? textFromContentBlocks({ blocks }) : null;
      if (
        !run || run.chatId !== input.chatId || run.userMessage.role !== "user" ||
        exactText === null || exactText !== input.sourceText
      ) return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      return createPrismaMemoryMutationAuthorizationRepository(client).mint(userId, {
        action: input.action,
        authorizedPayloadHash: input.authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactSourceEnd: exactText.length,
        exactSourceStart: 0,
        expectedTargetVersionId: input.expectedTargetVersionId,
        expiresAt: new Date(now.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
        modelRunId: input.modelRunId,
        nonceHash: memoryMutationNonceHash(
          userId,
          `tool:${input.modelRunId}:${input.persistedToolCallId}:${input.action}`
        ),
        persistedToolCallId: input.persistedToolCallId,
        requestId: randomUUID(),
        sourceChatId: input.chatId,
        sourceMessageId: run.userMessageId,
        targetFactId: input.targetFactId
      }, now);
    },

    async mintForControl(
      userId: string,
      input: MemoryMutationControlAuthorizationMint,
      now = new Date()
    ): Promise<MemoryMutationAuthorizationSnapshot> {
      const hasTargetSelectionBinding = input.targetSelectionBindingId !== undefined;
      const hasTargetSelectionOutput = input.targetSelectionOutputHash !== undefined;
      const hasTargetSelectionCandidateMap =
        input.targetSelectionCandidateMapHash !== undefined;
      const hasTargetSelectionHandle = input.targetSelectionSelectedHandle !== undefined;
      if (
        !bounded(userId, 256) || !bounded(input.chatId, 256) ||
        !bounded(input.modelRunId, 256) || !bounded(input.bindingId, 256) ||
        !Number.isFinite(input.admissionDeadlineAtMs) ||
        input.admissionDeadlineAtMs <= now.getTime() ||
        input.admissionDeadlineAtMs - now.getTime() >
          MEMORY_ADMISSION_MAX_TIMEOUT_MS ||
        !input.sourceText || input.sourceText.length > 2_000 ||
        input.sourceText.includes("\u0000") ||
        new Set([
          hasTargetSelectionBinding,
          hasTargetSelectionOutput,
          hasTargetSelectionCandidateMap,
          hasTargetSelectionHandle
        ]).size !== 1 ||
        (hasTargetSelectionBinding && (
          !targetAction(input.action) ||
          !bounded(input.targetSelectionBindingId!, 256) ||
          !bounded(input.targetSelectionOutputHash!, 128) ||
          !/^[a-f0-9]{64}$/u.test(input.targetSelectionCandidateMapHash!) ||
          !/^c[0-4]$/u.test(input.targetSelectionSelectedHandle!)
        )) ||
        !validTargetShape(input) || !controlIntentMatchesMutation(input.controlIntent, input)
      ) return memoryPersistenceFailure("memory_input_invalid");
      return withLockedMemoryTransaction(client, userId, async (tx) => {
      const binding = await tx.memoryExecutionBinding.findFirst({
        select: {
          acceptedOutputHash: true,
          inputHash: true,
          ordinal: true,
          retrievalAttemptId: true,
          secretFreeExecutionSnapshot: true
        },
        where: {
          acceptedOutputHash: { not: null },
          id: input.bindingId,
          logicalRole: "MEMORY_CONTROL",
          ordinal: 0,
          ownerType: "RETRIEVAL_ATTEMPT",
          relationsDetachedAt: null,
          state: "SUCCEEDED",
          userId
        }
      });
      if (!binding?.retrievalAttemptId) {
        return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      }
      const intentHash = memoryControlIntentHash(input.controlIntent);
      if (binding.acceptedOutputHash !== memoryControlAcceptedOutputHash(
        binding.inputHash,
        intentHash
      )) {
        return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      }
      if (hasTargetSelectionBinding) {
        const targetSelection = await tx.memoryExecutionBinding.findFirst({
          select: {
            acceptedOutputHash: true,
            inputHash: true,
            ordinal: true,
            secretFreeExecutionSnapshot: true
          },
          where: {
            acceptedOutputHash: input.targetSelectionOutputHash,
            id: input.targetSelectionBindingId,
            logicalRole: "MEMORY_CONTROL",
            ownerType: "RETRIEVAL_ATTEMPT",
            relationsDetachedAt: null,
            retrievalAttemptId: binding.retrievalAttemptId,
            state: "SUCCEEDED",
            userId
          }
        });
        if (
          binding.ordinal !== 0 ||
          targetSelection?.ordinal !== 1 ||
          !input.targetFactId || !input.expectedTargetVersionId ||
          targetSelection.acceptedOutputHash !== memoryTargetSelectionAcceptedOutputHash({
            candidateMapHash: input.targetSelectionCandidateMapHash!,
            inputHash: targetSelection.inputHash,
            selectedFactId: input.targetFactId,
            selectedHandle: input.targetSelectionSelectedHandle!,
            selectedVersionId: input.expectedTargetVersionId
          }) ||
          !sameMemoryExecutionTarget(
            binding.secretFreeExecutionSnapshot,
            targetSelection?.secretFreeExecutionSnapshot
          )
        ) {
          return memoryPersistenceFailure("memory_mutation_authorization_invalid");
        }
      }
      const attempt = await tx.memoryRetrievalAttempt.findFirst({
        select: { admittedUserMessageId: true },
        where: {
          chatId: input.chatId,
          id: binding.retrievalAttemptId,
          modelRunId: input.modelRunId,
          userId
        }
      });
      if (!attempt) {
        return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      }
      const run = await tx.modelRun.findFirst({
        select: {
          userMessageId: true,
          userMessage: { select: { content: true, role: true } }
        },
        where: { chatId: input.chatId, id: input.modelRunId, userId }
      });
      const stored = run?.userMessage.content;
      const blocks = stored && typeof stored === "object" && !Array.isArray(stored) &&
        Array.isArray((stored as { blocks?: unknown }).blocks)
        ? (stored as { blocks: unknown[] }).blocks
        : null;
      const exactText = blocks ? textFromContentBlocks({ blocks }) : null;
      if (
        !run || run.userMessageId !== attempt.admittedUserMessageId ||
        run.userMessage.role !== "user" || exactText === null || exactText !== input.sourceText
      ) return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      const requestId = encodeControlMutationEvidence({
        candidateMapHash: input.targetSelectionCandidateMapHash ?? null,
        intentHash,
        mutationHash: controlMutationHash(input),
        selectedHandle: input.targetSelectionSelectedHandle ?? null
      });
      return mintAuthorizationInTransaction(tx, userId, {
        action: input.action,
        admissionDeadlineAtMs: input.admissionDeadlineAtMs,
        authorizedPayloadHash: input.authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactSourceEnd: exactText.length,
        exactSourceStart: 0,
        expectedTargetVersionId: input.expectedTargetVersionId,
        expiresAt: new Date(now.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
        modelRunId: input.modelRunId,
        nonceHash: memoryMutationNonceHash(
          userId,
          `control:${input.modelRunId}:${input.bindingId}` +
            (hasTargetSelectionBinding
              ? `:selector:${input.targetSelectionBindingId}:` +
                `${input.targetSelectionOutputHash}`
              : "") +
            `:${input.action}:${input.authorizedPayloadHash}`
        ),
        persistedToolCallId: null,
        requestId,
        sourceChatId: input.chatId,
        sourceMessageId: run.userMessageId,
        targetFactId: input.targetFactId
      }, now);
      }, { deadlineAtMs: input.admissionDeadlineAtMs });
    }
  });
}
