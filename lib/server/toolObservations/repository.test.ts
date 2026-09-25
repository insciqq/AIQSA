// @vitest-environment node
import type { PrismaClient, ToolObservation } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { createToolObservationRepository, OBSERVATION_AVAILABILITY_HANDLES, ObservationStoreError } from "./repository";

const actor = { runId: "run-2", userId: "user-1" };

type Row = ToolObservation & Readonly<{ modelRun: { chatId: string; assistantMessageId: string | null }; toolCall: { state: string } }>;

function row(index: number, input: Partial<Row> = {}): Row {
  const own = index % 2 === 0;
  return {
    id: index.toString(16).padStart(32, "0"), modelRunId: own ? "run-2" : "run-1", toolCallId: `call-${index}`, formatVersion: 1,
    sourceKind: index % 3 === 0 ? "knowledge" : index % 3 === 1 ? "mcp" : "workspace", sourceBinding: null, executionReceipt: null,
    state: "READY", reservedBytes: 20, executionOutcome: "complete", byteSize: 20, checksum: "a".repeat(64), storageMode: "OBJECT",
    inlineText: null, storageKey: `tool-observations/v1/${index}/lease`, projection: null, sourceTruncated: false, maskable: true,
    leaseToken: null, leaseExpiresAt: null, failureCode: null, createdAt: new Date(), updatedAt: new Date(),
    modelRun: { chatId: "chat-1", assistantMessageId: own ? "answer-2" : "answer-1" }, toolCall: { state: "complete" },
    ...input
  };
}

/** Relational double for the authority and lookup queries of one availability
 * check. Real SQL, locking and source owners run in repository.prisma.test.ts. */
function fixture(rows: Row[], ancestors: readonly string[] = ["answer-1"]) {
  const tx = {
    modelRun: { findFirst: vi.fn(async () => ({ id: "run-2", chatId: "chat-1", assistantMessageId: "answer-2", status: "in_progress",
      errorPayload: null, chat: { archived: false, permanentDeletionAt: null, projectId: null } })) },
    user: { findFirst: vi.fn(async () => ({ id: actor.userId })) },
    chat: { findUnique: vi.fn(async () => ({ archived: false, permanentDeletionAt: null, projectId: null, userId: actor.userId })) },
    agentRunBinding: { findUnique: vi.fn(async () => null) },
    toolObservation: {
      findMany: vi.fn(async (query: { where: { id: { in: string[] } } }) => rows.filter(entry => query.where.id.in.includes(entry.id))),
      findUnique: vi.fn()
    },
    $queryRaw: vi.fn(async () => ancestors.map(id => ({ id })))
  };
  const prisma = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) };
  const authorizeSource = vi.fn(async (_tx: unknown, _source: ToolObservation): Promise<void> => undefined);
  const loadSource = vi.fn();
  const repository = createToolObservationRepository({ prisma: prisma as unknown as PrismaClient,
    authorizeSource: authorizeSource as never, loadSource });
  return { authorizeSource, loadSource, prisma, repository, tx };
}

describe("observation availability", () => {
  it("authorizes 50 observations in one transaction with one lookup and one ancestry query, without loading any source", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index));
    const f = fixture(rows);
    await expect(f.repository.available(actor, [...rows.map(entry => entry.id), rows[0]!.id])).resolves.toBe(true);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.modelRun.findFirst).toHaveBeenCalledOnce();
    expect(f.tx.toolObservation.findMany).toHaveBeenCalledOnce();
    expect(f.tx.toolObservation.findUnique).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.loadSource).not.toHaveBeenCalled();
    // Each source keeps its live authorization, grouped by kind.
    expect(f.authorizeSource).toHaveBeenCalledTimes(50);
    const kinds = f.authorizeSource.mock.calls.map(([, source]) => source.sourceKind);
    expect(kinds).toEqual([...kinds].sort());
  });

  it.each([
    ["a revoked MCP grant", (source: ToolObservation) => {
      if (source.sourceKind === "mcp") throw new McpToolAccessDeniedError();
    }],
    ["a deleted Knowledge source", (source: ToolObservation) => {
      if (source.sourceKind === "knowledge") throw new ObservationStoreError("tool_observation_unavailable");
    }]
  ])("is unavailable when %s is among them", async (_label, refuse) => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index));
    const f = fixture(rows);
    f.authorizeSource.mockImplementation(async (_tx, source) => refuse(source));
    await expect(f.repository.available(actor, rows.map(entry => entry.id))).resolves.toBe(false);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it.each([
    ["an unknown handle", [row(0)], [row(0).id, "f".repeat(32)], ["answer-1"]],
    ["an unsettled call", [row(0, { toolCall: { state: "running" } })], [row(0).id], ["answer-1"]],
    ["an unpublished original", [row(0, { state: "STORING" })], [row(0).id], ["answer-1"]],
    ["another chat", [row(0, { modelRun: { chatId: "chat-2", assistantMessageId: "answer-2" } })], [row(0).id], ["answer-1"]],
    ["a sibling branch", [row(1)], [row(1).id], []]
  ])("is unavailable for %s without authorizing sources", async (_label, rows, ids, ancestors) => {
    const f = fixture(rows, ancestors);
    await expect(f.repository.available(actor, ids)).resolves.toBe(false);
    expect(f.authorizeSource).not.toHaveBeenCalled();
  });

  it("refuses a run that lost its authority", async () => {
    const f = fixture([row(0)]);
    f.tx.user.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.repository.available(actor, [row(0).id])).resolves.toBe(false);
  });

  it("propagates database failures instead of reporting a source unavailable", async () => {
    const f = fixture([row(0), row(1)]);
    f.tx.toolObservation.findMany.mockRejectedValueOnce(new Error("connection reset"));
    await expect(f.repository.available(actor, [row(0).id, row(1).id])).rejects.toThrow("connection reset");
    f.authorizeSource.mockRejectedValueOnce(new Error("statement timeout"));
    await expect(f.repository.available(actor, [row(0).id, row(1).id])).rejects.toThrow("statement timeout");
  });

  it("checks nothing for an empty set and refuses an over-cap set before any query", async () => {
    const f = fixture([]);
    await expect(f.repository.available(actor, [])).resolves.toBe(true);
    const many = Array.from({ length: OBSERVATION_AVAILABILITY_HANDLES + 1 }, (_, index) => index.toString(16).padStart(32, "0"));
    await expect(f.repository.available(actor, many)).rejects.toThrow("tool_observation_conflict");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
