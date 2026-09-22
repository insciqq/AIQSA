// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import type { ProviderRunRequest } from "../providers/types";
import type { AgentResponsesTransport } from "../providers/agentResponses";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { WorkspaceActivityText } from "../workspace/activityText";
import { agentLimits } from "./config";
import { AgentExecutionError } from "./failures";
import { executeCodexTurn } from "./executor";
import type { RunFollowupOperations } from "../runs/runFollowups";
import type { RunFollowup } from "@/lib/contracts/runFollowups";

const store = vi.hoisted(() => ({
  arm: vi.fn(), renew: vi.fn(), toolCall: vi.fn(), settleTool: vi.fn(), failure: vi.fn(),
  fail: vi.fn(), setThread: vi.fn(), revoke: vi.fn(), drain: vi.fn(), usage: vi.fn(),
  assertActive: vi.fn(), claimFollowupInterrupt: vi.fn(), continueAfterExit: vi.fn()
}));
vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("./store", () => ({ createAgentRunStore: () => store }));
vi.mock("./prompt", () => ({ agentPrompts: () => ({ previousAssistantMessageId: null,
  developerInstructions: "fixture", prompt: "fixture", resumePrompt: "fixture" }) }));

function fixture(executeAgent: NonNullable<WorkspaceCoordinator["executeAgent"]>, signal = new AbortController().signal) {
  const events: ModelRunSseEvent[] = [];
  const request = { modelId: "fixture", searchPlan: { mode: "all_selected", options: [] },
    modelCapabilities: { contextWindow: 32768 }, workspace: { enabled: true },
    agent: { ...agentLimits(DEFAULT_AGENT_POLICY, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
      compatibilityHash: "a".repeat(64), mcpMode: "off" }
  } as unknown as ProviderRunRequest;
  return { events, input: { request, signal, runId: "fixture", userId: "fixture",
    workspace: { executeAgent } as WorkspaceCoordinator,
    transport: { snapshot: { providerFamily: "fake", connection: { responseTimeoutMs: 300_000 }, model: { adapterKind: "fake", capabilities: {} } } } as unknown as AgentResponsesTransport,
    onEvent: async (event: ModelRunSseEvent) => { events.push(event); }, onPersistedEvent: vi.fn(), onActivity: vi.fn(), onUsage: vi.fn()
  } };
}

describe("Agent executor terminal behavior", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    store.arm.mockResolvedValue({ token: "fixture" });
    store.toolCall.mockResolvedValue("call");
    store.usage.mockResolvedValue([]);
    store.failure.mockResolvedValue(null);
  });

  it.each([
    [300_000, undefined, 300_000],
    [3_600_000, undefined, 3_600_000],
    [3_600_000, 7_200_000, 7_200_000],
    [3_600_000, 86_400_000, 86_400_000]
  ] as const)("passes the frozen connection/model timeout to native execution (%s, %s)", async (connectionMs, modelMs, expectedMs) => {
    const executeAgent = vi.fn<NonNullable<WorkspaceCoordinator["executeAgent"]>>(async () => undefined);
    const f = fixture(executeAgent);
    f.input.transport = { ...f.input.transport, snapshot: { ...f.input.transport.snapshot,
      connection: { ...f.input.transport.snapshot.connection, responseTimeoutMs: connectionMs },
      model: { ...f.input.transport.snapshot.model, adapterKind: "deepseek_responses_native", answerSelectable: true,
        defaultParams: {}, modelClass: "answer", upstreamModelId: "synthetic", responseTimeoutMs: modelMs }
    } };
    await executeCodexTurn(f.input);
    expect(executeAgent).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ responseTimeoutMs: expectedMs })
    }));
  });

  it("continues sequentially with only new user input and acknowledges it after native turn start", async () => {
    const entries: RunFollowup[] = [];
    const delivery = vi.fn();
    const operations: RunFollowupOperations = { accept: vi.fn(), beginKnowledge: vi.fn(),
      load: vi.fn(async () => ({ revision: entries.length, entries: entries.map(entry => ({ ...entry })) })),
      deliver: vi.fn(async ({ revision, confirmedThrough }) => {
        expect(confirmedThrough).toBe(true);
        entries.forEach((entry, index) => { if (entry.ordinal <= revision) entries[index] = { ...entry, delivery: "delivered" }; });
        return true;
      }), close: vi.fn(async ({ revision }) => revision === entries.length) };
    store.toolCall.mockResolvedValueOnce("first-call").mockResolvedValueOnce("next-call");
    store.claimFollowupInterrupt.mockResolvedValue(true);
    store.continueAfterExit.mockResolvedValue({ token: "next-token", threadId: "native-thread", timeoutSeconds: 12 });
    let segment = 0;
    const f = fixture(async request => {
      const text = new WorkspaceActivityText();
      if (++segment === 1) {
        await request.onEvent({ type: "turn_started" }, text);
        await request.onEvent({ type: "message", id: "old", text: "Known partial." }, text);
        entries.push({ id: "followup", ordinal: 1, text: "Use CSV", author: "Synthetic", createdAt: new Date(0).toISOString(), delivery: "accepted" });
        expect(await request.shouldInterrupt!()).toBe(true);
        expect(operations.deliver).not.toHaveBeenCalled();
        return "interrupted";
      }
      expect(request).toMatchObject({ threadId: "native-thread", previousToolCallId: "first-call", runToken: "next-token", timeoutSeconds: 12 });
      expect(JSON.parse(request.resumePrompt)).toEqual([{ role: "user", text: "Use CSV" }]);
      expect(operations.deliver).not.toHaveBeenCalled();
      await request.onEvent({ type: "turn_started" }, text);
      await request.onEvent({ type: "message", id: "new", text: "count,total\n2,20" }, text);
    });
    f.input.request = { ...f.input.request, followupContextReserveTokens: 4096 };
    const result = await executeCodexTurn({ ...f.input, followups: { operations, beforeDelivery: async () => "Known partial.", onDelivery: delivery } });
    expect(result).toMatchObject({ finalText: "count,total\n2,20", followupRevision: 1 });
    expect(f.events.filter(event => event.type === "token").map(event => event.data)).toEqual([{ delta: "Known partial." }, { delta: "count,total\n2,20" }]);
    expect(delivery).toHaveBeenCalledExactlyOnceWith(1);
    expect(store.arm).toHaveBeenCalledOnce(); expect(store.revoke).toHaveBeenCalledExactlyOnceWith(true);
    expect(store.continueAfterExit).toHaveBeenCalledExactlyOnceWith("fixture", "first-call");
  });

  it("does not resume or acknowledge accepted input when Stop wins after native interruption", async () => {
    const controller = new AbortController();
    const f = fixture(async () => { controller.abort(); return "interrupted"; }, controller.signal);
    const operations = { load: vi.fn(async () => ({ revision: 0, entries: [] })), close: vi.fn(), deliver: vi.fn() } as unknown as RunFollowupOperations;
    await expect(executeCodexTurn({ ...f.input, followups: { operations, beforeDelivery: vi.fn(), onDelivery: vi.fn() } })).rejects.toThrow();
    expect(operations.deliver).not.toHaveBeenCalled(); expect(operations.close).not.toHaveBeenCalled();
    expect(store.continueAfterExit).not.toHaveBeenCalled();
    expect(store.revoke).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("delivers received text before a later gateway failure and retains its original cause", async () => {
    const f = fixture(async ({ onEvent }) => {
      await onEvent({ type: "message", id: "available", text: "Available result." }, new WorkspaceActivityText());
      store.failure.mockResolvedValue("agent_token_limit");
      throw new Error("workspace_runtime_unavailable");
    });
    await expect(executeCodexTurn(f.input)).rejects.toMatchObject({ code: "agent_token_limit" });
    expect(f.events).toEqual([{ type: "token", data: { delta: "Available result." } }]);
    expect(store.revoke).toHaveBeenCalledWith(false);
    expect(store.drain).toHaveBeenCalledOnce();
    expect(f.input.onUsage).toHaveBeenCalled();
  });

  it("persists an Agent deadline cause before revoking the grant", async () => {
    const controller = new AbortController();
    const f = fixture(async () => {
      controller.abort(new AgentExecutionError("agent_time_limit"));
      throw new Error("workspace_tool_cancelled");
    }, controller.signal);
    store.fail.mockImplementation(async () => { store.failure.mockResolvedValue("agent_time_limit"); });
    await expect(executeCodexTurn(f.input)).rejects.toMatchObject({ code: "agent_time_limit" });
    expect(store.fail).toHaveBeenCalledWith("agent_time_limit");
    expect(store.fail.mock.invocationCallOrder[0]).toBeLessThan(store.revoke.mock.invocationCallOrder[0]!);
  });

  it("buffers notes, publishes only the last message and settles accounting", async () => {
    const executeAgent = vi.fn<NonNullable<WorkspaceCoordinator["executeAgent"]>>(async ({ onEvent }) => {
      await onEvent({ type: "message", id: "first", text: "First." }, new WorkspaceActivityText());
      await onEvent({ type: "message", id: "final", text: "Final." }, new WorkspaceActivityText());
    });
    const f = fixture(executeAgent);
    const result = await executeCodexTurn(f.input);
    expect(executeAgent).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: null }));
    expect(result.finalText).toBe("Final.");
    expect(f.events).toEqual([{ type: "token", data: { delta: "Final." } }]);
    expect(f.input.onActivity.mock.calls.map(([entry]) => entry.text)).toEqual(["First.", "Final."]);
    expect(store.revoke).toHaveBeenCalledWith(true);
    expect(store.drain).not.toHaveBeenCalled();
    expect(f.input.onUsage).toHaveBeenCalled();
  });

  it("does not require an empty MCP server when Load all has no admitted tools", async () => {
    const executeAgent = vi.fn<NonNullable<WorkspaceCoordinator["executeAgent"]>>(async () => undefined);
    const f = fixture(executeAgent);
    f.input.request = { ...f.input.request, agent: { ...f.input.request.agent!, mcpMode: "all" } };
    await executeCodexTurn(f.input);
    expect(executeAgent).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ mcpMode: "off", aiqsaSearch: false })
    }));
  });

  it.each(["Stop", "error"])("flushes only the last received message on %s", async (outcome) => {
    const controller = new AbortController();
    const f = fixture(async ({ onEvent }) => {
      const text = new WorkspaceActivityText(["credential-fixture"]);
      await onEvent({ type: "message", id: "first", text: "Earlier note." }, text);
      await onEvent({ type: "message", id: "last", text: "Known credential-fixture result." }, text);
      expect(f.events).toEqual([]);
      if (outcome === "Stop") controller.abort();
      throw new Error("interrupted");
    }, controller.signal);
    await expect(executeCodexTurn(f.input)).rejects.toThrow();
    expect(f.events).toEqual([{ type: "token", data: { delta: "Known ••• result." } }]);
    expect(f.input.onActivity).toHaveBeenCalledTimes(2);
  });
});
