// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { McpCapabilityCatalog, McpRunPlanResult, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { McpToolAccessFilter } from "../mcp/toolAccess";
import { WORKSPACE_CODE_INVOCATION_HEADER } from "./codeMcp";
import { handleWorkspaceCodeMcpRequest, WORKSPACE_CODE_ERROR_META, type WorkspaceCodeMcpDependencies } from "./codeMcpGateway";
import { WorkspaceCodeAccessError, type WorkspaceCodeGatewayGrant, type WorkspaceCodeGatewayStore } from "./codeMcpStore";

const invocationId = "a".repeat(32);
const tokenHash = "1".repeat(64);
const fingerprint = "f".repeat(64);
const definitionHash = "d".repeat(64);
const commits = "mcp_gitlab_list_commits_0000000000";
const jobLog = "mcp_gitlab_get_job_log_1111111111";
const inputSchema = { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false };

function planTool(namespacedName: string, originalName: string, serverId = "server-gitlab", serverName = "GitLab") {
  return { definitionHash, description: `GitLab ${originalName}`, inputSchema, name: originalName, namespacedName,
    originalName, serverId, serverName };
}

function snapshotOf(tools: ReturnType<typeof planTool>[]): McpRunPlanSnapshot {
  const servers = [...new Map(tools.map((tool) => [tool.serverId, { fingerprint, revisionId: `${tool.serverId}-rev`,
    serverId: tool.serverId, serverName: tool.serverName }])).values()];
  return { servers, tools, version: 1 };
}

const plan = snapshotOf([planTool(commits, "list_commits"), planTool(jobLog, "get_job_log")]);
const catalog: McpCapabilityCatalog = { version: 1, servers: [{ description: "", namespace: "gitlab", revisionId: "server-gitlab-rev",
  serverId: "server-gitlab", serverName: "GitLab", tools: [
    { arguments: [{ description: "Project path", name: "project", types: ["string"] }], description: "List commits",
      namespacedName: commits, originalName: "list_commits" },
    { description: "Job log", namespacedName: jobLog, originalName: "get_job_log" }
  ] }] };

const budgets = { version: 1, maxCalls: 3, maxConcurrent: 4, maxPerSecond: 10 } as const;

function grantOf(overrides: Partial<WorkspaceCodeGatewayGrant> = {}): WorkspaceCodeGatewayGrant {
  return { authority: { kind: "plan", snapshot: plan }, budgets, chatId: "chat-1", runId: "run-1", sessionId: "session-1",
    tokenHash, userId: "user-1", ...overrides };
}

function memoryStore(grant: WorkspaceCodeGatewayGrant) {
  const invocations = new Map([[invocationId, "open"]]);
  const receipts: Array<Record<string, unknown>> = [];
  const state = { refused: 0, revoked: false };
  const store: WorkspaceCodeGatewayStore = {
    async load(hash) { return !state.revoked && hash === grant.tokenHash ? grant : null; },
    async assertActive(_grant, id) {
      if (state.revoked) throw new WorkspaceCodeAccessError("authority");
      if (invocations.get(id) !== "open") throw new WorkspaceCodeAccessError("invocation");
    },
    async claim(input) {
      if (state.revoked) return { kind: "refused", code: "code_token_revoked" };
      if (invocations.get(input.invocationId) !== "open") return { kind: "refused", code: "code_invocation_closed" };
      if (receipts.length >= input.grant.budgets.maxCalls) {
        state.refused += 1;
        return { kind: "refused", code: "code_mcp_call_limit" };
      }
      if (receipts.filter((receipt) => receipt.state === "dispatching").length >= input.grant.budgets.maxConcurrent) {
        return { kind: "refused", code: "code_mcp_busy" };
      }
      const id = `receipt-${receipts.length}`;
      receipts.push({ argumentHash: input.argumentHash, id, invocationId: input.invocationId, sequence: receipts.length,
        serverId: input.serverId, state: "dispatching", toolName: input.toolName });
      return { kind: "claimed", id, sequence: receipts.length - 1 };
    },
    async settle(input) {
      const receipt = receipts.find((candidate) => candidate.id === input.id);
      if (receipt?.state === "dispatching") Object.assign(receipt, { durationMs: input.durationMs, errorCode: input.errorCode,
        resultBytes: input.resultBytes, state: input.state });
    }
  };
  return { invocations, receipts, state, store };
}

function ready(snapshot: McpRunPlanSnapshot, names: readonly string[]): McpRunPlanResult {
  const tools = snapshot.tools.filter((tool) => names.includes(tool.namespacedName));
  const servers = snapshot.servers.filter((server) => tools.some((tool) => tool.serverId === server.serverId));
  return { bindings: servers.map((server) => ({ fingerprint: server.fingerprint, runtimeGenerationId: `${server.serverId}-generation`,
    serverId: server.serverId })), ok: true, snapshot: { servers, tools, version: 1 } };
}

function dependencies(store: WorkspaceCodeGatewayStore, current: McpRunPlanSnapshot = plan, overrides: Partial<WorkspaceCodeMcpDependencies> = {}) {
  const resolve = async (_userId: string, tools: readonly { namespacedName: string }[]) =>
    ready(current, tools.map((tool) => tool.namespacedName));
  const callRuntimeTool = vi.fn(async (input: Parameters<WorkspaceCodeMcpDependencies["callRuntimeTool"]>[0]) => {
    await input.beforeDispatch();
    return { isError: false, structuredContent: { commits: ["c-secret-result-1"] }, text: ["result text c-secret-result-1"],
      unsupportedContentTypes: [] };
  });
  return {
    callRuntimeTool,
    filterTools: vi.fn(async (_userId: string, tools: readonly unknown[]) => [...tools]) as unknown as McpToolAccessFilter,
    inspect: vi.fn(resolve),
    materialize: vi.fn(resolve),
    store,
    ...overrides
  } satisfies WorkspaceCodeMcpDependencies;
}

function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string | null> = {}) {
  const base: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json",
    [WORKSPACE_CODE_INVOCATION_HEADER]: invocationId };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  return new Request("http://app.invalid/api/internal/agent/mcp", { method: "POST", headers: base,
    body: JSON.stringify({ jsonrpc: "2.0", id: "request-1", method, params }) });
}

async function rpcBody(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : text);
}

const call = (name: string, args: Record<string, unknown>) => rpc("tools/call", { arguments: args, name });

describe("Workspace code MCP gateway", () => {
  it("lists exactly the run's frozen MCP authority, as current tool access allows", async () => {
    const memory = memoryStore(grantOf());
    const deps = dependencies(memory.store, plan, {
      filterTools: (async (_userId: string, tools: readonly { namespacedName?: string }[]) =>
        tools.filter((tool) => tool.namespacedName !== jobLog)) as McpToolAccessFilter
    });
    const listed = await rpcBody(await handleWorkspaceCodeMcpRequest(rpc("tools/list", {}), tokenHash, deps));
    expect(listed.result.tools).toEqual([expect.objectContaining({ _meta: { "aiqsa/server": "GitLab", "aiqsa/tool": "list_commits" },
      inputSchema, name: commits, title: "list_commits" })]);
    expect(memory.receipts).toEqual([]);
    expect(deps.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("dispatches by exact name through the shared pipeline and keeps only a content-free receipt", async () => {
    const memory = memoryStore(grantOf());
    const deps = dependencies(memory.store);
    const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "group/c-secret-argument" }), tokenHash, deps));
    expect(body.result).toEqual({ content: [{ text: "result text c-secret-result-1", type: "text" }],
      structuredContent: { commits: ["c-secret-result-1"] } });
    expect(deps.callRuntimeTool).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.callRuntimeTool).mock.calls[0]![0]).toMatchObject({ arguments: { project: "group/c-secret-argument" },
      definitionHash, generationId: "server-gitlab-generation", name: "list_commits" });
    expect(memory.receipts).toEqual([{ argumentHash: expect.stringMatching(/^[a-f0-9]{64}$/u), durationMs: expect.any(Number),
      errorCode: null, id: "receipt-0", invocationId, resultBytes: expect.any(Number), sequence: 0, serverId: "server-gitlab",
      state: "complete", toolName: commits }]);
    expect(JSON.stringify(memory.receipts)).not.toMatch(/c-secret-(argument|result)/u);
    expect(deps.filterTools).toHaveBeenCalledWith("user-1", expect.any(Array));
  });

  it("refuses names outside the run's authority before any receipt or dispatch", async () => {
    const memory = memoryStore(grantOf());
    const deps = dependencies(memory.store);
    const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call("mcp_personal_notes_2222222222", {}), tokenHash, deps));
    expect(body.error).toMatchObject({ code: -32602 });
    expect(memory.receipts).toEqual([]);
    expect(deps.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("returns typed budget refusals without dispatch and keeps the run going", async () => {
    const memory = memoryStore(grantOf({ budgets: { ...budgets, maxCalls: 1 } }));
    const deps = dependencies(memory.store);
    await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps);
    const refused = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "b" }), tokenHash, deps));
    expect(refused.result).toMatchObject({ isError: true, _meta: { [WORKSPACE_CODE_ERROR_META]: true },
      structuredContent: { code: "code_mcp_call_limit", dispatched: false } });
    expect(deps.callRuntimeTool).toHaveBeenCalledOnce();
    expect(memory.state.refused).toBe(1);
    // Concurrency: a receipt still dispatching occupies the only slot.
    const busy = memoryStore(grantOf({ budgets: { ...budgets, maxConcurrent: 1 } }));
    busy.receipts.push({ id: "in-flight", state: "dispatching" });
    const busyBody = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "c" }), tokenHash, dependencies(busy.store)));
    expect(busyBody.result.structuredContent).toMatchObject({ code: "code_mcp_busy", dispatched: false });
  });

  it("requires an open invocation of the bearer's run and a live bearer", async () => {
    const memory = memoryStore(grantOf());
    const deps = dependencies(memory.store);
    for (const header of [null, "not-an-invocation", "A".repeat(32)]) {
      const response = await handleWorkspaceCodeMcpRequest(rpc("tools/list", {}, { [WORKSPACE_CODE_INVOCATION_HEADER]: header }), tokenHash, deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "code_invocation_required" });
    }
    memory.invocations.set(invocationId, "closed");
    expect((await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps)).status).toBe(403);
    memory.invocations.set(invocationId, "open");
    memory.state.revoked = true;
    const revoked = await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "agent_authorization_required" });
    expect(deps.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("refuses a definition or configuration changed since admission without sending it", async () => {
    const memory = memoryStore(grantOf());
    const changed = snapshotOf([{ ...planTool(commits, "list_commits"), definitionHash: "e".repeat(64) }]);
    const deps = dependencies(memory.store, changed);
    const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
    expect(body.result.structuredContent).toMatchObject({ code: "tool_definition_changed", dispatched: false });
    expect(memory.receipts[0]).toMatchObject({ errorCode: "tool_definition_changed", state: "error" });
    expect(deps.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("records a dispatched call with a lost outcome as unknown and never retries it", async () => {
    const memory = memoryStore(grantOf());
    const callRuntimeTool = vi.fn(async (input: Parameters<WorkspaceCodeMcpDependencies["callRuntimeTool"]>[0]) => {
      await input.beforeDispatch();
      throw new Error("transport lost");
    });
    const deps = dependencies(memory.store, plan, { callRuntimeTool });
    const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
    expect(body.result.structuredContent).toMatchObject({ code: "execution_outcome_unknown", dispatched: true });
    expect(memory.receipts[0]).toMatchObject({ errorCode: "execution_outcome_unknown", state: "unknown" });
    expect(callRuntimeTool).toHaveBeenCalledOnce();
  });

  it("names a source that needs the user to sign in, with the input schema for invalid arguments", async () => {
    const memory = memoryStore(grantOf());
    const notReady: McpRunPlanResult = { code: "mcp_not_ready", issues: [{ errorCode: null, name: "GitLab",
      readiness: "reauthorization_required" }], ok: false };
    const deps = dependencies(memory.store, plan, {
      inspect: vi.fn(async () => notReady), materialize: vi.fn(async () => notReady)
    });
    const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
    expect(body.result.structuredContent).toMatchObject({ code: "authorization_required", dispatched: false });
    expect(memory.receipts[0]).toMatchObject({ errorCode: "authorization_required", serverId: "server-gitlab", state: "error" });
    const invalid = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { wrong: 1 }), tokenHash,
      dependencies(memoryStore(grantOf()).store)));
    expect(invalid.result.structuredContent).toMatchObject({ code: "invalid_arguments", dispatched: false, input_schema: inputSchema });
  });

  it("reports authority the run lost while a call was prepared as the run's, never as a source outage", async () => {
    for (const [lose, code] of [
      [(memory: ReturnType<typeof memoryStore>) => { memory.state.revoked = true; }, "code_token_revoked"],
      [(memory: ReturnType<typeof memoryStore>) => { memory.invocations.set(invocationId, "closed"); }, "code_invocation_closed"]
    ] as const) {
      // The run is stopped, or the command returns, just before the call would be sent.
      const memory = memoryStore(grantOf());
      const callRuntimeTool = vi.fn(async (input: Parameters<WorkspaceCodeMcpDependencies["callRuntimeTool"]>[0]) => {
        lose(memory);
        await input.beforeDispatch();
        return { isError: false, structuredContent: { commits: [] }, text: ["sent"], unsupportedContentTypes: [] };
      });
      const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash,
        dependencies(memory.store, plan, { callRuntimeTool })));
      expect(body.result.structuredContent).toMatchObject({ code, dispatched: false });
      // Scheduled source health counts only a source's own outage or sign-in, never this.
      expect(memory.receipts[0]).toMatchObject({ errorCode: code, state: "error" });
    }
  });

  it("calls an Auto catalog tool with its current definition, as find_tools would load it", async () => {
    const memory = memoryStore(grantOf({ authority: { kind: "catalog", catalog } }));
    const deps = dependencies(memory.store);
    const listed = await rpcBody(await handleWorkspaceCodeMcpRequest(rpc("tools/list", {}), tokenHash, deps));
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([commits, jobLog]);
    expect(listed.result.tools[0].inputSchema).toEqual({ properties: { project: { description: "Project path", type: "string" } },
      type: "object" });
    const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
    expect(body.result.structuredContent).toEqual({ commits: ["c-secret-result-1"] });
    expect(deps.materialize).toHaveBeenCalled();
    expect(memory.receipts[0]).toMatchObject({ state: "complete", toolName: commits });
  });

  describe("MCP write approval", () => {
    const interactive = { approval: { consentedServerIds: [], version: 1 as const } };
    function approvals(consume: boolean) {
      return {
        consume: vi.fn<NonNullable<WorkspaceCodeMcpDependencies["approvals"]>["consume"]>(async () => consume),
        request: vi.fn<NonNullable<WorkspaceCodeMcpDependencies["approvals"]>["request"]>(async () => "approval-1")
      };
    }

    it("refuses a tool that may change data without the user's approval: nothing sent, a card recorded", async () => {
      const memory = memoryStore(grantOf(interactive));
      const store = approvals(false);
      const deps = dependencies(memory.store, plan, { approvals: store });
      const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "group/repo" }), tokenHash, deps));
      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toEqual({ code: "approval_required", dispatched: false,
        message: "This MCP tool needs the user's approval in the chat. Nothing was sent." });
      expect(body.result._meta).toEqual({ [WORKSPACE_CODE_ERROR_META]: true });
      expect(deps.callRuntimeTool).not.toHaveBeenCalled();
      expect(memory.receipts[0]).toMatchObject({ errorCode: "approval_required", state: "error" });
      const scope = { chatId: "chat-1", runId: "run-1", userId: "user-1" };
      expect(store.request).toHaveBeenCalledWith(scope, expect.objectContaining({ definitionHash, serverId: "server-gitlab",
        serverName: "GitLab", source: "code", toolCallId: null, toolName: commits, toolTitle: "list_commits" }));
    });

    it("dispatches once a matching one-shot approval is consumed, and never asks without the marker", async () => {
      for (const [grant, store] of [[grantOf(interactive), approvals(true)], [grantOf(), approvals(false)]] as const) {
        const memory = memoryStore(grant);
        const deps = dependencies(memory.store, plan, { approvals: store });
        const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
        expect(body.result.structuredContent).toEqual({ commits: ["c-secret-result-1"] });
        expect(deps.callRuntimeTool).toHaveBeenCalledOnce();
        expect(store.request).not.toHaveBeenCalled();
      }
    });

    it("never asks for a tool its server annotates read-only, nor for a server always allowed", async () => {
      const readOnly = snapshotOf([{ ...planTool(commits, "list_commits"), annotations: { readOnlyHint: true } } as ReturnType<typeof planTool>]);
      for (const grant of [grantOf({ ...interactive, authority: { kind: "plan", snapshot: readOnly } }),
        grantOf({ approval: { consentedServerIds: ["server-gitlab"], version: 1 } })]) {
        const memory = memoryStore(grant);
        const store = approvals(false);
        const deps = dependencies(memory.store, grant.authority.kind === "plan" ? grant.authority.snapshot : plan, { approvals: store });
        const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
        expect(body.result.structuredContent).toEqual({ commits: ["c-secret-result-1"] });
        expect(store.consume).not.toHaveBeenCalled();
      }
    });

    it("fails closed without an approval store", async () => {
      const memory = memoryStore(grantOf(interactive));
      const deps = dependencies(memory.store, plan, { approvals: undefined });
      const body = await rpcBody(await handleWorkspaceCodeMcpRequest(call(commits, { project: "a" }), tokenHash, deps));
      expect(body.result.structuredContent).toMatchObject({ code: "approval_required", dispatched: false });
      expect(deps.callRuntimeTool).not.toHaveBeenCalled();
    });
  });
});
