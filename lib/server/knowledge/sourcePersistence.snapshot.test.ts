import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeSourceSnapshotConflictError,
  materializeKnowledgeBaseSnapshot
} from "./sourcePersistence";

type Header = {
  evidenceFingerprint: string;
  readySourceCount: number;
  sourceCount: number;
  sourceRevision: number;
};

const input = { indexGenerationId: "generation", knowledgeBaseId: "base" };

function fixture() {
  const headers = new Map<string, Header>();
  const counts = new Map<string, { exactCount: number; totalCount: number }>();
  const memberships = [
    { artifactId: "artifact", currentVersionId: "version", ownerUserId: "owner", sourceId: "source-a" },
    { artifactId: null, currentVersionId: "pending-version", ownerUserId: "owner", sourceId: "source-b" }
  ];
  const sourceInsert = vi.fn((snapshotId: string) => {
    counts.set(snapshotId, { exactCount: 1, totalCount: 1 });
    return 1;
  });
  const execute = vi.fn(async (sql: Prisma.Sql) => {
    const snapshotId = sql.values[0] as string;
    if (sql.text.includes('INSERT INTO "KnowledgeBaseSnapshotSource"')) {
      return sourceInsert(snapshotId);
    }
    if (!sql.text.includes('INSERT INTO "KnowledgeBaseSnapshot"')) {
      throw new Error("unexpected_snapshot_write");
    }
    if (headers.has(snapshotId)) return 0;
    headers.set(snapshotId, {
      evidenceFingerprint: sql.values[8] as string,
      readySourceCount: sql.values[7] as number,
      sourceCount: sql.values[6] as number,
      sourceRevision: sql.values[5] as number
    });
    return 1;
  });
  const query = vi.fn(async (sql: Prisma.Sql) => {
    if (sql.text.includes("FOR SHARE OF base, generation")) {
      return [{ ownerUserId: "owner", profileRevisionId: "profile", sourceRevision: 1 }];
    }
    if (sql.text.includes("FOR SHARE OF membership, source")) return memberships;
    if (sql.text.includes("WITH expected AS")) {
      const snapshotId = sql.values[2] as string;
      return [counts.get(snapshotId) ?? { exactCount: 0, totalCount: 0 }];
    }
    if (sql.text.includes('btrim("evidenceFingerprint")')) {
      const header = headers.get(sql.values[0] as string);
      return header ? [header] : [];
    }
    throw new Error("unexpected_snapshot_read");
  });
  return {
    client: { $executeRaw: execute, $queryRaw: query } as unknown as Prisma.TransactionClient,
    counts, execute, headers, memberships, query, sourceInsert
  };
}

describe("immutable Knowledge snapshot reuse", () => {
  it("creates ready membership once and validates the same snapshot on reuse", async () => {
    const state = fixture();
    const first = await materializeKnowledgeBaseSnapshot(state.client, input);
    expect(first).toMatchObject({ readySourceCount: 1, sourceCount: 2, sourceRevision: 1 });
    expect(state.sourceInsert).toHaveBeenCalledTimes(1);

    await expect(materializeKnowledgeBaseSnapshot(state.client, input)).resolves.toEqual(first);
    expect(state.sourceInsert).toHaveBeenCalledTimes(1);
    expect(state.headers.size).toBe(1);
  });

  it.each([
    { exactCount: 0, totalCount: 0 },
    { exactCount: 0, totalCount: 1 },
    { exactCount: 1, totalCount: 2 }
  ])("rejects incomplete, mismatched or extra existing members: %j", async (corruptCounts) => {
    const state = fixture();
    const first = await materializeKnowledgeBaseSnapshot(state.client, input);
    state.counts.set(first.snapshotId, corruptCounts);
    state.sourceInsert.mockClear();

    await expect(materializeKnowledgeBaseSnapshot(state.client, input))
      .rejects.toBeInstanceOf(KnowledgeSourceSnapshotConflictError);
    expect(state.sourceInsert).not.toHaveBeenCalled();
    expect(state.counts.get(first.snapshotId)).toEqual(corruptCounts);
  });

  it.each([
    { evidenceFingerprint: "wrong" },
    { sourceRevision: 2 },
    { sourceCount: 3 },
    { readySourceCount: 0 }
  ])("still rejects an inconsistent existing header: %j", async (corruptHeader) => {
    const state = fixture();
    const first = await materializeKnowledgeBaseSnapshot(state.client, input);
    Object.assign(state.headers.get(first.snapshotId)!, corruptHeader);
    state.sourceInsert.mockClear();

    await expect(materializeKnowledgeBaseSnapshot(state.client, input))
      .rejects.toBeInstanceOf(KnowledgeSourceSnapshotConflictError);
    expect(state.sourceInsert).not.toHaveBeenCalled();
  });

  it("creates new evidence when the ready version changes without rewriting the old snapshot", async () => {
    const state = fixture();
    const first = await materializeKnowledgeBaseSnapshot(state.client, input);
    const oldHeader = { ...state.headers.get(first.snapshotId)! };
    state.memberships[0]!.currentVersionId = "replacement-version";
    state.memberships[0]!.artifactId = "replacement-artifact";

    const next = await materializeKnowledgeBaseSnapshot(state.client, input);
    expect(next.snapshotId).not.toBe(first.snapshotId);
    expect(next.evidenceFingerprint).not.toBe(first.evidenceFingerprint);
    expect(next.sourceCount).toBe(first.sourceCount);
    expect(state.headers.get(first.snapshotId)).toEqual(oldHeader);
    expect(state.sourceInsert).toHaveBeenCalledTimes(2);
  });
});
