import type {
  MemoryRebuildInput,
  MemoryRebuildStatus
} from "../../../contracts/memory";
import { decodeMemoryRebuildStatus } from "../../../contracts/memory";
import { MemoryExecutionError } from "../execution";
import type { MemoryItemEmbeddingPin } from "../embedding/contract";
import type { MemoryMutationAuthorizationUse } from "../persistence/authorizations";
import type {
  MemoryRebuildAdmissionResult,
  MemoryRebuildRepository
} from "./repository";

export type MemoryRebuildAuthorizationRepository = Readonly<{
  resolveForUse(
    userId: string,
    input: MemoryMutationAuthorizationUse
  ): Promise<Readonly<{ confirmedAt: Date; requestId: string }>>;
}>;

export type MemoryRebuildServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_egress_consent_required"
  | "memory_embedding_unavailable"
  | "memory_intent_confirmation_required"
  | "memory_rebuild_in_progress"
  | "memory_rebuild_not_found"
  | "memory_version_stale";

export class MemoryRebuildServiceError extends Error {
  constructor(readonly code: MemoryRebuildServiceErrorCode) {
    super(code);
    this.name = "MemoryRebuildServiceError";
  }
}

export type MemoryRebuildService = Readonly<{
  cancel(userId: string, jobId: string): Promise<MemoryRebuildStatus>;
  start(userId: string, input: MemoryRebuildInput): Promise<MemoryRebuildStatus>;
  status(userId: string, jobId: string): Promise<MemoryRebuildStatus>;
}>;

function failure(code: MemoryRebuildServiceErrorCode): never {
  throw new MemoryRebuildServiceError(code);
}

function checked(value: MemoryRebuildStatus): MemoryRebuildStatus {
  const decoded = decodeMemoryRebuildStatus(value);
  if (!decoded.ok) return failure("memory_action_failed");
  return decoded.value;
}

function admissionFailure(result: Exclude<MemoryRebuildAdmissionResult, { kind: "ok" }>): never {
  switch (result.kind) {
    case "embedding_unavailable": return failure("memory_embedding_unavailable");
    case "in_progress": return failure("memory_rebuild_in_progress");
    case "memory_revision_conflict":
    case "settings_revision_conflict": return failure("memory_version_stale");
  }
}

function executionFailure(error: unknown): never {
  if (error instanceof MemoryExecutionError) {
    if (error.code === "memory_execution_egress_consent_required") {
      return failure("memory_egress_consent_required");
    }
    if (
      error.code === "memory_execution_capability_unavailable" ||
      error.code === "memory_execution_policy_unavailable" ||
      error.code === "memory_execution_qualification_required" ||
      error.code === "memory_execution_target_unavailable"
    ) {
      return failure("memory_embedding_unavailable");
    }
  }
  throw error;
}

export function createMemoryRebuildService(input: Readonly<{
  authorizationRepository: MemoryRebuildAuthorizationRepository;
  kick?: () => void;
  probeEmbeddingPin: (userId: string) => Promise<MemoryItemEmbeddingPin>;
  repository: MemoryRebuildRepository;
}>): MemoryRebuildService {
  const kick = () => {
    try {
      input.kick?.();
    } catch {
      // The durable job remains authoritative when an in-process wakeup fails.
    }
  };
  return Object.freeze({
    async cancel(userId, jobId) {
      const status = await input.repository.cancel(userId, jobId);
      if (!status) return failure("memory_rebuild_not_found");
      return checked(status);
    },

    async start(userId, rebuildInput) {
      if (rebuildInput.operation === "REDREAM_EXISTING_CHATS") {
        return failure("memory_contract_invalid");
      }
      let pin: MemoryItemEmbeddingPin | null = null;
      if (rebuildInput.operation === "REEMBED") {
        try {
          pin = await input.probeEmbeddingPin(userId);
        } catch (error) {
          return executionFailure(error);
        }
      }
      const admitted = await input.repository.admit(userId, {
        embeddingDeploymentId: rebuildInput.embeddingDeploymentId,
        expectedMemoryRevision: rebuildInput.expectedMemoryRevision,
        expectedSettingsRevision: rebuildInput.expectedSettingsRevision,
        operation: rebuildInput.operation,
        pin,
        requestIdentity: {
          embeddingDeploymentId: rebuildInput.embeddingDeploymentId ?? null,
          expectedMemoryRevision: rebuildInput.expectedMemoryRevision,
          expectedSettingsRevision: rebuildInput.expectedSettingsRevision,
          mutationAuthorizationId: rebuildInput.mutationAuthorizationId ?? null,
          operation: rebuildInput.operation
        }
      });
      if (admitted.kind !== "ok") return admissionFailure(admitted);
      kick();
      const status = await input.repository.status(userId, admitted.jobId);
      if (!status) return failure("memory_action_failed");
      return checked(status);
    },

    async status(userId, jobId) {
      const status = await input.repository.status(userId, jobId);
      if (!status) return failure("memory_rebuild_not_found");
      return checked(status);
    }
  });
}
