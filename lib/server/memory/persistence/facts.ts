import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  MemoryModality,
  MemorySensitivityClass,
  MemorySourceMode
} from "../../../contracts/memory";
import { memoryDerivativePlaintextAllowed } from "../../../domain/memory/safety";
import { prisma } from "../../prisma";
import {
  MEMORY_EXPLICIT_EMBEDDING_PIPELINE_VERSION,
  memoryExplicitEmbeddingJobFingerprint
} from "../embedding/contract";
import type { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  consumeMemoryMutationAuthorization,
  type MemoryMutationAuthorizationUse
} from "./authorizations";
import { memoryPersistenceFailure } from "./errors";
import { enqueueMemoryJob } from "./jobs";
import {
  memorySha256,
  memoryStableJson,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "./lexical";
import { requireActiveOwnedMemoryScope } from "./scopes";
import { assertMemoryWriteNotSuppressed } from "./suppressions";
import {
  advanceMemoryMutation,
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryActiveIndex,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export type MemoryDirectnessInput = "DIRECT" | "INFERRED" | "PARAPHRASED";

export type MemoryFactValueInput = Readonly<{
  canonicalKey: string;
  category: string;
  confidence: number;
  directness: MemoryDirectnessInput;
  displayText: string;
  importance: number;
  languageCode: string;
  modality: MemoryModality;
  pipelineVersion: string;
  secretTaintedSourceWindow: boolean;
  sensitivityClass: MemorySensitivityClass;
  sourceMode: MemorySourceMode;
  structuredValue: Prisma.InputJsonValue;
  validFrom?: Date | null;
  validTo?: Date | null;
}>;

type MemoryEvidenceCommonInput = Readonly<{
  observedAt: Date;
  safeExcerpt: string;
  safeSourceHash: string;
  safetyClass: MemorySensitivityClass;
  sourceProjectionVersion: string;
}>;

export type MemoryFactEvidenceInput = MemoryEvidenceCommonInput & (
  | Readonly<{ kind: "EXPLICIT_ACTION" }>
  | Readonly<{
      branchGeneration: number;
      chatId: string;
      kind: "MESSAGE";
      messageId: string;
      sourceRole: string;
    }>
);

type MemoryFactMutationCommonInput = Readonly<{
  authorization?: MemoryMutationAuthorizationUse;
  evidence: MemoryFactEvidenceInput;
  explicitSuppressionOverride: boolean;
  idempotencyFingerprint: string;
  idempotencyPayloadHash?: string;
  modelRunId?: string | null;
  persistedToolCallId?: string | null;
  requestId: string;
  value: MemoryFactValueInput;
}>;

export type MemoryFactSaveInput = MemoryFactMutationCommonInput & Readonly<{
  scopeId: string;
}>;

export type MemoryFactEditInput = MemoryFactMutationCommonInput & Readonly<{
  expectedVersionId: string;
  factId: string;
  pinned?: boolean;
  scopeId: string;
}>;

export type MemoryFactMoveInput = MemoryFactMutationCommonInput & Readonly<{
  expectedVersionId: string;
  factId: string;
  targetScopeId: string;
}>;

export type MemoryFactMutationOutcome = "CREATED" | "EDITED" | "MOVED" | "REINFORCED";

export type MemoryFactMutationResult = Readonly<{
  eventId: string;
  factId: string;
  memoryGeneration: number;
  memoryRevision: number;
  outcome: MemoryFactMutationOutcome;
  replayed: boolean;
  versionId: string;
}>;

type MemoryReceiptIdentity = Pick<
  MemoryFactMutationCommonInput,
  "idempotencyFingerprint" | "modelRunId" | "persistedToolCallId" | "requestId"
>;

const canonicalKeyPattern = /^[a-z][a-z0-9_.:-]{0,255}$/u;
const categoryPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const languageCodePattern = /^(AUTO|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$/u;
const sourceRoles = new Set(["assistant", "system", "tool", "user"]);

function validBounded(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function validPlaintext(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength &&
    value.trim().length > 0 && !value.includes("\u0000");
}

function validUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateEvidence(
  evidence: MemoryFactEvidenceInput,
  value: MemoryFactValueInput
): void {
  if (!memoryDerivativePlaintextAllowed(
    evidence.safetyClass,
    value.secretTaintedSourceWindow
  )) {
    return memoryPersistenceFailure("memory_plaintext_not_allowed");
  }
  if (
    !validPlaintext(evidence.safeExcerpt, 2_000) ||
    !validBounded(evidence.safeSourceHash, 128) ||
    !validBounded(evidence.sourceProjectionVersion, 64) ||
    !Number.isFinite(evidence.observedAt.getTime()) ||
    evidence.safetyClass !== value.sensitivityClass
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  if (value.sourceMode === "EXPLICIT" && evidence.kind !== "EXPLICIT_ACTION") {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  if (value.sourceMode === "AUTOMATIC" && evidence.kind !== "MESSAGE") {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  if (evidence.kind === "MESSAGE" && (
    !validBounded(evidence.chatId, 256) ||
    !validBounded(evidence.messageId, 256) ||
    !sourceRoles.has(evidence.sourceRole) ||
    !Number.isSafeInteger(evidence.branchGeneration) ||
    evidence.branchGeneration < 0
  )) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function validateValue(value: MemoryFactValueInput): void {
  if (!memoryDerivativePlaintextAllowed(
    value.sensitivityClass,
    value.secretTaintedSourceWindow
  )) {
    return memoryPersistenceFailure("memory_plaintext_not_allowed");
  }
  let normalizedSearchText = "";
  try {
    normalizedSearchText = normalizeMemorySearchText(value.displayText);
    memoryStableJson(value.structuredValue);
  } catch {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  if (
    !canonicalKeyPattern.test(value.canonicalKey) ||
    !categoryPattern.test(value.category) ||
    !validPlaintext(value.displayText, 2_000) ||
    !normalizedSearchText ||
    normalizedSearchText.length > 4_000 ||
    !languageCodePattern.test(value.languageCode) ||
    !validBounded(value.pipelineVersion, 64) ||
    !validUnitInterval(value.confidence) ||
    !validUnitInterval(value.importance) ||
    value.structuredValue === null ||
    (value.validFrom !== undefined && value.validFrom !== null &&
      !Number.isFinite(value.validFrom.getTime())) ||
    (value.validTo !== undefined && value.validTo !== null &&
      !Number.isFinite(value.validTo.getTime())) ||
    (value.validFrom && value.validTo && value.validTo <= value.validFrom)
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function validateMutationIdentity(input: MemoryReceiptIdentity): void {
  if (
    !validBounded(input.idempotencyFingerprint, 128) ||
    !validBounded(input.requestId, 256) ||
    (input.persistedToolCallId !== undefined && input.persistedToolCallId !== null &&
      !input.modelRunId) ||
    (input.modelRunId !== undefined && input.modelRunId !== null &&
      !validBounded(input.modelRunId, 256)) ||
    (input.persistedToolCallId !== undefined && input.persistedToolCallId !== null &&
      !validBounded(input.persistedToolCallId, 256))
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function validateMutation(
  input: MemoryFactMutationCommonInput,
  operation: "EDIT" | "MOVE_SCOPE" | "SAVE"
): void {
  validateMutationIdentity(input);
  if (
    input.idempotencyPayloadHash !== undefined &&
    !/^[a-f0-9]{64}$/u.test(input.idempotencyPayloadHash)
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  validateValue(input.value);
  validateEvidence(input.evidence, input.value);
  const authorization = input.authorization;
  if (input.value.sourceMode === "EXPLICIT") {
    if (
      !authorization ||
      authorization.action !== operation ||
      !validBounded(authorization.authorizationId, 256) ||
      !validBounded(authorization.authorizedPayloadHash, 128)
    ) {
      return memoryPersistenceFailure("memory_input_invalid");
    }
  } else if (authorization) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

async function requireEvidenceOwner(
  tx: MemoryTransaction,
  userId: string,
  evidence: MemoryFactEvidenceInput
): Promise<void> {
  if (evidence.kind !== "MESSAGE") return;
  const chat = await tx.chat.findFirst({
    select: { id: true },
    where: { id: evidence.chatId, userId }
  });
  if (!chat) return memoryPersistenceFailure("memory_scope_unavailable");
  const message = await tx.message.findFirst({
    select: { id: true },
    where: { chatId: evidence.chatId, id: evidence.messageId }
  });
  if (!message) return memoryPersistenceFailure("memory_scope_unavailable");
}

function payloadHash(
  operation: "EDIT" | "MOVE_SCOPE" | "SAVE",
  input: MemoryFactEditInput | MemoryFactMoveInput | MemoryFactSaveInput
): string {
  if (input.idempotencyPayloadHash) return input.idempotencyPayloadHash;
  return memorySha256({
    evidence: input.evidence,
    explicitSuppressionOverride: input.explicitSuppressionOverride,
    operation,
    scopeId: operation === "SAVE"
      ? (input as MemoryFactSaveInput).scopeId
      : operation === "EDIT"
        ? (input as MemoryFactEditInput).scopeId
        : undefined,
    target: operation === "EDIT" ? {
      expectedVersionId: (input as MemoryFactEditInput).expectedVersionId,
      factId: (input as MemoryFactEditInput).factId,
      pinned: (input as MemoryFactEditInput).pinned ?? null
    } : operation === "MOVE_SCOPE" ? {
      expectedVersionId: (input as MemoryFactMoveInput).expectedVersionId,
      factId: (input as MemoryFactMoveInput).factId,
      targetScopeId: (input as MemoryFactMoveInput).targetScopeId
    } : null,
    value: input.value
  });
}

function versionContentHash(value: Readonly<{
  category: string;
  confidence: number;
  directness: string;
  displayText: string | null;
  importance: number;
  languageCode: string;
  modality: string;
  pipelineVersion: string;
  sensitivityClass: string;
  sourceMode: string;
  structuredValue: Prisma.JsonValue;
  validFrom: Date | null;
  validTo: Date | null;
}>): string {
  return memorySha256({
    category: value.category,
    confidence: value.confidence,
    directness: value.directness,
    displayText: value.displayText,
    importance: value.importance,
    languageCode: value.languageCode,
    modality: value.modality,
    pipelineVersion: value.pipelineVersion,
    sensitivityClass: value.sensitivityClass,
    sourceMode: value.sourceMode,
    structuredValue: value.structuredValue,
    validFrom: value.validFrom,
    validTo: value.validTo
  });
}

function inputContentHash(value: MemoryFactValueInput): string {
  return versionContentHash({
    ...value,
    displayText: value.displayText,
    structuredValue: value.structuredValue as Prisma.JsonValue,
    validFrom: value.validFrom ?? null,
    validTo: value.validTo ?? null
  });
}

function receiptSnapshot(
  result: Omit<MemoryFactMutationResult, "replayed">,
  inputPayloadHash: string
): Prisma.InputJsonObject {
  return {
    eventId: result.eventId,
    factId: result.factId,
    inputPayloadHash,
    memoryGeneration: result.memoryGeneration,
    memoryRevision: result.memoryRevision,
    outcome: result.outcome,
    versionId: result.versionId
  };
}

function parseReceiptSnapshot(
  value: Prisma.JsonValue,
  expectedPayloadHash: string
): MemoryFactMutationResult {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  const snapshot = value as Record<string, Prisma.JsonValue>;
  if (
    typeof snapshot.eventId !== "string" ||
    typeof snapshot.factId !== "string" ||
    snapshot.inputPayloadHash !== expectedPayloadHash ||
    typeof snapshot.memoryGeneration !== "number" ||
    typeof snapshot.memoryRevision !== "number" ||
    (snapshot.outcome !== "CREATED" &&
      snapshot.outcome !== "EDITED" &&
      snapshot.outcome !== "MOVED" &&
      snapshot.outcome !== "REINFORCED") ||
    typeof snapshot.versionId !== "string"
  ) {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  return {
    eventId: snapshot.eventId,
    factId: snapshot.factId,
    memoryGeneration: snapshot.memoryGeneration,
    memoryRevision: snapshot.memoryRevision,
    outcome: snapshot.outcome,
    replayed: true,
    versionId: snapshot.versionId
  };
}

async function replayedReceipt(
  tx: MemoryTransaction,
  userId: string,
  operation: "EDIT" | "MOVE_SCOPE" | "SAVE",
  input: MemoryReceiptIdentity,
  inputPayloadHash: string
): Promise<MemoryFactMutationResult | null> {
  const receipt = await tx.memoryOperationReceipt.findUnique({
    where: {
      userId_idempotencyFingerprint: {
        idempotencyFingerprint: input.idempotencyFingerprint,
        userId
      }
    }
  });
  if (!receipt) return null;
  if (
    receipt.operation !== operation ||
    receipt.outcome !== "APPLIED" ||
    receipt.requestId !== input.requestId ||
    receipt.modelRunId !== (input.modelRunId ?? null) ||
    receipt.persistedToolCallId !== (input.persistedToolCallId ?? null)
  ) {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  return parseReceiptSnapshot(receipt.resultSnapshot, inputPayloadHash);
}

async function persistReceipt(
  tx: MemoryTransaction,
  userId: string,
  operation: "EDIT" | "MOVE_SCOPE" | "SAVE",
  input: MemoryReceiptIdentity,
  inputPayloadHash: string,
  result: Omit<MemoryFactMutationResult, "replayed">
): Promise<void> {
  await tx.memoryOperationReceipt.create({
    data: {
      idempotencyFingerprint: input.idempotencyFingerprint,
      modelRunId: input.modelRunId,
      operation,
      outcome: "APPLIED",
      persistedToolCallId: input.persistedToolCallId,
      requestId: input.requestId,
      resultCode: result.outcome.toLocaleLowerCase("en-US"),
      resultSnapshot: receiptSnapshot(result, inputPayloadHash),
      targetFactId: result.factId,
      targetVersionId: result.versionId,
      userId
    }
  });
}

async function createEvent(
  tx: MemoryTransaction,
  userId: string,
  factId: string,
  versionId: string,
  operation: "EDIT" | "EXPLICIT_SAVE" | "PROMOTE" | "REINFORCE" | "SCOPE_CHANGE",
  value: MemoryFactValueInput,
  evidence: MemoryFactEvidenceInput,
  eventId: string
): Promise<void> {
  await tx.memoryEvent.create({
    data: {
      actorType: value.sourceMode === "EXPLICIT" ? "USER" : "SYSTEM",
      actorUserId: value.sourceMode === "EXPLICIT" ? userId : null,
      factId,
      factVersionId: versionId,
      id: eventId,
      metadata: { schemaVersion: "memory-event-metadata-v1" },
      operation,
      sourceChatId: evidence.kind === "MESSAGE" ? evidence.chatId : null,
      sourceGeneration: evidence.kind === "MESSAGE" ? evidence.branchGeneration : null,
      userId
    }
  });
}

async function createEvidence(
  tx: MemoryTransaction,
  userId: string,
  versionId: string,
  eventId: string,
  evidence: MemoryFactEvidenceInput
): Promise<void> {
  await tx.memoryEvidence.create({
    data: {
      branchGeneration: evidence.kind === "MESSAGE" ? evidence.branchGeneration : null,
      chatId: evidence.kind === "MESSAGE" ? evidence.chatId : null,
      factVersionId: versionId,
      memoryEventId: evidence.kind === "EXPLICIT_ACTION" ? eventId : null,
      messageId: evidence.kind === "MESSAGE" ? evidence.messageId : null,
      observedAt: evidence.observedAt,
      safeExcerpt: evidence.safeExcerpt,
      safeSourceHash: evidence.safeSourceHash,
      safetyClass: evidence.safetyClass,
      sourceProjectionVersion: evidence.sourceProjectionVersion,
      sourceRole: evidence.kind === "MESSAGE" ? evidence.sourceRole : null,
      sourceType: evidence.kind,
      stance: "SUPPORTS",
      userId
    }
  });
}

async function createSearchEntry(
  tx: MemoryTransaction,
  activeIndex: MemoryActiveIndex,
  userId: string,
  versionId: string,
  value: MemoryFactValueInput,
  evidence: MemoryFactEvidenceInput
): Promise<Readonly<{
  embeddingState: "FAILED" | "NOT_APPLICABLE" | "PENDING" | "READY";
  id: string;
}>> {
  const safeSearchText = normalizeMemorySearchText(value.displayText);
  return tx.memorySearchEntry.create({
    data: {
      embeddingState: activeIndex.indexMode === "LEXICAL_ONLY" ? "NOT_APPLICABLE" : "PENDING",
      factVersionId: versionId,
      indexGenerationId: activeIndex.id,
      itemType: "FACT_VERSION",
      languageCode: value.languageCode,
      safeContentHash: memorySha256({
        displayText: value.displayText,
        structuredValue: value.structuredValue
      }),
      safeSearchText,
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(value.displayText),
      safetyIdentitySnapshot: memorySha256({
        safetyClass: value.sensitivityClass,
        secretTaintedSourceWindow: value.secretTaintedSourceWindow
      }),
      sourceIdentitySnapshot: memorySha256({
        branchGeneration: evidence.kind === "MESSAGE" ? evidence.branchGeneration : null,
        safeSourceHash: evidence.safeSourceHash,
        sourceProjectionVersion: evidence.sourceProjectionVersion,
        sourceType: evidence.kind
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: value.canonicalKey,
        category: value.category,
        normalizedValue: safeSearchText
      }),
      userId
    },
    select: { embeddingState: true, id: true }
  });
}

async function enqueueExplicitEmbedding(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryFactMutationCommonInput,
  searchEntry: Readonly<{
    embeddingState: "FAILED" | "NOT_APPLICABLE" | "PENDING" | "READY";
    id: string;
  }> | null
): Promise<void> {
  if (
    input.value.sourceMode !== "EXPLICIT" ||
    !searchEntry ||
    (searchEntry.embeddingState !== "PENDING" &&
      searchEntry.embeddingState !== "FAILED")
  ) {
    return;
  }
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryExplicitEmbeddingJobFingerprint(
      searchEntry.id,
      input.idempotencyFingerprint
    ),
    kind: "EMBED_ITEMS",
    pipelineVersion: MEMORY_EXPLICIT_EMBEDDING_PIPELINE_VERSION
  });
}

async function enqueueWorkingSetRefresh(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryFactMutationCommonInput,
  factId: string
): Promise<void> {
  if (!settings.useMemoryFacts) return;
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memorySha256({
      factId,
      memoryRevision: settings.memoryRevision,
      mutation: input.idempotencyFingerprint,
      purpose: "recalculate-working-set"
    }),
    kind: "RECALCULATE_WORKING_SET",
    pipelineVersion: input.value.pipelineVersion
  });
}

function suppressionMatchInput(input: MemoryFactMutationCommonInput) {
  return {
    canonicalKey: input.value.canonicalKey,
    category: input.value.category,
    normalizedValue: normalizeMemorySearchText(input.value.displayText),
    source: input.evidence.kind === "MESSAGE" ? {
      branchGeneration: input.evidence.branchGeneration,
      chatId: input.evidence.chatId,
      messageId: input.evidence.messageId
    } : undefined
  };
}

async function prepareFactWrite(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  keyring: MemorySuppressionKeyring,
  input: MemoryFactMutationCommonInput
): Promise<MemoryActiveIndex> {
  await requireEvidenceOwner(tx, settings.userId, input.evidence);
  await assertMemoryWriteNotSuppressed(
    tx,
    keyring,
    settings.userId,
    suppressionMatchInput(input),
    {
      explicitOverrideRequested: input.explicitSuppressionOverride,
      sourceMode: input.value.sourceMode
    }
  );
  await advanceMemoryMutation(
    tx,
    settings,
    input.value.sourceMode === "EXPLICIT" ? "EXPLICIT_SAVE" : "AUTOMATIC_ADD_OR_REINFORCE"
  );
  const activeIndex = await requireActiveMemoryIndex(tx, settings);
  if (!activeIndex) return memoryPersistenceFailure("memory_active_generation_invalid");
  return activeIndex;
}

const currentVersionSelect = {
  category: true,
  confidence: true,
  directness: true,
  displayText: true,
  id: true,
  importance: true,
  languageCode: true,
  modality: true,
  pipelineVersion: true,
  sensitivityClass: true,
  sourceMode: true,
  state: true,
  structuredValue: true,
  systemFrom: true,
  systemTo: true,
  validFrom: true,
  validTo: true
} satisfies Prisma.MemoryFactVersionSelect;

type MemoryFactRepositoryOptions = Readonly<{
  consumeExplicitAuthorization?: (
    tx: MemoryTransaction,
    userId: string,
    input: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>
  ) => Promise<void>;
}>;

export function createPrismaMemoryFactRepository(
  keyring: MemorySuppressionKeyring,
  client: PrismaClient = prisma,
  options: MemoryFactRepositoryOptions = {}
) {
  const consumeExplicitAuthorization = options.consumeExplicitAuthorization ??
    consumeMemoryMutationAuthorization;

  async function authorizeExplicitMutation(
    tx: MemoryTransaction,
    userId: string,
    input: MemoryFactMutationCommonInput
  ): Promise<void> {
    if (input.value.sourceMode !== "EXPLICIT") return;
    if (!input.authorization) {
      return memoryPersistenceFailure("memory_input_invalid");
    }
    await consumeExplicitAuthorization(tx, userId, {
      ...input.authorization,
      requestId: input.requestId
    });
  }

  return Object.freeze({
    async edit(userId: string, input: MemoryFactEditInput): Promise<MemoryFactMutationResult> {
      validateMutation(input, "EDIT");
      if (
        !validBounded(input.factId, 256) ||
        !validBounded(input.expectedVersionId, 256) ||
        !validBounded(input.scopeId, 256) ||
        input.value.sourceMode !== "EXPLICIT" ||
        (input.pinned !== undefined && typeof input.pinned !== "boolean")
      ) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const inputPayloadHash = payloadHash("EDIT", input);
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const replay = await replayedReceipt(
          tx,
          userId,
          "EDIT",
          input,
          inputPayloadHash
        );
        if (replay) return replay;
        await authorizeExplicitMutation(tx, userId, input);
        await requireActiveOwnedMemoryScope(tx, userId, input.scopeId);

        const fact = await tx.memoryFact.findFirst({
          select: {
            canonicalKey: true,
            currentVersionId: true,
            id: true,
            scopeId: true,
            state: true
          },
          where: { id: input.factId, userId }
        });
        if (!fact) return memoryPersistenceFailure("memory_fact_not_found");
        if (
          fact.state !== "ACTIVE" ||
          fact.currentVersionId !== input.expectedVersionId ||
          fact.scopeId !== input.scopeId
        ) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        if (fact.canonicalKey !== input.value.canonicalKey) {
          return memoryPersistenceFailure("memory_fact_identity_conflict");
        }
        const currentVersion = await tx.memoryFactVersion.findFirst({
          select: currentVersionSelect,
          where: {
            factId: fact.id,
            id: input.expectedVersionId,
            state: "ACTIVE",
            userId
          }
        });
        if (!currentVersion) return memoryPersistenceFailure("memory_fact_version_stale");

        await requireEvidenceOwner(tx, userId, input.evidence);
        await assertMemoryWriteNotSuppressed(
          tx,
          keyring,
          userId,
          suppressionMatchInput(input),
          { explicitOverrideRequested: input.explicitSuppressionOverride, sourceMode: "EXPLICIT" }
        );
        await advanceMemoryMutation(tx, settings, "EXPLICIT_EDIT_PIN_RESCOPE_OR_RESOLVE");
        const activeIndex = await requireActiveMemoryIndex(tx, settings);
        if (!activeIndex) return memoryPersistenceFailure("memory_active_generation_invalid");

        const eventId = randomUUID();
        const versionId = randomUUID();
        const transitionAt = new Date(Math.max(Date.now(), currentVersion.systemFrom.getTime() + 1));
        await createEvent(
          tx,
          userId,
          fact.id,
          versionId,
          "EDIT",
          input.value,
          input.evidence,
          eventId
        );
        const superseded = await tx.memoryFactVersion.updateMany({
          data: { state: "SUPERSEDED", systemTo: transitionAt },
          where: {
            factId: fact.id,
            id: input.expectedVersionId,
            state: "ACTIVE",
            systemTo: null,
            userId
          }
        });
        if (superseded.count !== 1) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        await tx.memoryFactVersion.create({
          data: {
            category: input.value.category,
            confidence: input.value.confidence,
            createdByEventId: eventId,
            directness: input.value.directness,
            displayText: input.value.displayText,
            factId: fact.id,
            id: versionId,
            importance: input.value.importance,
            languageCode: input.value.languageCode,
            modality: input.value.modality,
            normalizedSearchText: normalizeMemorySearchText(input.value.displayText),
            pipelineVersion: input.value.pipelineVersion,
            sensitivityClass: input.value.sensitivityClass,
            sourceMode: input.value.sourceMode,
            state: "ACTIVE",
            structuredValue: input.value.structuredValue,
            supersedesVersionId: input.expectedVersionId,
            systemFrom: transitionAt,
            userId,
            validFrom: input.value.validFrom,
            validTo: input.value.validTo
          }
        });
        const updated = await tx.memoryFact.updateMany({
          data: {
            category: input.value.category,
            currentVersionId: versionId,
            lastConfirmedAt: input.evidence.observedAt,
            ...(input.pinned === undefined ? {} : { pinned: input.pinned })
          },
          where: {
            currentVersionId: input.expectedVersionId,
            id: fact.id,
            state: "ACTIVE",
            userId
          }
        });
        if (updated.count !== 1) return memoryPersistenceFailure("memory_fact_version_stale");
        await tx.memorySearchEntry.deleteMany({
          where: {
            factVersionId: input.expectedVersionId,
            indexGenerationId: activeIndex.id,
            userId
          }
        });
        await createEvidence(tx, userId, versionId, eventId, input.evidence);
        const searchEntry = await createSearchEntry(
          tx,
          activeIndex,
          userId,
          versionId,
          input.value,
          input.evidence
        );
        await enqueueExplicitEmbedding(tx, settings, input, searchEntry);
        await enqueueWorkingSetRefresh(tx, settings, input, fact.id);

        const result = {
          eventId,
          factId: fact.id,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          outcome: "EDITED" as const,
          versionId
        };
        await persistReceipt(tx, userId, "EDIT", input, inputPayloadHash, result);
        return { ...result, replayed: false };
      });
    },

    async move(userId: string, input: MemoryFactMoveInput): Promise<MemoryFactMutationResult> {
      validateMutation(input, "MOVE_SCOPE");
      if (
        !validBounded(input.factId, 256) ||
        !validBounded(input.expectedVersionId, 256) ||
        !validBounded(input.targetScopeId, 256) ||
        input.value.sourceMode !== "EXPLICIT"
      ) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const inputPayloadHash = payloadHash("MOVE_SCOPE", input);
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const replay = await replayedReceipt(
          tx,
          userId,
          "MOVE_SCOPE",
          input,
          inputPayloadHash
        );
        if (replay) return replay;
        await authorizeExplicitMutation(tx, userId, input);
        const targetScope = await requireActiveOwnedMemoryScope(
          tx,
          userId,
          input.targetScopeId
        );

        const [sourceFact] = await tx.$queryRaw<Array<{
          canonicalKey: string;
          category: string;
          currentVersionId: string | null;
          id: string;
          pinned: boolean;
          scopeId: string;
          state: "ACTIVE" | "ORPHANED";
        }>>(Prisma.sql`
          SELECT "id", "scopeId", "canonicalKey", "category", "state"::text AS "state",
            "pinned", "currentVersionId"
          FROM "MemoryFact"
          WHERE "id" = ${input.factId} AND "userId" = ${userId}
            AND "state" IN (
              'ACTIVE'::"MemoryFactState",
              'ORPHANED'::"MemoryFactState"
            )
          FOR UPDATE
        `);
        if (!sourceFact) return memoryPersistenceFailure("memory_fact_not_found");
        if (sourceFact.scopeId === targetScope.id) {
          return memoryPersistenceFailure("memory_fact_identity_conflict");
        }
        const [sourceScope] = await tx.$queryRaw<Array<{
          id: string;
          state: "ACTIVE" | "ORPHANED";
        }>>(Prisma.sql`
          SELECT "id", "state"::text AS "state"
          FROM "MemoryScope"
          WHERE "id" = ${sourceFact.scopeId} AND "userId" = ${userId}
            AND "state" IN (
              'ACTIVE'::"MemoryScopeState",
              'ORPHANED'::"MemoryScopeState"
            )
          FOR SHARE
        `);
        if (!sourceScope || sourceScope.state !== sourceFact.state) {
          return memoryPersistenceFailure("memory_scope_unavailable");
        }
        if (
          (sourceFact.state === "ACTIVE" &&
            sourceFact.currentVersionId !== input.expectedVersionId) ||
          (sourceFact.state === "ORPHANED" && sourceFact.currentVersionId !== null)
        ) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        if (sourceFact.canonicalKey !== input.value.canonicalKey) {
          return memoryPersistenceFailure("memory_fact_identity_conflict");
        }
        const sourceVersion = await tx.memoryFactVersion.findFirst({
          select: currentVersionSelect,
          where: {
            factId: sourceFact.id,
            id: input.expectedVersionId,
            sourceMode: "EXPLICIT",
            state: sourceFact.state,
            userId
          }
        });
        if (!sourceVersion) return memoryPersistenceFailure("memory_fact_version_stale");
        if (!sourceVersion.displayText || sourceVersion.structuredValue === null) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        const movedValue: MemoryFactValueInput = {
          canonicalKey: sourceFact.canonicalKey,
          category: sourceVersion.category,
          confidence: sourceVersion.confidence,
          directness: sourceVersion.directness,
          displayText: sourceVersion.displayText,
          importance: sourceVersion.importance,
          languageCode: sourceVersion.languageCode,
          modality: sourceVersion.modality,
          pipelineVersion: sourceVersion.pipelineVersion,
          secretTaintedSourceWindow: false,
          sensitivityClass: sourceVersion.sensitivityClass,
          sourceMode: "EXPLICIT",
          structuredValue: sourceVersion.structuredValue as Prisma.InputJsonValue,
          validFrom: sourceVersion.validFrom,
          validTo: sourceVersion.validTo
        };
        const movedInput: MemoryFactMoveInput = { ...input, value: movedValue };
        if (sourceFact.state === "ORPHANED") {
          const latest = await tx.memoryFactVersion.findFirst({
            orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
            select: { id: true },
            where: { factId: sourceFact.id, state: "ORPHANED", userId }
          });
          if (latest?.id !== sourceVersion.id) {
            return memoryPersistenceFailure("memory_fact_version_stale");
          }
        }

        const [targetFact] = await tx.$queryRaw<Array<{
          currentVersionId: string | null;
          id: string;
          pinned: boolean;
          state: string;
        }>>(Prisma.sql`
          SELECT "id", "state"::text AS "state", "pinned", "currentVersionId"
          FROM "MemoryFact"
          WHERE "userId" = ${userId}
            AND "scopeId" = ${targetScope.id}
            AND "canonicalKey" = ${sourceFact.canonicalKey}
          FOR UPDATE
        `);
        if (targetFact && (targetFact.state !== "ACTIVE" || !targetFact.currentVersionId)) {
          return memoryPersistenceFailure("memory_fact_identity_conflict");
        }
        const targetCurrentVersion = targetFact?.currentVersionId
          ? await tx.memoryFactVersion.findFirst({
            select: currentVersionSelect,
            where: {
              factId: targetFact.id,
              id: targetFact.currentVersionId,
              state: "ACTIVE",
              userId
            }
          })
          : null;
        if (targetFact && !targetCurrentVersion) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        if (
          targetCurrentVersion &&
          versionContentHash(targetCurrentVersion) !== versionContentHash(sourceVersion)
        ) {
          return memoryPersistenceFailure("memory_fact_identity_conflict");
        }

        await requireEvidenceOwner(tx, userId, input.evidence);
        await assertMemoryWriteNotSuppressed(
          tx,
          keyring,
          userId,
          suppressionMatchInput(movedInput),
          { explicitOverrideRequested: false, sourceMode: "EXPLICIT" }
        );
        await advanceMemoryMutation(tx, settings, "EXPLICIT_EDIT_PIN_RESCOPE_OR_RESOLVE");
        const activeIndex = await requireActiveMemoryIndex(tx, settings);
        if (!activeIndex) return memoryPersistenceFailure("memory_active_generation_invalid");

        const eventId = randomUUID();
        const targetFactId = targetFact?.id ?? randomUUID();
        const targetVersionId = randomUUID();
        const transitionAt = new Date(Math.max(
          Date.now(),
          sourceVersion.systemFrom.getTime() + 1,
          (targetCurrentVersion?.systemFrom.getTime() ?? 0) + 1
        ));

        if (!targetFact) {
          await tx.memoryFact.create({
            data: {
              canonicalKey: sourceFact.canonicalKey,
              category: movedValue.category,
              currentVersionId: targetVersionId,
              id: targetFactId,
              lastConfirmedAt: input.evidence.observedAt,
              pinned: sourceFact.pinned,
              scopeId: targetScope.id,
              state: "ACTIVE",
              userId
            }
          });
        }
        await tx.memoryEvent.create({
          data: {
            actorType: "USER",
            actorUserId: userId,
            factId: targetFactId,
            factVersionId: targetVersionId,
            id: eventId,
            metadata: {
              movedFromFactId: sourceFact.id,
              movedFromScopeId: sourceFact.scopeId,
              movedFromVersionId: sourceVersion.id,
              movedToScopeId: targetScope.id,
              schemaVersion: "memory-scope-move-v1"
            },
            operation: "SCOPE_CHANGE",
            userId
          }
        });
        if (targetCurrentVersion && targetFact) {
          const superseded = await tx.memoryFactVersion.updateMany({
            data: { state: "SUPERSEDED", systemTo: transitionAt },
            where: {
              factId: targetFact.id,
              id: targetCurrentVersion.id,
              state: "ACTIVE",
              systemTo: null,
              userId
            }
          });
          if (superseded.count !== 1) {
            return memoryPersistenceFailure("memory_fact_version_stale");
          }
        }
        await tx.memoryFactVersion.create({
          data: {
            category: movedValue.category,
            confidence: movedValue.confidence,
            createdByEventId: eventId,
            directness: movedValue.directness,
            displayText: movedValue.displayText,
            factId: targetFactId,
            id: targetVersionId,
            importance: movedValue.importance,
            languageCode: movedValue.languageCode,
            modality: movedValue.modality,
            movedFromVersionId: sourceVersion.id,
            normalizedSearchText: normalizeMemorySearchText(movedValue.displayText),
            pipelineVersion: movedValue.pipelineVersion,
            sensitivityClass: movedValue.sensitivityClass,
            sourceMode: "EXPLICIT",
            state: "ACTIVE",
            structuredValue: movedValue.structuredValue,
            supersedesVersionId: targetCurrentVersion?.id,
            systemFrom: transitionAt,
            userId,
            validFrom: movedValue.validFrom,
            validTo: movedValue.validTo
          }
        });
        if (targetFact) {
          const updatedTarget = await tx.memoryFact.updateMany({
            data: {
              category: movedValue.category,
              currentVersionId: targetVersionId,
              lastConfirmedAt: input.evidence.observedAt,
              pinned: targetFact.pinned || sourceFact.pinned
            },
            where: {
              currentVersionId: targetCurrentVersion!.id,
              id: targetFact.id,
              state: "ACTIVE",
              userId
            }
          });
          if (updatedTarget.count !== 1) {
            return memoryPersistenceFailure("memory_fact_version_stale");
          }
        }
        const retractedVersion = await tx.memoryFactVersion.updateMany({
          data: {
            state: "RETRACTED",
            ...(sourceVersion.systemTo ? {} : { systemTo: transitionAt })
          },
          where: {
            factId: sourceFact.id,
            id: sourceVersion.id,
            state: sourceFact.state,
            userId
          }
        });
        if (retractedVersion.count !== 1) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        const retractedFact = await tx.memoryFact.updateMany({
          data: {
            currentVersionId: null,
            movedToFactId: targetFactId,
            pinned: false,
            state: "RETRACTED"
          },
          where: {
            currentVersionId: sourceFact.currentVersionId,
            id: sourceFact.id,
            state: sourceFact.state,
            userId
          }
        });
        if (retractedFact.count !== 1) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        await tx.memorySearchEntry.deleteMany({
          where: {
            factVersionId: {
              in: [sourceVersion.id, ...(targetCurrentVersion ? [targetCurrentVersion.id] : [])]
            },
            indexGenerationId: activeIndex.id,
            userId
          }
        });
        await createEvidence(tx, userId, targetVersionId, eventId, input.evidence);
        const searchEntry = await createSearchEntry(
          tx,
          activeIndex,
          userId,
          targetVersionId,
          movedValue,
          input.evidence
        );
        await enqueueExplicitEmbedding(tx, settings, movedInput, searchEntry);
        await enqueueWorkingSetRefresh(tx, settings, movedInput, targetFactId);

        const result = {
          eventId,
          factId: targetFactId,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          outcome: "MOVED" as const,
          versionId: targetVersionId
        };
        await persistReceipt(tx, userId, "MOVE_SCOPE", input, inputPayloadHash, result);
        return { ...result, replayed: false };
      });
    },

    async save(userId: string, input: MemoryFactSaveInput): Promise<MemoryFactMutationResult> {
      validateMutation(input, "SAVE");
      if (!validBounded(input.scopeId, 256)) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const inputPayloadHash = payloadHash("SAVE", input);
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const replay = await replayedReceipt(
          tx,
          userId,
          "SAVE",
          input,
          inputPayloadHash
        );
        if (replay) return replay;
        await authorizeExplicitMutation(tx, userId, input);
        await requireActiveOwnedMemoryScope(tx, userId, input.scopeId);

        const existing = await tx.memoryFact.findFirst({
          select: {
            currentVersionId: true,
            id: true,
            state: true
          },
          where: {
            canonicalKey: input.value.canonicalKey,
            scopeId: input.scopeId,
            userId
          }
        });
        let currentVersion: Awaited<ReturnType<typeof tx.memoryFactVersion.findFirst<{
          select: typeof currentVersionSelect;
        }>>> = null;
        let revivalVersionId: string | null = null;
        if (existing?.state === "ACTIVE" && existing.currentVersionId) {
          currentVersion = await tx.memoryFactVersion.findFirst({
            select: currentVersionSelect,
            where: {
              factId: existing.id,
              id: existing.currentVersionId,
              state: "ACTIVE",
              userId
            }
          });
          if (!currentVersion) return memoryPersistenceFailure("memory_fact_version_stale");
          if (versionContentHash(currentVersion) !== inputContentHash(input.value)) {
            return memoryPersistenceFailure("memory_fact_identity_conflict");
          }
        } else if (existing) {
          if (
            existing.state !== "FORGOTTEN" ||
            input.value.sourceMode !== "EXPLICIT" ||
            !input.explicitSuppressionOverride
          ) {
            return memoryPersistenceFailure("memory_fact_identity_conflict");
          }
          const prior = await tx.memoryFactVersion.findFirst({
            orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
            select: { id: true },
            where: { factId: existing.id, userId }
          });
          if (!prior) return memoryPersistenceFailure("memory_fact_version_stale");
          revivalVersionId = prior.id;
        }

        const activeIndex = await prepareFactWrite(tx, settings, keyring, input);
        if (existing && currentVersion) {
          const eventId = randomUUID();
          await createEvent(
            tx,
            userId,
            existing.id,
            currentVersion.id,
            "REINFORCE",
            input.value,
            input.evidence,
            eventId
          );
          await createEvidence(tx, userId, currentVersion.id, eventId, input.evidence);
          await tx.memoryFact.update({
            data: { lastConfirmedAt: input.evidence.observedAt },
            where: { id: existing.id }
          });
          const searchEntry = await tx.memorySearchEntry.findFirst({
            select: { embeddingState: true, id: true },
            where: {
              factVersionId: currentVersion.id,
              indexGenerationId: activeIndex.id,
              itemType: "FACT_VERSION",
              userId
            }
          });
          await enqueueExplicitEmbedding(tx, settings, input, searchEntry);
          await enqueueWorkingSetRefresh(tx, settings, input, existing.id);
          const result = {
            eventId,
            factId: existing.id,
            memoryGeneration: settings.memoryGeneration,
            memoryRevision: settings.memoryRevision,
            outcome: "REINFORCED" as const,
            versionId: currentVersion.id
          };
          await persistReceipt(tx, userId, "SAVE", input, inputPayloadHash, result);
          return { ...result, replayed: false };
        }

        const eventId = randomUUID();
        const factId = existing?.id ?? randomUUID();
        const versionId = randomUUID();
        if (existing) {
          const revived = await tx.memoryFact.updateMany({
            data: {
              category: input.value.category,
              currentVersionId: versionId,
              forgottenAt: null,
              lastConfirmedAt: input.evidence.observedAt,
              state: "ACTIVE"
            },
            where: { id: existing.id, state: "FORGOTTEN", userId }
          });
          if (revived.count !== 1) {
            return memoryPersistenceFailure("memory_fact_version_stale");
          }
        } else {
          await tx.memoryFact.create({
            data: {
              canonicalKey: input.value.canonicalKey,
              category: input.value.category,
              currentVersionId: versionId,
              id: factId,
              lastConfirmedAt: input.evidence.observedAt,
              scopeId: input.scopeId,
              state: "ACTIVE",
              userId
            }
          });
        }
        await createEvent(
          tx,
          userId,
          factId,
          versionId,
          input.value.sourceMode === "EXPLICIT" ? "EXPLICIT_SAVE" : "PROMOTE",
          input.value,
          input.evidence,
          eventId
        );
        await tx.memoryFactVersion.create({
          data: {
            category: input.value.category,
            confidence: input.value.confidence,
            createdByEventId: eventId,
            directness: input.value.directness,
            displayText: input.value.displayText,
            factId,
            id: versionId,
            importance: input.value.importance,
            languageCode: input.value.languageCode,
            modality: input.value.modality,
            normalizedSearchText: normalizeMemorySearchText(input.value.displayText),
            pipelineVersion: input.value.pipelineVersion,
            sensitivityClass: input.value.sensitivityClass,
            sourceMode: input.value.sourceMode,
            state: "ACTIVE",
            structuredValue: input.value.structuredValue,
            supersedesVersionId: revivalVersionId,
            userId,
            validFrom: input.value.validFrom,
            validTo: input.value.validTo
          }
        });
        await createEvidence(tx, userId, versionId, eventId, input.evidence);
        const searchEntry = await createSearchEntry(
          tx,
          activeIndex,
          userId,
          versionId,
          input.value,
          input.evidence
        );
        await enqueueExplicitEmbedding(tx, settings, input, searchEntry);
        await enqueueWorkingSetRefresh(tx, settings, input, factId);
        const result = {
          eventId,
          factId,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          outcome: "CREATED" as const,
          versionId
        };
        await persistReceipt(tx, userId, "SAVE", input, inputPayloadHash, result);
        return { ...result, replayed: false };
      });
    }
  });
}
