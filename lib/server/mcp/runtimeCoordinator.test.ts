import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpClientSessionError,
  type McpFatalResponseErrorCode
} from "./clientSession";
import { MAX_TOOL_DESCRIPTION_LENGTH } from "@/lib/contracts/mcp";
import { ToolHiveClientError } from "./toolhiveClient";
import { getContext, runWithContext, type ObservabilityContext } from "../observability";
import type { McpPublishedToolDefinitions } from "./definitions";
import {
  MCP_HEALTH_DEADLINE_MS,
  MCP_HEALTH_INVENTORY_DEADLINE_MS,
  McpRuntimeCoordinator,
  type McpRuntimeCoordinatorRepository,
  type McpRuntimeGenerationLaunch,
  type McpRuntimeInventoryTool,
  type McpRuntimeLaunch,
  type McpRuntimeSession
} from "./runtimeCoordinator";

const now = new Date("2026-07-22T18:00:00.000Z");

function deferred<Value>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function tool(name: string, definitionHash = `hash-${name}`, description: string | null = null): McpRuntimeInventoryTool {
  return { definitionHash, description, inputSchema: { type: "object" }, name };
}

const DEFAULT_TOOLS = ["echo", "large", "slow"].map((name) => tool(name));

/** What a checked revision published: its exact name/definition pairs. */
function publishedDefinitions(tools: readonly McpRuntimeInventoryTool[]): McpPublishedToolDefinitions {
  return { hashes: new Map(tools.map((entry) => [entry.name, entry.definitionHash])), kind: "definitions" };
}

function launch(overrides: Partial<McpRuntimeGenerationLaunch> = {}): McpRuntimeGenerationLaunch {
  return {
    callTimeoutMs: 10_000,
    fingerprint: "fingerprint-1",
    generationId: "generation-1",
    headers: {},
    publishedTools: publishedDefinitions(DEFAULT_TOOLS),
    redactionValues: [],
    retryAt: null,
    startupTimeoutMs: 10_000,
    url: "https://mcp.example.test/mcp",
    ...overrides
  };
}

function harness(input: {
  cleanupOrphans?: (tokens: readonly string[]) => Promise<void>;
  createError?: Error;
  dispose?: () => Promise<void>;
  dynamicSecrets?: string[];
  failList?: boolean;
  inventory?: McpRuntimeInventoryTool[];
  inventoryDescription?: string;
  now?: () => Date;
  /** Defaults to the upstream inventory: the server still matches its last check. */
  published?: McpPublishedToolDefinitions;
  retainedFingerprints?: string[];
} = {}) {
  const calls: string[] = [];
  let closed = false;
  let fatalResponseErrorCode: McpFatalResponseErrorCode | null = null;
  let listChanged: (() => void) | null = null;
  let inventory = input.inventory ?? ["echo", "large", "slow"].map((name) => ({
    definitionHash: `hash-${name}`,
    description: input.inventoryDescription ?? null,
    inputSchema: { type: "object" },
    name
  }));
  let launches = [launch({ publishedTools: input.published ?? publishedDefinitions(inventory) })];
  let sharedLaunches: McpRuntimeGenerationLaunch[] = [];
  const session: McpRuntimeSession = {
    callTool: vi.fn(async ({ name }) => ({
      isError: false,
      structuredContent: { name },
      text: [],
      unsupportedContentTypes: []
    })),
    close: vi.fn(async () => {
      closed = true;
    }),
    exactKnownSecrets: () => input.dynamicSecrets ?? [],
    fatalResponseErrorCode: () => fatalResponseErrorCode,
    isClosed: () => closed,
    ping: vi.fn(async () => undefined),
    listTools: vi.fn(async () => {
      if (input.failList) throw new Error("inventory schema invalid");
      return inventory;
    })
  };
  if (input.dispose) session.dispose = input.dispose;
  const repository: McpRuntimeCoordinatorRepository = {
    deleteDrainedGeneration: vi.fn(async () => true),
    finalizeDeletedServers: vi.fn(async () => 0),
    listDrainedGenerationIds: vi.fn(async () => []),
    ...(input.retainedFingerprints ? {
      listGenerationFingerprints: vi.fn(async () => input.retainedFingerprints!)
    } : {}),
    loadAcceptedGeneration: vi.fn(async () => null),
    markFailed: vi.fn(async ({ errorCode }) => {
      calls.push(`failed:${errorCode}`);
      return { applied: true, retryAt: new Date(now.getTime() + 5_000) };
    }),
    markReady: vi.fn(async () => {
      calls.push("ready");
      return true;
    }),
    markStarting: vi.fn(async () => {
      calls.push("starting");
      return true;
    }),
    synchronizeDesired: vi.fn(async () => launches),
    synchronizeShared: vi.fn(async () => sharedLaunches),
    touchLastUsed: vi.fn(async () => undefined)
  };
  const createSession = vi.fn(async (
    options: McpRuntimeLaunch & { signal?: AbortSignal; onToolsChanged(): void }
  ) => {
    if (input.createError) throw input.createError;
    listChanged = options.onToolsChanged;
    return session;
  });
  const coordinator = new McpRuntimeCoordinator({
    now: input.now ?? (() => now),
    repository,
    ...(input.cleanupOrphans ? {
      runtimeLifecycle: { cleanupOrphans: input.cleanupOrphans }
    } : {}),
    sessions: { create: createSession }
  });
  return {
    calls,
    coordinator,
    createSession,
    listChanged: () => listChanged?.(),
    repository,
    session,
    setClosed(value: boolean) { closed = value; },
    setFatalResponseErrorCode(value: McpFatalResponseErrorCode | null) {
      fatalResponseErrorCode = value;
    },
    setInventory(value: McpRuntimeInventoryTool[]) { inventory = value; },
    setLaunches(value: McpRuntimeGenerationLaunch[]) { launches = value; },
    setSharedLaunches(value: McpRuntimeGenerationLaunch[]) { sharedLaunches = value; }
  };
}

describe("MCP runtime coordinator", () => {
  it.each([true, false, "reject"] as const)("retains original startup failure before retry persistence=%s", async (outcome) => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const records = () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    const error = new McpClientSessionError({ code: "mcp_network_failed", operation: "initialize" });
    error.message = "PRIVATE_STARTUP_CANARY";
    const test = harness({ createError: error });
    test.setLaunches([launch({ generationId: `retry-${outcome}` })]);
    vi.mocked(test.repository.markFailed).mockImplementation(async () => {
      expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "initialize", outcome: "failed", code: "mcp_network_failed" }));
      if (outcome === "reject") throw new Error("PRIVATE_RETRY_CANARY");
      return { applied: outcome, retryAt: new Date("2026-07-22T18:00:05.000Z") };
    });
    try {
      if (outcome === "reject") await expect(test.coordinator.reconcileNow()).rejects.toThrow("PRIVATE_RETRY_CANARY");
      else await test.coordinator.reconcileNow();
      const retry = records().find((record) => record.event === "job_persistence" && record.stage === "retry");
      expect(retry).toMatchObject({ outcome: outcome === "reject" ? "unconfirmed" : outcome ? "confirmed" : "not_applied" });
      expect(retry.retry_at).toBe(outcome === true ? "2026-07-22T18:00:05.000Z" : undefined);
      expect(JSON.stringify(records())).not.toContain("PRIVATE_");
    } finally { await test.coordinator.stop(); writer.mockRestore(); }
  });

  it("recovers only the failed generation and keeps healthy reconcile and health polls quiet", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const test = harness();
    const a = launch({ generationId: "failed-generation", fingerprint: "failed-fingerprint" });
    const b = launch({ generationId: "healthy-generation", fingerprint: "healthy-fingerprint" });
    test.setLaunches([]);
    try {
      await test.coordinator.reconcileNow(); await test.coordinator.reconcileNow();
      // A previous test may have left an unscoped coordinator failure.
      writer.mockClear();
      await test.coordinator.reconcileNow();
      expect(writer).not.toHaveBeenCalled();
      test.setLaunches([a]);
      test.createSession.mockRejectedValueOnce(new McpClientSessionError({ code: "mcp_network_failed", operation: "initialize" }));
      await test.coordinator.reconcileNow();
      test.setLaunches([b]);
      await test.coordinator.reconcileNow();
      let records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(records.filter((record) => record.event === "subsystem.recovered" && record.stage === "process")).toHaveLength(0);
      test.setLaunches([a, b]);
      await test.coordinator.reconcileNow();
      records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(records.filter((record) => record.event === "subsystem.recovered" && record.stage === "process")).toHaveLength(1);
      writer.mockClear();
      await test.coordinator.reconcileNow();
      expect(test.coordinator.operationalStatus(a.generationId)).toBe("active");
      expect(writer).not.toHaveBeenCalled();
    } finally { await test.coordinator.stop(); writer.mockRestore(); }
  });

  it("isolates lazy startup, repeated kicks, inventory refresh and health polling while preserving tool context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const request = { trace_id: "1".repeat(32), run_id: "first-run", job_id: "request-job" };
    const nextRequest = { trace_id: "2".repeat(32), run_id: "second-run" };
    const test = harness({ now: () => new Date() });
    const drains: Array<ObservabilityContext | undefined> = [];
    const inventories: Array<ObservabilityContext | undefined> = [];
    const probes: Array<ObservabilityContext | undefined> = [];
    let callContext: ObservabilityContext | undefined;
    const listTools = vi.mocked(test.session.listTools).getMockImplementation()!;
    vi.mocked(test.repository.synchronizeDesired).mockImplementation(async () => {
      drains.push(getContext());
      return [launch()];
    });
    vi.mocked(test.session.listTools).mockImplementation(async (signal) => {
      inventories.push(getContext());
      return listTools(signal);
    });
    vi.mocked(test.session.ping).mockImplementation(async () => { probes.push(getContext()); });
    vi.mocked(test.session.callTool).mockImplementation(async () => {
      callContext = getContext();
      return { isError: false, structuredContent: null, text: [], unsupportedContentTypes: [] };
    });
    try {
      runWithContext(request, () => test.coordinator.start());
      await test.coordinator.reconcileNow();
      await runWithContext(nextRequest, () => test.coordinator.reconcileNow());
      runWithContext(nextRequest, () => test.listChanged());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await runWithContext(nextRequest, () => test.coordinator.callTool({
        definitionHash: "hash-echo",
        arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
      }));

      expect(drains.length).toBeGreaterThanOrEqual(3);
      expect(inventories).toHaveLength(2);
      expect(probes).toHaveLength(2);
      expect(inventories[0]?.trace_id).not.toBe(inventories[1]?.trace_id);
      expect(probes[0]?.trace_id).not.toBe(probes[1]?.trace_id);
      expect(drains[0]?.trace_id).not.toBe(drains[1]?.trace_id);
      for (const context of [...drains, ...inventories, ...probes]) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
        expect(context?.trace_id).not.toBe(request.trace_id);
        expect(context?.trace_id).not.toBe(nextRequest.trace_id);
      }
      expect(callContext).toEqual(nextRequest);
    } finally {
      await test.coordinator.stop();
    }
  });

  it("aborts a cold start when its only request is cancelled", async () => {
    const test = harness();
    test.createSession.mockImplementation(async ({ signal }) => new Promise<never>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("cancelled startup")), { once: true });
    }));
    const controller = new AbortController();
    const pending = test.coordinator.ensureUserServersReady("user-1", ["server-1"], controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(test.createSession).toHaveBeenCalledOnce());
    const startup = test.createSession.mock.calls[0]![0].signal!;
    controller.abort();
    await rejected;
    expect(startup.aborted).toBe(true);
    await vi.waitFor(() => expect(test.repository.markFailed).toHaveBeenCalledOnce());
    expect(test.repository.markReady).not.toHaveBeenCalled();
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("keeps a shared cold start alive for a second active request", async () => {
    const test = harness();
    const gate = deferred<McpRuntimeSession>();
    let startupContext: ObservabilityContext | undefined;
    test.createSession.mockImplementation(async () => {
      startupContext = getContext();
      return gate.promise;
    });
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = runWithContext({ trace_id: "3".repeat(32), run_id: "first-run" }, () =>
      test.coordinator.ensureUserServersReady("user-1", ["server-1"], first.signal)
    );
    const rejected = expect(cancelled).rejects.toBeDefined();
    const retained = runWithContext({ trace_id: "4".repeat(32), run_id: "second-run" }, () =>
      test.coordinator.ensureUserServersReady("user-1", ["server-1"], second.signal)
    );
    await vi.waitFor(() => expect(test.createSession).toHaveBeenCalledOnce());
    first.abort();
    await rejected;
    expect(test.createSession.mock.calls[0]![0].signal!.aborted).toBe(false);
    gate.resolve(test.session);
    await retained;
    expect(test.repository.markReady).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    expect(startupContext).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
    expect(startupContext?.trace_id).not.toBe("3".repeat(32));
    expect(startupContext?.trace_id).not.toBe("4".repeat(32));
    await test.coordinator.stop();
  });

  afterEach(() => vi.useRealTimers());

  it("renews unsupported-ping sessions with bounded protocol inventory and never publishes newly returned tools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date() });
    await test.coordinator.reconcileNow();
    const original = await test.session.listTools();
    test.setInventory([...original, { ...original[0], name: "new-tool", definitionHash: "new-hash" }]);
    vi.mocked(test.session.ping).mockRejectedValue(new McpClientSessionError({ code: "mcp_ping_unsupported", operation: "ping" }));
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
      await vi.advanceTimersByTimeAsync(0);
      expect(test.coordinator.operationalStatus("generation-1")).toBe("active");
      await expect(test.coordinator.callTool({ definitionHash: "hash-echo", generationId: "generation-1", name: "echo", arguments: {}, inputSchema: { type: "object" } }))
        .resolves.toMatchObject({ isError: false });
    }
    expect(test.session.ping).toHaveBeenCalledOnce();
    expect(test.createSession).toHaveBeenCalledOnce();
    expect(test.repository.markReady).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    expect(test.session.callTool).toHaveBeenCalledTimes(3);
    await expect(test.coordinator.callTool({ definitionHash: "hash-new-tool", generationId: "generation-1", name: "new-tool", arguments: {}, inputSchema: { type: "object" } }))
      .rejects.toMatchObject({ code: "mcp_tool_not_available" });
    await test.coordinator.stop();
  });

  it.each(["changed", "secret", "timeout"])("fails closed if the compatibility inventory is %s", async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date(), dynamicSecrets: ["PRIVATE_SECRET"] });
    await test.coordinator.reconcileNow();
    vi.mocked(test.session.ping).mockRejectedValue(new McpClientSessionError({ code: "mcp_ping_unsupported", operation: "ping" }));
    if (failure === "timeout") vi.mocked(test.session.listTools).mockImplementation(() => new Promise(() => {}));
    else test.setInventory([{ name: "echo", definitionHash: "changed", inputSchema: { type: "object" },
      description: failure === "secret" ? "PRIVATE_SECRET" : null }]);
    await vi.advanceTimersByTimeAsync(30_000);
    test.coordinator.operationalStatus("generation-1");
    await vi.advanceTimersByTimeAsync(MCP_HEALTH_INVENTORY_DEADLINE_MS);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("inactive");
    expect(test.repository.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: failure === "timeout" ? "mcp_timeout" : failure === "secret" ? "mcp_inventory_invalid" : "mcp_inventory_changed"
    }));
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("keeps a maximal paginated health inventory live past the ping deadline without publishing additions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const published = Array.from({ length: 1_024 }, (_, index) => tool(`tool_${index}`));
    const test = harness({ inventory: published, now: () => new Date() });
    await test.coordinator.reconcileNow();
    vi.mocked(test.session.ping).mockRejectedValue(new McpClientSessionError({ code: "mcp_ping_unsupported", operation: "ping" }));
    // 32 pages answering within their own deadline take longer than one ping deadline.
    vi.mocked(test.session.listTools).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve([...published, tool("tool_1024")]), 32 * (MCP_HEALTH_DEADLINE_MS / 4));
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
    await vi.advanceTimersByTimeAsync(32 * (MCP_HEALTH_DEADLINE_MS / 4));
    expect(test.coordinator.operationalStatus("generation-1")).toBe("active");
    expect(vi.mocked(test.session.listTools).mock.calls.at(-1)).toEqual([
      expect.any(AbortSignal), { requestTimeoutMs: MCP_HEALTH_DEADLINE_MS }
    ]);
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    expect(test.repository.markReady).toHaveBeenCalledOnce();
    await expect(test.coordinator.callTool({ definitionHash: "hash-tool_1023", generationId: "generation-1", name: "tool_1023", arguments: {}, inputSchema: { type: "object" } }))
      .resolves.toMatchObject({ isError: false });
    await expect(test.coordinator.callTool({ definitionHash: "hash-tool_1024", generationId: "generation-1", name: "tool_1024", arguments: {}, inputSchema: { type: "object" } }))
      .rejects.toMatchObject({ code: "mcp_tool_not_available" });
    await test.coordinator.stop();
  });

  it("applies a personal runtime's changed health inventory through the refresh instead of evicting it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ inventory: [tool("read"), tool("write")], now: () => new Date() });
    test.setLaunches([launch({ personalRuntime: true, publishedTools: { kind: "names", names: new Set() } })]);
    await test.coordinator.reconcileNow();
    vi.mocked(test.session.ping).mockRejectedValue(new McpClientSessionError({ code: "mcp_ping_unsupported", operation: "ping" }));
    const call = (name: string, definitionHash = `hash-${name}`) => test.coordinator.callTool({
      arguments: {}, definitionHash, generationId: "generation-1", inputSchema: { type: "object" }, name
    });

    // An unchanged inventory only renews liveness.
    await vi.advanceTimersByTimeAsync(30_000);
    test.coordinator.operationalStatus("generation-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.session.listTools).toHaveBeenCalledTimes(2);
    expect(test.repository.markReady).toHaveBeenCalledOnce();

    // An upstream change to another tool and an addition are applied, not evicted.
    test.setInventory([tool("read"), tool("write", "hash-write-changed"), tool("added")]);
    await vi.advanceTimersByTimeAsync(30_000);
    test.coordinator.operationalStatus("generation-1");
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(test.coordinator.operationalStatus("generation-1")).toBe("active"));
    expect(vi.mocked(test.repository.markReady).mock.calls[1]![0].inventory.tools)
      .toEqual([tool("read"), tool("write", "hash-write-changed"), tool("added")]);
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    expect(test.repository.markStarting).toHaveBeenCalledOnce();
    expect(test.createSession).toHaveBeenCalledOnce();
    await expect(call("read")).resolves.toMatchObject({ structuredContent: { name: "read" } });
    await expect(call("write")).rejects.toMatchObject({ code: "mcp_tool_definition_changed" });
    await expect(call("added")).resolves.toMatchObject({ structuredContent: { name: "added" } });
    expect(test.session.callTool).toHaveBeenCalledTimes(2);
    await test.coordinator.stop();
  });

  it("requires fresh protocol proof and deduplicates non-blocking health renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date() });
    expect(test.coordinator.operationalStatus("generation-1")).toBe("inactive");
    expect(test.createSession).not.toHaveBeenCalled();
    await test.coordinator.reconcileNow();
    expect(test.coordinator.operationalStatus("generation-1")).toBe("active");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("active");
    const ping = deferred<void>();
    vi.mocked(test.session.ping).mockReturnValue(ping.promise);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
    expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
    await test.coordinator.reconcileNow();
    expect(test.session.ping).toHaveBeenCalledTimes(1);
    expect(test.session.listTools).toHaveBeenCalledTimes(1);
    ping.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("active");
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("cancels a hanging probe at two seconds and ignores a late success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date() });
    await test.coordinator.reconcileNow();
    const ping = deferred<void>();
    vi.mocked(test.session.ping).mockReturnValue(ping.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(test.session.ping).mock.calls[0]![0]!.signal!.aborted).toBe(true);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("inactive");
    expect(test.repository.markFailed).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "mcp_timeout" }));
    ping.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("inactive");
    expect(test.createSession).toHaveBeenCalledTimes(1);
    await test.coordinator.stop();
  });

  it("renews 30 seconds after protocol success independently of the reconciliation timer's phase", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date() });
    const inventory = deferred<McpRuntimeInventoryTool[]>();
    vi.mocked(test.session.listTools).mockReturnValue(inventory.promise);
    test.coordinator.start();
    await vi.advanceTimersByTimeAsync(500);
    inventory.resolve([]);
    await test.coordinator.reconcileNow();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(test.session.ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.session.ping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.session.ping).toHaveBeenCalledTimes(2);
    await test.coordinator.stop();
  });

  it("bounds overlapping scheduler and catalog probes to four across generations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date() });
    const launches = Array.from({ length: 6 }, (_, index) => launch({
      fingerprint: `fingerprint-${index}`, generationId: `generation-${index}`
    }));
    const pending = launches.map(() => deferred<void>());
    const pings = launches.map((_, index) => vi.fn(() => pending[index]!.promise));
    test.setLaunches(launches);
    test.createSession.mockImplementation(async ({ generationId }) => ({
      ...test.session, ping: pings[Number(generationId.split("-")[1])]!
    }));
    await test.coordinator.reconcileNow();
    await vi.advanceTimersByTimeAsync(30_000);
    await test.coordinator.reconcileNow();
    for (const entry of launches) expect(test.coordinator.operationalStatus(entry.generationId)).toBe("checking");
    expect(pings.map((ping) => ping.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);
    pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings.map((ping) => ping.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 0]);
    for (const ping of pending) ping.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings.every((ping) => ping.mock.calls.length === 1)).toBe(true);
    expect(test.session.listTools).toHaveBeenCalledTimes(6);
    await test.coordinator.stop();
  });

  it("fences a drained generation's late ping and never probes a known closed session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const test = harness({ now: () => new Date() });
    await test.coordinator.reconcileNow();
    const pending = deferred<void>();
    vi.mocked(test.session.ping).mockReturnValue(pending.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("checking");
    await vi.advanceTimersByTimeAsync(0);
    test.setLaunches([]);
    vi.mocked(test.repository.listDrainedGenerationIds).mockResolvedValue(["generation-1"]);
    await test.coordinator.reconcileNow();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.coordinator.operationalStatus("generation-1")).toBe("inactive");
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    await test.coordinator.stop();

    const closed = harness();
    await closed.coordinator.reconcileNow();
    closed.setClosed(true);
    expect(closed.coordinator.operationalStatus("generation-1")).toBe("inactive");
    expect(closed.session.ping).not.toHaveBeenCalled();
    await closed.coordinator.stop();
  });

  it("starts only the explicitly requested on-demand servers", async () => {
    const test = harness();

    await test.coordinator.ensureUserServersReady("user-1", ["server-2", "server-2"]);

    expect(test.repository.synchronizeDesired).toHaveBeenCalledWith({
      now,
      onDemand: true,
      serverIds: ["server-2"],
      userId: "user-1"
    });
    expect(test.repository.synchronizeShared).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await test.coordinator.stop();
  });

  it("starts a Project's shared runtime on a cold coordinator without any member runtime", async () => {
    const test = harness();
    const shared = launch({ fingerprint: "shared-fingerprint", generationId: "shared-generation" });
    test.setSharedLaunches([shared]);

    await test.coordinator.ensureSharedServersReady(["server-2", "server-2"]);

    expect(test.repository.synchronizeShared).toHaveBeenCalledWith({ now, onDemand: true, serverIds: ["server-2"] });
    expect(test.repository.synchronizeDesired).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("shared-generation")).toBe(true);
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);

    // A stale inventory is refreshed on the next Project demand, whoever is online.
    test.setSharedLaunches([{ ...shared, inventoryRefreshRequired: true }]);
    await test.coordinator.ensureSharedServersReady(["server-2"]);
    expect(test.createSession).toHaveBeenCalledOnce();
    expect(test.session.listTools).toHaveBeenCalledTimes(2);
    expect(test.repository.markReady).toHaveBeenCalledTimes(2);
    await test.coordinator.stop();
  });

  it("keeps shared Project runtimes current only in the installation-wide pass", async () => {
    const test = harness();
    test.setLaunches([]);
    test.setSharedLaunches([launch({ fingerprint: "shared-fingerprint", generationId: "shared-generation" })]);

    await test.coordinator.reconcileNow("user-1");
    expect(test.repository.synchronizeShared).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("shared-generation")).toBe(false);

    await test.coordinator.reconcileNow();
    expect(test.repository.synchronizeShared).toHaveBeenCalledWith({ now });
    expect(test.coordinator.hasLiveGeneration("shared-generation")).toBe(true);
    await test.coordinator.stop();
  });

  it("offers only published enabled tools and fences held-back calls before settlement or I/O", async () => {
    const test = harness({
      inventory: [tool("echo"), tool("Echo"), tool("new_tool")],
      published: publishedDefinitions([tool("echo"), tool("Echo")])
    });
    test.setLaunches([launch({
      disabledToolNames: ["Echo"],
      publishedTools: publishedDefinitions([tool("echo"), tool("Echo")])
    })]);

    await test.coordinator.reconcileNow();

    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory).toEqual({
      exclusions: [
        { name: "Echo", reason: "disabled_by_policy" },
        { name: "new_tool", reason: "unpublished_addition" }
      ],
      tools: [tool("echo")],
      version: 1
    });
    for (const name of ["Echo", "new_tool"]) {
      await expect(test.coordinator.callTool({
        definitionHash: `hash-${name}`,
        arguments: {},
        generationId: "generation-1",
        inputSchema: { type: "object" },
        name
      })).rejects.toMatchObject({ code: "mcp_tool_not_available", operation: "call_tool" });
    }
    expect(test.repository.touchLastUsed).not.toHaveBeenCalled();
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("keeps a personal runtime's full upstream inventory and follows additions and removals after list_changed", async () => {
    const long = "d".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 100);
    const test = harness({ inventory: [tool("read_mail", "hash-read_mail", long), tool("send_mail")] });
    test.setLaunches([launch({
      personalRuntime: true,
      publishedTools: { kind: "names", names: new Set() }
    })]);

    await test.coordinator.reconcileNow();
    // The owner's switched-off tools are a projection filter: the runtime keeps every upstream tool.
    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory).toEqual({
      exclusions: [],
      tools: [tool("read_mail", "hash-read_mail", long), tool("send_mail")],
      version: 1
    });
    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].discoveredInventory).toEqual({
      tools: [{ description: "d".repeat(MAX_TOOL_DESCRIPTION_LENGTH), name: "read_mail" }, { description: null, name: "send_mail" }],
      version: 1
    });

    test.setInventory([tool("read_mail", "changed-read-definition"), tool("delete_mail")]);
    test.listChanged();
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(2));
    expect(vi.mocked(test.repository.markReady).mock.calls[1]![0]).toMatchObject({
      discoveredInventory: { tools: [{ description: null, name: "read_mail" }, { description: null, name: "delete_mail" }], version: 1 },
      inventory: { exclusions: [], tools: [tool("read_mail", "changed-read-definition"), tool("delete_mail")], version: 1 }
    });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-send_mail",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "send_mail"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-delete_mail",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "delete_mail"
    })).resolves.toMatchObject({ structuredContent: { name: "delete_mail" } });
    expect(test.session.callTool).toHaveBeenCalledOnce();
    await test.coordinator.stop();
  });

  it("holds back an upstream addition, a changed definition and a missing tool at start", async () => {
    const test = harness({
      inventory: [tool("echo", "hash-echo-changed"), tool("large"), tool("delete_repo")],
      published: publishedDefinitions(DEFAULT_TOOLS)
    });

    await test.coordinator.reconcileNow();

    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory).toEqual({
      exclusions: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "echo", reason: "definition_drift" },
        { name: "slow", reason: "missing_upstream" }
      ],
      tools: [tool("large")],
      version: 1
    });
    for (const name of ["delete_repo", "echo", "slow"]) {
      await expect(test.coordinator.callTool({
        definitionHash: `hash-${name}`,
        arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name
      })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    }
    await expect(test.coordinator.callTool({
      definitionHash: "hash-large",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "large"
    })).resolves.toMatchObject({ structuredContent: { name: "large" } });
    expect(test.session.callTool).toHaveBeenCalledOnce();
    await test.coordinator.stop();
  });

  it("holds back the same changes after list_changed and restores a reverted server without a new check", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
    })).resolves.toMatchObject({ structuredContent: { name: "echo" } });

    test.setInventory([tool("echo", "hash-echo-changed"), tool("large"), tool("delete_repo")]);
    test.listChanged();
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(2));

    expect(vi.mocked(test.repository.markReady).mock.calls[1]![0].inventory).toEqual({
      exclusions: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "echo", reason: "definition_drift" },
        { name: "slow", reason: "missing_upstream" }
      ],
      tools: [tool("large")],
      version: 1
    });
    for (const name of ["delete_repo", "echo", "slow"]) {
      await expect(test.coordinator.callTool({
        definitionHash: `hash-${name}`,
        arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name
      })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    }

    test.setInventory(DEFAULT_TOOLS);
    test.listChanged();
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(3));
    expect(vi.mocked(test.repository.markReady).mock.calls[2]![0].inventory).toEqual({
      exclusions: [], tools: DEFAULT_TOOLS, version: 1
    });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
    })).resolves.toMatchObject({ structuredContent: { name: "echo" } });
    expect(test.session.callTool).toHaveBeenCalledTimes(2);
    await test.coordinator.stop();
  });

  it("accounts for every published and upstream name exactly once, with policy first", async () => {
    const published = publishedDefinitions([tool("a"), tool("b"), tool("e"), tool("f")]);
    const test = harness({
      inventory: [tool("a"), tool("b", "hash-b-changed"), tool("c"), tool("d")],
      published
    });
    test.setLaunches([launch({ disabledToolNames: ["c", "e"], publishedTools: published })]);

    await test.coordinator.reconcileNow();

    const inventory = vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory;
    expect(inventory.tools.map(({ name }) => name)).toEqual(["a"]);
    expect(inventory.exclusions).toEqual([
      { name: "b", reason: "definition_drift" },
      { name: "c", reason: "disabled_by_policy" },
      { name: "d", reason: "unpublished_addition" },
      { name: "e", reason: "disabled_by_policy" },
      { name: "f", reason: "missing_upstream" }
    ]);
    const covered = [...inventory.tools, ...inventory.exclusions].map(({ name }) => name);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    await test.coordinator.stop();
  });

  it("matches a revision checked before definitions were recorded by name only", async () => {
    const test = harness({
      inventory: [tool("echo", "hash-echo-changed"), tool("large"), tool("delete_repo")],
      published: { kind: "names", names: new Set(["echo", "large", "slow"]) }
    });

    await test.coordinator.reconcileNow();

    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory).toEqual({
      exclusions: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "slow", reason: "missing_upstream" }
      ],
      tools: [tool("echo", "hash-echo-changed"), tool("large")],
      version: 1
    });
    // A run admitted the definition this runtime offers under the published name.
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo-changed",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
    })).resolves.toMatchObject({ structuredContent: { name: "echo" } });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-delete_repo",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "delete_repo"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    await test.coordinator.stop();
  });

  it("offers nothing and names every upstream tool when the recorded definitions do not verify", async () => {
    const test = harness({ published: { kind: "invalid" } });

    await test.coordinator.reconcileNow();

    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory).toEqual({
      exclusions: DEFAULT_TOOLS.map(({ name }) => ({ name, reason: "unpublished_addition" })),
      tools: [],
      version: 1
    });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("fails closed on an upstream inventory that repeats a tool name", async () => {
    const test = harness({
      inventory: [tool("echo"), tool("echo", "hash-echo-other")],
      published: publishedDefinitions([tool("echo")])
    });

    await test.coordinator.reconcileNow();

    expect(test.calls).toEqual(["starting", "failed:mcp_inventory_invalid"]);
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    await test.coordinator.stop();
  });

  it("allows an all-disabled runtime to stay ready with an empty effective inventory", async () => {
    const test = harness({
      inventory: [{
        definitionHash: "hash-echo",
        description: null,
        inputSchema: { type: "object" },
        name: "echo"
      }]
    });
    test.setLaunches([launch({ disabledToolNames: ["echo"], publishedTools: publishedDefinitions([tool("echo")]) })]);

    await test.coordinator.reconcileNow();

    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    expect(test.repository.markReady).toHaveBeenCalledWith(expect.objectContaining({
      inventory: { exclusions: [{ name: "echo", reason: "disabled_by_policy" }], tools: [], version: 1 }
    }));
    await test.coordinator.stop();
  });

  it("admits a new upstream tool only through a generation whose revision published it", async () => {
    const test = harness({ inventory: [tool("echo")] });
    await test.coordinator.reconcileNow();
    test.setInventory([tool("new_tool")]);
    test.listChanged();
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(2));

    expect(vi.mocked(test.repository.markReady).mock.calls[1]![0].inventory).toEqual({
      exclusions: [
        { name: "echo", reason: "missing_upstream" },
        { name: "new_tool", reason: "unpublished_addition" }
      ],
      tools: [],
      version: 1
    });
    for (const name of ["echo", "new_tool"]) {
      await expect(test.coordinator.callTool({
        definitionHash: `hash-${name}`,
        arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name
      })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    }

    // A new check publishes new_tool; its revision starts another generation in
    // this process while the previous one keeps its own fence until drained.
    test.setLaunches([launch({
      fingerprint: "fingerprint-2",
      generationId: "generation-2",
      publishedTools: publishedDefinitions([tool("new_tool")])
    })]);
    await test.coordinator.reconcileNow();

    await expect(test.coordinator.callTool({
      definitionHash: "hash-new_tool",
      arguments: {}, generationId: "generation-2", inputSchema: { type: "object" }, name: "new_tool"
    })).resolves.toMatchObject({ structuredContent: { name: "new_tool" } });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-new_tool",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "new_tool"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    expect(test.session.callTool).toHaveBeenCalledOnce();
    await test.coordinator.stop();
  });

  it("validates the complete upstream inventory before filtering disabled tools", async () => {
    const secret = "inventory-secret-value";
    const test = harness({
      inventory: [{
        definitionHash: "hash-secret",
        description: `Never expose ${secret}`,
        inputSchema: { type: "object" },
        name: "secret_tool"
      }]
    });
    test.setLaunches([launch({
      disabledToolNames: ["secret_tool"],
      redactionValues: [secret]
    })]);

    await test.coordinator.reconcileNow();

    expect(test.repository.markReady).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    await test.coordinator.stop();
  });

  it("coalesces a desired generation, marks it ready, reuses it, and routes calls", async () => {
    const test = harness();
    await test.coordinator.reconcileNow("user-1");
    await test.coordinator.reconcileNow("user-1");

    expect(test.calls).toEqual(["starting", "ready"]);
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: { text: "hello" },
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "echo"
    })).resolves.toEqual({
      isError: false,
      structuredContent: { name: "echo" },
      text: [],
      unsupportedContentTypes: []
    });
    expect(test.repository.touchLastUsed).toHaveBeenCalledWith("generation-1", now);
    await test.coordinator.stop();
  });

  it("validates arguments against the exact call snapshot before dispatch", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();

    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: { text: 42 },
      generationId: "generation-1",
      inputSchema: {
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object"
      },
      name: "echo"
    })).rejects.toMatchObject({ code: "mcp_call_arguments_invalid" });

    expect(test.session.callTool).not.toHaveBeenCalled();
    expect(test.repository.touchLastUsed).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("checks current caller authority after awaiting runtime persistence and before tool I/O", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    let allowed = true;
    vi.mocked(test.repository.touchLastUsed).mockImplementationOnce(async () => { allowed = false; });
    const beforeDispatch = vi.fn(async () => { if (!allowed) throw new Error("authority_revoked"); });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: {}, beforeDispatch, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo"
    })).rejects.toThrow("authority_revoked");
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(test.session.callTool).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await test.coordinator.stop();
  });

  it("does not dispatch when cancelled during runtime persistence", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    const controller = new AbortController();
    vi.mocked(test.repository.touchLastUsed).mockImplementationOnce(async () => { controller.abort(); });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "echo", signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("redacts exact effective secrets before returning MCP results", async () => {
    const secret = "runtime-secret-value";
    const test = harness();
    test.setLaunches([launch({ redactionValues: [secret] })]);
    vi.mocked(test.session.callTool).mockResolvedValueOnce({
      isError: false,
      structuredContent: {
        [secret]: { nested: `prefix:${secret}:suffix` },
        safe: 7
      },
      text: [`credential=${secret}`, "safe"],
      unsupportedContentTypes: []
    });
    await test.coordinator.reconcileNow();

    const result = await test.coordinator.callTool({
      definitionHash: "hash-echo",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "echo"
    });

    expect(result).toEqual({
      isError: false,
      structuredContent: {
        "[REDACTED]": { nested: "prefix:[REDACTED]:suffix" },
        safe: 7
      },
      text: ["credential=[REDACTED]", "safe"],
      unsupportedContentTypes: []
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await test.coordinator.stop();
  });

  it.each([
    { source: "static", useDynamic: false },
    { source: "oauth", useDynamic: true }
  ])("rejects an inventory that exposes an exact $source credential", async ({ useDynamic }) => {
    const secret = "inventory-secret-value";
    const test = harness({
      ...(useDynamic ? { dynamicSecrets: [secret] } : {}),
      inventoryDescription: `Never expose ${secret}`
    });
    test.setLaunches([launch({ redactionValues: useDynamic ? [] : [secret] })]);

    await test.coordinator.reconcileNow();

    expect(test.calls).toEqual(["starting", "failed:mcp_inventory_invalid"]);
    expect(test.repository.markReady).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    await test.coordinator.stop();
  });

  it("evicts a nonresponsive local workload and marks its generation for retry", async () => {
    const dispose = vi.fn(async () => undefined);
    const test = harness({ dispose });
    test.setLaunches([launch({
      toolHive: {
        cmdArguments: [],
        envVars: {},
        generationToken: "fingerprint-1",
        image: `example.test/mcp@sha256:${"a".repeat(64)}`
      }
    })]);
    vi.mocked(test.session.callTool).mockRejectedValueOnce(new McpClientSessionError({
      code: "mcp_request_timeout",
      operation: "call_tool",
      retryable: true
    }));
    await test.coordinator.reconcileNow();

    await expect(test.coordinator.callTool({
      definitionHash: "hash-slow",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "slow"
    })).rejects.toMatchObject({ code: "mcp_request_timeout" });

    expect(dispose).toHaveBeenCalledOnce();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    expect(test.repository.markFailed).toHaveBeenLastCalledWith({
      errorCode: "mcp_timeout",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
  });

  it("marks a missing generated image with an actionable stable code", async () => {
    const test = harness({
      createError: new ToolHiveClientError({
        code: "toolhive_artifact_missing",
        operation: "create_workload",
        status: 500
      })
    });

    await test.coordinator.reconcileNow();

    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_artifact_missing",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    await test.coordinator.stop();
  });

  it("does not evict a remote session when one call times out", async () => {
    const test = harness();
    vi.mocked(test.session.callTool).mockRejectedValueOnce(new McpClientSessionError({
      code: "mcp_request_timeout",
      operation: "call_tool",
      retryable: true
    }));
    await test.coordinator.reconcileNow();

    await expect(test.coordinator.callTool({
      definitionHash: "hash-slow",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "slow"
    })).rejects.toMatchObject({ code: "mcp_request_timeout" });

    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("keeps a semantic call-result limit failure live when the transport remains usable", async () => {
    const test = harness();
    vi.mocked(test.session.callTool).mockRejectedValueOnce(new McpClientSessionError({
      code: "mcp_call_result_too_large",
      operation: "call_tool"
    }));
    await test.coordinator.reconcileNow();

    await expect(test.coordinator.callTool({
      definitionHash: "hash-large",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_call_result_too_large" });

    expect(test.session.callTool).toHaveBeenCalledOnce();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it.each([
    "mcp_call_result_too_large",
    "mcp_response_too_large"
  ] as const)("evicts a closed fatal session from its explicit %s cause", async (code) => {
    const test = harness();
    vi.mocked(test.session.callTool).mockRejectedValueOnce(new McpClientSessionError({
      code: "mcp_session_closed",
      operation: "call_tool"
    }));
    await test.coordinator.reconcileNow();
    test.setFatalResponseErrorCode(code);
    test.setClosed(true);

    await expect(test.coordinator.callTool({
      definitionHash: "hash-large",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_session_closed" });

    expect(test.session.callTool).toHaveBeenCalledOnce();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: code,
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.createSession).toHaveBeenCalledOnce();
  });

  it("does not infer a transport-fatal cause from a concurrent semantic result failure", async () => {
    const test = harness();
    vi.mocked(test.session.callTool).mockImplementationOnce(async () => {
      test.setClosed(true);
      throw new McpClientSessionError({
        code: "mcp_call_result_too_large",
        operation: "call_tool"
      });
    });
    await test.coordinator.reconcileNow();

    await expect(test.coordinator.callTool({
      definitionHash: "hash-large",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_call_result_too_large" });

    expect(test.repository.markFailed).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_session_closed",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
  });

  it("preserves an out-of-band response overflow during closed-session reconciliation", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    test.setFatalResponseErrorCode("mcp_response_too_large");
    test.setClosed(true);

    await test.coordinator.reconcileNow();

    expect(test.repository.markFailed).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_response_too_large",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
  });

  it("reports a closed ToolHive session as unavailable and disposes it during reconciliation", async () => {
    const dispose = vi.fn(async () => undefined);
    const test = harness({ dispose });
    test.setLaunches([launch({
      toolHive: {
        cmdArguments: [],
        envVars: {},
        generationToken: "fingerprint-1",
        image: `example.test/mcp@sha256:${"a".repeat(64)}`
      }
    })]);
    await test.coordinator.reconcileNow();
    test.setClosed(true);

    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    await test.coordinator.reconcileNow();

    expect(dispose).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_session_closed",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.createSession).toHaveBeenCalledOnce();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
  });

  it("restores an exact accepted generation once and reuses its live session", async () => {
    const test = harness();
    test.setLaunches([]);
    vi.mocked(test.repository.loadAcceptedGeneration).mockResolvedValueOnce(launch());

    await expect(test.coordinator.ensureAcceptedGeneration("generation-1")).resolves.toBe(true);
    await expect(test.coordinator.ensureAcceptedGeneration("generation-1")).resolves.toBe(true);

    expect(test.repository.loadAcceptedGeneration).toHaveBeenCalledTimes(1);
    expect(test.repository.loadAcceptedGeneration).toHaveBeenCalledWith("generation-1", now);
    expect(test.calls).toEqual(["starting", "ready"]);
    await test.coordinator.stop();
  });

  it("restores an accepted generation with only the tools its own revision published", async () => {
    const test = harness({ inventory: [tool("echo"), tool("delete_repo")] });
    test.setLaunches([]);
    vi.mocked(test.repository.loadAcceptedGeneration).mockResolvedValueOnce(launch({
      publishedTools: publishedDefinitions([tool("echo")])
    }));

    await expect(test.coordinator.ensureAcceptedGeneration("generation-1")).resolves.toBe(true);

    expect(vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory).toEqual({
      exclusions: [{ name: "delete_repo", reason: "unpublished_addition" }],
      tools: [tool("echo")],
      version: 1
    });
    await expect(test.coordinator.callTool({
      definitionHash: "hash-delete_repo",
      arguments: {}, generationId: "generation-1", inputSchema: { type: "object" }, name: "delete_repo"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    expect(test.session.callTool).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("does not start a generation without an active accepted binding", async () => {
    const test = harness();
    test.setLaunches([]);

    await expect(test.coordinator.ensureAcceptedGeneration("generation-missing")).resolves.toBe(false);

    expect(test.repository.markStarting).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-missing")).toBe(false);
  });

  it("refreshes inventory on list_changed and closes a stale late generation", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    test.listChanged();
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(2));

    vi.mocked(test.repository.markReady).mockResolvedValueOnce(false);
    test.listChanged();
    await vi.waitFor(() => expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false));
    expect(test.session.close).toHaveBeenCalled();
  });

  it("refreshes a stale persisted inventory during send-time reconciliation", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    test.setLaunches([launch({ inventoryRefreshRequired: true })]);

    await test.coordinator.reconcileNow();

    expect(test.session.listTools).toHaveBeenCalledTimes(2);
    expect(test.repository.markReady).toHaveBeenCalledTimes(2);
    await test.coordinator.stop();
  });

  it("keeps list_changed inventory ready and serializes burst refreshes", async () => {
    const test = harness();
    const firstRefreshStarted = deferred<void>();
    const releaseFirstRefresh = deferred<void>();
    let listCount = 0;
    vi.mocked(test.session.listTools).mockImplementation(async () => {
      listCount += 1;
      if (listCount === 2) {
        firstRefreshStarted.resolve();
        await releaseFirstRefresh.promise;
      }
      return [{
        definitionHash: "hash-1",
        description: null,
        inputSchema: { type: "object" },
        name: "echo"
      }];
    });
    await test.coordinator.reconcileNow();

    test.listChanged();
    await firstRefreshStarted.promise;
    // A refresh never marks its generation starting: plan rechecks keep passing.
    expect(test.calls).toEqual(["starting", "ready"]);
    test.listChanged();
    test.listChanged();
    releaseFirstRefresh.resolve();

    await vi.waitFor(() => expect(test.session.listTools).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(3));
    expect(test.repository.markStarting).toHaveBeenCalledOnce();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await test.coordinator.stop();
  });

  it("keeps accepted calls dispatching through a slow refresh and refuses only the definition it changed", async () => {
    const test = harness({ inventory: [tool("read"), tool("write")] });
    test.setLaunches([launch({ personalRuntime: true, publishedTools: { kind: "names", names: new Set() } })]);
    await test.coordinator.reconcileNow();
    const listed = deferred<McpRuntimeInventoryTool[]>();
    vi.mocked(test.session.listTools).mockImplementationOnce(() => listed.promise);
    const call = (name: string, definitionHash = `hash-${name}`) => test.coordinator.callTool({
      arguments: {}, definitionHash, generationId: "generation-1", inputSchema: { type: "object" }, name
    });

    test.listChanged();
    await vi.waitFor(() => expect(test.session.listTools).toHaveBeenCalledTimes(2));
    // While upstream is re-listed the generation stays ready, live and dispatching.
    expect(test.calls).toEqual(["starting", "ready"]);
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await expect(call("read")).resolves.toMatchObject({ structuredContent: { name: "read" } });

    listed.resolve([tool("read"), tool("write", "hash-write-changed")]);
    await vi.waitFor(() => expect(test.coordinator.operationalStatus("generation-1")).toBe("active"));
    expect(test.calls).toEqual(["starting", "ready", "ready"]);
    await expect(call("read")).resolves.toMatchObject({ structuredContent: { name: "read" } });
    await expect(call("write")).rejects.toMatchObject({ code: "mcp_tool_definition_changed" });
    await expect(call("write", "hash-write-changed")).resolves.toMatchObject({ structuredContent: { name: "write" } });
    expect(test.session.callTool).toHaveBeenCalledTimes(3);
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    await test.coordinator.stop();
  });

  it("refuses a definition a refresh changed during the caller's last recheck before sending anything", async () => {
    const test = harness({ inventory: [tool("read"), tool("write")] });
    test.setLaunches([launch({ personalRuntime: true, publishedTools: { kind: "names", names: new Set() } })]);
    await test.coordinator.reconcileNow();
    test.setInventory([tool("read"), tool("write", "hash-write-changed")]);
    // The caller's plan recheck passed; the refresh commits before the send.
    const beforeDispatch = vi.fn(async () => {
      test.listChanged();
      await vi.waitFor(() => expect(test.coordinator.operationalStatus("generation-1")).toBe("active"));
    });

    await expect(test.coordinator.callTool({
      arguments: {}, beforeDispatch, definitionHash: "hash-write", generationId: "generation-1",
      inputSchema: { type: "object" }, name: "write"
    })).rejects.toMatchObject({ code: "mcp_tool_definition_changed" });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(test.repository.markReady).toHaveBeenCalledTimes(2);
    expect(test.session.callTool).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await expect(test.coordinator.callTool({
      arguments: {}, definitionHash: "hash-read", generationId: "generation-1", inputSchema: { type: "object" }, name: "read"
    })).resolves.toMatchObject({ structuredContent: { name: "read" } });
    await test.coordinator.stop();
  });

  it("lets one fatal owner settle a call overflow racing an inventory refresh", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    const refreshStarted = deferred<void>();
    const refreshFailure = deferred<never>();
    vi.mocked(test.session.listTools).mockImplementationOnce(async () => {
      refreshStarted.resolve();
      return refreshFailure.promise;
    });
    test.listChanged();
    await refreshStarted.promise;
    vi.mocked(test.session.callTool).mockImplementationOnce(async () => {
      test.setFatalResponseErrorCode("mcp_call_result_too_large");
      test.setClosed(true);
      refreshFailure.reject(new McpClientSessionError({
        code: "mcp_session_closed",
        operation: "list_tools"
      }));
      throw new McpClientSessionError({
        code: "mcp_call_result_too_large",
        operation: "call_tool"
      });
    });

    await expect(test.coordinator.callTool({
      definitionHash: "hash-large",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_call_result_too_large" });

    await vi.waitFor(() => expect(test.repository.markFailed).toHaveBeenCalledOnce());
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_call_result_too_large",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.session.close).toHaveBeenCalledOnce();
  });

  it("orders fatal eviction after an in-flight refresh readiness write", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    const lateReadyStarted = deferred<void>();
    const releaseLateReady = deferred<boolean>();
    vi.mocked(test.repository.markReady).mockImplementationOnce(async () => {
      lateReadyStarted.resolve();
      return releaseLateReady.promise;
    });
    test.listChanged();
    await lateReadyStarted.promise;
    vi.mocked(test.session.callTool).mockImplementationOnce(async () => {
      test.setFatalResponseErrorCode("mcp_response_too_large");
      test.setClosed(true);
      throw new McpClientSessionError({
        code: "mcp_session_closed",
        operation: "call_tool"
      });
    });
    const callFailure = expect(test.coordinator.callTool({
      definitionHash: "hash-large",
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_session_closed" });

    await vi.waitFor(() => expect(test.session.callTool).toHaveBeenCalledOnce());
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    releaseLateReady.resolve(true);
    await callFailure;

    expect(test.repository.markFailed).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_response_too_large",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
  });

  it("does not leave a late refresh ready after its live session was closed", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    const lateReadyStarted = deferred<void>();
    const releaseLateReady = deferred<boolean>();
    vi.mocked(test.repository.markReady).mockImplementationOnce(async () => {
      test.calls.push("ready");
      lateReadyStarted.resolve();
      return releaseLateReady.promise;
    });

    test.listChanged();
    await lateReadyStarted.promise;
    await test.coordinator.stop();
    releaseLateReady.resolve(true);

    await vi.waitFor(() => expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_session_closed",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    }));
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
  });

  it("persists only a stable failure code and observes retry fences", async () => {
    const failed = harness({ failList: true });
    await failed.coordinator.reconcileNow();
    expect(failed.calls).toEqual(["starting", "failed:mcp_inventory_invalid"]);

    const delayed = harness();
    delayed.setLaunches([launch({ retryAt: new Date(now.getTime() + 1_000) })]);
    await delayed.coordinator.reconcileNow();
    expect(delayed.calls).toEqual([]);
  });

  it.each([
    { code: "mcp_inventory_cursor_cycle", persisted: "mcp_inventory_cursor_cycle" },
    { code: "mcp_inventory_page_limit", persisted: "mcp_inventory_page_limit" },
    { code: "mcp_inventory_time_limit", persisted: "mcp_inventory_time_limit" },
    { code: "mcp_inventory_tool_limit", persisted: "mcp_inventory_tool_limit" },
    { code: "mcp_inventory_tool_invalid", persisted: "mcp_inventory_invalid" }
  ] as const)("persists the inventory bound $code as $persisted and stays not ready", async ({ code, persisted }) => {
    const test = harness();
    vi.mocked(test.session.listTools).mockRejectedValue(new McpClientSessionError({ code, operation: "list_tools" }));
    await test.coordinator.reconcileNow();
    expect(test.calls).toEqual(["starting", `failed:${persisted}`]);
    expect(test.repository.markReady).not.toHaveBeenCalled();
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
    await test.coordinator.stop();
  });

  it.each([
    { code: "mcp_initialize_response_too_large", operation: "initialize" },
    { code: "mcp_inventory_response_too_large", operation: "list_tools" },
    { code: "mcp_call_result_too_large", operation: "call_tool" },
    { code: "mcp_response_too_large", operation: "session" }
  ] as const)("preserves the stable runtime failure code $code", async ({ code, operation }) => {
    const test = harness({
      createError: new McpClientSessionError({
        code,
        operation
      })
    });

    await test.coordinator.reconcileNow();

    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: code,
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(false);
  });

  it("closes and deletes only generations the repository proves are drained", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    vi.mocked(test.repository.listDrainedGenerationIds).mockResolvedValueOnce(["generation-1"]);
    test.setLaunches([]);
    await test.coordinator.reconcileNow();

    expect(test.session.close).toHaveBeenCalled();
    expect(test.repository.deleteDrainedGeneration).toHaveBeenCalledWith("generation-1");
    expect(test.repository.finalizeDeletedServers).toHaveBeenCalled();
  });

  it("disposes drained local workloads and cleans only unretained owned orphans", async () => {
    const dispose = vi.fn(async () => undefined);
    const cleanupOrphans = vi.fn(async () => undefined);
    const test = harness({
      cleanupOrphans,
      dispose,
      retainedFingerprints: ["fingerprint-retained"]
    });
    await test.coordinator.reconcileNow();
    vi.mocked(test.repository.listDrainedGenerationIds).mockResolvedValueOnce(["generation-1"]);
    test.setLaunches([]);

    await test.coordinator.reconcileNow();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cleanupOrphans).toHaveBeenLastCalledWith(["fingerprint-retained"]);
  });
});
