import { describe, expect, it, vi } from "vitest";
import { RESEARCHER_CONTEXT_CLEARING } from "../../../contracts/research";
import type { ModelRunSseEvent } from "../../../domain/modelRunEvents";
import { contextTokenEstimator } from "../../../domain/tokenEstimate";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderModelCapabilities, ProviderRunRequest, ProviderRunResult } from "../../providers/types";
import type { SubagentBinding, SubagentTurnInput } from "../../subagents/ports";
import type { ModelToolCall } from "../../tools/types";
import { CLEARED_RESULT_HEADING } from "../compaction/clearing";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../toolCallStore";
import type { EngineTool, ToolRegistry } from "../toolRegistry";
import { executeReadToolResult, toolResultOutputText } from "../toolResults";
import { projectTranscript, type TranscriptItem } from "../transcript";
import { decodeTranscriptItem, encodeTranscriptItem } from "../transcriptCodec";
import { createAgentUnknownEffects } from "../unknownEffects";
import { subagentRequestShape } from "./runSubagents";
import { createSubagentRunner, type SubagentHost } from "./runner";

/**
 * A research researcher's long turn on the real runner and loop: every step opens a page of 20 thousand characters, and the
 * host's clearing policy keeps its context small (`compaction/clearing.ts`), while a host without one keeps every page.
 */
const STEPS = 60;
const PAGE_CHARACTERS = 20_000;
const POLICY = RESEARCHER_CONTEXT_CLEARING;
const estimate = contextTokenEstimator({ modelId: "fake-qsa", provider: "fake" });

const pageText = (index: number) => `Page ${index}: ${"The latex layer is 3 cm over 1 cm of coir; owners report it holds its shape. ".repeat(300)}`
  .slice(0, PAGE_CHARACTERS);
const url = (index: number) => `https://shop.example/item-${index}`;

/** What a provider counts for a request, by the run's own estimate. */
const counted = (request: ProviderRunRequest) => estimate([request.prompt, request.tools ?? [], request.history ?? []]);

function researcherTurn(clearing: boolean) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = requests.length;
      const calls: ModelToolCall[] = step <= STEPS ? [{ arguments: { url: url(step) }, id: `call-${step}`, name: "fetch_url" }] : [];
      return { finalProviderResponsePreview: {}, finalText: step <= STEPS ? "" : "Outcome: done\nFindings recorded.", toolCalls: calls,
        usage: { inputTokens: counted(request), outputTokens: 20 } };
    }
  };
  const saved = new Map<string, string>();
  const fetchUrl: EngineTool = {
    activity: () => ({ origin: "mcp", serverName: "Web", toolName: "fetch_url" }),
    definition: { capability: "web_fetch", description: "Read a page.", inputSchema: { type: "object" }, name: "fetch_url" },
    effects: "none",
    execute: async ({ call }) => ({ callId: call.id, content: [{ text: pageText(Number(String(call.arguments.url).split("-").at(-1))), type: "text" }],
      name: call.name, status: "complete" }),
    observationSource: "mcp"
  };
  const registry: ToolRegistry = { definitions: () => [fetchUrl.definition], resolve: (name) => name === "fetch_url" ? fetchUrl : undefined };
  const rows = new Map<string, ToolCallRow>();
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
        providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: "now", state: "running", toolName: input.toolName };
      rows.set(row.id, row);
      return { kind: "running", row };
    }),
    refuse: vi.fn(),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const recorded: TranscriptItem[] = [];
  const snapshot = { connection: {}, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
    providerFamily: "fake", providerModelId: "model-1" } as unknown as ProviderExecutionSnapshot;
  const modelCapabilities: ProviderModelCapabilities = { contextWindow: 400_000, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false,
    toolCalling: true, vision: false };
  const request = { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] }, modelCapabilities, modelId: "fake-qsa", params: {},
    prompt: { developer: null, system: "Workspace contract." }, provider: "fake", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto" } as unknown as ProviderRunRequest;
  const fences = createAgentUnknownEffects();
  const host: SubagentHost = {
    branchRunIds: [],
    buildRegistry: vi.fn(async () => registry),
    callTimeLeft: () => true,
    chatId: "chat",
    deadlineAt: Date.now() + 600_000,
    deadlineSignal: new AbortController().signal,
    followupTexts: () => [],
    maxToolCalls: null,
    maxToolRounds: null,
    now: Date.now,
    onWorkspaceLifecycle: vi.fn(async () => undefined),
    recordDetachedCompaction: vi.fn(async () => true),
    recordSearchEvidence: vi.fn(async () => undefined),
    request,
    requestShape: subagentRequestShape,
    ...(clearing ? { resultClearing: POLICY } : {}),
    route: vi.fn(async () => ({ ok: true as const, route: { adapter, request: { modelCapabilities, modelId: "fake-qsa", params: {}, provider: "fake",
      reasoningEffort: null }, snapshot, timeoutMs: 10_000 } })),
    runContextItems: [{ id: "ctx-0", kind: "user", runContext: true, text: "Skills index: research" }],
    saveResult: vi.fn(async (input) => {
      const handle = `tor1_${(saved.size + 1).toString(16).padStart(32, "0")}`;
      saved.set(handle, input.text);
      return { handle };
    }),
    settleTurn: vi.fn(async () => true),
    settleUsage: vi.fn(async () => undefined),
    signal: new AbortController().signal,
    toolCalls,
    toolState: { calls: 0 },
    toolTimeLeft: () => true,
    transcripts: {
      append: vi.fn(async (_scope, _from, items: readonly TranscriptItem[]) => { recorded.push(...items); }),
      loadRuns: vi.fn(async (input: Readonly<{ runIds: readonly string[] }>) =>
        new Map(input.runIds.map((runId): [string, TranscriptItem[]] => [runId, []]))),
      nextSequence: vi.fn(async () => 0),
      runLive: vi.fn(async () => true)
    },
    unknownEffects: (threadId) => fences.agent(threadId),
    usage: () => undefined,
    userFollowups: vi.fn(async () => []),
    userId: "user"
  };
  const binding: SubagentBinding = { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "connection-1",
    providerModelId: "model-1", reasoningEffort: null };
  const input: SubagentTurnInput = { binding, brief: "Compare mattresses on shop.example.\n\n# Research method (from the server)\nRecord each finding.",
    chatId: "chat", deadlineAt: new Date(Date.now() + 600_000), hostRunId: "run", mode: "foreground", name: "lab", parentRunId: "run",
    parentToolCallId: "call-row", signal: new AbortController().signal, threadId: "thread-1", turnId: "turn-1", type: null, userId: "user",
    userMessage: "Find me a mattress." };
  const reader = { read: async ({ handle }: { handle: string }) => {
    const text = saved.get(handle);
    return text === undefined ? null : { arguments: {}, text, toolName: "fetch_url" };
  } };
  const run = async () => {
    const runner = createSubagentRunner(host);
    return runner.wait(await runner.start(input));
  };
  return { reader, recorded, requests, run };
}

const outputsOf = (request: ProviderRunRequest) =>
  (request.history ?? []).flatMap((item) => item.type === "tool_result" ? [{ callId: item.callId, output: item.output }] : []);
const isStub = (output: string) => output.startsWith(CLEARED_RESULT_HEADING);

describe("a research researcher's context clearing", () => {
  it("keeps a 60-step researcher under the high mark after the first clearing, a recent page whole and an old one a stub with a working handle", async () => {
    const turn = researcherTurn(true);
    const result = await turn.run();
    expect(result).toMatchObject({ state: "done" });
    expect(turn.requests).toHaveLength(STEPS + 1);
    const counts = turn.requests.map(counted);
    const first = turn.requests.findIndex((request) => outputsOf(request).some(({ output }) => isStub(output)));
    expect(first).toBeGreaterThan(0);
    for (const count of counts.slice(first)) expect(count).toBeLessThanOrEqual(POLICY.clearAboveTokens);
    // Each clearing lands near the low mark and takes several steps to fill again, so the cache misses once per clearing.
    const clearings = counts.flatMap((count, index) => index > 0 && count < counts[index - 1]! ? [index] : []);
    expect(clearings.length).toBeGreaterThan(1);
    expect(clearings.length).toBeLessThan(STEPS / 4);
    expect(Math.max(...counts)).toBeLessThan(POLICY.clearAboveTokens + estimate(pageText(1)));

    const last = outputsOf(turn.requests.at(-1)!);
    expect(last).toHaveLength(STEPS);
    // The newest pages are whole; every older one is a stub whose handle reads the page back.
    expect(last.slice(-POLICY.keepRecentResults).map(({ output }) => output)).toEqual(
      Array.from({ length: POLICY.keepRecentResults }, (_, index) => pageText(STEPS - POLICY.keepRecentResults + 1 + index)));
    const old = last[0]!;
    expect(isStub(old.output)).toBe(true);
    expect(old.output).toContain(`characters of fetch_url url="${url(1)}"`);
    const handle = /"handle":"(tor1_[a-f0-9]{32})"/u.exec(old.output)?.[1];
    const read = await executeReadToolResult({ arguments: { handle }, id: "read-1", name: "read_tool_result" },
      { chatId: "chat", reader: turn.reader, userId: "user" });
    expect(JSON.parse(toolResultOutputText(read))).toMatchObject({ text: pageText(1), tool: "fetch_url" });
  });

  it("records the clearing with the thread, so a replay renders the same context byte for byte", async () => {
    const turn = researcherTurn(true);
    await turn.run();
    const stubs = turn.recorded.filter((item) => item.kind === "tool_result" && item.cleared === true);
    expect(stubs.length).toBeGreaterThan(0);
    // The thread's rows as a later turn loads them; the final answer came after the last request.
    const replayed = turn.recorded.map((item) => decodeTranscriptItem({ ...encodeTranscriptItem(item), id: item.id }));
    const answered = replayed.length - 1 - [...replayed].reverse().findIndex((item) => item.kind === "assistant_text");
    expect(replayed[answered]).toMatchObject({ kind: "assistant_text", text: "Outcome: done\nFindings recorded." });
    const live = turn.requests.at(-1)!.history!;
    // The run's own context (the Skills index and the turn's context) is rebuilt for every run and never recorded.
    const rebuilt = live.findIndex((item) => item.type === "user" && item.text.includes("Compare mattresses"));
    expect(rebuilt).toBe(2);
    const target = { model: "fake-qsa", provider: "connection-1" };
    expect(JSON.stringify(projectTranscript(replayed.slice(0, answered), target))).toBe(JSON.stringify(live.slice(rebuilt)));
  });

  it("keeps every page of a sub-agent whose host clears nothing", async () => {
    const turn = researcherTurn(false);
    await turn.run();
    const last = turn.requests.at(-1)!;
    expect(outputsOf(last).some(({ output }) => isStub(output))).toBe(false);
    expect(counted(last)).toBeGreaterThan(STEPS * estimate(pageText(1)) * 0.9);
    expect(turn.recorded.some((item) => item.kind === "tool_result" && item.cleared === true)).toBe(false);
  });
});
