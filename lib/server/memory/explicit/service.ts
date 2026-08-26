import { randomUUID } from "node:crypto";
import type {
  MemoryCreateInput,
  MemoryConflictResolutionInput,
  MemoryDetailResponse,
  MemoryEvidenceResponse,
  MemoryListInput,
  MemoryListResponse,
  MemoryListSearchInput,
  MemoryMutationAuthorizationInput,
  MemoryMutationAuthorizationResponse,
  MemoryMutationResponse,
  MemorySensitivityClass,
  MemoryUndoForgetInput,
  MemoryUpdateInput
} from "../../../contracts/memory";
import type { MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import {
  decodeMemoryDetailResponse,
  decodeMemoryEvidenceResponse,
  decodeMemoryListResponse,
  decodeMemoryMutationAuthorizationResponse,
  decodeMemoryMutationResponse,
  MEMORY_CONFIRMATION_COPY_VERSION
} from "../../../contracts/memory";
import { memoryMutationIntentAllowed } from "../../../domain/memory/safety";
import {
  type MemoryMutationAuthorizationMint,
  type MemoryMutationAuthorizationUse,
  MEMORY_MUTATION_AUTHORIZATION_TTL_MS,
  memoryMutationNonceHash,
  memoryTargetAuthorizationPayloadHash
} from "../persistence/authorizations";
import {
  MemoryPersistenceError,
  type MemoryPersistenceErrorCode
} from "../persistence/errors";
import type {
  MemoryFactEditInput,
  MemoryFactMoveInput,
  MemoryFactMutationResult,
  MemoryFactResolveInput,
  MemoryFactSafetyClassificationInput,
  MemoryFactSaveInput,
  MemoryFactValueInput
} from "../persistence/facts";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import type { ActiveMemoryScope } from "../persistence/scopes";
import type {
  ExplicitMemoryConflictEditable,
  ExplicitMemoryEditable,
  ExplicitMemoryForgetUndoCandidate
} from "./repository";
import { memoryExplicitStatementContainsSecret } from "./safety";
import {
  MemoryStatementClassificationError,
  memoryStatementClassificationDecision,
  type MemoryStatementClassification,
  type MemoryStatementClassifier
} from "./statementClassifier";

type StorableMemoryStatementClassification = Omit<
  MemoryStatementClassification,
  "sensitivity" | "storageDecision"
> & Readonly<{
  sensitivity: "NORMAL";
  storageDecision: "ALLOW";
}>;

export const MEMORY_EXPLICIT_PIPELINE_VERSION = "memory-explicit-api-v1";
export const MEMORY_EXPLICIT_SOURCE_PROJECTION_VERSION =
  "memory-explicit-action-v1";

export type ExplicitMemoryAuthorizationRepository = Readonly<{
  mint(
    userId: string,
    input: MemoryMutationAuthorizationMint,
    now?: Date
  ): Promise<Readonly<{ expiresAt: Date; id: string }>>;
  resolveForUse(
    userId: string,
    input: MemoryMutationAuthorizationUse
  ): Promise<Readonly<{ confirmedAt: Date; replayed?: boolean; requestId: string }>>;
}>;

export type ExplicitMemoryFactRepository = Readonly<{
  edit(userId: string, input: MemoryFactEditInput): Promise<MemoryFactMutationResult>;
  move(userId: string, input: MemoryFactMoveInput): Promise<MemoryFactMutationResult>;
  resolve(userId: string, input: MemoryFactResolveInput): Promise<MemoryFactMutationResult>;
  save(userId: string, input: MemoryFactSaveInput): Promise<MemoryFactMutationResult>;
}>;

export type ExplicitMemoryReadRepository = Readonly<{
  detail(userId: string, factId: string): Promise<MemoryDetailResponse | null>;
  evidence(
    userId: string,
    factId: string,
    cursor: string | null
  ): Promise<MemoryEvidenceResponse | null>;
  get(userId: string, factId: string): Promise<MemoryMutationResponse["memory"] | null>;
  getConflict(userId: string, factId: string): Promise<ExplicitMemoryConflictEditable | null>;
  getEditable(userId: string, factId: string): Promise<ExplicitMemoryEditable | null>;
  getForgetUndoCandidate(
    userId: string,
    factId: string,
    deletionId: string,
    now: Date
  ): Promise<ExplicitMemoryForgetUndoCandidate | null>;
  list(userId: string, input: MemoryListInput): Promise<MemoryListResponse>;
  search(userId: string, input: MemoryListSearchInput): Promise<MemoryListResponse>;
}>;

export type ExplicitMemoryScopeRepository = Readonly<{
  ensure(
    userId: string,
    scope: MemoryCreateInput["scope"],
    options?: Readonly<{ deadlineAtMs?: number }>
  ): Promise<ActiveMemoryScope>;
  ensureGlobal(userId: string): Promise<ActiveMemoryScope>;
}>;

export type ExplicitMemoryServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_index_unavailable"
  | "memory_intent_confirmation_required"
  | "memory_not_found"
  | "memory_operation_unsupported"
  | "memory_scope_invalid"
  | "memory_scope_unavailable"
  | "memory_secret_rejected"
  | "memory_statement_invalid"
  | "memory_unavailable"
  | "memory_undo_unavailable"
  | "memory_version_stale";

export class ExplicitMemoryServiceError extends Error {
  readonly code: ExplicitMemoryServiceErrorCode;

  constructor(code: ExplicitMemoryServiceErrorCode) {
    super(code);
    this.code = code;
    this.name = "ExplicitMemoryServiceError";
  }
}

export class MemoryControlledMutationCommittedError extends Error {
  constructor(
    readonly factId: string,
    readonly statement: string,
    readonly versionId: string
  ) {
    super("memory_controlled_mutation_committed");
    this.name = "MemoryControlledMutationCommittedError";
  }
}

export type ExplicitMemoryService = Readonly<{
  create(
    userId: string,
    input: MemoryCreateInput,
    execution?: MemoryOperationExecutionContext
  ): Promise<MemoryMutationResponse>;
  evidence(
    userId: string,
    factId: string,
    cursor: string | null
  ): Promise<MemoryEvidenceResponse>;
  get(userId: string, factId: string): Promise<MemoryDetailResponse>;
  list(userId: string, input: MemoryListInput): Promise<MemoryListResponse>;
  mintAuthorization(
    userId: string,
    input: MemoryMutationAuthorizationInput
  ): Promise<MemoryMutationAuthorizationResponse>;
  search(userId: string, input: MemoryListSearchInput): Promise<MemoryListResponse>;
  resolveConflict(
    userId: string,
    factId: string,
    input: MemoryConflictResolutionInput
  ): Promise<MemoryMutationResponse>;
  undoForget(
    userId: string,
    factId: string,
    input: MemoryUndoForgetInput
  ): Promise<MemoryMutationResponse>;
  update(
    userId: string,
    factId: string,
    input: MemoryUpdateInput,
    execution?: MemoryOperationExecutionContext
  ): Promise<MemoryMutationResponse>;
}>;

export type MemoryOperationExecutionContext = Readonly<{
  admissionDeadlineAtMs?: number;
  authorizedPayloadHash?: string;
  exactStatementHash?: string;
  modelRunId: string;
  persistedToolCallId?: string | null;
  safetyClassifierExecutionId?: string;
  safetyClassifierIntent?: MemoryActionIntent;
  sensitivityClass?: "NORMAL" | "SENSITIVE";
}>;

function failure(code: ExplicitMemoryServiceErrorCode): never {
  throw new ExplicitMemoryServiceError(code);
}

function publicPersistenceCode(
  code: MemoryPersistenceErrorCode
): ExplicitMemoryServiceErrorCode {
  switch (code) {
    case "memory_admission_deadline_exceeded":
      return "memory_unavailable";
    case "memory_fact_not_found":
      return "memory_not_found";
    case "memory_fact_version_stale":
    case "memory_revision_conflict":
    case "memory_settings_conflict":
      return "memory_version_stale";
    case "memory_mutation_authorization_invalid":
    case "memory_idempotency_conflict":
    case "memory_fact_suppressed":
      return "memory_intent_confirmation_required";
    case "memory_scope_unavailable":
      return "memory_scope_unavailable";
    case "memory_plaintext_not_allowed":
      return "memory_secret_rejected";
    case "memory_active_generation_invalid":
      return "memory_index_unavailable";
    case "memory_undo_unavailable":
      return "memory_undo_unavailable";
    case "memory_input_invalid":
      return "memory_contract_invalid";
    default:
      return "memory_action_failed";
  }
}

function controlSafetyClassification(
  execution: MemoryOperationExecutionContext | undefined
): MemoryFactSafetyClassificationInput | undefined {
  if (!execution?.safetyClassifierExecutionId) return undefined;
  if (!execution.safetyClassifierIntent) return failure("memory_contract_invalid");
  return {
    executionId: execution.safetyClassifierExecutionId,
    intent: execution.safetyClassifierIntent,
    kind: "CONTROL"
  };
}

function statementSafetyClassification(
  classification: StorableMemoryStatementClassification | null,
  inputStatement: string,
  displayProjection: "CLASSIFIER_NORMALIZED" | "EXACT_INPUT" =
    "CLASSIFIER_NORMALIZED"
): MemoryFactSafetyClassificationInput | undefined {
  if (!classification?.executionId) return undefined;
  if (!classification.acceptedOutputHash || !classification.inputHash) {
    return failure("memory_contract_invalid");
  }
  return {
    acceptedOutputHash: classification.acceptedOutputHash,
    decision: memoryStatementClassificationDecision(classification),
    displayProjection,
    executionId: classification.executionId,
    inputHash: classification.inputHash,
    inputStatement,
    kind: "STATEMENT"
  };
}

function classifiedModality(
  classification: StorableMemoryStatementClassification | null,
  fallback: MemoryFactValueInput["modality"]
): MemoryFactValueInput["modality"] {
  if (!classification) return fallback;
  if (classification.responsePreference) return "PREFERENCE";
  return fallback === "PREFERENCE" ? "STATE" : fallback;
}

async function persisted<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MemoryPersistenceError) {
      return failure(publicPersistenceCode(error.code));
    }
    throw error;
  }
}

function requireStatement(statement: string): void {
  if (
    !normalizeMemorySearchText(statement) ||
    statement.length > 2_000
  ) {
    return failure("memory_statement_invalid");
  }
  if (memoryExplicitStatementContainsSecret(statement)) {
    return failure("memory_secret_rejected");
  }
}

function languageCode(_statement: string): string {
  return "und";
}

function customCanonicalKey(statement: string): string {
  return `custom.${memorySha256({
    normalizedStatement: normalizeMemorySearchText(statement),
    version: "memory-explicit-custom-key-v1"
  }).slice(0, 48)}`;
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(value);
}

function canonicalStorableSensitivity(
  value: MemorySensitivityClass
): MemorySensitivityClass {
  return value === "SENSITIVE" ? "NORMAL" : value;
}

function canonicalStorableCategory(value: string, responsePreference = false): string {
  if (responsePreference) return "preferences";
  return value === "sensitive" ? "about_you" : value;
}

const sensitivityRank: Readonly<Record<MemorySensitivityClass, number>> = {
  HIGHLY_SENSITIVE: 2,
  NORMAL: 0,
  SECRET: 3,
  SENSITIVE: 1
};

function mostRestrictiveSensitivity(
  values: readonly MemorySensitivityClass[]
): MemorySensitivityClass {
  return values.map(canonicalStorableSensitivity).reduce((mostRestrictive, value) =>
    sensitivityRank[value] > sensitivityRank[mostRestrictive]
      ? value
      : mostRestrictive, "NORMAL");
}

function valueFor(input: Readonly<{
  canonicalKey: string;
  category: string;
  modality: MemoryFactValueInput["modality"];
  safetyClassification?: MemoryFactValueInput["safetyClassification"];
  sensitivityClass?: MemoryFactValueInput["sensitivityClass"];
  statement: string;
  validFrom: Date | null;
  validTo: Date | null;
}>): MemoryFactValueInput {
  return {
    canonicalKey: input.canonicalKey,
    category: canonicalStorableCategory(input.category),
    confidence: 1,
    directness: "DIRECT",
    displayText: input.statement,
    importance: 1,
    languageCode: languageCode(input.statement),
    modality: input.modality,
    pipelineVersion: MEMORY_EXPLICIT_PIPELINE_VERSION,
    ...(input.safetyClassification
      ? { safetyClassification: input.safetyClassification }
      : {}),
    secretTaintedSourceWindow: false,
    sensitivityClass: canonicalStorableSensitivity(
      input.sensitivityClass ?? "NORMAL"
    ),
    sourceMode: "EXPLICIT",
    structuredValue: {
      kind: "explicit_statement",
      statement: input.statement
    },
    validFrom: input.validFrom,
    validTo: input.validTo
  };
}

function evidenceFor(
  statement: string,
  observedAt: Date,
  safetyClass: MemoryFactValueInput["sensitivityClass"] = "NORMAL"
) {
  const canonicalSafetyClass = canonicalStorableSensitivity(safetyClass);
  return {
    kind: "EXPLICIT_ACTION" as const,
    observedAt,
    safeExcerpt: statement,
    safeSourceHash: memorySha256(statement),
    safetyClass: canonicalSafetyClass,
    sourceProjectionVersion: MEMORY_EXPLICIT_SOURCE_PROJECTION_VERSION
  };
}

function authorizationUse(input: Readonly<{
  action: "EDIT" | "MOVE_SCOPE" | "SAVE";
  admissionDeadlineAtMs?: number;
  authorizationId: string;
  authorizedPayloadHash: string;
  expectedTargetVersionId?: string;
  targetFactId?: string;
}>): MemoryMutationAuthorizationUse {
  return input;
}

function idempotencyFingerprint(input: MemoryMutationAuthorizationUse): string {
  return memorySha256({
    action: input.action,
    authorizationId: input.authorizationId,
    domain: "aiqsa.memory.explicit-operation",
    version: "v1"
  });
}

function idempotencyPayloadHash(
  action: "EDIT" | "MOVE_SCOPE" | "SAVE",
  payload: unknown
): string {
  return memorySha256({
    action,
    domain: "aiqsa.memory.explicit-operation-payload",
    payload,
    version: "v1"
  });
}

function mutationResponse(memory: MemoryMutationResponse["memory"]): MemoryMutationResponse {
  const decoded = decodeMemoryMutationResponse({ memory });
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

function checkedList(response: MemoryListResponse): MemoryListResponse {
  const decoded = decodeMemoryListResponse(response);
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

function checkedEvidence(response: MemoryEvidenceResponse): MemoryEvidenceResponse {
  const decoded = decodeMemoryEvidenceResponse(response);
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

function checkedDetail(response: MemoryDetailResponse): MemoryDetailResponse {
  const decoded = decodeMemoryDetailResponse(response);
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

export function createExplicitMemoryService(input: Readonly<{
  authorizationRepository: ExplicitMemoryAuthorizationRepository;
  clock?: () => Date;
  factRepository: ExplicitMemoryFactRepository;
  readRepository: ExplicitMemoryReadRepository;
  scopeRepository: ExplicitMemoryScopeRepository;
  statementClassifier?: MemoryStatementClassifier;
}>): ExplicitMemoryService {
  const clock = input.clock ?? (() => new Date());

  async function currentResponse(
    userId: string,
    factId: string
  ): Promise<MemoryMutationResponse> {
    const memory = await persisted(() => input.readRepository.get(userId, factId));
    if (!memory) return failure("memory_not_found");
    return mutationResponse(memory);
  }

  async function classifyStatement(
    userId: string,
    mutationAuthorizationId: string,
    statement: string
  ): Promise<StorableMemoryStatementClassification | null> {
    if (!input.statementClassifier) return null;
    let classification: MemoryStatementClassification;
    try {
      classification = await input.statementClassifier.classify(statement, {
        execution: { mutationAuthorizationId, userId }
      });
    } catch (error) {
      return failure(error instanceof MemoryStatementClassificationError &&
        error.code === "memory_statement_classification_unavailable"
        ? "memory_unavailable"
        : "memory_action_failed");
    }
    if (classification.sensitivity === "SECRET" ||
      classification.sensitivity === "UNCERTAIN") {
      return failure("memory_secret_rejected");
    }
    if (classification.storageDecision !== "ALLOW") {
      return failure("memory_statement_invalid");
    }
    requireStatement(classification.normalizedStatement);
    return {
      ...classification,
      category: canonicalStorableCategory(
        classification.category,
        classification.responsePreference
      ) as
        StorableMemoryStatementClassification["category"],
      sensitivity: "NORMAL",
      storageDecision: "ALLOW"
    };
  }

  return Object.freeze({
    async create(userId, createInput, execution) {
      requireStatement(createInput.statement);
      const authorizedPayloadHash = execution?.authorizedPayloadHash ??
        memorySha256(createInput.statement);
      const authorization = authorizationUse({
        action: "SAVE",
        ...(execution?.admissionDeadlineAtMs === undefined
          ? {}
          : { admissionDeadlineAtMs: execution.admissionDeadlineAtMs }),
        authorizationId: createInput.mutationAuthorizationId,
        authorizedPayloadHash
      });
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const classification = execution?.sensitivityClass || resolved.replayed
        ? null
        : await classifyStatement(
            userId,
            createInput.mutationAuthorizationId,
            createInput.statement
          );
      const statement = classification?.normalizedStatement ?? createInput.statement;
      const sensitivityClass = canonicalStorableSensitivity(
        execution?.sensitivityClass ?? classification?.sensitivity ?? "NORMAL"
      );
      const scope = await persisted(() => execution?.admissionDeadlineAtMs === undefined
        ? input.scopeRepository.ensure(userId, createInput.scope)
        : input.scopeRepository.ensure(userId, createInput.scope, {
            deadlineAtMs: execution.admissionDeadlineAtMs
          }));
      const observedAt = resolved.confirmedAt;
      const saved = await persisted(() => input.factRepository.save(userId, {
        authorization,
        evidence: evidenceFor(statement, observedAt, sensitivityClass),
        explicitSuppressionOverride: true,
        idempotencyFingerprint: idempotencyFingerprint(authorization),
        idempotencyPayloadHash: idempotencyPayloadHash("SAVE", createInput),
        ...(execution
          ? {
              modelRunId: execution.modelRunId,
              persistedToolCallId: execution.persistedToolCallId
            }
          : {}),
        requestId: resolved.requestId,
        scopeId: scope.id,
        value: valueFor({
          canonicalKey: customCanonicalKey(statement),
          category: classification?.category ?? createInput.category ?? "other",
          modality: classifiedModality(classification, createInput.modality ?? "STATE"),
          safetyClassification: execution?.safetyClassifierExecutionId
            ? controlSafetyClassification(execution)
            : statementSafetyClassification(classification, createInput.statement),
          sensitivityClass,
          statement,
          validFrom: dateOrNull(createInput.validFrom),
          validTo: dateOrNull(createInput.validTo)
        })
      }));
      if (execution?.admissionDeadlineAtMs !== undefined) {
        throw new MemoryControlledMutationCommittedError(
          saved.factId,
          statement,
          saved.versionId
        );
      }
      return currentResponse(userId, saved.factId);
    },

    async evidence(userId, factId, cursor) {
      const response = await persisted(() =>
        input.readRepository.evidence(userId, factId, cursor)
      );
      if (!response) return failure("memory_not_found");
      return checkedEvidence(response);
    },

    async get(userId, factId) {
      const detail = await persisted(() => input.readRepository.detail(userId, factId));
      if (!detail) return failure("memory_not_found");
      return checkedDetail(detail);
    },

    async list(userId, listInput) {
      return checkedList(await persisted(() =>
        input.readRepository.list(userId, listInput)
      ));
    },

    async mintAuthorization(userId, authorizationInput) {
      if (
        authorizationInput.action === "BULK_DELETE" &&
        authorizationInput.operation !== "DELETE_EXPLICIT" &&
        authorizationInput.operation !== "DELETE_LEARNED" &&
        authorizationInput.operation !== "CLEAR_HISTORY_INDEX" &&
        authorizationInput.operation !== "DELETE_ALL_REUSABLE"
      ) {
        return failure("memory_operation_unsupported");
      }
      const target = authorizationInput.action === "SAVE" ||
        authorizationInput.action === "BULK_DELETE"
        ? null
        : {
            expectedTargetVersionId: authorizationInput.expectedTargetVersionId,
            targetFactId: authorizationInput.targetFactId
          };
      const allowed = memoryMutationIntentAllowed({
        action: authorizationInput.action,
        confirmationCopyVersion: authorizationInput.confirmationCopyVersion,
        exactCurrentUserSpan: authorizationInput.action === "SAVE",
        exactTarget: authorizationInput.action !== "SAVE",
        expectedVersion: target !== null,
        explicitConfirmation: true,
        origin: "DIRECT_API"
      });
      if (!allowed) return failure("memory_intent_confirmation_required");
      const now = clock();
      const authorizedPayloadHash = authorizationInput.action === "SAVE"
        ? authorizationInput.exactStatementHash
        : memoryTargetAuthorizationPayloadHash({
            action: authorizationInput.action,
            expectedMemoryRevision: authorizationInput.action === "BULK_DELETE"
              ? authorizationInput.expectedMemoryRevision
              : undefined,
            expectedSettingsRevision: authorizationInput.action === "BULK_DELETE"
              ? authorizationInput.expectedSettingsRevision
              : undefined,
            expectedTargetVersionId: target?.expectedTargetVersionId,
            operation: authorizationInput.action === "BULK_DELETE"
              ? authorizationInput.operation
              : undefined,
            targetFactId: target?.targetFactId
          });
      const minted = await persisted(() => input.authorizationRepository.mint(userId, {
        action: authorizationInput.action,
        authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: target?.expectedTargetVersionId,
        expiresAt: new Date(now.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
        nonceHash: memoryMutationNonceHash(userId, authorizationInput.requestNonce),
        requestId: randomUUID(),
        targetFactId: target?.targetFactId
      }, now));
      const decoded = decodeMemoryMutationAuthorizationResponse({
        expiresAt: minted.expiresAt.toISOString(),
        mutationAuthorizationId: minted.id
      });
      if (!decoded.ok) return failure("memory_action_failed");
      return decoded.value;
    },

    async search(userId, searchInput) {
      return checkedList(await persisted(() =>
        input.readRepository.search(userId, searchInput)
      ));
    },

    async resolveConflict(userId, factId, resolveInput) {
      const conflict = await persisted(() =>
        input.readRepository.getConflict(userId, factId));
      if (!conflict) return failure("memory_not_found");
      const expectedVersionIds = conflict.versions.map(({ id }) => id);
      if (
        expectedVersionIds.length !== resolveInput.expectedVersionIds.length ||
        expectedVersionIds.some((id, index) => id !== resolveInput.expectedVersionIds[index])
      ) {
        return failure("memory_version_stale");
      }
      const anchorVersionId = expectedVersionIds[0]!;
      const selectedVersionId = resolveInput.resolution.kind === "CHOOSE"
        ? resolveInput.resolution.versionId
        : anchorVersionId;
      const selected = conflict.versions.find(({ id }) => id === selectedVersionId);
      if (!selected) return failure("memory_version_stale");
      const statement = resolveInput.resolution.kind === "CORRECT"
        ? resolveInput.resolution.statement
        : selected.displayText;
      requireStatement(statement);
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: "EDIT",
        expectedTargetVersionId: anchorVersionId,
        targetFactId: factId
      });
      const authorization = authorizationUse({
        action: "EDIT",
        authorizationId: resolveInput.mutationAuthorizationId,
        authorizedPayloadHash,
        expectedTargetVersionId: anchorVersionId,
        targetFactId: factId
      });
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization));
      const classification = resolveInput.resolution.kind === "CORRECT" &&
        !resolved.replayed
        ? await classifyStatement(
            userId,
            resolveInput.mutationAuthorizationId,
            statement
          )
        : null;
      const storedStatement = classification?.normalizedStatement ?? statement;
      const sensitivityClass = resolveInput.resolution.kind === "CORRECT"
        ? mostRestrictiveSensitivity([
            ...conflict.versions.map((version) => version.sensitivityClass),
            classification?.sensitivity ?? "NORMAL"
          ])
        : selected.sensitivityClass;
      await persisted(() => input.factRepository.resolve(userId, {
        authorization,
        evidence: evidenceFor(storedStatement, resolved.confirmedAt, sensitivityClass),
        expectedVersionIds,
        explicitSuppressionOverride: false,
        factId,
        idempotencyFingerprint: idempotencyFingerprint(authorization),
        idempotencyPayloadHash: idempotencyPayloadHash("EDIT", {
          factId,
          input: resolveInput,
          operation: "RESOLVE_CONFLICT"
        }),
        requestId: resolved.requestId,
        scopeId: conflict.scopeId,
        selectedVersionId,
        value: valueFor({
          canonicalKey: conflict.canonicalKey,
          category: classification?.category ?? conflict.category,
          modality: classifiedModality(classification, selected.modality),
          safetyClassification: statementSafetyClassification(classification, statement),
          sensitivityClass,
          statement: storedStatement,
          validFrom: selected.validFrom,
          validTo: selected.validTo
        })
      }));
      return currentResponse(userId, factId);
    },

    async undoForget(userId, factId, undoInput) {
      const now = clock();
      const candidate = await persisted(() =>
        input.readRepository.getForgetUndoCandidate(
          userId,
          factId,
          undoInput.deletionId,
          now
        )
      );
      if (!candidate) return failure("memory_undo_unavailable");
      requireStatement(candidate.displayText);
      const authorization = authorizationUse({
        action: "SAVE",
        authorizationId: undoInput.mutationAuthorizationId,
        authorizedPayloadHash: memorySha256(candidate.displayText)
      });
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const revived = await persisted(() => input.factRepository.save(userId, {
        authorization,
        evidence: evidenceFor(
          candidate.displayText,
          resolved.confirmedAt,
          candidate.sensitivityClass
        ),
        explicitSuppressionOverride: true,
        idempotencyFingerprint: idempotencyFingerprint(authorization),
        idempotencyPayloadHash: idempotencyPayloadHash("SAVE", {
          deletionId: undoInput.deletionId,
          factId,
          operation: "UNDO_FORGET"
        }),
        requestId: resolved.requestId,
        scopeId: candidate.scopeId,
        undoForget: {
          deletionId: undoInput.deletionId,
          expectedVersionId: candidate.versionId,
          now
        },
        value: valueFor({
          canonicalKey: candidate.canonicalKey,
          category: candidate.category,
          modality: candidate.modality,
          sensitivityClass: candidate.sensitivityClass,
          statement: candidate.displayText,
          validFrom: candidate.validFrom,
          validTo: candidate.validTo
        })
      }));
      return currentResponse(userId, revived.factId);
    },

    async update(userId, factId, updateInput, execution) {
      const current = await persisted(() =>
        input.readRepository.getEditable(userId, factId)
      );
      if (!current) return failure("memory_not_found");
      const updatesStatement = Object.hasOwn(updateInput, "statement");
      if (execution?.exactStatementHash !== undefined && (
        !updatesStatement || typeof updateInput.statement !== "string" ||
        execution.exactStatementHash !== memorySha256(updateInput.statement)
      )) {
        return failure("memory_contract_invalid");
      }
      const targetScope = updateInput.scope
        ? await persisted(() => input.scopeRepository.ensure(userId, updateInput.scope!))
        : null;
      const moving = targetScope !== null && targetScope.id !== current.scopeId;
      if (moving) {
        const mixedMove = [
          "category",
          "modality",
          "pinned",
          "statement",
          "validFrom",
          "validTo"
        ].some((key) => Object.hasOwn(updateInput, key));
        if (mixedMove) return failure("memory_contract_invalid");
        const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
          action: "MOVE_SCOPE",
          expectedTargetVersionId: updateInput.expectedVersionId,
          targetFactId: factId
        });
        const authorization = authorizationUse({
          action: "MOVE_SCOPE",
          authorizationId: updateInput.mutationAuthorizationId,
          authorizedPayloadHash,
          expectedTargetVersionId: updateInput.expectedVersionId,
          targetFactId: factId
        });
        const resolved = await persisted(() =>
          input.authorizationRepository.resolveForUse(userId, authorization)
        );
        const moved = await persisted(() => input.factRepository.move(userId, {
          authorization,
          evidence: evidenceFor(
            current.displayText,
            resolved.confirmedAt,
            current.sensitivityClass
          ),
          expectedVersionId: updateInput.expectedVersionId,
          explicitSuppressionOverride: false,
          factId,
          idempotencyFingerprint: idempotencyFingerprint(authorization),
          idempotencyPayloadHash: idempotencyPayloadHash("MOVE_SCOPE", {
            factId,
            input: updateInput
          }),
          ...(execution
            ? {
                modelRunId: execution.modelRunId,
                persistedToolCallId: execution.persistedToolCallId
              }
            : {}),
          requestId: resolved.requestId,
          targetScopeId: targetScope.id,
          value: valueFor({
            canonicalKey: current.canonicalKey,
            category: current.category,
            modality: current.modality,
            sensitivityClass: current.sensitivityClass,
            statement: current.displayText,
            validFrom: current.validFrom,
            validTo: current.validTo
          })
        }));
        return currentResponse(userId, moved.factId);
      }
      if (current.factState !== "ACTIVE") {
        return failure("memory_scope_unavailable");
      }
      const requestedStatement = updateInput.statement ?? current.displayText;
      requireStatement(requestedStatement);
      const validFrom = Object.hasOwn(updateInput, "validFrom")
        ? dateOrNull(updateInput.validFrom)
        : current.validFrom;
      const validTo = Object.hasOwn(updateInput, "validTo")
        ? dateOrNull(updateInput.validTo)
        : current.validTo;
      if (validFrom && validTo && validFrom >= validTo) {
        return failure("memory_statement_invalid");
      }
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: "EDIT",
        expectedTargetVersionId: updateInput.expectedVersionId,
        replacementStatementHash: execution && Object.hasOwn(updateInput, "statement")
          ? memorySha256(requestedStatement)
          : undefined,
        targetFactId: factId
      });
      const authorization = authorizationUse({
        action: "EDIT",
        ...(execution?.admissionDeadlineAtMs === undefined
          ? {}
          : { admissionDeadlineAtMs: execution.admissionDeadlineAtMs }),
        authorizationId: updateInput.mutationAuthorizationId,
        authorizedPayloadHash,
        expectedTargetVersionId: updateInput.expectedVersionId,
        targetFactId: factId
      });
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const classification = Object.hasOwn(updateInput, "statement") &&
        !execution?.sensitivityClass && !resolved.replayed
        ? await classifyStatement(
            userId,
            updateInput.mutationAuthorizationId,
            requestedStatement
          )
        : null;
      const statement = execution?.exactStatementHash === undefined
        ? classification?.normalizedStatement ?? requestedStatement
        : requestedStatement;
      const sensitivityClass = execution?.sensitivityClass || classification
        ? mostRestrictiveSensitivity([
            current.sensitivityClass,
            execution?.sensitivityClass ?? classification!.sensitivity
          ])
        : current.sensitivityClass;
      const observedAt = resolved.confirmedAt;
      const edited = await persisted(() => input.factRepository.edit(userId, {
        authorization,
        evidence: evidenceFor(statement, observedAt, sensitivityClass),
        expectedVersionId: updateInput.expectedVersionId,
        explicitSuppressionOverride: false,
        factId,
        idempotencyFingerprint: idempotencyFingerprint(authorization),
        idempotencyPayloadHash: idempotencyPayloadHash("EDIT", {
          factId,
          input: updateInput
        }),
        ...(execution
          ? {
              modelRunId: execution.modelRunId,
              persistedToolCallId: execution.persistedToolCallId
            }
          : {}),
        pinned: updateInput.pinned,
        requestId: resolved.requestId,
        scopeId: current.scopeId,
        value: valueFor({
          canonicalKey: current.canonicalKey,
          category: classification?.category ?? updateInput.category ?? current.category,
          modality: classifiedModality(
            classification,
            updateInput.modality ?? current.modality
          ),
          safetyClassification: execution?.safetyClassifierExecutionId
            ? controlSafetyClassification(execution)
            : statementSafetyClassification(
                classification,
                requestedStatement,
                execution?.exactStatementHash === undefined
                  ? "CLASSIFIER_NORMALIZED"
                  : "EXACT_INPUT"
              ),
          sensitivityClass,
          statement,
          validFrom,
          validTo
        })
      }));
      if (execution?.admissionDeadlineAtMs !== undefined) {
        throw new MemoryControlledMutationCommittedError(
          edited.factId,
          statement,
          edited.versionId
        );
      }
      return currentResponse(userId, factId);
    }
  });
}
