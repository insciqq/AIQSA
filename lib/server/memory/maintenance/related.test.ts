import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../../observability";
import type { MemoryVectorProfile, MemoryVectorSearchInput } from "../retrieval/vector";
import { loadMemoryMaintenanceRelatedMemories, MEMORY_MAINTENANCE_RELATED_LIMIT } from "./related";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));

const profile: MemoryVectorProfile = { configurationFingerprint: "a".repeat(64), connectionId: "connection", dimension: 1_024,
  generationId: "generation", minimumSimilarity: 0.55, providerModelId: "embedding-model",
  retrievalConfigFingerprint: "memory-vector-fixture", vectorSpaceFingerprint: "b".repeat(64) };
const observedAt = new Date("2026-09-20T10:00:00.000Z");
const vector = (seed: number) => JSON.stringify(Array.from({ length: 1_024 }, (_, index) => index === seed ? 1 : 0));
type Statement = Readonly<{ versionId: string; factId?: string; statement: string }>;

/** A read-only stand-in for PostgreSQL: stored source embeddings, then the
 * current statements of the ranked related versions. */
function store(input: Readonly<{ embedded: readonly string[]; statements: readonly Statement[]; fail?: boolean }>) {
  const statementReads: string[][] = [];
  const $queryRaw = vi.fn(async (query: Prisma.Sql) => {
    if (input.fail) throw new Error("synthetic_read_failure");
    if (query.sql.includes("\"MemorySearchEntry\"")) {
      return input.embedded.filter((versionId) => query.values.includes(versionId))
        .map((factVersionId, index) => ({ factVersionId, embedding: vector(index) }));
    }
    const requested = query.values.filter((value): value is string => typeof value === "string");
    statementReads.push(requested.filter((value) => input.statements.some(({ versionId }) => versionId === value)));
    return input.statements.filter(({ versionId }) => requested.includes(versionId)).map(({ versionId, factId, statement }) =>
      ({ versionId, factId: factId ?? `fact-${versionId}`, statement, observedAt }));
  });
  return { queryRaw: $queryRaw, client: { $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">, statementReads };
}
function vectors(hits: Readonly<Record<string, readonly string[] | "DEGRADED">>, ready = true) {
  const searched: MemoryVectorSearchInput[] = [];
  return { searched, repository: {
    resolveActiveProfile: vi.fn(async () => ready ? { status: "READY" as const, profile }
      : { status: "DEGRADED" as const, reason: "memory_vector_unavailable" as const }),
    search: vi.fn(async (input: MemoryVectorSearchInput, _options?: unknown) => {
      searched.push(input);
      const source = Object.keys(hits)[searched.length - 1]!;
      const ranked = hits[source]!;
      if (ranked === "DEGRADED") return { status: "DEGRADED" as const, reason: "memory_vector_generation_stale" as const, hits: [] as [], lanes: [] as [] };
      return { status: "READY" as const, profile, lanes: [], hits: ranked.map((itemId, rank) => ({ itemId, entryId: `entry-${itemId}`,
        itemType: "FACT_VERSION" as const, distance: rank / 10, score: 1 - rank / 10 })) };
    })
  } };
}
const sources = ["S1", "S2", "S3"].map((ref) => ({ ref, factId: `fact-${ref}`, versionId: `version-${ref}` }));
const owner = { jobId: "job-1" };

beforeEach(() => { vi.mocked(logEvent).mockReset(); });

describe("maintenance related memories", () => {
  it("reviews without related memories when the owner has no ready embedding profile", async () => {
    const { client, queryRaw } = store({ embedded: ["version-S1"], statements: [] });
    const { repository } = vectors({}, false);
    expect(await loadMemoryMaintenanceRelatedMemories(client, "owner", sources, { ...owner, vectors: repository })).toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
    expect(repository.search).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
  it("shows the nearest other current memories whole and redacted, at most three per source, through the ordinary vector search", async () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const { client, statementReads } = store({ embedded: ["version-S1", "version-S2"], statements: [
      { versionId: "explicit", statement: "I always want complete code with every fix applied." },
      { versionId: "pinned", statement: "I write Python at work." },
      { versionId: "long", statement: "x".repeat(1_001) },
      { versionId: "same-fact", factId: "fact-S1", statement: "An older version of the source fact." },
      { versionId: "third", statement: "I prefer dark themes." },
      { versionId: "fourth", statement: "I use a standing desk." },
      { versionId: "secret", statement: `My deploy token is ${token} on staging.` }
    ] });
    const { repository, searched } = vectors({
      // The source itself ranks first; a memory no longer current has no statement.
      S1: ["version-S1", "explicit", "gone", "long", "same-fact", "pinned", "third", "fourth"],
      S2: ["version-S2", "explicit", "secret"]
    });
    const related = await loadMemoryMaintenanceRelatedMemories(client, "owner", sources, { ...owner, vectors: repository });
    expect(related.get("S1")).toEqual([
      { ref: "S1M1", factId: "fact-explicit", versionId: "explicit", statement: "I always want complete code with every fix applied.", observedAt },
      { ref: "S1M2", factId: "fact-pinned", versionId: "pinned", statement: "I write Python at work.", observedAt },
      { ref: "S1M3", factId: "fact-third", versionId: "third", statement: "I prefer dark themes.", observedAt }
    ]);
    expect(related.get("S1")).toHaveLength(MEMORY_MAINTENANCE_RELATED_LIMIT);
    expect(related.get("S2")).toEqual([
      { ref: "S2M1", factId: "fact-explicit", versionId: "explicit", statement: "I always want complete code with every fix applied.", observedAt },
      { ref: "S2M2", factId: "fact-secret", versionId: "secret", statement: "My deploy token is [REDACTED:TOKEN] on staging.", observedAt }
    ]);
    // A source without a stored embedding is reviewed without related memories.
    expect(related.has("S3")).toBe(false);
    expect(searched).toHaveLength(2);
    for (const input of searched) {
      expect(input).toMatchObject({ itemTypes: ["FACT_VERSION"], minimumScore: 0, userId: "owner", profile,
        limit: MEMORY_MAINTENANCE_RELATED_LIMIT * 2 + 1, eligibility: { factMode: "CURRENT", chatId: null,
          allowedFactSensitivity: ["NORMAL", "SENSITIVE"] } });
      expect(input.vector).toHaveLength(1_024);
    }
    expect(repository.search.mock.calls.map(([, options]) => options)).toEqual([{ admission: "LANE", signal: undefined },
      { admission: "LANE", signal: undefined }]);
    // Statements are read once for every ranked version, after the searches.
    expect(statementReads).toHaveLength(1);
    expect(logEvent).not.toHaveBeenCalled();
  });
  it("bounds the related statements of the whole batch", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ ref: `S${index + 1}`, factId: `fact-S${index + 1}`, versionId: `version-S${index + 1}` }));
    const statements = many.flatMap(({ ref }) => [1, 2, 3].map((rank) => ({ versionId: `${ref}-${rank}`, statement: `${ref}`.padEnd(900, ".") })));
    const { client } = store({ embedded: many.map(({ versionId }) => versionId), statements });
    const { repository } = vectors(Object.fromEntries(many.map(({ ref }) => [ref, [1, 2, 3].map((rank) => `${ref}-${rank}`)])));
    const related = await loadMemoryMaintenanceRelatedMemories(client, "owner", many, { ...owner, vectors: repository });
    expect([...related.values()].map((memories) => memories.length)).toEqual([3, 3, 3, 3, 1]);
    expect([...related.values()].flat().reduce((total, { statement }) => total + statement.length, 0)).toBeLessThanOrEqual(12_000);
  });
  it("stops showing related memories once the embedding profile changes during the pass", async () => {
    const { client } = store({ embedded: ["version-S1", "version-S2", "version-S3"], statements: [{ versionId: "explicit", statement: "A." }] });
    const { repository } = vectors({ S1: ["explicit"], S2: "DEGRADED", S3: ["explicit"] });
    const related = await loadMemoryMaintenanceRelatedMemories(client, "owner", sources, { ...owner, vectors: repository });
    expect([...related.keys()]).toEqual(["S1"]);
    expect(repository.search).toHaveBeenCalledTimes(2);
  });
  it("reviews without related memories and logs only a content-free code when a read fails", async () => {
    const { client } = store({ embedded: [], statements: [], fail: true });
    const { repository } = vectors({ S1: ["explicit"] });
    expect(await loadMemoryMaintenanceRelatedMemories(client, "owner", sources, { ...owner, vectors: repository })).toEqual(new Map());
    expect(vi.mocked(logEvent).mock.calls).toEqual([["service_operation", { subsystem: "memory", stage: "prepare", outcome: "degraded",
      code: "memory_maintenance_related_context_unavailable", job_id: "job-1" }]]);
    // A cancelled job ends with its cancellation instead.
    const aborted = new AbortController();
    aborted.abort();
    await expect(loadMemoryMaintenanceRelatedMemories(client, "owner", sources, { ...owner, vectors: repository, signal: aborted.signal }))
      .rejects.toThrow("synthetic_read_failure");
  });
});
