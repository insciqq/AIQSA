// @vitest-environment node
import type { PrismaClient, ToolObservation } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { createToolObservationRepository, OBSERVATION_AVAILABILITY_HANDLES, ObservationStoreError } from "./repository";
import { TOOL_OBSERVATION_LIMITS, type ToolObservationBudgetUsage } from "./contract";

const actor = { runId: "run-2", userId: "user-1" };

type Row = ToolObservation & Readonly<{ modelRun: { chatId: string; assistantMessageId: string | null; userMessageId?: string };
  toolCall: { state: string } }>;

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

  it("accepts an earlier attempt of a user message on the branch, never another edit of it", async () => {
    // The earlier attempt's answer is a sibling; its question is on the path.
    const attempt = row(1, { modelRun: { chatId: "chat-1", assistantMessageId: "answer-sibling", userMessageId: "question-1" } });
    const accepted = fixture([attempt], ["answer-2", "question-1"]);
    await expect(accepted.repository.available(actor, [attempt.id])).resolves.toBe(true);
    expect(accepted.authorizeSource).toHaveBeenCalledOnce();
    // Another edit answers a different user message that is not on the path.
    const edit = row(1, { modelRun: { chatId: "chat-1", assistantMessageId: "answer-edit", userMessageId: "question-edit" } });
    const refused = fixture([edit], ["answer-2", "question-1"]);
    await expect(refused.repository.available(actor, [edit.id])).resolves.toBe(false);
    expect(refused.authorizeSource).not.toHaveBeenCalled();
    // A run without a surviving answer still qualifies by its question.
    const orphan = row(1, { modelRun: { chatId: "chat-1", assistantMessageId: null, userMessageId: "question-1" } });
    await expect(fixture([orphan], ["answer-2", "question-1"]).repository.available(actor, [orphan.id])).resolves.toBe(true);
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

describe("observation reservation budget", () => {
  /** The same double plus the reservation's statements; the real budget SQL
   * and its locking run in repository.prisma.test.ts. */
  function reservation(budget: ToolObservationBudgetUsage) {
    const f = fixture([]);
    const budgetQueries = vi.fn(() => [budget]);
    Object.assign(f.tx, {
      $executeRaw: vi.fn(async () => 0),
      modelRunToolCall: { findFirst: vi.fn(async () => ({ id: "call-new" })) },
      $queryRaw: vi.fn(async (query: unknown) => Array.isArray(query) && query.join("").includes('AS "branchBytes"') ? budgetQueries() : [])
    });
    Object.assign(f.tx.toolObservation, { create: vi.fn(async ({ data }: { data: Partial<Row> }) => row(0, { ...data, state: "RESERVED" })) });
    return { ...f, budgetQueries, producer: { ...actor, toolCallId: "call-new" } };
  }
  const exhausted = { runBytes: 0n, branchBytes: BigInt(TOOL_OBSERVATION_LIMITS.branchBytes) };

  it("claims a call the branch budget cannot admit with a zero ceiling instead of refusing it", async () => {
    const f = reservation(exhausted);
    const reserved = await f.repository.reserve(f.producer, "mcp", 1024);
    expect(reserved).toMatchObject({ claimed: true, degraded: true, observation: { reservedBytes: 0 } });
    const room = reservation({ runBytes: 0n, branchBytes: 0n });
    expect(await room.repository.reserve(room.producer, "workspace", 1024))
      .toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: 1024 }) });
  });

  it("never degrades source-owned producers, which the store budget does not count", async () => {
    const f = reservation(exhausted);
    expect(await f.repository.reserve(f.producer, "knowledge", 4096))
      .toEqual({ claimed: true, observation: expect.objectContaining({ reservedBytes: 4096 }) });
    expect(f.budgetQueries).not.toHaveBeenCalled();
  });
});
