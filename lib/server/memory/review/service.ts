import type {
  MemoryFeedbackInput,
  MemoryFeedbackMutationResponse
} from "../../../contracts/memory";
import { decodeMemoryFeedbackMutationResponse } from "../../../contracts/memory";
import {
  MemoryPersistenceError,
  type MemoryPersistenceErrorCode
} from "../persistence/errors";
import type { MemoryMutationAuthorizationUse } from "../persistence/authorizations";

export type MemoryReviewExecution = Readonly<{
  authorization: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>;
}>;

export type MemoryFeedbackRepository = Readonly<{
  record(
    userId: string,
    factId: string,
    input: MemoryFeedbackInput,
    authorization?: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>
  ): Promise<MemoryFeedbackMutationResponse>;
}>;

export type MemoryReviewServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_intent_confirmation_required"
  | "memory_not_found"
  | "memory_version_stale";

export class MemoryReviewServiceError extends Error {
  constructor(readonly code: MemoryReviewServiceErrorCode) {
    super(code);
    this.name = "MemoryReviewServiceError";
  }
}

function failure(code: MemoryReviewServiceErrorCode): never {
  throw new MemoryReviewServiceError(code);
}

function publicCode(code: MemoryPersistenceErrorCode): MemoryReviewServiceErrorCode {
  switch (code) {
    case "memory_fact_not_found":
      return "memory_not_found";
    case "memory_fact_version_stale":
      return "memory_version_stale";
    case "memory_idempotency_conflict":
    case "memory_mutation_authorization_invalid":
      return "memory_intent_confirmation_required";
    case "memory_input_invalid":
      return "memory_contract_invalid";
    default:
      return "memory_action_failed";
  }
}

export function createMemoryReviewService(repository: MemoryFeedbackRepository) {
  return Object.freeze({
    async feedback(
      userId: string,
      factId: string,
      input: MemoryFeedbackInput,
      execution?: MemoryReviewExecution
    ): Promise<MemoryFeedbackMutationResponse> {
      try {
        const value = await repository.record(
          userId,
          factId,
          input,
          execution?.authorization
        );
        const decoded = decodeMemoryFeedbackMutationResponse(value);
        if (!decoded.ok) return failure("memory_action_failed");
        return decoded.value;
      } catch (error) {
        if (error instanceof MemoryPersistenceError) return failure(publicCode(error.code));
        throw error;
      }
    }
  });
}

export type MemoryReviewService = ReturnType<typeof createMemoryReviewService>;
