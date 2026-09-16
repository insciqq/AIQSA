// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import type { ProviderRunRequest } from "../providers/types";
import type { AgentResponsesTransport } from "../providers/agentResponses";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { agentLimits } from "./config";
import { AgentExecutionError } from "./failures";
import { executeCodexTurn } from "./executor";

const store = vi.hoisted(() => ({
  arm: vi.fn(), renew: vi.fn(), toolCall: vi.fn(), settleTool: vi.fn(), failure: vi.fn(),
  fail: vi.fn(), setThread: vi.fn(), revoke: vi.fn(), drain: vi.fn(), usage: vi.fn()
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
    transport: { snapshot: { providerFamily: "fake", model: { adapterKind: "fake", capabilities: {} } } } as unknown as AgentResponsesTransport,
    onEvent: async (event: ModelRunSseEvent) => { events.push(event); }, onActivity: vi.fn(), onUsage: vi.fn()
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

  it("delivers received text before a later gateway failure and retains its original cause", async () => {
    const f = fixture(async ({ onEvent }) => {
      await onEvent({ type: "message", id: "available", text: "Available result." });
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

  it("keeps Off deadline absent, sends each message once and settles accounting", async () => {
    const executeAgent = vi.fn<NonNullable<WorkspaceCoordinator["executeAgent"]>>(async ({ onEvent }) => {
      await onEvent({ type: "message", id: "first", text: "First." });
      await onEvent({ type: "message", id: "final", text: "Final." });
    });
    const f = fixture(executeAgent);
    const result = await executeCodexTurn(f.input);
    expect(executeAgent).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: null }));
    expect(result.finalText).toBe("First.\n\nFinal.");
    expect(f.events).toHaveLength(2);
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
});
