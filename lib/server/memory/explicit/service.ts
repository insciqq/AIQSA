import { randomUUID } from "node:crypto";
import type {
  MemoryCreateInput,
  MemoryEvidenceResponse,
  MemoryListInput,
  MemoryListResponse,
  MemoryListSearchInput,
  MemoryMutationAuthorizationInput,
  MemoryMutationAuthorizationResponse,
  MemoryMutationResponse,
  MemoryUpdateInput
} from "../../../contracts/memory";
import {
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
  MemoryFactSaveInput,
  MemoryFactValueInput
} from "../persistence/facts";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import type { ActiveMemoryScope } from "../persistence/scopes";
import type { ExplicitMemoryEditable } from "./repository";
import { memoryExplicitStatementContainsSecret } from "./safety";

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
  ): Promise<Readonly<{ confirmedAt: Date; requestId: string }>>;
}>;

export type ExplicitMemoryFactRepository = Readonly<{
  edit(userId: string, input: MemoryFactEditInput): Promise<MemoryFactMutationResult>;
  move(userId: string, input: MemoryFactMoveInput): Promise<MemoryFactMutationResult>;
  save(userId: string, input: MemoryFactSaveInput): Promise<MemoryFactMutationResult>;
}>;

export type ExplicitMemoryReadRepository = Readonly<{
  evidence(
    userId: string,
    factId: string,
    cursor: string | null
  ): Promise<MemoryEvidenceResponse | null>;
  get(userId: string, factId: string): Promise<MemoryMutationResponse["memory"] | null>;
  getEditable(userId: string, factId: string): Promise<ExplicitMemoryEditable | null>;
  list(userId: string, input: MemoryListInput): Promise<MemoryListResponse>;
  search(userId: string, input: MemoryListSearchInput): Promise<MemoryListResponse>;
}>;

export type ExplicitMemoryScopeRepository = Readonly<{
  ensure(userId: string, scope: MemoryCreateInput["scope"]): Promise<ActiveMemoryScope>;
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
  | "memory_version_stale";

export class ExplicitMemoryServiceError extends Error {
  readonly code: ExplicitMemoryServiceErrorCode;

  constructor(code: ExplicitMemoryServiceErrorCode) {
    super(code);
    this.code = code;
    this.name = "ExplicitMemoryServiceError";
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
  get(userId: string, factId: string): Promise<MemoryMutationResponse>;
  list(userId: string, input: MemoryListInput): Promise<MemoryListResponse>;
  mintAuthorization(
    userId: string,
    input: MemoryMutationAuthorizationInput
  ): Promise<MemoryMutationAuthorizationResponse>;
  search(userId: string, input: MemoryListSearchInput): Promise<MemoryListResponse>;
  update(
    userId: string,
    factId: string,
    input: MemoryUpdateInput,
    execution?: MemoryOperationExecutionContext
  ): Promise<MemoryMutationResponse>;
}>;

export type MemoryOperationExecutionContext = Readonly<{
  modelRunId: string;
  persistedToolCallId: string;
}>;

function failure(code: ExplicitMemoryServiceErrorCode): never {
  throw new ExplicitMemoryServiceError(code);
}

function publicPersistenceCode(
  code: MemoryPersistenceErrorCode
): ExplicitMemoryServiceErrorCode {
  switch (code) {
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
    case "memory_input_invalid":
      return "memory_contract_invalid";
    default:
      return "memory_action_failed";
  }
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

function languageCode(statement: string): string {
  const cyrillic = /\p{Script=Cyrillic}/u.test(statement);
  const latin = /\p{Script=Latin}/u.test(statement);
  if (cyrillic && !latin) return "ru";
  if (latin && !cyrillic) return "en";
  return "AUTO";
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

function valueFor(input: Readonly<{
  canonicalKey: string;
  category: string;
  modality: MemoryFactValueInput["modality"];
  sensitivityClass?: MemoryFactValueInput["sensitivityClass"];
  statement: string;
  validFrom: Date | null;
  validTo: Date | null;
}>): MemoryFactValueInput {
  return {
    canonicalKey: input.canonicalKey,
    category: input.category,
    confidence: 1,
    directness: "DIRECT",
    displayText: input.statement,
    importance: 1,
    languageCode: languageCode(input.statement),
    modality: input.modality,
    pipelineVersion: MEMORY_EXPLICIT_PIPELINE_VERSION,
    secretTaintedSourceWindow: false,
    sensitivityClass: input.sensitivityClass ?? "NORMAL",
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
  return {
    kind: "EXPLICIT_ACTION" as const,
    observedAt,
    safeExcerpt: statement,
    safeSourceHash: memorySha256(statement),
    safetyClass,
    sourceProjectionVersion: MEMORY_EXPLICIT_SOURCE_PROJECTION_VERSION
  };
}

function authorizationUse(input: Readonly<{
  action: "EDIT" | "MOVE_SCOPE" | "SAVE";
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

export function createExplicitMemoryService(input: Readonly<{
  authorizationRepository: ExplicitMemoryAuthorizationRepository;
  clock?: () => Date;
  factRepository: ExplicitMemoryFactRepository;
  readRepository: ExplicitMemoryReadRepository;
  scopeRepository: ExplicitMemoryScopeRepository;
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

  return Object.freeze({
    async create(userId, createInput, execution) {
      requireStatement(createInput.statement);
      const authorizedPayloadHash = memorySha256(createInput.statement);
      const authorization = authorizationUse({
        action: "SAVE",
        authorizationId: createInput.mutationAuthorizationId,
        authorizedPayloadHash
      });
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const scope = await persisted(() =>
        input.scopeRepository.ensure(userId, createInput.scope));
      const observedAt = resolved.confirmedAt;
      const saved = await persisted(() => input.factRepository.save(userId, {
        authorization,
        evidence: evidenceFor(createInput.statement, observedAt),
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
          canonicalKey: customCanonicalKey(createInput.statement),
          category: createInput.category ?? "custom",
          modality: createInput.modality ?? "STATE",
          statement: createInput.statement,
          validFrom: dateOrNull(createInput.validFrom),
          validTo: dateOrNull(createInput.validTo)
        })
      }));
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
      return currentResponse(userId, factId);
    },

    async list(userId, listInput) {
      return checkedList(await persisted(() =>
        input.readRepository.list(userId, listInput)
      ));
    },

    async mintAuthorization(userId, authorizationInput) {
      if (
        authorizationInput.action === "BULK_DELETE" &&
        authorizationInput.operation !== "DELETE_EXPLICIT"
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

    async update(userId, factId, updateInput, execution) {
      const current = await persisted(() =>
        input.readRepository.getEditable(userId, factId)
      );
      if (!current) return failure("memory_not_found");
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
      const statement = updateInput.statement ?? current.displayText;
      requireStatement(statement);
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
        targetFactId: factId
      });
      const authorization = authorizationUse({
        action: "EDIT",
        authorizationId: updateInput.mutationAuthorizationId,
        authorizedPayloadHash,
        expectedTargetVersionId: updateInput.expectedVersionId,
        targetFactId: factId
      });
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const observedAt = resolved.confirmedAt;
      await persisted(() => input.factRepository.edit(userId, {
        authorization,
        evidence: evidenceFor(statement, observedAt, current.sensitivityClass),
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
          category: updateInput.category ?? current.category,
          modality: updateInput.modality ?? current.modality,
          sensitivityClass: current.sensitivityClass,
          statement,
          validFrom,
          validTo
        })
      }));
      return currentResponse(userId, factId);
    }
  });
}
