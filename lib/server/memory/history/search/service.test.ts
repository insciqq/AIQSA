import { describe, expect, it, vi } from "vitest";
import type {
  MemoryHistorySearchInput,
  MemoryHistorySearchResponse
} from "../../../../contracts/memory";
import {
  MemoryHistorySearchRepositoryError,
  type MemoryHistorySearchRepository,
  type PreparedMemoryHistorySearch
} from "./repository";
import {
  createMemoryHistorySearchService,
  MemoryHistorySearchServiceError
} from "./service";

const request: MemoryHistorySearchInput = {
  chatIds: [],
  cursor: null,
  folderId: null,
  from: null,
  pageSize: 20,
  query: "history query",
  to: null
};

function prepared(
  overrides: Partial<PreparedMemoryHistorySearch["snapshot"]> = {}
): PreparedMemoryHistorySearch {
  return {
    chatIds: [],
    filterHash: "a".repeat(64),
    folderId: null,
    from: null,
    input: request,
    normalizedQuery: "history query",
    offset: 0,
    snapshot: {
      activeGenerationId: "generation-1",
      indexMode: "HYBRID",
      lexicalState: "READY",
      memoryRevision: 4,
      referenceChatHistory: true,
      ...overrides
    },
    to: null,
    userId: "user-1"
  };
}

const response: MemoryHistorySearchResponse = {
  indexing: {
    degradationCode: null,
    lexicalState: "READY",
    vectorState: "READY"
  },
  nextCursor: null,
  results: []
};

function repository(
  value: PreparedMemoryHistorySearch,
  overrides: Partial<MemoryHistorySearchRepository> = {}
): MemoryHistorySearchRepository {
  return {
    prepare: vi.fn(async () => value),
    search: vi.fn(async () => response),
    ...overrides
  };
}

describe("Memory history search service", () => {
  it("runs an optional hybrid vector lane and passes only bounded candidates to rejoin", async () => {
    const repo = repository(prepared());
    const vectorLane = {
      search: vi.fn(async () => ({
        hits: [{ entryId: "entry-1", score: 0.7 }],
        status: "READY" as const
      }))
    };
    const service = createMemoryHistorySearchService({ repository: repo, vectorLane });
    await expect(service.search("user-1", request)).resolves.toEqual(response);
    expect(vectorLane.search).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }));
    expect(repo.search).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      { hits: [{ entryId: "entry-1", score: 0.7 }], status: "READY" }
    );
  });

  it("keeps lexical search available when vectors fail and skips the lane when disabled", async () => {
    const repo = repository(prepared());
    const vectorLane = {
      search: vi.fn(async () => {
        throw new Error("private provider failure");
      })
    };
    await createMemoryHistorySearchService({ repository: repo, vectorLane })
      .search("user-1", request);
    expect(repo.search).toHaveBeenCalledWith(expect.anything(), {
      hits: [],
      reason: "memory_vector_unavailable",
      status: "DEGRADED"
    });

    const disabled = prepared({
      activeGenerationId: null,
      indexMode: null,
      lexicalState: "DISABLED",
      referenceChatHistory: false
    });
    const disabledRepo = repository(disabled);
    await createMemoryHistorySearchService({ repository: disabledRepo, vectorLane })
      .search("user-1", request);
    expect(vectorLane.search).toHaveBeenCalledTimes(1);
    expect(disabledRepo.search).toHaveBeenCalledWith(disabled, null);
  });

  it("maps repository and unknown failures without preserving private messages", async () => {
    const invalid = createMemoryHistorySearchService({
      repository: repository(prepared(), {
        prepare: vi.fn(async () => {
          throw new MemoryHistorySearchRepositoryError("memory_contract_invalid");
        })
      })
    });
    await expect(invalid.search("user-1", request)).rejects.toEqual(
      new MemoryHistorySearchServiceError("memory_contract_invalid")
    );

    const failed = createMemoryHistorySearchService({
      repository: repository(prepared(), {
        search: vi.fn(async () => {
          throw new Error("private history query");
        })
      })
    });
    await expect(failed.search("user-1", request)).rejects.toEqual(
      new MemoryHistorySearchServiceError("memory_action_failed")
    );
  });
});
