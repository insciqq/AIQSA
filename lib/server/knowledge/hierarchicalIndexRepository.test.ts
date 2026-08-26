import { describe, expect, it, vi } from "vitest";
import type { KnowledgeChunkPlanEntry } from "./chunking";
import { buildAndPersistKnowledgeHierarchicalIndex } from "./hierarchicalIndexRepository";

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
  it("emits only bounded counts and artifact identity when exact entries are truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      knowledgeArtifactExactEntry: { createMany: vi.fn(async () => ({ count: 10_000 })) },
      knowledgeArtifactPassageIndex: { createMany: vi.fn(async () => ({ count: 240 })) },
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
    warn.mockRestore();
  });
});
