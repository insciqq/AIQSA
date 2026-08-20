import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encodeKnowledgeExactCursor } from "./hierarchicalRetrieval";
import {
  createPrismaKnowledgeHierarchicalRetrievalRepository,
  knowledgeHierarchicalSourceMetadataDiscoverySql
} from "./prismaHierarchicalRetrievalRepository";

const admittedScope = {
  runId: "run-1",
  scopeKind: "admitted_run" as const,
  sourceArtifactIds: ["artifact-1", "artifact-2"],
  userId: "user-1"
};

function sqlText(value: unknown): string {
  return (value as Prisma.Sql).strings.join("?");
}

function fakeClient(rows: readonly unknown[]) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [...rows])
  };
  const client = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) =>
      operation(tx))
  };
  return { client, tx };
}

describe("Prisma hierarchical exact and Source discovery", () => {
  it("executes exact matching only through an admitted-run bounded SQL scope", async () => {
    const { client, tx } = fakeClient([{
      results: [{
        field: "body",
        indexArtifactId: "hierarchy-1",
        page: 2,
        pageEnd: 2,
        passageId: "passage-1",
        sectionId: "section-1",
        sourceArtifactId: "artifact-1",
        value: "Invoice-42"
      }],
      scannedBytes: 128n,
      scanTruncated: false
    }]);
    const repository = createPrismaKnowledgeHierarchicalRetrievalRepository(client as never);

    await expect(repository.findExact({
      ...admittedScope,
      caseSensitive: true,
      field: "body",
      limit: 2,
      operation: "token",
      query: "Invoice-42"
    })).resolves.toEqual({
      nextCursor: null,
      results: [{
        field: "body",
        indexArtifactId: "hierarchy-1",
        kind: "token",
        page: 2,
        pageEnd: 2,
        passageId: "passage-1",
        sectionId: "section-1",
        sourceArtifactId: "artifact-1",
        value: "Invoice-42"
      }],
      scannedBytes: 128,
      scanTruncated: false
    });

    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(client.$transaction).toHaveBeenCalledOnce();
    const query = (tx.$queryRaw.mock.calls as unknown[][])[0]?.[0];
    const text = sqlText(query);
    expect(text).toContain('INNER JOIN "KnowledgeRunSourceBinding"');
    expect(text).toContain('run."id" = ?');
    expect(text).toContain('run."userId" = ?');
    expect(text).toContain('source_artifact."id" IN (?,?)');
    expect(text).toContain('bounded."text" ~ ?');
  });

  it("groups every matching metadata row by Source before applying the page cursor", async () => {
    const query = knowledgeHierarchicalSourceMetadataDiscoverySql({
      fields: ["heading", "source_name"],
      limit: 3,
      offset: 0,
      query: "quarterly",
      scope: admittedScope
    });
    const text = sqlText(query);
    const groupAt = text.indexOf('GROUP BY matched."sourceArtifactId"');
    const offsetAt = text.lastIndexOf("OFFSET ?");
    const limitAt = text.lastIndexOf("LIMIT ?");

    // Even if S1 contributes 101 heading rows, it becomes one source_matches
    // row before OFFSET/LIMIT and therefore cannot hide a matching S2.
    expect(groupAt).toBeGreaterThan(0);
    expect(offsetAt).toBeGreaterThan(groupAt);
    expect(limitAt).toBeGreaterThan(offsetAt);
    expect(text.slice(0, groupAt)).not.toContain("LIMIT ?");
    expect(text).not.toContain('"KnowledgeArtifactPassageIndex"');
    expect(text).not.toContain('"KnowledgeArtifactSectionIndex"');
  });

  it("returns stable Source-level pages with canonical matched-field provenance", async () => {
    const { client, tx } = fakeClient([]);
    tx.$queryRaw
      .mockResolvedValueOnce([
        {
          indexArtifactId: "hierarchy-1",
          matchedFields: ["heading", "source_name"],
          similarity: 0.9,
          sourceArtifactId: "artifact-1"
        },
        {
          indexArtifactId: "hierarchy-2",
          matchedFields: ["source_name"],
          similarity: 0.8,
          sourceArtifactId: "artifact-2"
        }
      ])
      .mockResolvedValueOnce([{
        indexArtifactId: "hierarchy-2",
        matchedFields: ["source_name"],
        similarity: 0.8,
        sourceArtifactId: "artifact-2"
      }]);
    const repository = createPrismaKnowledgeHierarchicalRetrievalRepository(client as never);

    const first = await repository.discoverSourceMetadata({
      ...admittedScope,
      fields: ["source_name", "heading"],
      limit: 1,
      query: "quarterly"
    });
    expect(first).toEqual({
      nextCursor: encodeKnowledgeExactCursor(1),
      results: [{
        indexArtifactId: "hierarchy-1",
        matchedFields: ["heading", "source_name"],
        similarity: 0.9,
        sourceArtifactId: "artifact-1"
      }]
    });

    const second = await repository.discoverSourceMetadata({
      ...admittedScope,
      cursor: first.nextCursor!,
      fields: ["heading", "source_name"],
      limit: 1,
      query: "quarterly"
    });
    expect(second).toEqual({
      nextCursor: null,
      results: [{
        indexArtifactId: "hierarchy-2",
        matchedFields: ["source_name"],
        similarity: 0.8,
        sourceArtifactId: "artifact-2"
      }]
    });
    const secondSql = (tx.$queryRaw.mock.calls as unknown[][])[1]?.[0] as Prisma.Sql;
    expect(secondSql.values.slice(-2)).toEqual([1, 2]);
  });

  it("maps a PostgreSQL statement timeout to a stable exact-query error", async () => {
    const timeout = new Prisma.PrismaClientKnownRequestError("cancelled", {
      clientVersion: "test",
      code: "P2010",
      meta: { code: "57014" }
    });
    const client = {
      $queryRaw: vi.fn(async () => []),
      $transaction: vi.fn(async () => {
        throw timeout;
      })
    };
    const repository = createPrismaKnowledgeHierarchicalRetrievalRepository(client as never);

    await expect(repository.findExact({
      ...admittedScope,
      field: "body",
      limit: 1,
      operation: "phrase",
      query: "needle"
    })).rejects.toMatchObject({ code: "knowledge_exact_query_timed_out" });
  });

  it("rejects an unsafe regex before opening a SQL transaction", async () => {
    const { client, tx } = fakeClient([]);
    const repository = createPrismaKnowledgeHierarchicalRetrievalRepository(client as never);

    await expect(repository.findExact({
      ...admittedScope,
      field: "body",
      limit: 1,
      operation: "regex",
      query: "(a+)+$"
    })).rejects.toMatchObject({ code: "knowledge_exact_pattern_unsafe" });
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("stops pagination instead of emitting a cursor beyond the bounded offset", async () => {
    const exactRow = (artifact: string) => ({
      field: "body",
      indexArtifactId: `hierarchy-${artifact}`,
      page: 1,
      pageEnd: 1,
      passageId: `passage-${artifact}`,
      sectionId: `section-${artifact}`,
      sourceArtifactId: artifact,
      value: "needle"
    });
    const { client } = fakeClient([{
      results: [exactRow("artifact-1"), exactRow("artifact-2")],
      scannedBytes: 32n,
      scanTruncated: false
    }]);
    const repository = createPrismaKnowledgeHierarchicalRetrievalRepository(client as never);

    await expect(repository.findExact({
      ...admittedScope,
      cursor: encodeKnowledgeExactCursor(10_000),
      field: "body",
      limit: 1,
      operation: "phrase",
      query: "needle"
    })).resolves.toMatchObject({
      nextCursor: null,
      results: [{ sourceArtifactId: "artifact-1" }]
    });
  });
});
