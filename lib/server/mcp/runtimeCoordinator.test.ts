import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpClientSessionError,
  type McpFatalResponseErrorCode
} from "./clientSession";
import { ToolHiveClientError } from "./toolhiveClient";
import {
  McpRuntimeCoordinator,
  type McpRuntimeCoordinatorRepository,
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

function launch(overrides: Partial<McpRuntimeLaunch> = {}): McpRuntimeLaunch {
  return {
    callTimeoutMs: 10_000,
    fingerprint: "fingerprint-1",
    generationId: "generation-1",
    headers: {},
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
  retainedFingerprints?: string[];
} = {}) {
  const calls: string[] = [];
  let closed = false;
  let fatalResponseErrorCode: McpFatalResponseErrorCode | null = null;
  let launches = [launch()];
  let listChanged: (() => void) | null = null;
  let inventory = input.inventory ?? ["echo", "large", "slow"].map((name) => ({
    definitionHash: `hash-${name}`,
    description: input.inventoryDescription ?? null,
    inputSchema: { type: "object" },
    name
  }));
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
      return true;
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
    touchLastUsed: vi.fn(async () => undefined)
  };
  const createSession = vi.fn(async (
    options: McpRuntimeLaunch & { onToolsChanged(): void }
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
    setLaunches(value: McpRuntimeLaunch[]) { launches = value; }
  };
}

describe("MCP runtime coordinator", () => {
  afterEach(() => vi.useRealTimers());

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
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    await test.coordinator.stop();
  });

  it("publishes only enabled tools and fences disabled calls before settlement or I/O", async () => {
    const test = harness({
      inventory: ["echo", "Echo", "new_tool"].map((name) => ({
        definitionHash: `hash-${name}`,
        description: null,
        inputSchema: { type: "object" },
        name
      }))
    });
    test.setLaunches([launch({ disabledToolNames: ["Echo"] })]);

    await test.coordinator.reconcileNow();

    expect(test.repository.markReady).toHaveBeenCalledWith(expect.objectContaining({
      inventory: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "echo" }),
          expect.objectContaining({ name: "new_tool" })
        ]),
        version: 1
      }
    }));
    const readyInventory = vi.mocked(test.repository.markReady).mock.calls[0]![0].inventory;
    expect(readyInventory.tools.map((tool) => tool.name)).toEqual(["echo", "new_tool"]);

    await expect(test.coordinator.callTool({
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "Echo"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available", operation: "call_tool" });
    expect(test.repository.touchLastUsed).not.toHaveBeenCalled();
    expect(test.session.callTool).not.toHaveBeenCalled();
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
    test.setLaunches([launch({ disabledToolNames: ["echo"] })]);

    await test.coordinator.reconcileNow();

    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
    expect(test.repository.markReady).toHaveBeenCalledWith(expect.objectContaining({
      inventory: { tools: [], version: 1 }
    }));
    await test.coordinator.stop();
  });

  it("refreshes the exact enabled-name fence only with accepted inventory", async () => {
    const test = harness({
      inventory: [{
        definitionHash: "hash-echo",
        description: null,
        inputSchema: { type: "object" },
        name: "echo"
      }]
    });
    await test.coordinator.reconcileNow();
    test.setInventory([{
      definitionHash: "hash-new",
      description: null,
      inputSchema: { type: "object" },
      name: "new_tool"
    }]);
    test.listChanged();
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(2));

    await expect(test.coordinator.callTool({
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "echo"
    })).rejects.toMatchObject({ code: "mcp_tool_not_available" });
    await expect(test.coordinator.callTool({
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "new_tool"
    })).resolves.toMatchObject({ structuredContent: { name: "new_tool" } });
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
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_call_result_too_large" });

    expect(test.repository.markFailed).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_connect_failed",
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
      errorCode: "mcp_connect_failed",
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

  it("marks list_changed inventory non-ready and serializes burst refreshes", async () => {
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
    expect(test.calls).toEqual(["starting", "ready", "starting"]);
    test.listChanged();
    test.listChanged();
    releaseFirstRefresh.resolve();

    await vi.waitFor(() => expect(test.session.listTools).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(test.repository.markReady).toHaveBeenCalledTimes(3));
    expect(test.repository.markStarting).toHaveBeenCalledTimes(3);
    expect(test.coordinator.hasLiveGeneration("generation-1")).toBe(true);
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

  it("orders fatal eviction after an in-flight refresh starting write", async () => {
    const test = harness();
    await test.coordinator.reconcileNow();
    const lateStartingStarted = deferred<void>();
    const releaseLateStarting = deferred<boolean>();
    vi.mocked(test.repository.markStarting).mockImplementationOnce(async () => {
      lateStartingStarted.resolve();
      return releaseLateStarting.promise;
    });
    test.listChanged();
    await lateStartingStarted.promise;
    vi.mocked(test.session.callTool).mockImplementationOnce(async () => {
      test.setFatalResponseErrorCode("mcp_response_too_large");
      test.setClosed(true);
      throw new McpClientSessionError({
        code: "mcp_session_closed",
        operation: "call_tool"
      });
    });
    const callFailure = expect(test.coordinator.callTool({
      arguments: {},
      generationId: "generation-1",
      inputSchema: { type: "object" },
      name: "large"
    })).rejects.toMatchObject({ code: "mcp_session_closed" });

    await vi.waitFor(() => expect(test.session.callTool).toHaveBeenCalledOnce());
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    releaseLateStarting.resolve(true);
    await callFailure;

    expect(test.repository.markFailed).toHaveBeenCalledOnce();
    expect(test.repository.markFailed).toHaveBeenCalledWith({
      errorCode: "mcp_response_too_large",
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      now
    });
    expect(test.session.listTools).toHaveBeenCalledOnce();
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
      errorCode: "mcp_connect_failed",
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
