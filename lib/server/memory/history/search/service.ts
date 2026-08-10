import type {
  MemoryHistorySearchInput,
  MemoryHistorySearchResponse
} from "../../../../contracts/memory";
import {
  MemoryHistorySearchRepositoryError,
  type MemoryHistorySearchRepository,
  type MemoryHistoryVectorOutcome,
  type PreparedMemoryHistorySearch
} from "./repository";

export type MemoryHistoryVectorLane = Readonly<{
  search(input: Readonly<{
    prepared: PreparedMemoryHistorySearch;
    userId: string;
  }>): Promise<MemoryHistoryVectorOutcome>;
}>;

export type MemoryHistorySearchServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_source_stale";

export class MemoryHistorySearchServiceError extends Error {
  constructor(readonly code: MemoryHistorySearchServiceErrorCode) {
    super(code);
    this.name = "MemoryHistorySearchServiceError";
  }
}

export type MemoryHistorySearchService = Readonly<{
  search(
    userId: string,
    input: MemoryHistorySearchInput
  ): Promise<MemoryHistorySearchResponse>;
}>;

function serviceError(error: unknown): never {
  if (error instanceof MemoryHistorySearchServiceError) throw error;
  if (error instanceof MemoryHistorySearchRepositoryError) {
    throw new MemoryHistorySearchServiceError(error.code);
  }
  throw new MemoryHistorySearchServiceError("memory_action_failed");
}

export function createMemoryHistorySearchService(input: Readonly<{
  repository: MemoryHistorySearchRepository;
  vectorLane?: MemoryHistoryVectorLane | null;
}>): MemoryHistorySearchService {
  return Object.freeze({
    async search(userId, request) {
      try {
        const prepared = await input.repository.prepare(userId, request);
        let vector: MemoryHistoryVectorOutcome | null = null;
        if (
          prepared.snapshot.lexicalState === "READY" &&
          prepared.snapshot.indexMode === "HYBRID" &&
          input.vectorLane
        ) {
          try {
            vector = await input.vectorLane.search({ prepared, userId });
          } catch {
            vector = {
              hits: [],
              reason: "memory_vector_unavailable",
              status: "DEGRADED"
            };
          }
        }
        return await input.repository.search(prepared, vector);
      } catch (error) {
        return serviceError(error);
      }
    }
  });
}
