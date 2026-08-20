import { describe, expect, it, vi } from "vitest";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";

const acceptedAt = new Date("2031-02-03T04:05:06.000Z");
const hierarchyChecksum = "a".repeat(64);

const rows = [0, 1, 2].map((ordinal) => ({
  contentHash: String(ordinal + 1).repeat(64),
  contextPrefix: "",
  documentContext: null,
  headingPath: ["Section"],
  id: `passage-${ordinal}`,
  ordinal,
  page: ordinal + 1,
  sectionId: "section-1",
  sourceName: "Pinned source",
  text: `Complete passage ${ordinal}`
}));

function sourceBinding() {
  return {
    fileNameSnapshot: "pinned.txt",
    id: "source-binding-1",
    ordinal: 0,
    profileBinding: { id: "profile-binding-1", ordinal: 0 },
    sourceAlias: "S1",
    sourceArtifact: {
      hierarchicalIndexes: [{
        checksum: hierarchyChecksum,
        id: "hierarchy-1",
        passageCount: 3,
        state: "ready"
      }],
      id: "source-artifact-1",
      state: "ready"
    },
    sourceArtifactId: "source-artifact-1",
    sourceId: "source-1",
    sourceNameSnapshot: "Pinned source",
    sourceVersionId: "source-version-1",
    sourceVersionNumber: 2
  };
}

function store() {
  const passageFindMany = vi.fn(async (input: Readonly<{
    take: number;
    where: Readonly<{ ordinal: Readonly<{ gte: number }> }>;
  }>) => rows.slice(input.where.ordinal.gte, input.where.ordinal.gte + input.take));
  const passageFindFirst = vi.fn(async (input: Readonly<{
    where: Readonly<{ ordinal: number }>;
  }>) => rows[input.where.ordinal] ?? null);
  const retrieval = createPrismaKnowledgeRetrievalStore({
    knowledgeArtifactPassageIndex: {
      findFirst: passageFindFirst,
      findMany: passageFindMany
    },
    knowledgeRunSourceBinding: {
      findFirst: vi.fn(async () => sourceBinding()),
      findMany: vi.fn(async () => [sourceBinding()])
    },
    modelRun: { findFirst: vi.fn(async () => ({ createdAt: acceptedAt })) }
  } as never);
  return { passageFindFirst, passageFindMany, retrieval };
}

describe("Prisma Knowledge strategy Source enumeration", () => {
  it("creates the retrieval session before the first strategy step and reuses it", async () => {
    const create = vi.fn(async ({ data }: Readonly<{ data: Readonly<{ id: string }> }>) => ({
      ...data,
      acceptedAt: null,
      receiptHash: null
    }));
    const session = { acceptedAt: null, id: "retrieval-session-1", receiptHash: null };
    const findUnique = vi.fn(async () => findUnique.mock.calls.length > 1 ? session : null);
    const transaction = {
      $queryRaw: vi.fn(async () => [{ id: "run-1" }]),
      knowledgeRetrievalSession: { create, findUnique },
      modelRun: {
        findUnique: vi.fn(async () => ({
          knowledgeRunScope: {
            budgetPolicy: { maxOperations: 14 },
            exclusions: [],
            resolvedBaseCount: 0,
            resolvedSourceCount: 1,
            selection: { kind: "all_my_knowledge" }
          },
          normalizedRequest: {
            knowledgePlanner: {
              automaticRetrieval: true,
              coverage: { expectedPassageCount: 1, mode: "verified_only", namedTargets: [] },
              evidenceMode: "compact",
              intent: "single_source_summary",
              originalQuery: "Summarize the source",
              rewrite: { exactTerms: [], query: "Summarize the source" },
              status: "ready",
              strategy: "full_context",
              subqueries: [{
                exact: null,
                exactTerms: [],
                lanes: ["lexical"],
                operation: "automatic_search",
                ordinal: 0,
                purpose: "summary",
                query: "Summarize the source",
                targetNames: [],
                targetResolution: null,
                targetSourceIds: []
              }],
              targetResolution: null,
              targetSourceIds: [],
              version: 2
            }
          }
        }))
      }
    };
    const retrieval = createPrismaKnowledgeRetrievalStore({
      $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) =>
        operation(transaction))
    } as never);

    const first = await retrieval.prepareStrategySession!({
      runId: "run-1",
      userId: "owner-1"
    });
    const second = await retrieval.prepareStrategySession!({
      runId: "run-1",
      userId: "owner-1"
    });

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).toEqual({ id: "retrieval-session-1" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("freezes an accepted Source/hierarchy and pages every passage in ordinal order", async () => {
    const { passageFindFirst, retrieval } = store();
    const sources = await retrieval.loadStrategySources!({
      runId: "run-1",
      userId: "owner-1"
    });

    expect(sources).toEqual([{
      bindingId: "source-binding-1",
      hierarchicalArtifactId: "hierarchy-1",
      hierarchicalChecksum: hierarchyChecksum,
      ordinal: 0,
      passageCount: 3,
      sourceAlias: "S1",
      sourceArtifactId: "source-artifact-1",
      sourceId: "source-1",
      sourceVersionId: "source-version-1",
      sourceVersionNumber: 2,
      version: 1
    }]);

    const first = await retrieval.loadStrategyPassagePage!({
      cursor: null,
      executionId: "execution-1",
      limit: 2,
      runId: "run-1",
      source: sources[0]!,
      streamId: "full-context-source-1",
      userId: "owner-1"
    });
    expect(first.complete).toBe(false);
    expect(first.items.map((item) => item.passageOrdinal)).toEqual([0, 1]);
    expect(first.passages.map((passage) => passage.text)).toEqual([
      "Complete passage 0",
      "Complete passage 1"
    ]);
    expect(first.nextCursor).toMatchObject({ nextPassageOrdinal: 2, pageOrdinal: 1 });

    const second = await retrieval.loadStrategyPassagePage!({
      cursor: first.nextCursor!,
      executionId: "execution-1",
      limit: 2,
      runId: "run-1",
      source: sources[0]!,
      streamId: "full-context-source-1",
      userId: "owner-1"
    });
    expect(second.complete).toBe(true);
    expect(second.items.map((item) => item.passageOrdinal)).toEqual([2]);
    expect(second.nextCursor).toBeNull();
    expect(passageFindFirst).toHaveBeenCalledOnce();
  });

  it("rejects a continuation whose predecessor hash does not match the frozen passage", async () => {
    const { retrieval } = store();
    const [source] = await retrieval.loadStrategySources!({
      runId: "run-1",
      userId: "owner-1"
    });
    const first = await retrieval.loadStrategyPassagePage!({
      cursor: null,
      executionId: "execution-1",
      limit: 2,
      runId: "run-1",
      source: source!,
      streamId: "exhaustive-source-1",
      userId: "owner-1"
    });

    await expect(retrieval.loadStrategyPassagePage!({
      cursor: { ...first.nextCursor!, previousItemHash: "f".repeat(64) },
      executionId: "execution-1",
      limit: 2,
      runId: "run-1",
      source: source!,
      streamId: "exhaustive-source-1",
      userId: "owner-1"
    })).rejects.toThrow("knowledge_strategy_cursor_predecessor_mismatch");
  });
});
