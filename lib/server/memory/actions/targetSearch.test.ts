import {
  memoryDetailFixture,
  memoryListFixture,
  memorySummaryFixture
} from "@/tests/support/memoryFixtures";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT } from "../retrieval/vector";
import {
  createMemoryActionTargetSearchService,
  createPrismaMemoryActionTargetRepository
} from "./targetSearch";

const vector = Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0);
const profile = {
  configurationFingerprint: "b".repeat(64),
  connectionId: "connection-1",
  dimension: 1_024 as const,
  generationId: "generation-1",
  minimumSimilarity: 0.55,
  providerModelId: "embedding-1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  vectorSpaceFingerprint: "c".repeat(64)
};

function dependencies() {
  const summary = memorySummaryFixture();
  const explicitService = {
    get: vi.fn(async (_userId: string, _factId: string) =>
      memoryDetailFixture(summary)),
    list: vi.fn(async () => memoryListFixture([])),
    search: vi.fn(async () => memoryListFixture([]))
  };
  const repository = {
    byActiveGenerationVersionIds: vi.fn(async () => [{
      factId: summary.id,
      versionId: summary.currentVersionId!
    }]),
    exactActive: vi.fn(async () => [])
  };
  const utilities = {
    embedQuery: vi.fn(async () => ({
      bindingId: "binding-embedding",
      profile,
      status: "READY" as const,
      vector
    }))
  };
  const vectorRepository = {
    resolveActiveProfile: vi.fn(async () => ({ profile, status: "READY" as const })),
    search: vi.fn(async () => ({
      hits: [{
        distance: 0.1,
        entryId: "entry-1",
        itemId: summary.currentVersionId!,
        itemType: "FACT_VERSION" as const,
        score: 0.9
      }],
      lanes: [],
      profile,
      status: "READY" as const
    }))
  };
  return { explicitService, repository, summary, utilities, vectorRepository };
}

describe("Memory action target search", () => {
  it("resolves a paraphrase from the active-generation vector lane", async () => {
    const deps = dependencies();
    const result = await createMemoryActionTargetSearchService(deps as never).semantic({
      attemptId: "attempt-1",
      query: "the preference about brief replies",
      signal: new AbortController().signal,
      userId: "user-1"
    });
    expect(result).toMatchObject({
      status: "READY",
      targets: [{ factId: "memory-fact-1", versionId: "memory-version-1" }]
    });
    expect(deps.utilities.embedQuery).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: "attempt-1",
      purpose: "ACTION_TARGET"
    }));
    expect(deps.explicitService.search).toHaveBeenCalledOnce();
    expect(deps.repository.byActiveGenerationVersionIds).toHaveBeenCalledWith(
      "user-1",
      ["memory-version-1"]
    );
  });

  it("returns strongest tied owned targets from a bounded local zero-hit fallback", async () => {
    const deps = dependencies();
    const weekly = memorySummaryFixture({
      currentVersionId: "memory-version-weekly",
      displayText: "My private-marker weekly reporting format is concise.",
      id: "memory-fact-weekly"
    });
    const monthly = memorySummaryFixture({
      currentVersionId: "memory-version-monthly",
      displayText: "My private-marker monthly reporting format is detailed.",
      id: "memory-fact-monthly"
    });
    deps.vectorRepository.search.mockResolvedValue({
      hits: [],
      lanes: [],
      profile,
      status: "READY"
    });
    deps.explicitService.list.mockResolvedValue(memoryListFixture([
      weekly,
      monthly,
      memorySummaryFixture({
        currentVersionId: "memory-version-unrelated",
        displayText: "I prefer tea.",
        id: "memory-fact-unrelated"
      })
    ]));

    await expect(createMemoryActionTargetSearchService(deps as never).semantic({
      attemptId: "attempt-1",
      fallbackText:
        "Change my saved private-marker reporting-format preference to visual summaries.",
      query: "visual summaries",
      signal: new AbortController().signal,
      userId: "user-1"
    })).resolves.toMatchObject({
      status: "READY",
      targets: [
        { factId: "memory-fact-monthly" },
        { factId: "memory-fact-weekly" }
      ]
    });
    expect(deps.explicitService.list).toHaveBeenCalledWith("user-1", {
      pageSize: 20,
      scope: { type: "GLOBAL_USER" },
      state: "ACTIVE"
    });
  });

  it("supplements one semantic winner when the exact command has tied local targets", async () => {
    const deps = dependencies();
    const weekly = memorySummaryFixture({
      currentVersionId: "memory-version-weekly",
      displayText: "My private-marker weekly reporting format is concise.",
      id: "memory-fact-weekly"
    });
    const monthly = memorySummaryFixture({
      currentVersionId: "memory-version-monthly",
      displayText: "My private-marker monthly reporting format is detailed.",
      id: "memory-fact-monthly"
    });
    deps.vectorRepository.search.mockResolvedValue({
      hits: [{
        distance: 0.1,
        entryId: "entry-weekly",
        itemId: weekly.currentVersionId!,
        itemType: "FACT_VERSION",
        score: 0.9
      }],
      lanes: [],
      profile,
      status: "READY"
    });
    deps.repository.byActiveGenerationVersionIds.mockResolvedValue([{
      factId: weekly.id,
      versionId: weekly.currentVersionId!
    }]);
    deps.explicitService.get.mockImplementation(async (_userId, factId) =>
      memoryDetailFixture(factId === weekly.id ? weekly : monthly));
    deps.explicitService.list.mockResolvedValue(memoryListFixture([weekly, monthly]));

    await expect(createMemoryActionTargetSearchService(deps as never).semantic({
      attemptId: "attempt-1",
      fallbackText:
        "Change one private-marker reporting-format preference without saying weekly or monthly.",
      query: "reporting-format preference",
      signal: new AbortController().signal,
      userId: "user-1"
    })).resolves.toMatchObject({
      status: "READY",
      targets: [
        { factId: "memory-fact-weekly" },
        { factId: "memory-fact-monthly" }
      ]
    });
  });

  it("treats learned legacy sensitive targets like normal targets", async () => {
    const deps = dependencies();
    const sensitive = memorySummaryFixture({
      sensitivityClass: "SENSITIVE",
      sourceMode: "AUTOMATIC"
    });
    deps.vectorRepository.search.mockResolvedValue({
      hits: [],
      lanes: [],
      profile,
      status: "READY"
    });
    deps.explicitService.search.mockResolvedValue(memoryListFixture([sensitive]));

    await expect(createMemoryActionTargetSearchService(deps as never).semantic({
      attemptId: "attempt-1",
      query: "the preference about brief replies",
      signal: new AbortController().signal,
      userId: "user-1"
    })).resolves.toMatchObject({
      status: "READY",
      targets: [{ factId: sensitive.id, versionId: sensitive.currentVersionId }]
    });
  });

  it("admits normal and legacy sensitive facts in authoritative target SQL", async () => {
    const queries: Array<{ strings: readonly string[] }> = [];
    const client = {
      $queryRaw: vi.fn(async (query: { strings: readonly string[] }) => {
        queries.push(query);
        return [];
      })
    };
    await createPrismaMemoryActionTargetRepository(client as never).exactActive(
      "user-1",
      "target statement",
      5
    );
    const sql = queries[0]?.strings.join("?") ?? "";
    expect(sql).toContain('version."sensitivityClass" IN (');
    expect(sql).toContain("'SENSITIVE'::\"MemorySensitivityClass\"");
    expect(sql).not.toContain('version."sensitivityClass" = \'NORMAL\'');
    expect(sql).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
  });

  it("resolves an exact active statement before any embedding", async () => {
    const deps = dependencies();
    deps.repository.exactActive.mockResolvedValue([{
      factId: deps.summary.id,
      versionId: deps.summary.currentVersionId!
    }] as never);
    const result = await createMemoryActionTargetSearchService(deps as never).exact({
      query: "I prefer concise answers in Russian.",
      userId: "user-1"
    });
    expect(result).toMatchObject({ status: "READY", targets: [{ factId: "memory-fact-1" }] });
    expect(deps.repository.exactActive).toHaveBeenCalledWith(
      "user-1",
      "i prefer concise answers in russian.",
      5
    );
    expect(deps.utilities.embedQuery).not.toHaveBeenCalled();
    expect(deps.vectorRepository.search).not.toHaveBeenCalled();
  });

  it("drops an exact identity when the final target reload is legacy-scoped", async () => {
    const deps = dependencies();
    deps.repository.exactActive.mockResolvedValue([{
      factId: deps.summary.id,
      versionId: deps.summary.currentVersionId!
    }] as never);
    deps.explicitService.get.mockResolvedValue(memoryDetailFixture(memorySummaryFixture({
      scope: { targetId: "folder-1", type: "FOLDER" }
    })));

    await expect(createMemoryActionTargetSearchService(deps as never).exact({
      query: "I prefer concise answers in Russian.",
      userId: "user-1"
    })).resolves.toEqual({ status: "READY", targets: [] });
  });

  it("fails closed without a vector profile and never falls back to lexical-only", async () => {
    const deps = dependencies();
    deps.vectorRepository.resolveActiveProfile.mockResolvedValue({
      reason: "memory_vector_unavailable",
      status: "DEGRADED"
    } as never);
    await expect(createMemoryActionTargetSearchService(deps as never).semantic({
      attemptId: "attempt-1",
      query: "brief replies",
      signal: new AbortController().signal,
      userId: "user-1"
    })).resolves.toEqual({
      reason: "memory_vector_unavailable",
      status: "UNAVAILABLE"
    });
    expect(deps.utilities.embedQuery).not.toHaveBeenCalled();
    expect(deps.explicitService.search).not.toHaveBeenCalled();
  });

  it("fails closed when embedding or the required lexical lane is unavailable", async () => {
    const embeddingDeps = dependencies();
    embeddingDeps.utilities.embedQuery.mockResolvedValue({
      reason: "memory_query_embedding_unavailable",
      status: "UNAVAILABLE"
    } as never);
    const embeddingResult = await createMemoryActionTargetSearchService(
      embeddingDeps as never
    ).semantic({
      attemptId: "attempt-1",
      query: "brief replies",
      signal: new AbortController().signal,
      userId: "user-1"
    });
    expect(embeddingResult.status).toBe("UNAVAILABLE");
    expect(embeddingDeps.explicitService.search).not.toHaveBeenCalled();

    const lexicalDeps = dependencies();
    lexicalDeps.explicitService.search.mockRejectedValue(new Error("index unavailable"));
    const lexicalResult = await createMemoryActionTargetSearchService(
      lexicalDeps as never
    ).semantic({
      attemptId: "attempt-1",
      query: "brief replies",
      signal: new AbortController().signal,
      userId: "user-1"
    });
    expect(lexicalResult).toEqual({
      reason: "memory_action_semantic_target_unavailable",
      status: "UNAVAILABLE"
    });
  });

  it("excludes vector scores at the configured floor", async () => {
    const deps = dependencies();
    deps.vectorRepository.search.mockResolvedValue({
      hits: [{
        distance: 0.45,
        entryId: "entry-floor",
        itemId: "memory-version-1",
        itemType: "FACT_VERSION",
        score: profile.minimumSimilarity
      }],
      lanes: [],
      profile,
      status: "READY"
    });
    const result = await createMemoryActionTargetSearchService(deps as never).semantic({
      attemptId: "attempt-1",
      query: "a pure semantic paraphrase",
      signal: new AbortController().signal,
      userId: "user-1"
    });
    expect(result).toEqual({ status: "READY", targets: [] });
    expect(deps.repository.byActiveGenerationVersionIds).toHaveBeenCalledWith("user-1", []);
  });
});
