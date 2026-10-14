const allowMcpTools: import("./toolAccess").McpToolAccessFilter = async (_userId, tools) => [...tools];
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "../tools/types";
import { mergeMcpRunPlanSnapshots } from "./discovery";
import {
  executeDurableMcpDiscovery,
  McpAutoDiscoveryUnavailableError
} from "./durableDiscovery";
import { searchMcpCatalog } from "./toolSearch";
import type {
  McpCapabilityCatalog,
  McpDiscoveryState,
  McpRunPlanResult,
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

vi.mock("./toolSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toolSearch")>();
  return { ...actual, searchMcpCatalog: vi.fn(actual.searchMcpCatalog) };
});

beforeEach(() => { vi.mocked(searchMcpCatalog).mockClear(); });

function call(id: string, query = "select:action_0"): ModelToolCall {
  return { arguments: { query }, id, name: "find_tools" };
}

const text = (result: Awaited<ReturnType<typeof executeDurableMcpDiscovery>>) =>
  (result.toolResult.content[0] as { text: string }).text;

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
          toolIds: [...input.toolIds],
          ...(input.unavailable?.length ? { unavailable: [...input.unavailable] } : {})
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
  const base = (state: ReturnType<typeof harness>) => ({
    filterTools: allowMcpTools,
    activeDiscovery: state.discovery(),
    activeSnapshot: state.snapshot(),
    appendEpoch: state.appendEpoch,
    materialize: state.materialize,
    roundIndex: 0,
    runId: "run-1",
    userId: "user-1"
  });

  it("filters current rights from an old discovery catalog and replays without searching", async () => {
    const state = harness();
    let granted = true;
    const filterTools: import("./toolAccess").McpToolAccessFilter = async (_userId, tools) => tools.filter(() => granted);
    const input = () => ({ ...base(state), filterTools, call: call("current-access"), modelRunToolCallId: "access-call" });
    const initial = await executeDurableMcpDiscovery(input());
    expect(text(initial)).toContain(toolIds[0]);
    const saved = structuredClone(state.snapshot());
    granted = false;
    const replay = await executeDurableMcpDiscovery(input());
    expect(text(replay)).not.toContain(toolIds[0]);
    expect(replay.snapshot).toEqual(saved);
    expect(searchMcpCatalog).toHaveBeenCalledOnce();
    expect(state.materialize).toHaveBeenCalledOnce();
    // Without current access the search sees no candidates and loads nothing.
    const next = await executeDurableMcpDiscovery({ ...input(), call: call("next-access"), modelRunToolCallId: "next-call" });
    expect(text(next)).toContain("No enabled MCP tool matched this query");
    expect(state.materialize).toHaveBeenCalledOnce();
  });

  it("stores the query in the epoch and accepts a legacy goal call", async () => {
    const state = harness();
    await executeDurableMcpDiscovery({ ...base(state), call: { arguments: { goal: " select:action_2 " }, id: "legacy",
      name: "find_tools" }, modelRunToolCallId: "persisted-legacy" });
    expect(state.discovery().epochs).toEqual([{ epoch: 1, goal: "select:action_2", modelRunToolCallId: "persisted-legacy",
      roundIndex: 0, toolIds: [toolIds[2]] }]);
  });

  it("lists already-active matches in rank order without materializing them again", async () => {
    const state = harness();
    await executeDurableMcpDiscovery({ ...base(state), call: call("first"), modelRunToolCallId: "persisted-first" });
    const second = await executeDurableMcpDiscovery({ ...base(state), call: call("second", "select:action_1, action_0, nope"),
      modelRunToolCallId: "persisted-second" });
    expect(state.materialize).toHaveBeenLastCalledWith("user-1", [expect.objectContaining({ namespacedName: toolIds[1] })], undefined);
    expect(state.discovery().epochs[1]).toMatchObject({ toolIds: [toolIds[1], toolIds[0]] });
    expect(text(second)).toContain(`Loaded 1 MCP tool for the next step:\n- ${toolIds[1]} (Catalog)`);
    expect(text(second)).toContain(`Already available (no need to load again):\n- ${toolIds[0]} (Catalog)`);
    expect(text(second)).toContain('["nope"]');
    // Replay derives the same split from earlier epochs, without searching.
    const replay = await executeDurableMcpDiscovery({ ...base(state), call: call("second", "select:action_1, action_0, nope"),
      modelRunToolCallId: "persisted-second" });
    expect(text(replay)).toContain(`Already available (no need to load again):\n- ${toolIds[0]} (Catalog)`);
    expect(searchMcpCatalog).toHaveBeenCalledTimes(2);
  });

  it("limits keyword results to the per-call budget", async () => {
    const state = harness();
    await executeDurableMcpDiscovery({ ...base(state), call: call("keywords", "perform action"),
      maxResults: 3, modelRunToolCallId: "persisted-keywords" });
    expect(state.discovery().epochs[0]!.toolIds).toHaveLength(3);
    expect(state.snapshot().tools).toHaveLength(3);
  });

  it("keys epochs by persisted tool-call ID and replays legacy coalesced epochs per call", async () => {
    const state = harness();
    await executeDurableMcpDiscovery({ ...base(state), call: call("provider-a"), modelRunToolCallId: "persisted-a" });
    // A coalesced batch persisted one shared selection for every call of the batch.
    const legacy = { ...state.discovery(), epochs: [...state.discovery().epochs, {
      epoch: 2, goal: "perform the action", modelRunToolCallId: "persisted-b", roundIndex: 0, toolIds: [toolIds[0]!]
    }] };
    const replay = await executeDurableMcpDiscovery({ ...base(state), activeDiscovery: legacy,
      call: { arguments: { goal: "perform the action" }, id: "provider-b", name: "find_tools" },
      modelRunToolCallId: "persisted-b" });
    expect(text(replay)).toContain(`Already available (no need to load again):\n- ${toolIds[0]}`);
    await expect(executeDurableMcpDiscovery({ ...base(state), activeDiscovery: legacy, call: call("provider-b", "other"),
      modelRunToolCallId: "persisted-b" })).rejects.toThrow("mcp_discovery_checkpoint_conflict");
    expect(searchMcpCatalog).toHaveBeenCalledOnce();
    expect(state.materialize).toHaveBeenCalledOnce();
  });

  it("checkpoints an empty selection and replays it without searching or materializing", async () => {
    const state = harness();
    const input = () => ({ ...base(state), call: call("provider-empty", "unrelated weather"),
      modelRunToolCallId: "persisted-empty", roundIndex: 2 });
    await executeDurableMcpDiscovery(input());
    await executeDurableMcpDiscovery(input());
    expect(searchMcpCatalog).toHaveBeenCalledOnce();
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
    await expect(executeDurableMcpDiscovery({ ...base(state), call: call("provider-relevant"),
      modelRunToolCallId: "persisted-relevant" })).resolves.toMatchObject({
      snapshot: { tools: [{ namespacedName: toolIds[0] }] }
    });
    expect(state.materialize).toHaveBeenCalledWith("user-1", [{
      namespacedName: toolIds[0],
      revisionId: "revision-catalog",
      serverId: "server-catalog"
    }], undefined);
    expect(JSON.stringify(state.materialize.mock.calls)).not.toContain(brokenToolId);
  });

  it("accumulates more than twelve tools under the general MCP run-plan limit", async () => {
    const state = harness();
    for (let index = 0; index < 13; index += 1) {
      await executeDurableMcpDiscovery({ ...base(state), call: call(`provider-${index}`, `select:action_${index}`),
        modelRunToolCallId: `persisted-${index}`, roundIndex: index });
    }
    expect(state.snapshot().tools).toHaveLength(13);
    expect(state.discovery().epochs).toHaveLength(13);
  });

  it("rethrows cancellation without a checkpoint", async () => {
    const state = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(executeDurableMcpDiscovery({ ...base(state), call: call("cancelled"),
      modelRunToolCallId: "persisted-cancelled", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(state.appendEpoch).not.toHaveBeenCalled();
  });

  it("rejects malformed arguments before searching", async () => {
    const state = harness();
    await expect(executeDurableMcpDiscovery({ ...base(state), call: { arguments: { query: "x", goal: "x" }, id: "bad",
      name: "find_tools" }, modelRunToolCallId: "persisted-bad" })).rejects.toThrow("mcp_discovery_arguments_invalid");
    expect(searchMcpCatalog).not.toHaveBeenCalled();
  });

  it("checkpoints a selected server that is not ready as unavailable and still answers", async () => {
    const state = harness();
    const materialize = vi.fn(async () => ({
      code: "mcp_not_ready" as const,
      issues: [{ errorCode: "PRIVATE_RUNTIME_DETAIL", name: "Catalog", readiness: "unavailable" as const }],
      ok: false as const
    }));
    const input = () => ({ ...base(state), call: call("provider-not-ready"), materialize,
      modelRunToolCallId: "persisted-not-ready" });
    const result = await executeDurableMcpDiscovery(input());
    expect(result.toolResult.status).toBe("complete");
    expect(state.discovery().epochs).toEqual([{ epoch: 1, goal: "select:action_0", modelRunToolCallId: "persisted-not-ready",
      roundIndex: 0, toolIds: [], unavailable: [{ reason: "mcp_server_unavailable", serverId: "server-catalog" }] }]);
    expect(state.appendEpoch).toHaveBeenCalledWith(expect.objectContaining({
      bindings: [], snapshot: { servers: [], tools: [], version: 1 }, toolIds: []
    }));
    expect(text(result)).toBe("Unavailable now (their matching tools were not loaded):\n" +
      "- Catalog: Unavailable right now. Try again later or check it in MCP settings.\n" +
      "Do not guess what those tools would return. Tell the user briefly which service was unavailable and what to do.");
    expect(text(result)).not.toContain("PRIVATE_RUNTIME_DETAIL");
    // Recovery replays the checkpoint without searching or calling the server again.
    const replay = await executeDurableMcpDiscovery(input());
    expect(text(replay)).toBe(text(result));
    expect(materialize).toHaveBeenCalledOnce();
    expect(searchMcpCatalog).toHaveBeenCalledOnce();
  });

  it("loads an available server's tools beside an unavailable one, each reason named once", async () => {
    const other = (name: string) => ({
      description: `${name} integration`, namespace: name.toLowerCase(), revisionId: `revision-${name}`,
      serverId: `server-${name}`, serverName: name,
      tools: [{ arguments: [], description: `Perform action in ${name}`, namespacedName: `mcp_${name.toLowerCase()}_action`,
        originalName: "action" }]
    });
    const multi: McpCapabilityCatalog = { servers: [...catalog.servers, other("Gitlab"), other("Kaiten"), other("Tracker")],
      version: 1 };
    const state = harness(multi);
    const issues: Record<string, Extract<McpRunPlanResult, { ok: false }>["issues"][number]> = {
      "server-Gitlab": { errorCode: null, name: "Gitlab", readiness: "queued", signInRequired: true },
      "server-Kaiten": { errorCode: "mcp_authorization_required", name: "Kaiten", personalCredentialRejected: true,
        readiness: "unavailable" },
      "server-Tracker": { errorCode: "mcp_initialize_failed", name: "Tracker", readiness: "unavailable" }
    };
    const materialize = vi.fn(async (userId: string, tools: readonly Readonly<{
      namespacedName: string; revisionId: string; serverId: string;
    }>[]): Promise<McpRunPlanResult> => {
      const issue = issues[tools[0]!.serverId];
      return issue ? { code: "mcp_not_ready", issues: [issue], ok: false } : state.materialize(userId, tools);
    });
    const query = `select:mcp_gitlab_action, action_0, mcp_kaiten_action, action_1, mcp_tracker_action`;
    const input = () => ({ ...base(state), call: call("provider-mixed", query), materialize,
      modelRunToolCallId: "persisted-mixed" });
    const result = await executeDurableMcpDiscovery(input());

    // One materialization per server; the available one's two tools load together.
    expect(materialize.mock.calls.map(([, tools]) => tools.map((tool) => tool.namespacedName))).toEqual([
      ["mcp_gitlab_action"], [toolIds[0], toolIds[1]], ["mcp_kaiten_action"], ["mcp_tracker_action"]
    ]);
    expect(result.snapshot.tools.map((tool) => tool.namespacedName)).toEqual([toolIds[0], toolIds[1]]);
    expect(state.appendEpoch).toHaveBeenCalledWith(expect.objectContaining({
      bindings: [expect.objectContaining({ serverId: "server-catalog" })],
      toolIds: [toolIds[0], toolIds[1]],
      unavailable: [
        { reason: "mcp_reauthorization_required", serverId: "server-Gitlab" },
        { reason: "mcp_personal_credential_rejected", serverId: "server-Kaiten" },
        { reason: "mcp_server_unavailable", serverId: "server-Tracker" }
      ]
    }));
    expect(text(result)).toBe([
      "Loaded 2 MCP tools for the next step:",
      `- ${toolIds[0]} (Catalog): Perform action 0`,
      `- ${toolIds[1]} (Catalog): Perform action 1`,
      "Unavailable now (their matching tools were not loaded):",
      "- Gitlab: Sign-in needed. Reconnect it in MCP settings.",
      "- Kaiten: Credential rejected. Update the personal value or reconnect it in MCP settings.",
      "- Tracker: Unavailable right now. Try again later or check it in MCP settings.",
      "Do not guess what those tools would return. Tell the user briefly which service was unavailable and what to do."
    ].join("\n"));
    expect(text(result)).not.toContain("mcp_gitlab_action");

    // A crash after the checkpoint replays both sets without calling any server again.
    const replay = await executeDurableMcpDiscovery({ ...input(), activeDiscovery: state.discovery(), activeSnapshot: state.snapshot() });
    expect(text(replay)).toBe(text(result));
    expect(replay.snapshot).toEqual(result.snapshot);
    expect(materialize).toHaveBeenCalledTimes(4);
    expect(state.appendEpoch).toHaveBeenCalledOnce();
  });

  it("keeps a single available server's epoch and result exactly as before", async () => {
    const state = harness();
    const result = await executeDurableMcpDiscovery({ ...base(state), call: call("single"), modelRunToolCallId: "persisted-single" });
    expect(state.appendEpoch.mock.calls[0]![0]).not.toHaveProperty("unavailable");
    expect(state.discovery().epochs[0]).not.toHaveProperty("unavailable");
    expect(text(result)).toBe(`Loaded 1 MCP tool for the next step:\n- ${toolIds[0]} (Catalog): Perform action 0`);
  });

  it("redacts unexpected materialization errors and does not checkpoint them", async () => {
    const state = harness();
    const rawFailure = "PRIVATE_RUNTIME_ENDPOINT_FAILURE";
    let failure: unknown;
    try {
      await executeDurableMcpDiscovery({ ...base(state), call: call("provider-materialization-exception"),
        materialize: async () => { throw new Error(rawFailure); },
        modelRunToolCallId: "persisted-materialization-exception" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "mcp_auto_discovery_materialization_failed",
      internalReason: "mcp_materialization_failed",
      message: expect.stringContaining("could not activate")
    } satisfies Partial<McpAutoDiscoveryUnavailableError>);
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(rawFailure);
    expect(state.appendEpoch).not.toHaveBeenCalled();
  });
});
