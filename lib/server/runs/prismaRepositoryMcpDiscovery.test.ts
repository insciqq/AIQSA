import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaMcpDiscoveryOperations } from "./prismaRepositoryMcpDiscovery";
import { McpRunPlanConflictError } from "./runRepositoryContract";

/**
 * Where an Auto discovery epoch binds the servers it loads: on the run that owns the calling run's bindings. A background
 * sub-agent's run holds no MCP binding rows of its own, so a server only it loaded used to be bound on its own run, where
 * neither its registry nor its saved results look, and every call of that server's tools was refused.
 */

const USER = "user-1";
const tool = { definitionHash: "a".repeat(64), description: "Get a card", inputSchema: { type: "object" }, name: "get_card",
  namespacedName: "mcp_tracker_get_card", originalName: "get_card", serverId: "server-tracker", serverName: "Tracker" };
const snapshot = { servers: [{ fingerprint: "fingerprint-tracker", revisionId: "revision-tracker", serverId: "server-tracker", serverName: "Tracker" }],
  tools: [tool], version: 1 as const };
const binding = { fingerprint: "fingerprint-tracker", runtimeGenerationId: "generation-tracker", serverId: "server-tracker" };
const normalizedRequest = { mcpDiscovery: { catalog: { servers: [{ description: "Cards", namespace: "tracker", revisionId: "revision-tracker",
  serverId: "server-tracker", serverName: "Tracker", tools: [{ description: "Get a card", namespacedName: tool.namespacedName,
    originalName: "get_card" }] }], version: 1 }, epochs: [], version: 2 } };

type Run = Readonly<{ assistantMessageId: string | null; chatId: string; id: string; subagentTurn: unknown; userId: string }>;
const main: Run = { assistantMessageId: "answer", chatId: "chat", id: "run-main", subagentTurn: null, userId: USER };
const background = (parentRunId = "run-main"): Run => ({ assistantMessageId: null, chatId: "chat", id: "run-bg", userId: USER,
  subagentTurn: { mode: "background", parentRun: { subagentTurn: null }, parentRunId } });

type Options = Readonly<{
  /** Fingerprints each run already binds. */
  bound?: Readonly<Record<string, readonly string[]>>;
  /** The caller's request as its lock reads it, when something changed it since its first read. */
  movedRequest?: unknown;
  /** Another agent bound the same generation first: the insert does nothing, and the row is what `boundRow` says. */
  raced?: Readonly<{ boundRow: boolean }>;
}>;

function harness(runs: readonly Run[], options: Options = {}) {
  const order: string[] = [];
  const inserted: Array<Readonly<{ fingerprint: unknown; runId: unknown }>> = [];
  const tx = {
    $queryRaw: vi.fn(async (query: readonly string[], ...values: unknown[]) => {
      const sql = query.join("?");
      if (sql.includes("FROM \"ModelRun\" AS run")) {
        // The lock is a fragment the query embeds (`Prisma.sql`), present only in a locking read.
        const locked = JSON.stringify(values.slice(2)).includes("FOR UPDATE OF run");
        order.push(`${locked ? "lock" : "read"} ${String(values[0])}`);
        const run = runs.find((candidate) => candidate.id === values[0]);
        const request = locked && options.movedRequest !== undefined ? options.movedRequest : normalizedRequest;
        return run ? [{ chatId: run.chatId, normalizedRequest: request, status: "streaming" }] : [];
      }
      // `insertAcceptedMcpRunBindings` reading the row a racing insert left.
      if (sql.includes("FROM \"McpRunBinding\"")) return options.raced?.boundRow ? [{ id: "binding-raced" }] : [];
      return [];
    }),
    // `insertAcceptedMcpRunBindings`: one row per new binding, under the run it names.
    $executeRaw: vi.fn(async (query: readonly string[], ...values: unknown[]) => {
      const at = (marker: string) => values[query.findIndex((part) => part.trimEnd().endsWith(marker))];
      order.push(`bind ${String(values[1])}`);
      if (options.raced) return 0;
      inserted.push({ fingerprint: at('generation."fingerprint" ='), runId: values[1] });
      return 1;
    }),
    mcpRunBinding: { findMany: vi.fn(async ({ where }: { where: { modelRunId: string } }) =>
      (options.bound?.[where.modelRunId] ?? []).map((runtimeGenerationFingerprint) => ({ runtimeGenerationFingerprint }))) },
    mcpToolAccessPolicy: { findMany: vi.fn(async () => []) },
    modelRun: {
      // Runs as the database finds them by the query's own scope (`runBindingOwner`).
      findFirst: vi.fn(async ({ where }: { where: { chatId: string; id: string; subagentTurnId?: null; userId: string } }) =>
        runs.find((run) => run.id === where.id && run.chatId === where.chatId && run.userId === where.userId &&
          (where.subagentTurnId !== null || run.subagentTurn === null)) ?? null),
      update: vi.fn(async (_input: { where: { id: string } }) => ({}))
    },
    modelRunToolCall: { findFirst: vi.fn(async () => ({ arguments: { query: "tracker card" }, roundIndex: 1, toolName: "find_tools" })) },
    user: { findUnique: vi.fn(async () => ({ groups: [], status: "active" })) }
  };
  // A transaction that fails rolls back; the operation reports what it returned or threw.
  const client = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) };
  const append = (runId: string) => createPrismaMcpDiscoveryOperations(client as unknown as PrismaClient).appendMcpDiscoveryEpoch({
    bindings: [binding], goal: "tracker card", modelRunToolCallId: "call-find", roundIndex: 1, runId, snapshot,
    toolIds: [tool.namespacedName], userId: USER });
  return { append, client, inserted, order, tx };
}

describe("an Auto discovery epoch's bindings", () => {
  it("binds a background sub-agent's load on the main-agent run its registry reads, and keeps the epoch on its own run", async () => {
    const h = harness([main, background()]);
    expect(await h.append("run-bg")).toMatchObject({ discovery: { epochs: [{ toolIds: [tool.namespacedName] }] } });
    expect(h.inserted).toEqual([{ fingerprint: "fingerprint-tracker", runId: "run-main" }]);
    expect(h.tx.mcpRunBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { modelRunId: "run-main" } }));
    expect(h.tx.modelRun.update).toHaveBeenCalledOnce();
    expect(h.tx.modelRun.update.mock.calls[0]![0].where).toEqual({ id: "run-bg" });
    // It binds on the main-agent run before it holds its own, and holds no lock of the main-agent run's at all: waiting for
    // that run while holding a sub-agent's closed a cycle with an image the main agent publishes and a sub-agent's settlement.
    expect(h.order).toEqual(["read run-bg", "bind run-main", "lock run-bg"]);
  });

  it("binds nothing twice: a server the main agent already bound is the sub-agent's as it is", async () => {
    const h = harness([main, background()], { bound: { "run-main": ["fingerprint-tracker"] } });
    expect(await h.append("run-bg")).not.toBeNull();
    expect(h.inserted).toEqual([]);
    expect(h.order).toEqual(["read run-bg", "lock run-bg"]);
  });

  it("takes a binding another agent of the answer made meanwhile as its own, and refuses a generation it does not match", async () => {
    const raced = harness([main, background()], { raced: { boundRow: true } });
    expect(await raced.append("run-bg")).toMatchObject({ discovery: { epochs: [{ toolIds: [tool.namespacedName] }] } });
    const stale = harness([main, background()], { raced: { boundRow: false } });
    await expect(stale.append("run-bg")).rejects.toBeInstanceOf(McpRunPlanConflictError);
    expect(stale.tx.modelRun.update).not.toHaveBeenCalled();
  });

  it("goes back on what it bound when its own run moved between its read and its lock", async () => {
    const h = harness([main, background()], { movedRequest: { ...normalizedRequest, mcp: snapshot } });
    expect(await h.append("run-bg")).toBeNull();
    // The binding was written inside the transaction the move rolled back.
    await expect(h.client.$transaction.mock.results[0]!.value).rejects.toThrow();
    expect(h.tx.modelRun.update).not.toHaveBeenCalled();
  });

  it("binds a main-agent run's own load on itself under its own lock, as before", async () => {
    const h = harness([main]);
    expect(await h.append("run-main")).not.toBeNull();
    expect(h.inserted).toEqual([{ fingerprint: "fingerprint-tracker", runId: "run-main" }]);
    expect(h.order).toEqual(["read run-main", "lock run-main", "bind run-main"]);
  });

  it("refuses a run whose turn leads to no main-agent run of its chat, binding and recording nothing", async () => {
    const h = harness([main, background("run-elsewhere"), { ...main, chatId: "other-chat", id: "run-elsewhere" }]);
    expect(await h.append("run-bg")).toBeNull();
    expect(h.inserted).toEqual([]);
    expect(h.tx.modelRun.update).not.toHaveBeenCalled();
  });
});
