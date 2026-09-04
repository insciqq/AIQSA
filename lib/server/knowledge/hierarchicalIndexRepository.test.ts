import { describe, expect, it, vi } from "vitest";
import type { KnowledgeChunkPlanEntry } from "./chunking";
import {
  buildAndPersistKnowledgeHierarchicalIndex,
  buildAndPersistKnowledgeHierarchicalIndexBatch,
  createPrismaKnowledgeHierarchicalIndexRepository,
  KNOWLEDGE_HIERARCHICAL_INDEX_SOURCE_BATCH_SIZE,
  KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_MAX_WAIT_MS,
  KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_TIMEOUT_MS,
  KNOWLEDGE_HIERARCHICAL_INDEX_WRITE_BATCH_SIZE
} from "./hierarchicalIndexRepository";

function overflowChunks(): KnowledgeChunkPlanEntry[] {
  return Array.from({ length: 240 }, (_, index) => {
    const numbers = Array.from({ length: 60 }, (_value, numberIndex) =>
      String(1_000_000 + index * 100 + numberIndex));
    const text = `SAFE-${index.toString().padStart(4, "0")} 2026-08-20 ${numbers.join(" ")}`;
    return {
      contentHash: index.toString(16).padStart(64, "0"),
      contextPrefix: "",
      documentContext: null,
      embeddingText: text,
      embeddingTextHash: (index + 1).toString(16).padStart(64, "0"),
      headingPath: [],
      index,
      layoutKind: "body" as const,
      page: index + 1,
      pageEnd: index + 1,
      sourceBlockEnd: index,
      sourceBlockIds: [`block-${index}`],
      sourceBlockStart: index,
      text,
      tokenCount: 1
    };
  });
}

describe("Knowledge hierarchical index persistence diagnostics", () => {
  it("rejects invalid Source batches before touching persistence", async () => {
    const tx = { $queryRaw: vi.fn() };
    const input = {
      chunks: [overflowChunks()[0]!],
      document: null,
      now: new Date("2026-09-04T13:00:00.000Z"),
      sourceArtifactId: "artifact-batch",
      sourceVersionId: "version-batch"
    };

    await expect(buildAndPersistKnowledgeHierarchicalIndexBatch(tx as never, []))
      .rejects.toThrow("knowledge_hierarchical_index_settlement_failed");
    await expect(buildAndPersistKnowledgeHierarchicalIndexBatch(
      tx as never,
      Array.from(
        { length: KNOWLEDGE_HIERARCHICAL_INDEX_SOURCE_BATCH_SIZE + 1 },
        () => input
      )
    )).rejects.toThrow("knowledge_hierarchical_index_settlement_failed");
    await expect(buildAndPersistKnowledgeHierarchicalIndexBatch(
      tx as never,
      [input, input]
    )).rejects.toThrow("knowledge_hierarchical_index_settlement_failed");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("emits only bounded counts and artifact identity when exact entries are truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const createExactEntries = vi.fn(async (_input: { data: unknown[] }) => ({
      count: 10_000
    }));
    const createPassageEntries = vi.fn(async (_input: { data: unknown[] }) => ({
      count: 240
    }));
    const tx = {
      $queryRaw: vi.fn(async () => [{
        description: "Private source description",
        fileName: "private-financial-catalog.pdf",
        mimeType: "application/pdf",
        sourceArtifactId: "artifact-overflow",
        sourceArtifactState: "processing",
        sourceName: "Private financial catalog",
        sourceVersionId: "version-overflow",
        tags: ["private-tag"]
      }]),
      knowledgeArtifactDocumentIndex: { create: vi.fn(async () => ({})) },
      knowledgeArtifactExactEntry: { createMany: createExactEntries },
      knowledgeArtifactPassageIndex: { createMany: createPassageEntries },
      knowledgeArtifactSectionIndex: { createMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeHierarchicalIndexArtifact: {
        create: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    };

    await expect(buildAndPersistKnowledgeHierarchicalIndex(tx as never, {
      chunks: overflowChunks(),
      document: null,
      now: new Date("2026-08-26T07:00:00.000Z"),
      sourceArtifactId: "artifact-overflow",
      sourceVersionId: "version-overflow"
    })).resolves.toBe("created");

    expect(createPassageEntries).toHaveBeenCalledOnce();
    expect(createPassageEntries.mock.calls[0]![0].data)
      .toHaveLength(240);
    expect(createExactEntries).toHaveBeenCalledTimes(
      10_000 / KNOWLEDGE_HIERARCHICAL_INDEX_WRITE_BATCH_SIZE
    );
    expect(createExactEntries.mock.calls.every(([input]) =>
      input.data.length <= KNOWLEDGE_HIERARCHICAL_INDEX_WRITE_BATCH_SIZE)).toBe(true);

    expect(warn).toHaveBeenCalledOnce();
    const serialized = warn.mock.calls[0]![0];
    expect(typeof serialized).toBe("string");
    expect(JSON.parse(String(serialized))).toEqual({
      candidateCount: expect.any(Number),
      event: "knowledge_hierarchical_exact_index_truncated",
      reasonCode: "exact_index_truncated",
      retainedCount: 10_000,
      sourceArtifactId: "artifact-overflow",
      sourceVersionId: "version-overflow"
    });
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("SAFE-");
    expect(serialized).not.toContain("private-tag");

    warn.mockClear();
    const onExactIndexTruncated = vi.fn();
    await expect(buildAndPersistKnowledgeHierarchicalIndex(tx as never, {
      chunks: overflowChunks(),
      document: null,
      now: new Date("2026-08-26T07:00:00.000Z"),
      onExactIndexTruncated,
      sourceArtifactId: "artifact-overflow",
      sourceVersionId: "version-overflow"
    })).resolves.toBe("created");
    expect(onExactIndexTruncated).toHaveBeenCalledWith({
      candidateCount: expect.any(Number),
      retainedCount: 10_000,
      sourceArtifactId: "artifact-overflow",
      sourceVersionId: "version-overflow"
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("gives bounded bulk index writes an explicit transaction deadline", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{
        description: "",
        fileName: "source.txt",
        mimeType: "text/plain",
        sourceArtifactId: "artifact-transaction",
        sourceArtifactState: "processing",
        sourceName: "source.txt",
        sourceVersionId: "version-transaction",
        tags: []
      }]),
      knowledgeArtifactDocumentIndex: { create: vi.fn(async () => ({})) },
      knowledgeArtifactExactEntry: { createMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeArtifactPassageIndex: { createMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeArtifactSectionIndex: { createMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeHierarchicalIndexArtifact: {
        create: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    };
    const transaction = vi.fn(async (
      operation: (client: typeof tx) => Promise<unknown>
    ) => operation(tx));
    const repository = createPrismaKnowledgeHierarchicalIndexRepository({
      $transaction: transaction
    } as never);

    await expect(repository.build({
      chunks: [overflowChunks()[0]!],
      document: null,
      now: new Date("2026-08-30T10:00:00.000Z"),
      sourceArtifactId: "artifact-transaction",
      sourceVersionId: "version-transaction"
    })).resolves.toBe("created");

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_MAX_WAIT_MS,
      timeout: KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_TIMEOUT_MS
    });
  });
});
