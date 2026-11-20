import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { createPrismaMcpDiscoveryOperations } from "./prismaRepositoryMcpDiscovery";
import { McpRunPlanConflictError } from "./runRepositoryContract";

/**
 * Where and under which lock an Auto discovery epoch binds what it loads (2026-11-20): on the run whose agent called
 * `find_tools`, the only run its transaction locks or writes. A background sub-agent's run binds on itself, where its
 * registry reads (`lib/server/engine/execution.ts`); binding on the main-agent run deadlocked. A transaction the database
 * rolls back for a conflict runs again on the run as it then stands, a bounded number of times.
 */

const USER = "user-1";
const servers = {
  tracker: { fingerprint: "fingerprint-tracker", revisionId: "revision-tracker", serverId: "server-tracker", serverName: "Tracker" },
  wiki: { fingerprint: "fingerprint-wiki", revisionId: "revision-wiki", serverId: "server-wiki", serverName: "Wiki" }
} as const;
type ServerKey = keyof typeof servers;
const toolOf = (key: ServerKey) => ({ definitionHash: "a".repeat(64), description: `Read ${key}`, inputSchema: { type: "object" },
  name: "read", namespacedName: `mcp_${key}_read`, originalName: "read", serverId: servers[key].serverId, serverName: servers[key].serverName });
const request = () => ({ mcpDiscovery: { catalog: { servers: (Object.keys(servers) as ServerKey[]).map((key) => ({
  description: `${servers[key].serverName} records`, namespace: key, revisionId: servers[key].revisionId, serverId: servers[key].serverId,
  serverName: servers[key].serverName, tools: [{ description: `Read ${key}`, namespacedName: `mcp_${key}_read`, originalName: "read" }] })),
version: 1 }, epochs: [], version: 2 } });

type Run = { normalizedRequest: Record<string, unknown>; status: string; userId: string };
type State = { bindings: Array<Readonly<{ fingerprint: string; runId: string }>>; runs: Map<string, Run> };
type Statement = Readonly<{ sql: string; values: readonly unknown[] }>;

const knownError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("synthetic", { clientVersion: "test", code, ...(meta ? { meta } : {}) });
const deadlock = () => knownError("P2010", { code: "40P01" });

/** The value bound right after the SQL fragment that ends with `marker`. */
function boundAfter(strings: readonly string[], values: readonly unknown[], marker: string): unknown {
  const index = strings.findIndex((part) => part.trimEnd().endsWith(marker));
  return index < 0 ? undefined : values[index];
}

/**
 * A database of runs, their binding rows and the `find_tools` calls they hold, whose transactions commit what they wrote
 * only when they return. `beforeInsert` runs before each binding insert, with the attempt it belongs to, and may fail it.
 */
function database(input: Readonly<{ beforeInsert?: (attempt: number, state: State) => void; insert?: () => number;
  runs: Readonly<Record<string, Partial<Run>>> }>) {
  let state: State = { bindings: [], runs: new Map(Object.entries(input.runs).map(([id, run]) => [id,
    { normalizedRequest: request(), status: "streaming", userId: USER, ...run }])) };
  const calls = new Map<string, Readonly<{ arguments: unknown; roundIndex: number; runId: string; toolName: string }>>();
  const statements: Statement[] = [];
  let attempts = 0;
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    attempts += 1;
    const attempt = attempts;
    const draft: State = { bindings: [...state.bindings], runs: new Map([...state.runs].map(([id, run]) => [id, structuredClone(run)])) };
    const tx = {
      $queryRaw: async (strings: readonly string[], ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        const run = draft.runs.get(String(values[0]));
        return run && run.userId === values[1] ? [{ normalizedRequest: run.normalizedRequest, status: run.status }] : [];
      },
      $executeRaw: async (strings: readonly string[], ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        input.beforeInsert?.(attempt, state);
        const runId = String(values[1]);
        const fingerprint = String(boundAfter(strings, values, 'generation."fingerprint" ='));
        // The unique index sees rows other transactions committed meanwhile, not only this one's snapshot.
        if ([...draft.bindings, ...state.bindings].some((row) => row.runId === runId && row.fingerprint === fingerprint)) {
          throw knownError("P2010", { code: "23505" });
        }
        const inserted = input.insert?.() ?? 1;
        if (inserted === 1) draft.bindings.push({ fingerprint, runId });
        return inserted;
      },
      mcpRunBinding: { findMany: async ({ where }: { where: { modelRunId: string } }) => draft.bindings
        .filter((row) => row.runId === where.modelRunId).map((row) => ({ runtimeGenerationFingerprint: row.fingerprint })) },
      mcpToolAccessPolicy: { findMany: async () => [] },
      modelRun: { update: async ({ data, where }: { data: { normalizedRequest: Record<string, unknown> }; where: { id: string } }) => {
        statements.push({ sql: "update run", values: [where.id] });
        draft.runs.get(where.id)!.normalizedRequest = data.normalizedRequest;
        return {};
      } },
      modelRunToolCall: { findFirst: async ({ where }: { where: { id: string; modelRunId: string } }) => {
        const call = calls.get(where.id);
        return call && call.runId === where.modelRunId ? call : null;
      } },
      user: { findUnique: async () => ({ groups: [], status: "active" }) }
    };
    const result = await work(tx);
    state = draft;
    return result;
  });
  const operations = createPrismaMcpDiscoveryOperations({ $transaction: transaction } as unknown as PrismaClient);
  let ordinal = 0;
  /** `find_tools` on `runId` loading `load` (already active: `active`), as its agent's registry asks for it. */
  const append = (runId: string, load: readonly ServerKey[], active: readonly ServerKey[] = [], callId = `call-${ordinal += 1}`) => {
    calls.set(callId, { arguments: { query: "records" }, roundIndex: 1, runId, toolName: "find_tools" });
    return operations.appendMcpDiscoveryEpoch({ bindings: load.map((key) => ({ fingerprint: servers[key].fingerprint,
      runtimeGenerationId: `generation-${key}`, serverId: servers[key].serverId })), goal: "records", modelRunToolCallId: callId,
    roundIndex: 1, runId, snapshot: { servers: load.map((key) => ({ ...servers[key] })), tools: load.map(toolOf), version: 1 },
    toolIds: [...load, ...active].map((key) => `mcp_${key}_read`), userId: USER });
  };
  /** Commits an epoch of another agent of `runId` that bound `key`, as a concurrent discovery would. */
  const commitOther = (runId: string, key: ServerKey) => {
    const run = state.runs.get(runId)!;
    const discovery = run.normalizedRequest.mcpDiscovery as { epochs: unknown[] };
    state.bindings.push({ fingerprint: servers[key].fingerprint, runId });
    run.normalizedRequest = { ...run.normalizedRequest, mcp: { servers: [{ ...servers[key] }], tools: [toolOf(key)], version: 1 },
      mcpDiscovery: { ...discovery, epochs: [...discovery.epochs, { epoch: discovery.epochs.length + 1, goal: "records",
        modelRunToolCallId: "call-other", roundIndex: 1, toolIds: [`mcp_${key}_read`] }] } };
  };
  return { append, bindings: () => state.bindings, commitOther, run: (id: string) => state.runs.get(id)!, statements, transaction };
}

describe("an Auto discovery epoch's bindings and lock", () => {
  it("binds a background sub-agent's load on its own run, the only run it locks or writes, without holding off key shares", async () => {
    const db = database({ runs: { "run-bg": {}, "run-main": {} } });
    expect(await db.append("run-bg", ["tracker"])).toMatchObject({ discovery: { epochs: [{ epoch: 1, toolIds: ["mcp_tracker_read"] }] } });
    expect(db.bindings()).toEqual([{ fingerprint: servers.tracker.fingerprint, runId: "run-bg" }]);
    const [lock] = db.statements;
    expect(lock!.sql).toContain("FOR NO KEY UPDATE OF run");
    expect(lock!.sql).not.toMatch(/FOR UPDATE/u);
    expect(db.statements.flatMap((statement) => statement.values).filter((value) => value === "run-main")).toEqual([]);
    expect(db.run("run-main").normalizedRequest).toEqual(request());
  });

  it("binds a server once per run: the later of two epochs of one run plans on what the earlier committed", async () => {
    const db = database({ runs: { "run-bg": {} } });
    // Two foreground children of one background run, one after the other on the run's lock.
    await db.append("run-bg", ["tracker"]);
    expect(await db.append("run-bg", ["tracker", "wiki"])).toMatchObject({ discovery: { epochs: [{ epoch: 1 }, { epoch: 2 }] },
      snapshot: { servers: [{ serverId: "server-tracker" }, { serverId: "server-wiki" }] } });
    expect(db.bindings()).toEqual([{ fingerprint: servers.tracker.fingerprint, runId: "run-bg" },
      { fingerprint: servers.wiki.fingerprint, runId: "run-bg" }]);
  });

  it("inserts the servers it loads in fingerprint order", async () => {
    const db = database({ runs: { "run-bg": {} } });
    await db.append("run-bg", ["wiki", "tracker"]);
    expect(db.bindings().map((row) => row.fingerprint)).toEqual([servers.tracker.fingerprint, servers.wiki.fingerprint]);
  });

  it("runs again on the run as it then stands when the database rolled it back for a conflict", async () => {
    // A deadlock while another agent of the run commits an epoch that bound the same server: the next attempt reads both.
    const db = database({ beforeInsert: (attempt) => {
      if (attempt === 1) {
        db.commitOther("run-bg", "tracker");
        throw deadlock();
      }
    }, runs: { "run-bg": {} } });
    expect(await db.append("run-bg", ["tracker", "wiki"])).toMatchObject({ discovery: { epochs: [{ modelRunToolCallId: "call-other" },
      { epoch: 2, toolIds: ["mcp_tracker_read", "mcp_wiki_read"] }] } });
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.bindings()).toEqual([{ fingerprint: servers.tracker.fingerprint, runId: "run-bg" },
      { fingerprint: servers.wiki.fingerprint, runId: "run-bg" }]);
    // A binding row another writer committed first is a conflict too.
    const unique = database({ beforeInsert: (attempt, state) => {
      if (attempt === 1) state.bindings.push({ fingerprint: servers.tracker.fingerprint, runId: "run-bg" });
    }, runs: { "run-bg": {} } });
    const seen = unique.append("run-bg", ["tracker"]);
    await expect(seen).resolves.toMatchObject({ discovery: { epochs: [{ epoch: 1 }] } });
    expect(unique.transaction).toHaveBeenCalledTimes(2);
    expect(unique.bindings()).toHaveLength(1);
  });

  it("gives up after a bounded number of conflicts, and never runs a refusal again", async () => {
    const stuck = database({ beforeInsert: () => { throw deadlock(); }, runs: { "run-bg": {} } });
    await expect(stuck.append("run-bg", ["tracker"])).rejects.toMatchObject({ code: "P2010" });
    expect(stuck.transaction).toHaveBeenCalledTimes(3);
    expect(stuck.run("run-bg").normalizedRequest).toEqual(request());
    for (const [failure, kind] of [[() => { throw new McpToolAccessDeniedError(); }, McpToolAccessDeniedError],
      [undefined, McpRunPlanConflictError]] as const) {
      const refused = database({ ...(failure ? { beforeInsert: failure } : {}), insert: () => 0, runs: { "run-bg": {} } });
      await expect(refused.append("run-bg", ["tracker"])).rejects.toBeInstanceOf(kind);
      expect(refused.transaction).toHaveBeenCalledOnce();
      expect(refused.bindings()).toEqual([]);
    }
  });

  it("replays a settled call's epoch as it stands, binding and writing nothing", async () => {
    const db = database({ runs: { "run-bg": {} } });
    const first = await db.append("run-bg", ["tracker"], [], "call-settled");
    const statements = db.statements.length;
    expect(await db.append("run-bg", ["tracker"], [], "call-settled")).toEqual(first);
    expect(db.statements.slice(statements).map((statement) => statement.sql)).toEqual([db.statements[0]!.sql]);
    expect(db.bindings()).toHaveLength(1);
  });

  it("refuses a run of another user, locking and binding nothing of it", async () => {
    const db = database({ runs: { "run-bg": { userId: "user-2" } } });
    expect(await db.append("run-bg", ["tracker"])).toBeNull();
    expect(db.bindings()).toEqual([]);
  });
});
