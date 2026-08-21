import type {
  MemoryBulkDeleteInput,
  MemoryDeletionStatus,
  MemoryForgetInput,
  MemoryForgetResponse,
  MemoryMutationResponse
} from "../../../contracts/memory";
import {
  decodeMemoryDeletionStatus,
  decodeMemoryForgetResponse
} from "../../../contracts/memory";
import type { MemoryMutationAuthorizationUse } from "../persistence/authorizations";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import {
  MemoryPersistenceError,
  type MemoryPersistenceErrorCode
} from "../persistence/errors";
import { memorySha256 } from "../persistence/lexical";
import type {
  MemoryDeleteExplicitMutationInput,
  MemoryDeleteExplicitMutationResult,
  MemoryForgetMutationInput,
  MemoryForgetMutationResult
} from "./repository";
import { memoryLifecycleIdempotencyFingerprint } from "./repository";

export type MemoryLifecycleAuthorizationRepository = Readonly<{
  resolveForUse(
    userId: string,
    input: MemoryMutationAuthorizationUse
  ): Promise<Readonly<{ confirmedAt: Date; requestId: string }>>;
}>;

export type MemoryLifecycleMutationRepository = Readonly<{
  clearHistory(
    userId: string,
    input: MemoryDeleteExplicitMutationInput
  ): Promise<MemoryDeleteExplicitMutationResult>;
  deleteAllReusable(
    userId: string,
    input: MemoryDeleteExplicitMutationInput
  ): Promise<MemoryDeleteExplicitMutationResult>;
  deleteExplicit(
    userId: string,
    input: MemoryDeleteExplicitMutationInput
  ): Promise<MemoryDeleteExplicitMutationResult>;
  deleteLearned(
    userId: string,
    input: MemoryDeleteExplicitMutationInput
  ): Promise<MemoryDeleteExplicitMutationResult>;
  forget(userId: string, input: MemoryForgetMutationInput): Promise<MemoryForgetMutationResult>;
  status(userId: string, deletionId: string): Promise<MemoryDeletionStatus | null>;
}>;

export type MemoryLifecycleReadRepository = Readonly<{
  get(userId: string, factId: string): Promise<MemoryMutationResponse["memory"] | null>;
}>;

export type MemoryLifecycleServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_intent_confirmation_required"
  | "memory_not_found"
  | "memory_operation_unsupported"
  | "memory_version_stale";

export class MemoryLifecycleServiceError extends Error {
  constructor(readonly code: MemoryLifecycleServiceErrorCode) {
    super(code);
    this.name = "MemoryLifecycleServiceError";
  }
}

export class MemoryControlledForgetCommittedError extends Error {
  constructor() {
    super("memory_controlled_forget_committed");
    this.name = "MemoryControlledForgetCommittedError";
  }
}

export type MemoryLifecycleService = Readonly<{
  deleteExplicit(userId: string, input: MemoryBulkDeleteInput): Promise<MemoryDeletionStatus>;
  forget(
    userId: string,
    factId: string,
    input: MemoryForgetInput,
    execution?: MemoryLifecycleExecutionContext
  ): Promise<MemoryForgetResponse>;
  status(userId: string, deletionId: string): Promise<MemoryDeletionStatus>;
}>;

export type MemoryLifecycleExecutionContext = Readonly<{
  admissionDeadlineAtMs?: number;
  modelRunId: string;
  persistedToolCallId?: string | null;
}>;

function failure(code: MemoryLifecycleServiceErrorCode): never {
  throw new MemoryLifecycleServiceError(code);
}

function publicPersistenceCode(
  code: MemoryPersistenceErrorCode
): MemoryLifecycleServiceErrorCode {
  switch (code) {
    case "memory_fact_not_found":
    case "memory_scope_unavailable":
      return "memory_not_found";
    case "memory_fact_version_stale":
    case "memory_revision_conflict":
    case "memory_settings_conflict":
      return "memory_version_stale";
    case "memory_mutation_authorization_invalid":
    case "memory_idempotency_conflict":
      return "memory_intent_confirmation_required";
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

function lifecyclePayloadHash(action: "BULK_DELETE" | "FORGET", payload: unknown): string {
  return memorySha256({
    action,
    domain: "aiqsa.memory.lifecycle-operation-payload",
    payload,
    version: "v1"
  });
}

function checkedDeletion(value: MemoryDeletionStatus): MemoryDeletionStatus {
  const decoded = decodeMemoryDeletionStatus(value);
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

function checkedForget(
  response: MemoryForgetResponse
): MemoryForgetResponse {
  const decoded = decodeMemoryForgetResponse(response);
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

export function createMemoryLifecycleService(input: Readonly<{
  authorizationRepository: MemoryLifecycleAuthorizationRepository;
  clock?: () => Date;
  kick?: () => void;
  mutationRepository: MemoryLifecycleMutationRepository;
  readRepository: MemoryLifecycleReadRepository;
}>): MemoryLifecycleService {
  const clock = input.clock ?? (() => new Date());
  const kick = () => {
    try {
      input.kick?.();
    } catch {
      // The durable outbox remains authoritative when an in-process wakeup fails.
    }
  };

  return Object.freeze({
    async deleteExplicit(userId, deleteInput) {
      const operation = deleteInput.operation;
      if (
        operation !== "DELETE_EXPLICIT" &&
        operation !== "DELETE_LEARNED" &&
        operation !== "CLEAR_HISTORY_INDEX" &&
        operation !== "DELETE_ALL_REUSABLE"
      ) {
        return failure("memory_operation_unsupported");
      }
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: "BULK_DELETE",
        expectedMemoryRevision: deleteInput.expectedMemoryRevision,
        expectedSettingsRevision: deleteInput.expectedSettingsRevision,
        operation
      });
      const authorization = {
        action: "BULK_DELETE" as const,
        authorizationId: deleteInput.mutationAuthorizationId,
        authorizedPayloadHash
      };
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const now = clock();
      const mutation = operation === "DELETE_ALL_REUSABLE"
        ? input.mutationRepository.deleteAllReusable
        : operation === "CLEAR_HISTORY_INDEX"
        ? input.mutationRepository.clearHistory
        : operation === "DELETE_LEARNED"
          ? input.mutationRepository.deleteLearned
          : input.mutationRepository.deleteExplicit;
      const admitted = await persisted(() => mutation(userId, {
        authorization,
        expectedMemoryRevision: deleteInput.expectedMemoryRevision,
        expectedSettingsRevision: deleteInput.expectedSettingsRevision,
        idempotencyFingerprint: memoryLifecycleIdempotencyFingerprint(
          "BULK_DELETE",
          authorization.authorizationId
        ),
        idempotencyPayloadHash: lifecyclePayloadHash("BULK_DELETE", deleteInput),
        now,
        operation,
        requestId: resolved.requestId
      }));
      kick();
      const status = await persisted(() =>
        input.mutationRepository.status(userId, admitted.deletionId)
      );
      if (!status) return failure("memory_action_failed");
      return checkedDeletion(status);
    },

    async forget(userId, factId, forgetInput, execution) {
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: "FORGET",
        expectedTargetVersionId: forgetInput.expectedVersionId,
        targetFactId: factId
      });
      const authorization = {
        action: "FORGET" as const,
        ...(execution?.admissionDeadlineAtMs === undefined
          ? {}
          : { admissionDeadlineAtMs: execution.admissionDeadlineAtMs }),
        authorizationId: forgetInput.mutationAuthorizationId,
        authorizedPayloadHash,
        expectedTargetVersionId: forgetInput.expectedVersionId,
        targetFactId: factId
      };
      const resolved = await persisted(() =>
        input.authorizationRepository.resolveForUse(userId, authorization)
      );
      const now = clock();
      const forgotten = await persisted(() => input.mutationRepository.forget(userId, {
        authorization,
        expectedVersionId: forgetInput.expectedVersionId,
        factId,
        idempotencyFingerprint: memoryLifecycleIdempotencyFingerprint(
          "FORGET",
          authorization.authorizationId
        ),
        idempotencyPayloadHash: lifecyclePayloadHash("FORGET", { factId, forgetInput }),
        ...(execution
          ? {
              modelRunId: execution.modelRunId,
              persistedToolCallId: execution.persistedToolCallId
            }
          : {}),
        now,
        requestId: resolved.requestId
      }));
      kick();
      if (execution?.admissionDeadlineAtMs !== undefined) {
        throw new MemoryControlledForgetCommittedError();
      }
      return checkedForget({
        memory: forgotten.tombstone,
        undo: {
          deletionId: forgotten.deletionId,
          expiresAt: forgotten.undoExpiresAt.toISOString(),
          versionId: forgotten.versionId
        }
      });
    },

    async status(userId, deletionId) {
      const status = await persisted(() =>
        input.mutationRepository.status(userId, deletionId)
      );
      if (!status) return failure("memory_not_found");
      return checkedDeletion(status);
    }
  });
}
