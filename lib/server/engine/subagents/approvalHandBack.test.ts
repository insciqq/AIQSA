import { describe, expect, it, vi } from "vitest";
import type { McpApprovalRequest } from "../../mcp/writeApproval";
import { ToolCallRepeatHistory } from "../../runs/toolCallRepeatGuard";
import type { ModelToolCall } from "../../tools/types";
import { runToolBatch, SUBAGENT_APPROVAL_HANDED_BACK_OUTPUT, type ToolBatchDeps } from "../toolBatch";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../toolCallStore";
import type { EngineTool, ToolRegistry } from "../toolRegistry";
import { createUnknownEffects } from "../unknownEffects";

const approval: McpApprovalRequest = { argumentsDigest: "a".repeat(64), definitionHash: "b".repeat(64), serverId: "jira",
  serverName: "Jira", toolName: "mcp_jira_create_issue", toolTitle: "Create" };

function setup(tool: Partial<EngineTool>, hasApproval?: boolean) {
  let id = 0;
  const row = (input: { arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number; toolName: string },
    state: ToolCallRow["state"]): ToolCallRow => ({ arguments: input.arguments as ToolCallRow["arguments"], id: `row-${id++}`,
    ordinal: input.ordinal, providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: null, state,
    toolName: input.toolName });
  const store = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => ({ kind: "running", row: row(input, "running") })),
    ...(hasApproval === undefined ? {} : { hasApproval: vi.fn(async () => hasApproval) }),
    refuse: vi.fn(async (input) => row(input, "error")),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const execute = vi.fn(async ({ call }: { call: ModelToolCall }) => ({ callId: call.id, content: [{ text: "created", type: "text" as const }],
    name: call.name, status: "complete" as const }));
  const engineTool: EngineTool = { activity: () => ({ origin: "mcp" }), approval: () => approval, definition: { capability: "mcp",
    description: "Create", inputSchema: { type: "object" }, name: "mcp_jira_create_issue" }, effects: "external", execute,
  observationSource: "mcp", ...tool };
  const registry: ToolRegistry = { definitions: () => [engineTool.definition], resolve: (name) => name === "mcp_jira_create_issue" ? engineTool : undefined };
  const handedBack: Array<{ approval: McpApprovalRequest; call: ModelToolCall }> = [];
  const deps: ToolBatchDeps = { approvalHandBack: (call, request) => handedBack.push({ approval: request, call }), chatId: "chat",
    history: new ToolCallRepeatHistory(), maxToolCalls: null, onEvent: vi.fn(async () => undefined), onLiveEvent: vi.fn(), registry,
    runId: "run", saveResult: vi.fn(async () => ({ unsavedReason: "test" })), signal: new AbortController().signal, store,
    thread: { threadId: "thread-1", turnId: "turn-1" }, unknownEffects: createUnknownEffects(), userId: "user" };
  return { deps, execute, handedBack, store };
}

const calls = [{ arguments: { summary: "Bug" }, id: "c1", name: "mcp_jira_create_issue" }];

describe("a sub-agent's MCP write", () => {
  it("that needs the user's approval is not sent, has no card, and goes back with the exact call", async () => {
    const ctx = setup({});
    const batch = await runToolBatch(ctx.deps, { calls: 0 }, { calls, round: 1 });
    expect(batch.results[0]).toMatchObject({ outcome: "error", output: SUBAGENT_APPROVAL_HANDED_BACK_OUTPUT });
    expect(batch.approvals).toEqual([]);
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(ctx.store.begin).not.toHaveBeenCalled();
    expect(ctx.store.refuse).toHaveBeenCalledWith(expect.objectContaining({ thread: { threadId: "thread-1", turnId: "turn-1" } }));
    expect(ctx.handedBack).toEqual([{ approval, call: calls[0] }]);
  });

  it("that the guard refused goes back too, and one the guard allowed is sent under its record", async () => {
    const asked = setup({ guardedApproval: async () => ({ ...approval, guard: { decision: "ask", reason: "Not requested." } }) });
    await runToolBatch(asked.deps, { calls: 0 }, { calls, round: 1 });
    expect(asked.handedBack).toHaveLength(1);
    expect(asked.execute).not.toHaveBeenCalled();
    const allowed = setup({ guardedApproval: async () => ({ ...approval, guard: { decision: "allow", reason: "Requested." } }) });
    await runToolBatch(allowed.deps, { calls: 0 }, { calls, round: 1 });
    expect(allowed.handedBack).toEqual([]);
    expect(allowed.execute).toHaveBeenCalledTimes(1);
    expect(allowed.store.begin).toHaveBeenCalledWith(expect.objectContaining({ approval: expect.objectContaining({ guard:
      { decision: "allow", reason: "Requested." } }), thread: { threadId: "thread-1", turnId: "turn-1" } }));
  });

  it("that repeats an unknown effect goes back too, and the main agent's call keeps the fence of the uncertain attempt", async () => {
    const uncertainAt = new Date("2026-10-30T08:00:00.000Z");
    const ctx = setup({ retryApproval: () => approval });
    ctx.deps.unknownEffects.record(calls[0]!, "unknown", uncertainAt);
    await runToolBatch(ctx.deps, { calls: 0 }, { calls, round: 1 });
    expect(ctx.handedBack).toEqual([{ approval, call: calls[0] }]);
    expect(ctx.execute).not.toHaveBeenCalled();
    // The main agent makes the handed-back call on the run's same fence: only a decision newer than the attempt sends it.
    const main = setup({ retryApproval: () => approval }, false);
    const { approvalHandBack: _handBack, thread: _thread, ...mainDeps } = { ...main.deps, unknownEffects: ctx.deps.unknownEffects };
    void _handBack; void _thread;
    await runToolBatch(mainDeps, { calls: 0 }, { calls, round: 1 });
    expect(main.store.hasApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalAfter: uncertainAt }));
    expect(main.store.begin).toHaveBeenCalledWith(expect.objectContaining({ approval, approvalAfter: uncertainAt }));
  });

  it("that the user already allowed is sent", async () => {
    const ctx = setup({}, true);
    await runToolBatch(ctx.deps, { calls: 0 }, { calls, round: 1 });
    expect(ctx.handedBack).toEqual([]);
    expect(ctx.execute).toHaveBeenCalledTimes(1);
  });
});
