import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSubagentSummaryResponse } from "../../../contracts/subagentViews";
import { toolActivityDescriptors, TOOL_ACTIVITY_REQUEST_KEYS } from "../../tools/activityDescriptors";
import { runEndedToolCallResult } from "../toolLoopPersistence";
import { createSubagentViews, subagentTurnWorkspaceActivity } from "./views";

vi.mock("../../toolObservations/repository", () => ({
  branchPathMessageIds: vi.fn(async () => new Set(["answer-1"]))
}));

const at = new Date("2026-10-30T10:00:00.000Z");

function turn(id: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    endedAt: state === "running" || state === "waiting" ? null : at, executionRun: { id: `run-${id}`, status: "streaming" }, id, mode: "background",
    modelId: "gpt-raw-id", outcome: state === "done" ? "done" : null, parentRun: { assistantMessageId: "answer-1", status: "complete" },
    parentRunId: "parent-1", parentToolCallId: `call-${id}`, providerModelId: "provider-model-1", reasonCode: null, reasoningEffort: "high",
    result: null, startedAt: at, state, updatedAt: at, ...overrides
  };
}

const thread = (id: string, turns: readonly unknown[]) => ({
  anchorRun: { assistantMessageId: "answer-1" }, createdAt: at, id, name: id, turns, typeName: null, updatedAt: at
});

const runningCall = (turnId: string, overrides: Record<string, unknown> = {}) => ({
  arguments: { query: "private query" }, completedAt: null, id: `tool-${turnId}`, ordinal: 0, providerCallId: `provider-${turnId}`, result: null,
  roundIndex: 1, startedAt: at, state: "running", subagentTurnId: turnId, toolName: "web_search", ...overrides
});

function fakeClient(input: Readonly<{ calls?: readonly unknown[]; request?: unknown; threads: readonly unknown[] }>) {
  const tx = {
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => [{ activityRequest: input.request ?? {}, id: "parent-1" }]),
    chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "answer-1" })) },
    modelRunToolCall: { findMany: vi.fn(async () => input.calls ?? []) },
    providerModel: { findMany: vi.fn(async () => [{ displayName: "GPT-6 Luna", id: "provider-model-1" }]) },
    subagentThread: { findMany: vi.fn(async () => input.threads) }
  };
  const client = {
    $transaction: vi.fn(async (body: (value: typeof tx) => Promise<unknown>) => body(tx)),
    chat: { findMany: vi.fn(async () => [{ id: "chat-1" }, { id: "chat-2" }]) }
  };
  return { client: client as unknown as PrismaClient, tx };
}

describe("the summary's model and current step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives an active thread the identity of its latest running call and its turn's model, valid for the decoder", async () => {
    const { client, tx } = fakeClient({
      calls: [runningCall("turn-a", { id: "tool-new", ordinal: 1, toolName: "web_search" }), runningCall("turn-a", { toolName: "old_tool" })],
      threads: [thread("alpha", [turn("turn-a", "running")])]
    });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]).toMatchObject({ model: { displayName: "GPT-6 Luna", effort: "high" } });
    const step = chat!.threads[0]!.currentStep;
    expect(step).toMatchObject({ toolName: "web_search" });
    // The identity only: never the call's arguments or result, even as a value in the projection.
    expect(JSON.stringify(step)).not.toContain("private query");
    expect(decodeSubagentSummaryResponse({ chats: [chat] })).not.toBeNull();
    const where = tx.modelRunToolCall.findMany.mock.calls[0] as unknown as [{ take: number; where: unknown }];
    expect(where[0].take).toBeLessThanOrEqual(160);
    expect(where[0].where).toMatchObject({ modelRunId: { in: ["run-turn-a"] }, subagentTurnId: { in: ["turn-a"] } });
  });

  it("selects only the request's tool-naming keys, for the caller's own run, and still names an MCP step", async () => {
    const { client, tx } = fakeClient({ calls: [runningCall("turn-a", { toolName: "mcp_jira_search" })],
      request: { mcp: { tools: [{ namespacedName: "mcp_jira_search", originalName: "search", serverName: "Jira" }] } },
      threads: [thread("alpha", [turn("turn-a", "running")])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toEqual({ origin: "mcp", serverName: "Jira", toolName: "search" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0]!;
    expect(sql.join("?")).toContain("entry.key = ANY(");
    expect(sql.join("?")).not.toMatch(/SELECT\s+(?:run\.)?"normalizedRequest"/u);
    expect(values).toEqual([[...TOOL_ACTIVITY_REQUEST_KEYS], ["parent-1"], "user-1"]);
  });

  it("selects every request key a tool's identity depends on, and not the context", () => {
    const full = { messages: [{ content: "the admitted context" }], context: "x", input: "y",
      agent: undefined, fetchUrl: {}, imagePlan: {}, mcp: { tools: [{ namespacedName: "mcp_a", originalName: "a", serverName: "A" }] },
      mcpDiscovery: { catalog: { servers: [{ tools: [{ namespacedName: "mcp_b", originalName: "b" }] }] } }, scheduledTaskManagementTool: true,
      scheduledTaskTool: true, searchPlan: { mode: "all_selected", options: [{ adapterKind: "provider_model_client", displayName: "E" }] },
      skillSaveTool: true, visionAnalysis: {}, workspace: { enabled: true }, workspaceImageView: true };
    const selected = Object.fromEntries(Object.entries(full).filter(([key]) => TOOL_ACTIVITY_REQUEST_KEYS.includes(key)));
    expect([...toolActivityDescriptors(selected)]).toEqual([...toolActivityDescriptors(full)]);
    for (const key of ["messages", "context", "input"]) expect(TOOL_ACTIVITY_REQUEST_KEYS).not.toContain(key);
  });

  it("names the answer that started the latest turn", async () => {
    const { client } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "done")])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.latestAnswerMessageId).toBe("answer-1");
  });

  it("reads a foreground turn's calls on its parent run", async () => {
    const { client, tx } = fakeClient({ calls: [runningCall("turn-f")],
      threads: [thread("zeta", [turn("turn-f", "running", { executionRun: null, mode: "foreground", parentRun: { assistantMessageId: "answer-1", status: "streaming" } })])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toMatchObject({ toolName: "web_search" });
    expect(tx.modelRunToolCall.findMany.mock.calls[0]).toMatchObject([{ where: { modelRunId: { in: ["parent-1"] } } }]);
  });

  it("leaves the step unknown without a running call, and never reads the request for it", async () => {
    const { client, tx } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "running")])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("leaves the step unknown for a call whose run already ended", async () => {
    const { client } = fakeClient({ calls: [runningCall("turn-a")],
      threads: [thread("alpha", [turn("turn-a", "running", { executionRun: { id: "run-turn-a", status: "cancelled" } })])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toBeNull();
  });

  it("costs an idle chat no step query, keeps the model that ran and falls back to its id for a deleted one", async () => {
    const { client, tx } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "done")]),
      thread("beta", [turn("turn-b", "failed", { providerModelId: "gone", reasoningEffort: null })])] });
    tx.providerModel.findMany.mockResolvedValue([{ displayName: "GPT-6 Luna", id: "provider-model-1" }]);
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(tx.modelRunToolCall.findMany).not.toHaveBeenCalled();
    expect(chat!.threads.map((row) => row.model)).toEqual([{ displayName: "GPT-6 Luna", effort: "high" }, { displayName: "gpt-raw-id", effort: null }]);
    expect(chat!.threads.map((row) => row.currentStep)).toEqual([null, null]);
  });

  it("looks a model's name up once across the chats of one summary", async () => {
    const { client, tx } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "done")])] });
    const { chats } = await createSubagentViews(client).summary({ chatIds: ["chat-1", "chat-2"], userId: "user-1" });
    expect(chats).toHaveLength(2);
    expect(tx.providerModel.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("subagentTurnWorkspaceActivity", () => {
  const definitions = [{ namespacedName: "mcp_workspace_sandbox_exec_abc", originalName: "sandbox_exec" }];
  const call = (id: string, overrides: Record<string, unknown> = {}) => ({
    arguments: { args: ["open", "https://example.com"], command: "aiqsa-browser" }, id, result: null, startedAt: at,
    toolName: "mcp_workspace_sandbox_exec_abc", ...overrides
  });
  const stored = (...payloads: readonly Record<string, unknown>[]) => ({
    artifacts: payloads.map((payload) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" })),
    callId: "provider", content: [{ text: "{}", type: "text" }], name: "tool", status: "complete"
  });

  it("shows a running turn's Workspace command, and only Workspace calls", () => {
    const activity = subagentTurnWorkspaceActivity({ active: true, calls: [call("c1"), call("c2", { toolName: "web_search" })], definitions, runId: "run-1" });
    expect(activity?.entries).toHaveLength(1);
    expect(activity?.entries[0]).toMatchObject({ kind: "command", phase: "running" });
    expect(activity?.entries[0]?.command?.preview).toContain("aiqsa-browser open");
  });

  it("reads a settled call's stored entries, and an async command's poll updates its starting row", () => {
    const start = { command: { preview: "python3 report.py" }, id: "call:start", kind: "command", phase: "running" };
    const finished = { ...start, command: { exitCode: 0, preview: "python3 report.py", stdoutPreview: "report ready" }, phase: "succeeded" };
    const activity = subagentTurnWorkspaceActivity({ active: true, calls: [call("start", { result: stored(start) }), call("poll", { result: stored(finished) })],
      definitions, runId: "run-1" });
    expect(activity?.entries).toHaveLength(1);
    expect(activity?.entries[0]).toMatchObject({ command: { exitCode: 0, stdoutPreview: "report ready" }, id: "call:start", phase: "succeeded" });
  });

  it("keeps a call that ended with the run as an unknown step instead of failing the thread", () => {
    const activity = subagentTurnWorkspaceActivity({ active: false, calls: [call("c1", { result: runEndedToolCallResult() })], definitions, runId: "run-1" });
    expect(activity?.entries[0]).toMatchObject({ kind: "command", phase: "unknown" });
  });

  it("skips a malformed stored entry and has nothing to show without Workspace calls", () => {
    expect(subagentTurnWorkspaceActivity({ active: true, calls: [call("c1", { result: stored({ id: "bad" }) })], definitions, runId: "run-1" })).toBeNull();
    expect(subagentTurnWorkspaceActivity({ active: true, calls: [call("c1")], definitions: null, runId: "run-1" })).toBeNull();
    expect(subagentTurnWorkspaceActivity({ active: true, calls: [], definitions, runId: "run-1" })).toBeNull();
  });
});
