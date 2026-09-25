import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ContextCompactionStatus } from "../../contracts/contextCompaction";
import { calculateContextBudgetLimits } from "../../domain/contextBudget";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "../providers/openRouterChatRequest";
import type { ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import { projectObservationForProvider } from "../toolObservations/projection";
import { anthropicMessagesToolBridge, openAIResponsesToolBridge, openRouterChatToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import type { ProviderToolBridge, RunTool, ToolExecutionResult } from "../tools/types";
import { conversationContextPolicy } from "./contextCompactionContract";
import { prepareCompactedProviderRequest } from "./contextCompactionConsumer";
import { createContextCompactionPublisher } from "./contextCompactionEvents";
import {
  contextObservationsFromResults,
  toolTranscriptReduction,
  toolTranscriptUnits,
  transcriptCoverageRef
} from "./contextCompactionPlanner";
import { contextSummarySource, type ContextSummaryReceipts } from "./contextCompactionSummarizer";
import { applyProviderRequestContextBudget, measureSessionContext } from "./runContextBudget";

type Wire = "anthropic" | "openai" | "openrouter";

const BRIDGES: Record<Wire, ProviderToolBridge> = {
  anthropic: anthropicMessagesToolBridge,
  openai: openAIResponsesToolBridge,
  openrouter: openRouterChatToolBridge
};

/** The reviewer probe: 16k window, 1k output reserve, 10% margin. */
const PROBE_WINDOW = 16_000;
const PROBE_OUTPUT = 1_000;
const PROBE_BUDGET = calculateContextBudgetLimits({ contextWindow: PROBE_WINDOW, maxOutputTokens: PROBE_OUTPUT }).budgetTokens;

const writeFileTool: RunTool = {
  capability: "workspace",
  description: "Write a Workspace file.",
  inputSchema: { additionalProperties: false, properties: { content: { type: "string" }, path: { type: "string" } },
    required: ["path", "content"], type: "object" },
  name: "write_file"
};

const hex = (seed: string, length: number) => createHash("sha256").update(seed).digest("hex").slice(0, length);

function writeResult(index: number, chars: number): ToolExecutionResult {
  return projectObservationForProvider({
    callId: `call_write_${index}`,
    content: [{ text: `Wrote src/file-${index}.ts RESULT_${index} ${"r".repeat(chars)}`, type: "text" }],
    name: "write_file",
    observation: { byteSize: chars + 64, checksum: hex(`checksum-${index}`, 64), encoding: "json-utf8-v1",
      handle: `tor1_${hex(`handle-${index}`, 32)}`, maskable: true, source: "workspace", sourceTruncated: false, version: 1 },
    status: "complete"
  });
}

/** One provider round as its bridge serializes it, including the reasoning or
 * thinking items the provider returned with the call. */
function writeRound(wire: Wire, index: number, argumentChars: number, resultChars: number) {
  const bridge = BRIDGES[wire];
  const callId = `call_write_${index}`;
  const args = { content: `ARGS_${index} ${"w".repeat(argumentChars)}`, path: `src/file-${index}.ts` };
  const providerMessage = wire === "openai"
    ? [{ encrypted_content: `enc-${index}`, id: `rs_${index}`, summary: [], type: "reasoning" },
      { arguments: JSON.stringify(args), call_id: callId, name: "write_file", status: "completed", type: "function_call" }]
    : wire === "anthropic"
      ? { content: [{ signature: `sig-${index}`, thinking: `plan ${index}`, type: "thinking" },
        { id: callId, input: args, name: "write_file", type: "tool_use" }], role: "assistant" }
      : undefined;
  const result = writeResult(index, resultChars);
  const items = [
    ...bridge.serializeAssistantToolCalls({ calls: [{ arguments: args, id: callId, name: "write_file" }],
      ...(providerMessage ? { providerMessage } : {}) }),
    bridge.appendToolResult(undefined, result)
  ];
  return { items, result };
}

function current(): ProviderConversationMessage {
  return { content: { blocks: [{ text: "Refactor the project files.", type: "text" }] }, id: "current", role: "user" };
}

function probeRequest(wire: Wire, providerToolMessages: unknown[]): ProviderRunRequest {
  const messages = [current()];
  return {
    attachmentIds: [], attachments: [], chatId: "chat-1",
    content: messages[0]!.content,
    context: { messages, mode: "branch_path" },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages, mode: "hybrid" }),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: PROBE_WINDOW, defaultMaxOutputTokens: PROBE_OUTPUT, nativePdfInput: false,
      nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: wire === "anthropic" ? "claude-test" : "gpt-test",
    params: {},
    prompt: { developer: null, system: "Accepted system" },
    provider: wire,
    providerToolMessages,
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto", toolObservationVersion: 1, tools: [readToolResultTool, writeFileTool]
  };
}

function rounds(wire: Wire, from: number, to: number, argumentChars = 6_000, resultChars = 400) {
  const built = Array.from({ length: to - from + 1 }, (_, offset) => writeRound(wire, from + offset, argumentChars, resultChars));
  return { items: built.flatMap((round) => round.items), results: built.map((round) => round.result) };
}

/** The probe transcript: ten old rounds and the newest batch. */
function probe(wire: Wire) {
  const old = rounds(wire, 1, 10);
  const newest = writeRound(wire, 11, 6_000, 3_000);
  return { items: [...old.items, ...newest.items], results: [...old.results, newest.result] };
}

function compaction(request: ProviderRunRequest, wire: Wire, results: readonly ToolExecutionResult[]) {
  const summaryRequests: ProviderRunRequest[] = [];
  const statuses: ContextCompactionStatus[] = [];
  const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
    summaryRequests.push(next);
    const output = JSON.stringify({ notes: `Notes ${summaryRequests.length}: files 1-${results.length} were written.`, sourceRefs: [] });
    yield { data: { delta: output }, type: "token" };
    return { finalProviderResponsePreview: {}, finalText: output, usage: { inputTokens: 5, outputTokens: 2 } };
  } };
  const settle = vi.fn<ContextSummaryReceipts["settle"]>(async () => undefined);
  const run = () => prepareCompactedProviderRequest({
    bridge: BRIDGES[wire],
    failure: (code, message) => Object.assign(new Error(message), { code }),
    observations: contextObservationsFromResults(results),
    publisher: createContextCompactionPublisher(async (status) => { statuses.push(status); }),
    receipts: { claim: async () => undefined, settle },
    request,
    signal: new AbortController().signal,
    summaryAdapter: adapter
  });
  return { run, settle, statuses, summaryRequests };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The provider request is valid for its protocol: no dangling call ids, and
 * reasoning/thinking items travel only with the calls they precede. */
function expectValidWire(wire: Wire, request: ProviderRunRequest): readonly string[] {
  const callIds: string[] = [];
  if (wire === "openai") {
    const input = (buildOpenAIResponsesRequest(request).input as unknown[]).map(record);
    const answered = new Set(input.filter((item) => item.type === "function_call_output").map((item) => String(item.call_id)));
    const seen = new Set<string>();
    input.forEach((item, index) => {
      if (item.type === "reasoning") expect(input[index + 1]?.type).toBe("function_call");
      if (item.type === "function_call") {
        seen.add(String(item.call_id));
        callIds.push(String(item.call_id));
        expect(answered.has(String(item.call_id))).toBe(true);
      }
      if (item.type === "function_call_output") expect(seen.has(String(item.call_id))).toBe(true);
    });
  } else if (wire === "openrouter") {
    const messages = buildOpenRouterChatRequest(request).messages.map(record);
    messages.forEach((message, index) => {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => String(record(call).id)) : [];
      if (calls.length === 0) {
        if (message.role === "tool") {
          const owner = messages.slice(0, index).reverse().find((candidate) => candidate.role !== "tool");
          expect((owner?.tool_calls as unknown[] | undefined)?.map((call) => record(call).id)).toContain(message.tool_call_id);
        }
        return;
      }
      callIds.push(...calls);
      const answers = messages.slice(index + 1, index + 1 + calls.length);
      expect(answers.map((answer) => [answer.role, answer.tool_call_id])).toEqual(calls.map((id) => ["tool", id]));
    });
  } else {
    const messages = (buildAnthropicMessagesRequest(request).messages as unknown[]).map(record);
    messages.forEach((message, index) => {
      if (index > 0) expect(message.role).not.toBe(messages[index - 1]!.role);
      const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
      const uses = blocks.filter((block) => block.type === "tool_use").map((block) => String(block.id));
      const answers = blocks.filter((block) => block.type === "tool_result").map((block) => String(block.tool_use_id));
      if (answers.length > 0) {
        const previous = (messages[index - 1]?.content as unknown[] | undefined ?? []).map(record);
        expect(answers).toEqual(previous.filter((block) => block.type === "tool_use").map((block) => String(block.id)));
      }
      if (uses.length > 0) {
        callIds.push(...uses);
        const next = (messages[index + 1]?.content as unknown[] | undefined ?? []).map(record);
        expect(next.filter((block) => block.type === "tool_result").map((block) => String(block.tool_use_id))).toEqual(uses);
      }
    });
    // The newest assistant turn keeps its signed thinking block first.
    const lastAssistant = messages.filter((message) => message.role === "assistant").at(-1);
    expect(record((lastAssistant?.content as unknown[])[0]).type).toBe("thinking");
  }
  return callIds;
}

describe("hybrid transcript minimum", () => {
  it.each(["openai", "openrouter", "anthropic"] as const)(
    "fits the reviewer probe after a summary by removing covered rounds as whole units (%s)", async (wire) => {
      expect(PROBE_BUDGET).toBe(13_400);
      const { items, results } = probe(wire);
      const request = probeRequest(wire, items);
      // Before: the transcript alone is far over budget, yet not irreducible.
      const measured = applyProviderRequestContextBudget({ bridge: BRIDGES[wire], observations: contextObservationsFromResults(results), request });
      expect(measured).toMatchObject({ ok: true, request: { contextCompaction: { outcome: "needs_summary" } } });

      const run = compaction(request, wire, results);
      const prepared = await run.run();
      expect(run.summaryRequests.length).toBeGreaterThan(0);
      expect(run.statuses.at(-1)).toMatchObject({ outcome: "summary_applied", state: "complete" });
      expect(prepared.contextCompaction!.afterTokens).toBeLessThanOrEqual(PROBE_BUDGET);
      expect(measureSessionContext({ bridge: BRIDGES[wire], observations: contextObservationsFromResults(results), request: prepared })
        .approximateInputTokens).toBeLessThanOrEqual(PROBE_BUDGET);

      // Old rounds left as whole units, oldest first; the newest batch is exact.
      const kept = prepared.providerToolMessages ?? [];
      const units = toolTranscriptUnits(kept);
      expect(units.every((unit) => unit.settled)).toBe(true);
      const keptCalls = units.flatMap((unit) => unit.callIds);
      expect(keptCalls.at(-1)).toBe("call_write_11");
      expect(keptCalls.length).toBeLessThan(11);
      expect(keptCalls).toEqual(Array.from({ length: keptCalls.length }, (_, index) => `call_write_${12 - keptCalls.length + index}`));
      const newestWire = JSON.stringify(kept.slice(units.at(-1)!.start));
      expect(newestWire).toContain("ARGS_11");
      expect(newestWire).toContain("RESULT_11");
      expect(JSON.stringify(kept)).not.toContain("ARGS_1 ");

      // The summary covered every round; its refs keep recall for the dropped calls.
      const summary = prepared.contextCompactionSummary!;
      expect(summary.sourceRefs).toContain(transcriptCoverageRef("call_write_11"));
      for (const result of results) expect(summary.sourceRefs).toContain(result.observation!.handle);
      expect(expectValidWire(wire, prepared)).toEqual(keptCalls);
    });

  it("buys an incremental summary (earlier notes plus the uncovered delta) when the transcript grows again", async () => {
    const wire = "openai";
    const first = probe(wire);
    const initial = await compaction(probeRequest(wire, first.items), wire, first.results).run();
    const coveredCalls = toolTranscriptUnits(initial.providerToolMessages ?? []).flatMap((unit) => unit.callIds);
    // Nine more rounds after the committed summary: none of them is covered.
    const later = rounds(wire, 12, 20);
    const newest = writeRound(wire, 21, 6_000, 3_000);
    const grown = { ...initial, providerToolMessages: [...initial.providerToolMessages!, ...later.items, ...newest.items] };
    const results = [...first.results, ...later.results, newest.result];
    const reduction = toolTranscriptReduction(grown);
    expect(reduction.covered.flatMap((unit) => unit.callIds)).toEqual(coveredCalls);
    expect(reduction.older.length).toBeGreaterThan(reduction.covered.length);

    const run = compaction(grown, wire, results);
    const prepared = await run.run();
    expect(run.summaryRequests.length).toBeGreaterThan(0);
    const envelopes = JSON.stringify(run.summaryRequests.map((request) => request.content));
    // The source is the earlier notes plus the delta: covered rounds are not re-read.
    expect(envelopes).toContain("previous-notes");
    expect(envelopes).toContain("Notes ");
    expect(envelopes).toContain("ARGS_12");
    const coveredArgs = coveredCalls.map((callId) => `ARGS_${callId.replace("call_write_", "")} `);
    for (const marker of coveredArgs) expect(envelopes).not.toContain(marker);
    expect(contextSummarySource(grown, contextObservationsFromResults(results)).units
      .some((unit) => coveredArgs.some((marker) => unit.text.includes(marker)))).toBe(false);

    const summary = prepared.contextCompactionSummary!;
    expect(summary.id).not.toBe(initial.contextCompactionSummary!.id);
    expect(summary.sourceRefs).toContain(transcriptCoverageRef("call_write_21"));
    // Handles of calls that left in the first cycle stay citable for recall.
    for (const result of results) expect(summary.sourceRefs).toContain(result.observation!.handle);
    expect(prepared.contextCompaction!.afterTokens).toBeLessThanOrEqual(PROBE_BUDGET);
    const keptCalls = expectValidWire(wire, prepared);
    expect(keptCalls.at(-1)).toBe("call_write_21");
    expect(keptCalls).not.toContain("call_write_12");
  });

  it("keeps a genuinely irreducible newest batch as context_too_large and names it as the cause", () => {
    const wire = "openai";
    const old = rounds(wire, 1, 3);
    const newest = writeRound(wire, 4, 60_000, 400);
    const results = [...old.results, newest.result];
    const refused = applyProviderRequestContextBudget({ bridge: BRIDGES[wire], observations: contextObservationsFromResults(results),
      request: probeRequest(wire, [...old.items, ...newest.items]) });
    expect(refused).toMatchObject({ ok: false, error: { code: "context_too_large" } });
    if (refused.ok) return;
    expect(refused.error.message).toMatch(/^The newest tool results \(about \d+ estimated tokens\) do not fit beside the prompt, pinned context, current message, and tools \(about \d+ estimated tokens\)/u);
    expect(refused.error.message).toContain(`(${PROBE_BUDGET} estimated tokens available)`);
  });

  it("never removes the newest batch, an unsettled round or a clarification tail, and never splits a parallel batch", () => {
    const call = (id: string) => ({ arguments: "{}", call_id: id, name: "write_file", type: "function_call" });
    const output = (id: string) => ({ call_id: id, output: `done ${id}`, type: "function_call_output" });
    const clarification = { content: "Also update the README.", role: "user" };
    const messages = [
      { encrypted_content: "enc", id: "rs_a", summary: [], type: "reasoning" }, call("a1"), call("a2"), output("a2"), output("a1"),
      call("b1"), output("b1"), output("stray"),
      call("c1"), call("c2"), output("c1"),
      call("d1"), output("d1"),
      clarification
    ];
    const units = toolTranscriptUnits(messages);
    expect(units.map((unit) => [unit.start, unit.end, unit.callIds, unit.settled])).toEqual([
      [0, 5, ["a1", "a2"], true],
      [5, 8, ["b1"], false],
      [8, 11, ["c1", "c2"], false],
      [11, 13, ["d1"], true],
      [13, 14, [], false]
    ]);
    const request = probeRequest("openai", messages);
    const summary = { formatVersion: 1 as const, id: `cs1_${"e".repeat(32)}`, notes: "Notes.", sourceDigest: "f".repeat(64),
      sourceRefs: [transcriptCoverageRef("d1")] };
    const summarized: ProviderRunRequest = { ...request, contextCompactionSummary: summary,
      context: { ...request.context!, messages: [{ content: { blocks: [{ text: "Notes.", type: "text" }] },
        id: `__context-summary-${summary.id}`, role: "assistant" }, current()] } };
    const reduction = toolTranscriptReduction(summarized);
    // Only the settled parallel batch older than the newest batch may leave, whole.
    expect(reduction.older.map((unit) => unit.callIds)).toEqual([["a1", "a2"]]);
    expect(reduction.covered.map((unit) => unit.callIds)).toEqual([["a1", "a2"]]);
    // Notes carried from an earlier turn, or a provider continuation, cover nothing here.
    expect(toolTranscriptReduction({ ...summarized, contextCompactionPolicy: { ...summarized.contextCompactionPolicy!,
      reuse: { coveredMessageId: "x", runId: "earlier", summary } } }).covered).toEqual([]);
    expect(toolTranscriptReduction({ ...summarized, previousProviderResponseId: "resp_1" }).older).toEqual([]);
  });
});
