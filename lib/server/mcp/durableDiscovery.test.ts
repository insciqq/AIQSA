import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "../tools/types";
import { mergeMcpRunPlanSnapshots } from "./discovery";
import {
  executeDurableMcpDiscovery,
  McpAutoDiscoveryUnavailableError
} from "./durableDiscovery";
import type {
  McpCapabilityCatalog,
  McpDiscoveryState,
  McpRunPlanSnapshot
} from "./runPlan";

const toolIds = Array.from(
  { length: 14 },
  (_, index) => `mcp_catalog_action_${String(index).padStart(2, "0")}`
);

const catalog: McpCapabilityCatalog = {
  servers: [{
    description: "A test integration with many independent actions",
    namespace: "catalog",
    revisionId: "revision-catalog",
    serverId: "server-catalog",
    serverName: "Catalog",
    tools: toolIds.map((namespacedName, index) => ({
      arguments: [],
      description: `Perform action ${index}`,
      namespacedName,
      originalName: `action_${index}`
    }))
  }],
  version: 1
};

const request = {
  content: { blocks: [{ text: "Complete the requested action", type: "text" as const }] },
  context: { messages: [], mode: "branch_path" as const }
};

function call(id: string, goal = "perform the action"): ModelToolCall {
  return { arguments: { goal }, id, name: "find_tools" };
}

function addedSnapshot(selectedToolIds: readonly string[]): McpRunPlanSnapshot {
  if (selectedToolIds.length === 0) return { servers: [], tools: [], version: 1 };
  return {
    servers: [{
      fingerprint: "fingerprint-catalog",
      revisionId: "revision-catalog",
      serverId: "server-catalog",
      serverName: "Catalog"
    }],
    tools: selectedToolIds.map((namespacedName) => {
      const index = toolIds.indexOf(namespacedName);
      return {
        definitionHash: index.toString(16).padStart(64, "0"),
        description: `Perform action ${index}`,
        inputSchema: { type: "object" },
        name: `action_${index}`,
        namespacedName,
        originalName: `action_${index}`,
        serverId: "server-catalog",
        serverName: "Catalog"
      };
    }),
    version: 1
  };
}

function harness(activeCatalog: McpCapabilityCatalog = catalog) {
  let discovery: McpDiscoveryState = { catalog: activeCatalog, epochs: [], version: 2 };
  let snapshot: McpRunPlanSnapshot = { servers: [], tools: [], version: 1 };
  const materialize = vi.fn(async (_userId: string, tools: readonly Readonly<{
    namespacedName: string;
    revisionId: string;
    serverId: string;
  }>[]) => ({
    bindings: tools.length > 0 ? [{
      fingerprint: "fingerprint-catalog",
      runtimeGenerationId: "generation-catalog",
      serverId: "server-catalog"
    }] : [],
    ok: true as const,
    snapshot: addedSnapshot(tools.map((tool) => tool.namespacedName))
  }));
  const appendEpoch = vi.fn(async (input: Parameters<
    typeof executeDurableMcpDiscovery
  >[0] extends { appendEpoch: infer T } ? T extends (...args: infer A) => unknown ? A[0] : never : never) => {
    const replay = discovery.epochs.find((epoch) =>
      epoch.modelRunToolCallId === input.modelRunToolCallId
    );
    if (!replay) {
      snapshot = mergeMcpRunPlanSnapshots(snapshot, input.snapshot);
      discovery = {
        ...discovery,
        epochs: [...discovery.epochs, {
          epoch: discovery.epochs.length + 1,
          goal: input.goal,
          modelRunToolCallId: input.modelRunToolCallId,
          roundIndex: input.roundIndex,
          toolIds: [...input.toolIds]
        }]
      };
    }
    return { discovery, snapshot };
  });
  return {
    appendEpoch,
    discovery: () => discovery,
    materialize,
    snapshot: () => snapshot
  };
}

describe("durable MCP discovery", () => {
  it("keys epochs by persisted tool-call ID and replays without rerouting", async () => {
    const state = harness();
    const route = vi.fn()
      .mockResolvedValueOnce({ toolNames: [toolIds[0]], usageAttribution: null })
      .mockResolvedValueOnce({ toolNames: [toolIds[1]], usageAttribution: null });
    const execute = (modelRunToolCallId: string, providerCallId: string) =>
      executeDurableMcpDiscovery({
        activeDiscovery: state.discovery(),
        activeSnapshot: state.snapshot(),
        appendEpoch: state.appendEpoch,
        call: call(providerCallId, "same goal"),
        materialize: state.materialize,
        modelRunToolCallId,
        request,
        roundIndex: 0,
        router: { route },
        runId: "run-1",
        userId: "user-1"
      });

    await execute("persisted-call-a", "provider-call-a");
    await execute("persisted-call-b", "provider-call-b");
    const replay = await execute("persisted-call-a", "provider-call-a-replayed");

    expect(route).toHaveBeenCalledTimes(2);
    expect(state.materialize).toHaveBeenCalledTimes(2);
    expect(state.discovery().epochs.map((epoch) => epoch.modelRunToolCallId)).toEqual([
      "persisted-call-a",
      "persisted-call-b"
    ]);
    expect(replay.toolResult.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining(toolIds[0]!) })
    ]);
  });

  it("checkpoints an empty selection and replays it without the router or materializer", async () => {
    const state = harness();
    const route = vi.fn(async () => ({ toolNames: [], usageAttribution: null }));
    const input = () => ({
      activeDiscovery: state.discovery(),
      activeSnapshot: state.snapshot(),
      appendEpoch: state.appendEpoch,
      call: call("provider-empty", "no external action needed"),
      materialize: state.materialize,
      modelRunToolCallId: "persisted-empty",
      request,
      roundIndex: 2,
      router: { route },
      runId: "run-1",
      userId: "user-1"
    });

    await executeDurableMcpDiscovery(input());
    await executeDurableMcpDiscovery(input());

    expect(route).toHaveBeenCalledOnce();
    expect(state.materialize).not.toHaveBeenCalled();
    expect(state.appendEpoch).toHaveBeenCalledOnce();
    expect(state.discovery().epochs).toEqual([expect.objectContaining({
      modelRunToolCallId: "persisted-empty",
      toolIds: []
    })]);
  });

  it("materializes a relevant tool without depending on an unrelated broken server", async () => {
    const brokenToolId = "mcp_broken_irrelevant_action";
    const state = harness({
      servers: [...catalog.servers, {
        description: "An unavailable integration irrelevant to this goal",
        namespace: "broken",
        revisionId: "revision-broken",
        serverId: "server-broken",
        serverName: "Broken integration",
        tools: [{
          arguments: [],
          description: "Perform an unrelated action",
          namespacedName: brokenToolId,
          originalName: "unrelated_action"
        }]
      }],
      version: 1
    });
    const route = vi.fn(async () => ({
      toolNames: [toolIds[0]!],
      usageAttribution: null
    }));

    await expect(executeDurableMcpDiscovery({
      activeDiscovery: state.discovery(),
      activeSnapshot: state.snapshot(),
      appendEpoch: state.appendEpoch,
      call: call("provider-relevant"),
      materialize: state.materialize,
      modelRunToolCallId: "persisted-relevant",
      request,
      roundIndex: 0,
      router: { route },
      runId: "run-1",
      userId: "user-1"
    })).resolves.toMatchObject({
      snapshot: { tools: [{ namespacedName: toolIds[0] }] }
    });
    expect(state.materialize).toHaveBeenCalledWith("user-1", [{
      namespacedName: toolIds[0],
      revisionId: "revision-catalog",
      serverId: "server-catalog"
    }]);
    expect(JSON.stringify(state.materialize.mock.calls)).not.toContain(brokenToolId);
  });

  it("accumulates more than twelve tools under the general MCP run-plan limit", async () => {
    const state = harness();
    let selectionIndex = 0;
    const route = vi.fn(async () => ({
      toolNames: [toolIds[selectionIndex++]!],
      usageAttribution: null
    }));

    for (let index = 0; index < 13; index += 1) {
      await executeDurableMcpDiscovery({
        activeDiscovery: state.discovery(),
        activeSnapshot: state.snapshot(),
        appendEpoch: state.appendEpoch,
        call: call(`provider-${index}`),
        materialize: state.materialize,
        modelRunToolCallId: `persisted-${index}`,
        request,
        roundIndex: index,
        router: { route },
        runId: "run-1",
        userId: "user-1"
      });
    }

    expect(state.snapshot().tools).toHaveLength(13);
    expect(state.discovery().epochs).toHaveLength(13);
  });

  it("maps router failures to one safe public error", async () => {
    const state = harness();
    const rawFailure = "upstream-secret-endpoint-failed";

    await expect(executeDurableMcpDiscovery({
      activeDiscovery: state.discovery(),
      activeSnapshot: state.snapshot(),
      appendEpoch: state.appendEpoch,
      call: call("provider-failure"),
      materialize: state.materialize,
      modelRunToolCallId: "persisted-failure",
      request,
      roundIndex: 0,
      router: { route: async () => { throw new Error(rawFailure); } },
      runId: "run-1",
      userId: "user-1"
    })).rejects.toMatchObject({
      code: "mcp_auto_discovery_unavailable",
      internalReason: "mcp_router_request_failed",
      message: "Automatic tool discovery is unavailable."
    } satisfies Partial<McpAutoDiscoveryUnavailableError>);
  });

  it("treats a selected tool that is not ready as a fatal discovery failure", async () => {
    const state = harness();
    const materialize = vi.fn(async () => ({
      code: "mcp_not_ready" as const,
      issues: [{ errorCode: "private-runtime-detail", name: "Catalog", readiness: "unavailable" as const }],
      ok: false as const
    }));

    await expect(executeDurableMcpDiscovery({
      activeDiscovery: state.discovery(),
      activeSnapshot: state.snapshot(),
      appendEpoch: state.appendEpoch,
      call: call("provider-materialization-failure"),
      materialize,
      modelRunToolCallId: "persisted-materialization-failure",
      request,
      roundIndex: 0,
      router: {
        route: async () => ({ toolNames: [toolIds[0]!], usageAttribution: null })
      },
      runId: "run-1",
      userId: "user-1"
    })).rejects.toMatchObject({
      code: "mcp_auto_discovery_unavailable",
      internalReason: "mcp_materialization_mcp_not_ready",
      message: "Automatic tool discovery is unavailable."
    } satisfies Partial<McpAutoDiscoveryUnavailableError>);

    expect(materialize).toHaveBeenCalledOnce();
    expect(state.appendEpoch).not.toHaveBeenCalled();
    expect(state.discovery().epochs).toEqual([]);
  });

  it("redacts unexpected materialization errors and does not checkpoint them", async () => {
    const state = harness();
    const rawFailure = "PRIVATE_TOOLHIVE_ENDPOINT_FAILURE";

    let failure: unknown;
    try {
      await executeDurableMcpDiscovery({
        activeDiscovery: state.discovery(),
        activeSnapshot: state.snapshot(),
        appendEpoch: state.appendEpoch,
        call: call("provider-materialization-exception"),
        materialize: async () => { throw new Error(rawFailure); },
        modelRunToolCallId: "persisted-materialization-exception",
        request,
        roundIndex: 0,
        router: {
          route: async () => ({ toolNames: [toolIds[0]!], usageAttribution: null })
        },
        runId: "run-1",
        userId: "user-1"
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "mcp_auto_discovery_unavailable",
      internalReason: "mcp_materialization_failed",
      message: "Automatic tool discovery is unavailable."
    } satisfies Partial<McpAutoDiscoveryUnavailableError>);
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(rawFailure);
    expect(state.appendEpoch).not.toHaveBeenCalled();
  });
});
