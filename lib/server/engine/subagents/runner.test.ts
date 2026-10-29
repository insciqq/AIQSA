import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_BLOCKED_REASONS, SUBAGENT_USAGE_PURPOSE, decodeSubagentCallResult } from "../../../contracts/subagents";
import type { ModelRunSseEvent } from "../../../domain/modelRunEvents";
import type { McpApprovalRequest } from "../../mcp/writeApproval";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../../providers/types";
import type { RunUsageAttribution } from "../../runs/runRepositoryContract";
import type { SubagentBinding, SubagentTurnInput } from "../../subagents/ports";
import type { ModelToolCall, ToolExecutionResult } from "../../tools/types";
import { SUBAGENT_ROLE_SECTION } from "../prompts";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../toolCallStore";
import type { EngineTool, ToolRegistry } from "../toolRegistry";
import type { TranscriptItem } from "../transcript";
import { subagentRequestShape } from "./runSubagents";
import { createSubagentRunner, parseSubagentOutcome, type SubagentHost } from "./runner";

type Step = Readonly<{ calls?: ModelToolCall[]; hang?: true; text?: string }>;

function scriptedAdapter(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      if (step.hang) {
        await new Promise<void>((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
      }
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

const ok = (call: ModelToolCall, text: string): ToolExecutionResult =>
  ({ callId: call.id, content: [{ text, type: "text" }], name: call.name, status: "complete" });

function engineTool(name: string, capability: "mcp" | "session" | "skill", execute: EngineTool["execute"],
  extra: Partial<EngineTool> = {}): EngineTool {
  return { activity: () => ({ origin: "mcp", serverName: "Jira", toolName: name }), definition: { capability, description: name,
    inputSchema: { type: "object" }, name }, effects: "none", execute, observationSource: "mcp", ...extra };
}

const approval: McpApprovalRequest = { argumentsDigest: "a".repeat(64), definitionHash: "b".repeat(64), serverId: "jira",
  serverName: "Jira", toolName: "mcp_jira_create_issue", toolTitle: "Create" };

const snapshot = { connection: {}, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
  providerFamily: "fake", providerModelId: "model-1" } as unknown as ProviderExecutionSnapshot;

const request = {
  attachmentIds: ["attachment-1"], attachments: [], chatId: "chat", content: { blocks: [{ text: "Hello", type: "text" }] },
  modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true },
  modelId: "fake-qsa", params: {}, personalContext: { approxTokens: 5, itemCount: 1, memoryGeneration: 1, memoryRevision: 1,
    mode: "standing-v1", text: "The user lives in Madrid." },
  prompt: { developer: "Visible answer contract", personalInstructions: "Always answer in French.", system: "Workspace contract." },
  provider: "fake", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
} as unknown as ProviderRunRequest;

const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "connection-1",
  providerModelId: "model-1", reasoningEffort: null };

function setup(steps: readonly Step[], options: Readonly<{ earlier?: TranscriptItem[]; followups?: () => { id: string; text: string }[] }> = {}) {
  const { adapter, requests } = scriptedAdapter(steps);
  const appended: Array<{ items: readonly TranscriptItem[]; thread: unknown }> = [];
  const begun: unknown[] = [];
  const rows = new Map<string, ToolCallRow>();
  const row = (input: { arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number; toolName: string },
    state: ToolCallRow["state"]): ToolCallRow => {
    const made: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
      providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: "now", state, toolName: input.toolName };
    rows.set(made.id, made);
    return made;
  };
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => { begun.push(input); return { kind: "running", row: row(input, "running") }; }),
    refuse: vi.fn(async (input) => row(input, "error")),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const lookup = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call, "[browser #3] click: button \"Add to cart\" @ shop.example\nok"));
  const tools = [
    engineTool("browser_handoff", "session", vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call, "done"))),
    engineTool("manage_secret", "session", vi.fn()),
    engineTool("load_skill", "skill", vi.fn()),
    engineTool("mcp_jira_get_issue", "mcp", lookup),
    engineTool("mcp_jira_create_issue", "mcp", vi.fn(), { approval: () => approval, effects: "external" })
  ];
  const registry: ToolRegistry = { definitions: () => tools.map((entry) => entry.definition),
    resolve: (name) => tools.find((entry) => entry.definition.name === name) };
  const usage: RunUsageAttribution[] = [];
  const settled: unknown[] = [];
  const controller = new AbortController();
  const host: SubagentHost = {
    branchRunIds: options.earlier ? ["run-earlier"] : [],
    buildRegistry: vi.fn(async () => registry),
    callTimeLeft: () => true,
    chatId: "chat",
    deadlineAt: Date.now() + 60_000,
    deadlineSignal: new AbortController().signal,
    followupTexts: () => [],
    maxToolCalls: null,
    maxToolRounds: null,
    now: Date.now,
    onWorkspaceLifecycle: vi.fn(async () => undefined),
    pendingUserFollowups: vi.fn(async () => options.followups?.() ?? []),
    recordDetachedCompaction: vi.fn(async () => true),
    request,
    requestShape: subagentRequestShape,
    route: vi.fn(async () => ({ ok: true as const, route: { adapter, request: { modelCapabilities: request.modelCapabilities,
      modelId: "fake-qsa", params: {}, provider: "fake", reasoningEffort: null }, snapshot, timeoutMs: 10_000 } })),
    runContextItems: [{ id: "ctx-0", kind: "user", runContext: true, text: "Skills index: research" }],
    saveResult: vi.fn(async () => ({ unsavedReason: "test" })),
    setTurnState: vi.fn(async () => true),
    settleTurn: vi.fn(async (input) => { settled.push(input); return true; }),
    settleUsage: vi.fn(async () => undefined),
    signal: controller.signal,
    toolCalls,
    toolState: { calls: 0 },
    toolTimeLeft: () => true,
    transcripts: {
      append: vi.fn(async (scope, _from, items) => { appended.push({ items, thread: scope.thread }); }),
      loadRuns: vi.fn(async (input) => new Map(input.runIds.map((runId) => [runId,
        input.threadId === "thread-1" && runId === "run-earlier" ? options.earlier ?? [] : []]))),
      nextSequence: vi.fn(async () => 0),
      runLive: vi.fn(async () => true)
    },
    usage: (attribution) => usage.push(attribution),
    userId: "user"
  };
  const runner = createSubagentRunner(host);
  const input = (extra: Partial<SubagentTurnInput> = {}): SubagentTurnInput => ({ binding, brief: "Compare laptops on shop.example.",
    chatId: "chat", deadlineAt: new Date(Date.now() + 60_000), hostRunId: "run", mode: "foreground", name: "shop", parentRunId: "run",
    parentToolCallId: "call-row", signal: new AbortController().signal, threadId: "thread-1", turnId: "turn-1", type: null,
    userId: "user", userMessage: "Buy the cheapest one with my card.", ...extra });
  return { appended, begun, controller, host, input, lookup, requests, runner, settled, toolCalls, usage };
}

const userTexts = (request: ProviderRunRequest) =>
  (request.history ?? []).flatMap((item) => item.type === "user" ? [item.text] : []);

describe("sub-agent runner", () => {
  it("runs a turn on the parent's route with its own prompt, the brief and the user's message, filtered tools and thread keys", async () => {
    const ctx = setup([{ calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] },
      { text: "Outcome: partial\nFound two of three laptops." }]);
    const handle = await ctx.runner.start(ctx.input());
    const result = await ctx.runner.wait(handle);
    expect(decodeSubagentCallResult(result)).toEqual(result);
    expect(result).toMatchObject({ kind: "ended", model: { effort: null, id: "fake-qsa" }, name: "shop", outcome: "partial",
      report: "Outcome: partial\nFound two of three laptops.", state: "done" });
    expect(result.steps).toEqual([{ outcome: "complete", summary: "[browser #3] click: button \"Add to cart\" @ shop.example",
      tool: "Jira: mcp_jira_get_issue" }]);
    const first = ctx.requests[0]!;
    // Its own stable prompt, without the parent's answer rules or anything personal to the user's conversation.
    expect(first.prompt.system).toContain(SUBAGENT_ROLE_SECTION);
    expect(first.prompt.system).toContain("Workspace contract.");
    expect(first.prompt.developer).toBeNull();
    expect(first.prompt.personalInstructions).toBeUndefined();
    expect(first.personalContext).toBeUndefined();
    expect(first.attachmentIds).toEqual([]);
    // The brief and the user's message verbatim, the run's own context, and never the main transcript.
    const texts = userTexts(first);
    expect(texts[0]).toBe("Skills index: research");
    expect(texts.at(-1)).toContain("<main_agent_brief>\nCompare laptops on shop.example.\n</main_agent_brief>");
    expect(texts.at(-1)).toContain("<user_message>\nBuy the cheapest one with my card.\n</user_message>");
    // The run's registry, filtered: no resource change, load_skill kept.
    expect((first.tools ?? []).map((tool) => tool.name)).toEqual(["browser_handoff", "load_skill", "mcp_jira_get_issue",
      "mcp_jira_create_issue"]);
    expect(ctx.begun).toEqual([expect.objectContaining({ thread: { threadId: "thread-1", turnId: "turn-1" } })]);
    expect(ctx.appended.every((write) => JSON.stringify(write.thread) === JSON.stringify({ threadId: "thread-1", turnId: "turn-1" })))
      .toBe(true);
    expect(ctx.appended[0]!.items[0]).toMatchObject({ id: "sub-turn-1", kind: "user" });
    expect(ctx.usage).toHaveLength(2);
    expect(ctx.usage.every((entry) => entry.purpose === SUBAGENT_USAGE_PURPOSE)).toBe(true);
    expect(ctx.settled).toEqual([{ result, turnId: "turn-1" }]);
  });

  it("hands a data-changing MCP call back to the main agent unsent and without a card", async () => {
    const ctx = setup([{ calls: [{ arguments: { summary: "Bug" }, id: "c1", name: "mcp_jira_create_issue" }] },
      { text: "Outcome: done\nPrepared the issue." }]);
    const result = await ctx.runner.wait(await ctx.runner.start(ctx.input()));
    expect(result).toMatchObject({ outcome: "blocked", reason: SUBAGENT_BLOCKED_REASONS.needsApproval, state: "done",
      approvals: [{ arguments: { summary: "Bug" }, reason: "approval_required", serverName: "Jira", toolName: "mcp_jira_create_issue" }],
      steps: [{ outcome: "refused", summary: "needs_approval" }] });
    expect(ctx.toolCalls.begin).not.toHaveBeenCalled();
    expect(ctx.toolCalls.refuse).toHaveBeenCalledTimes(1);
  });

  it("continues a thread from its own earlier items on the branch", async () => {
    const earlier: TranscriptItem[] = [
      { id: "sub-turn-0", kind: "user", text: "<main_agent_brief>\nFind laptops.\n</main_agent_brief>" },
      { id: "a0", kind: "assistant_text", text: "Outcome: done\nThree laptops in /workspace/project/shop/." }
    ];
    const ctx = setup([{ text: "Outcome: done\nThe second is cheapest." }], { earlier });
    const result = await ctx.runner.wait(await ctx.runner.continue(ctx.input({ brief: "Which is cheapest?", turnId: "turn-2" })));
    expect(result.report).toBe("Outcome: done\nThe second is cheapest.");
    const history = ctx.requests[0]!.history ?? [];
    expect(history).toEqual(expect.arrayContaining([{ text: "Outcome: done\nThree laptops in /workspace/project/shop/.",
      type: "assistant_text" }]));
    expect(userTexts(ctx.requests[0]!).at(-1)).toContain("<main_agent_message>\nWhich is cheapest?\n</main_agent_message>");
    expect(ctx.host.transcripts.loadRuns).toHaveBeenCalledWith({ chatId: "chat", runIds: ["run-earlier", "run"], threadId: "thread-1",
      userId: "user" });
  });

  it("gives the sub-agent the user's follow-ups that arrive while the main agent waits", async () => {
    // The parent run's accepted follow-up stays listed until the main agent's own next round delivers it there.
    const ctx = setup([{ calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] }, { text: "Outcome: done\nOk." }],
      { followups: () => [{ id: "f1", text: "Only under 1000 EUR." }] });
    await ctx.runner.wait(await ctx.runner.start(ctx.input()));
    expect(ctx.requests).toHaveLength(2);
    expect(userTexts(ctx.requests[1]!).some((text) => text.includes("Only under 1000 EUR."))).toBe(true);
    expect(userTexts(ctx.requests[1]!).filter((text) => text.includes("Only under 1000 EUR."))).toHaveLength(1);
  });

  it("ends as stopped on stop_subagent or the parent's Stop, keeping what it recorded", async () => {
    const ctx = setup([{ hang: true }]);
    const handle = await ctx.runner.start(ctx.input());
    await vi.waitFor(() => expect(ctx.requests).toHaveLength(1));
    const stopped = await ctx.runner.stop(handle, "stop_subagent");
    expect(stopped).toMatchObject({ reason: "stop_subagent", state: "stopped" });
    expect(ctx.appended[0]!.items[0]).toMatchObject({ id: "sub-turn-1" });
    const parent = setup([{ hang: true }]);
    const turn = await parent.runner.start(parent.input());
    await vi.waitFor(() => expect(parent.requests).toHaveLength(1));
    parent.controller.abort();
    await expect(parent.runner.wait(turn)).resolves.toMatchObject({ reason: "parent_stopped", state: "stopped" });
  });

  it("waits for the user during its browser handoff, then runs again", async () => {
    const ctx = setup([{ calls: [{ arguments: { reason: "sign_in" }, id: "c1", name: "browser_handoff" }] }, { text: "Outcome: done\nIn." }]);
    await ctx.runner.wait(await ctx.runner.start(ctx.input()));
    expect(vi.mocked(ctx.host.setTurnState!).mock.calls.map(([input]) => input.state)).toEqual(["waiting", "running"]);
  });

  it("fails visibly when the route is refused, never running on another model", async () => {
    const ctx = setup([{ text: "unused" }]);
    vi.mocked(ctx.host.route).mockResolvedValueOnce({ code: "subagent_model_unavailable", ok: false });
    const result = await ctx.runner.wait(await ctx.runner.start(ctx.input()));
    expect(result).toMatchObject({ reason: "subagent_model_unavailable", state: "failed" });
    expect(ctx.requests).toHaveLength(0);
  });

  it("reads the outcome line of a report", () => {
    expect(parseSubagentOutcome("Outcome: blocked (sign_in_required)\nThe site wants a login.")).toEqual({ outcome: "blocked",
      reason: "sign_in_required" });
    expect(parseSubagentOutcome("**Outcome:** partial")).toEqual({ outcome: "partial" });
    expect(parseSubagentOutcome("Here is what I found.")).toBeNull();
  });
});
