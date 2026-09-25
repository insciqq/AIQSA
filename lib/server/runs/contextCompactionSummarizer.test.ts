import { describe, expect, it } from "vitest";
import type { ContextSummary, ContextSummaryAttempt } from "../../contracts/contextCompaction";
import { calculateContextBudgetLimits, estimateApproxTokens } from "../../domain/contextBudget";
import type { NormalizedTokenUsage } from "../../domain/usage";
import { ProviderRequestTimeoutError } from "../providers/network";
import type { NormalizedSearchPlanOption, ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import { CONTEXT_COMPACTION_LIMITS, conversationContextPolicy } from "./contextCompactionContract";
import { contextObservationsFromResults } from "./contextCompactionPlanner";
import {
  applyContextSummaryToRequest,
  applyReusedContextSummary,
  contextSummaryIsCurrent,
  contextSummarySource,
  ContextSummaryError,
  executeContextSummary,
  type ContextSummaryReceipts
} from "./contextCompactionSummarizer";

function text(value: string, id: string, role: "assistant" | "user" = "user",
  purpose?: ProviderConversationMessage["purpose"]): ProviderConversationMessage {
  return { content: { blocks: [{ text: value, type: "text" }] }, id, role, ...(purpose ? { purpose } : {}) };
}

/** Budget 3,200 tokens: a 640-token exact tail share and room for one call. */
function request(input: Readonly<{
  messages?: readonly ProviderConversationMessage[];
  window?: number;
  maxOutputTokens?: number;
  overrides?: Partial<ProviderRunRequest>;
}> = {}): ProviderRunRequest {
  const messages = [...(input.messages ?? [
    text(`old rare fact and user correction ${"o".repeat(4_000)}`, "message-old"),
    text("Acknowledged.", "reply-old", "assistant"),
    text("current request", "message-current")
  ])];
  return {
    attachmentIds: [], attachments: [], chatId: "chat", content: messages.at(-1)!.content,
    context: { messages, mode: "branch_path" },
    contextCompaction: { afterTokens: 4_000, beforeTokens: 4_000, budgetTokens: 3_200, legacyFallback: false,
      maskedBatches: 0, maskedObservations: 0, outcome: "needs_summary", version: 1 },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: messages.at(-1)!.id, messages, mode: "hybrid" }),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: input.window ?? 16_000, defaultMaxOutputTokens: 256, maxOutputTokens: input.maxOutputTokens ?? 1_024,
      nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
    modelId: "answer-model", params: { reasoning: { effort: "low" } }, prompt: { developer: null, system: "ordinary prompt" }, provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", toolObservationVersion: 1,
    ...input.overrides
  };
}

type Output = string | ((request: ProviderRunRequest) => string);

function adapter(outputs: readonly Output[], calls: ProviderRunRequest[], log: string[] = []): Pick<ProviderAdapter, "stream"> {
  let index = 0;
  return {
    async *stream(next) {
      calls.push(next);
      log.push("dispatch");
      const output = outputs[index++] ?? outputs.at(-1) ?? "{}";
      const value = typeof output === "function" ? output(next) : output;
      yield { data: { delta: value }, type: "token" };
      yield { data: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, type: "usage" };
      return { finalProviderResponsePreview: {}, finalText: value, usage: {} };
    }
  };
}

function receipts(log: string[] = []) {
  const claims: ContextSummaryAttempt[] = [];
  const settled: Array<{ attempt: ContextSummaryAttempt; summary?: ContextSummary; usage: NormalizedTokenUsage }> = [];
  const hooks: ContextSummaryReceipts = {
    async claim(attempt) { claims.push(attempt); log.push(`claim:${attempt.attempt}`); },
    async settle(attempt, usage, summary) {
      settled.push({ attempt, usage, ...(summary ? { summary } : {}) });
      log.push(`settle:${attempt.state}:${attempt.attempt}`);
    }
  };
  return { claims, hooks, settled };
}

const json = (notes: string, sourceRefs: readonly string[] = []) => JSON.stringify({ notes, sourceRefs });
const envelopeText = (value: ProviderRunRequest) => (value.content.blocks[0] as { text: string }).text;

describe("context compaction summarizer", () => {
  it("keeps the summary as derived context with the current input and a token-bounded tail", async () => {
    const calls: ProviderRunRequest[] = [];
    const pin = text("exact pinned evidence", "knowledge-evidence:v1", "user", "knowledge_evidence");
    const source = request({ messages: [
      text(`old rare fact ${"o".repeat(4_000)}`, "message-old"), text("Acknowledged.", "reply-old", "assistant"),
      pin, text("current request", "message-current")
    ] });
    const summarized = await executeContextSummary({
      adapter: adapter([json("Rare fact is preserved; user correction wins.", ["message-old"])], calls),
      request: source
    });
    expect(calls).toHaveLength(1);
    expect(summarized.summary.sourceDigest).toBe(contextSummarySource(source).digest);
    expect(summarized.summary.sourceRefs).toEqual(expect.arrayContaining(["message-current", "reply-old", "message-old"]));
    expect(contextSummaryIsCurrent(summarized.request)).toBe(true);
    // The large old message is replaced by notes; pins keep their bytes and
    // stay directly before the current message.
    expect(summarized.request.context?.messages.map(message => message.id)).toEqual([
      `__context-summary-${summarized.summary.id}`, "reply-old", pin.id, "message-current"
    ]);
    expect(summarized.request.context?.messages.at(-2)).toEqual(pin);
    expect(envelopeText(calls[0]!)).not.toContain("exact pinned evidence");
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.toolChoice).toBe("none");
    expect(calls[0]?.previousProviderResponseId).toBeUndefined();
  });

  it("uses the accepted utility allowance instead of a fixed cap", async () => {
    const calls: ProviderRunRequest[] = [];
    await executeContextSummary({
      adapter: adapter([json("bounded notes", ["message-old"])], calls),
      request: request({ overrides: { generationBudget: { version: 1, contextWindow: 16_000, maxOutputTokens: 2_048, timeoutMs: 30_000 } } })
    });
    expect(calls[0]?.params.maxOutputTokens).toBe(2_048);
  });

  it("strips Memory, Knowledge, Search, attachments and tools while keeping the answer binding", async () => {
    const calls: ProviderRunRequest[] = [];
    const hosted = { adapterKind: "answer_provider_hosted", config: {}, credentialMode: "installation", executionModes: ["all_selected"],
      modelId: "answer-model", optionId: "openai-native-web-search", protocol: "openai_responses_web_search", provider: "openai",
      providerModelId: null, revisionId: "revision", searchStrategyRowId: "row" } as unknown as NormalizedSearchPlanOption;
    const source = request({ overrides: {
      artifactTool: true,
      attachmentIds: ["attachment-1"],
      attachments: [{ byteSize: 10, extractedText: "PRIVATE_ATTACHMENT_TEXT", fileName: "a.txt", id: "attachment-1", kind: "document",
        metadata: {}, mimeType: "text/plain", status: "ready" }],
      imagePlan: { version: 1 } as unknown as ProviderRunRequest["imagePlan"],
      knowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 },
      params: { maxTokens: 999, max_output_tokens: 999, reasoning: { effort: "high" } },
      personalContext: { approxTokens: 5, itemCount: 1, memoryGeneration: 1, memoryRevision: 1, mode: "prefetched",
        text: "PRIVATE_MEMORY_TEXT" },
      previousProviderResponseId: "response-previous",
      reasoningEffort: "high",
      searchPlan: { mode: "all_selected", options: [hosted] },
      toolChoice: "auto",
      tools: [readToolResultTool]
    } });
    await executeContextSummary({ adapter: adapter([json("bounded notes", ["message-old"])], calls), request: source });
    const summary = calls[0]!;
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_MEMORY_TEXT|PRIVATE_ATTACHMENT_TEXT|response-previous/u);
    expect(summary).not.toHaveProperty("personalContext");
    expect(summary).not.toHaveProperty("artifactTool");
    expect(summary).not.toHaveProperty("imagePlan");
    expect(summary).toMatchObject({ attachmentIds: [], attachments: [], knowledgePlan: { mode: "none" },
      searchPlan: { options: [] }, toolChoice: "none", toolMode: "none" });
    expect(openAIResponsesToolBridge.serializeHostedTools?.(summary)).toEqual([]);
    // Same binding: provider, model, capabilities and the admitted reasoning
    // directive, with one canonical output allowance.
    expect(summary).toMatchObject({ modelCapabilities: source.modelCapabilities, modelId: source.modelId, provider: source.provider,
      reasoningEffort: "high" });
    expect(summary.params).toEqual({ maxOutputTokens: 1_024, reasoning: { effort: "high" } });
  });

  it("repairs one invalid response on the same binding with a bounded hint, never echoing it", async () => {
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    const summarized = await executeContextSummary({
      adapter: adapter(["INVALID_OUTPUT_CANARY", json("bounded notes", ["message-old"])], calls),
      receipts: recorded.hooks,
      request: request()
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.system).toContain("did not satisfy the server contract");
    expect(JSON.stringify(calls[1])).not.toContain("INVALID_OUTPUT_CANARY");
    expect(summarized.attempts.map(({ attempt, state }) => [attempt, state])).toEqual([[1, "invalid"], [2, "committed"]]);
    expect(recorded.settled.map(({ attempt }) => attempt.state)).toEqual(["invalid", "committed"]);
    expect(recorded.settled.at(-1)?.summary).toEqual(summarized.summary);
  });

  it("rejects a provider that invents source references", async () => {
    const calls: ProviderRunRequest[] = [];
    await expect(executeContextSummary({
      adapter: adapter([json("unsafe", ["invented"]), json("still unsafe", ["invented"])], calls),
      request: request()
    })).rejects.toMatchObject({ code: "context_compaction_summary_invalid" });
    expect(calls).toHaveLength(2);
  });

  it("does not pay again when the committed summary is already applied", async () => {
    const calls: ProviderRunRequest[] = [];
    const first = await executeContextSummary({ adapter: adapter([json("once", ["message-old"])], calls), request: request() });
    const second = await executeContextSummary({
      adapter: adapter([json("should not run")], calls),
      existingAttempts: first.attempts,
      existingSummary: first.summary,
      request: first.request
    });
    expect(second.summary.id).toBe(first.summary.id);
    expect(calls).toHaveLength(1);
  });

  it("claims every paid call durably before dispatch and settles it with its usage", async () => {
    const log: string[] = [];
    const recorded = receipts(log);
    const summarized = await executeContextSummary({
      adapter: adapter([json("bounded notes", ["message-old"])], [], log),
      receipts: recorded.hooks,
      request: request()
    });
    expect(log).toEqual(["claim:1", "dispatch", "settle:committed:1"]);
    expect(recorded.claims[0]).toMatchObject({ attempt: 1, state: "claim", sourceDigest: summarized.summary.sourceDigest });
    expect(recorded.claims[0]?.id).toBe(recorded.settled[0]?.attempt.id);
    expect(recorded.settled[0]).toMatchObject({ attempt: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      usage: { completeness: "complete", inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  });

  it("continues the attempt counter from durable receipts and holds the cap across a restart", async () => {
    const source = request();
    const digest = contextSummarySource(source).digest;
    const earlier = (count: number): ContextSummaryAttempt[] => Array.from({ length: count }, (_, index) => ({
      attempt: index + 1, bindingDigest: "b".repeat(64), errorCode: "context_compaction_summary_invalid",
      id: `csa1_earlier_${index}`, sourceDigest: digest, state: "invalid"
    }));
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    await expect(executeContextSummary({
      adapter: adapter(["not-json"], calls), existingAttempts: earlier(CONTEXT_COMPACTION_LIMITS.summaryCalls - 1),
      receipts: recorded.hooks, request: source
    })).rejects.toMatchObject({ code: "context_compaction_summary_failed" });
    // The restart continued at the next number and stopped at the cap.
    expect(calls).toHaveLength(1);
    expect(recorded.claims.map(({ attempt }) => attempt)).toEqual([CONTEXT_COMPACTION_LIMITS.summaryCalls]);
    await expect(executeContextSummary({
      adapter: adapter([json("never")], calls), existingAttempts: earlier(CONTEXT_COMPACTION_LIMITS.summaryCalls), request: source
    })).rejects.toMatchObject({ code: "context_compaction_summary_failed" });
    expect(calls).toHaveLength(1);
  });

  it.each(["claim", "unknown"] as const)("never repeats a %s call for the same source", async state => {
    const source = request();
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    await expect(executeContextSummary({
      adapter: adapter([json("never")], calls), receipts: recorded.hooks, request: source,
      existingAttempts: [{ attempt: 1, bindingDigest: "b".repeat(64), id: "csa1_lost", sourceDigest: contextSummarySource(source).digest, state }]
    })).rejects.toMatchObject({ code: "context_compaction_outcome_unknown" });
    expect(calls).toHaveLength(0);
    expect(recorded.claims).toHaveLength(0);
  });

  it("records Stop during a paid call as unknown and keeps the cancellation", async () => {
    const controller = new AbortController();
    const recorded = receipts();
    const stopping: Pick<ProviderAdapter, "stream"> = { async *stream() {
      yield { data: { inputTokens: 7 }, type: "usage" };
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    } };
    const failure = await executeContextSummary({ adapter: stopping, receipts: recorded.hooks, request: request(), signal: controller.signal })
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(ContextSummaryError);
    expect(recorded.settled).toEqual([expect.objectContaining({ attempt: expect.objectContaining({ state: "unknown" }),
      usage: expect.objectContaining({ completeness: "partial", inputTokens: 7 }) })]);
  });

  it.each([
    ["transport", new Error("socket hang up")],
    ["rate limit", Object.assign(new Error("rate limited"), { status: 429 })],
    ["server error", Object.assign(new Error("upstream"), { status: 503 })],
    ["timeout", new ProviderRequestTimeoutError(30_000)]
  ])("classifies a provider %s failure as provider_failed with its partial usage", async (_label, error) => {
    const recorded = receipts();
    const failing: Pick<ProviderAdapter, "stream"> = { async *stream() {
      yield { data: { inputTokens: 14, outputTokens: 1, totalTokens: 15 }, type: "usage" };
      throw error;
    } };
    await expect(executeContextSummary({ adapter: failing, receipts: recorded.hooks, request: request() }))
      .rejects.toMatchObject({ code: "context_compaction_provider_failed" });
    expect(recorded.settled).toEqual([expect.objectContaining({
      attempt: expect.objectContaining({ errorCode: "context_compaction_provider_failed", state: "failed" }),
      usage: expect.objectContaining({ completeness: "partial", inputTokens: 14, outputTokens: 1, totalTokens: 15 })
    })]);
  });

  it("keeps an owner-classified authority failure's own code", async () => {
    const denied = Object.assign(new Error("model gone"), { code: "model_not_available" });
    const failing: Pick<ProviderAdapter, "stream"> = { async *stream() { throw denied; } };
    await expect(executeContextSummary({ adapter: failing, request: request() })).rejects.toBe(denied);
  });

  it("fails closed as source_unavailable when a referenced original cannot be read", async () => {
    const settled = [
      projectObservationForProvider({ callId: "older", content: [{ text: "older result", type: "text" }], name: "read_record",
        observation: { byteSize: 20_000, checksum: "a".repeat(64), encoding: "json-utf8-v1", handle: `tor1_${"a".repeat(32)}`,
          maskable: true, source: "mcp", sourceTruncated: false, version: 1 }, status: "complete" })
    ];
    const masked = openAIResponsesToolBridge.appendToolResult(undefined, { callId: "older", name: "read_record", status: "complete",
      content: [{ type: "json", value: { observation: settled[0]!.observation, reader: "read_tool_result" } }] });
    const calls: ProviderRunRequest[] = [];
    const checked: string[][] = [];
    await expect(executeContextSummary({
      adapter: adapter([json("never")], calls),
      observations: contextObservationsFromResults(settled),
      request: request({ overrides: { providerToolMessages: [{ call_id: "older", name: "read_record", type: "function_call" }, masked] } }),
      sourceAvailable: async handles => { checked.push([...handles]); return false; }
    })).rejects.toMatchObject({ code: "context_compaction_source_unavailable" });
    expect(checked).toEqual([[`tor1_${"a".repeat(32)}`]]);
    expect(calls).toHaveLength(0);
  });

  it("summarizes an oversized source in bounded parts oldest first, then one reduction", async () => {
    // 4,000-token window, 256-token output: every call must fit 3,600 tokens.
    const history = Array.from({ length: 10 }, (_, index) =>
      text(`MESSAGE_${index} ${String(index).repeat(2_000)}`, `h${index}`, index % 2 ? "assistant" : "user"));
    const source = request({ maxOutputTokens: 256, window: 4_000, messages: [...history, text("CURRENT_QUESTION", "current")],
      overrides: { providerToolMessages: [{ call_id: "tool-1", name: "read_record", type: "function_call" },
        { call_id: "tool-1", output: "NEWEST_TOOL_RESULT", type: "function_call_output" }] } });
    const capacity = calculateContextBudgetLimits({ contextWindow: 4_000 }).budgetTokens;
    const calls: ProviderRunRequest[] = [];
    const summarized = await executeContextSummary({
      adapter: adapter([(next) => {
        const body = envelopeText(next);
        expect(estimateApproxTokens(next.prompt.system) + estimateApproxTokens(body) + Number(next.params.maxOutputTokens))
          .toBeLessThanOrEqual(capacity);
        return next.prompt.system!.includes("notes of consecutive parts")
          ? json("combined notes of every part")
          : json(`part notes ${calls.length}`);
      }], calls),
      request: source
    });
    const bodies = calls.map(envelopeText);
    const partials = calls.filter(call => !call.prompt.system!.includes("notes of consecutive parts"));
    expect(partials.length).toBeGreaterThan(1);
    expect(calls).toHaveLength(partials.length + 1);
    // Nothing is cut: every message reaches a part, oldest first, and the
    // newest messages and tool results arrive in the last part.
    for (const [index, message] of history.entries()) {
      expect(bodies.slice(0, partials.length).some(body => body.includes(`id="${message.id}"`))).toBe(true);
      expect(bodies.slice(0, partials.length).join("").split(String(index).repeat(2_000)).length).toBeGreaterThan(1);
    }
    expect(bodies[0]).toContain('id="h0"');
    expect(bodies[partials.length - 1]).toContain("CURRENT_QUESTION");
    expect(bodies[partials.length - 1]).toContain("NEWEST_TOOL_RESULT");
    expect(bodies.at(-1)).toContain("part notes");
    expect(summarized.summary.notes).toBe("combined notes of every part");
    // Digest and references describe exactly what was sent.
    expect(summarized.summary.sourceDigest).toBe(contextSummarySource(source).digest);
    for (const ref of summarized.summary.sourceRefs.filter(ref => !ref.startsWith("ctxr1_"))) {
      expect(bodies.some(body => body.includes(ref))).toBe(true);
    }
    expect(summarized.attempts.map(({ state }) => state)).toEqual([...partials.map(() => "settled"), "committed"]);
  });

  it("summarizes the newest span when the source needs more calls than a plan may use", async () => {
    // 4,000-token window: about 3,000 input tokens per call; 30,000 tokens of history.
    const history = Array.from({ length: 60 }, (_, index) =>
      text(`TURN_${index} ${String(index % 10).repeat(2_000)}`, `h${index}`, index % 2 ? "assistant" : "user"));
    const source = request({ maxOutputTokens: 256, window: 4_000, messages: [...history, text("CURRENT_QUESTION", "current")],
      overrides: { providerToolMessages: [{ call_id: "tool-1", name: "read_record", type: "function_call" },
        { call_id: "tool-1", output: "NEWEST_TOOL_RESULT", type: "function_call_output" }] } });
    const calls: ProviderRunRequest[] = [];
    const summarized = await executeContextSummary({
      adapter: adapter([json("span notes")], calls), request: source
    });
    const omitted = summarized.omitted!;
    // Whole turns (user and reply) leave oldest first; the newest stay.
    expect(omitted.messages).toBeGreaterThan(0);
    expect(omitted.messages % 2).toBe(0);
    expect(omitted.tokens).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(CONTEXT_COMPACTION_LIMITS.summaryPlannedCalls);
    const bodies = calls.map(envelopeText).join("\n");
    expect(bodies).not.toContain('id="h0"');
    expect(bodies).not.toContain(`id="h${omitted.messages - 1}"`);
    expect(bodies).toContain(`id="h${omitted.messages}"`);
    expect(bodies).toContain("CURRENT_QUESTION");
    expect(bodies).toContain("NEWEST_TOOL_RESULT");
    // Digest and refs describe only the summarized span.
    const span: ProviderRunRequest = { ...source, context: { mode: "branch_path", messages: source.context!.messages.slice(omitted.messages) } };
    expect(summarized.summary.sourceDigest).toBe(contextSummarySource(span).digest);
    expect(summarized.summary.sourceDigest).not.toBe(contextSummarySource(source).digest);
    expect(summarized.summary.sourceRefs).not.toContain("h0");
    expect(summarized.summary.sourceRefs).toContain(`h${omitted.messages}`);
    expect(summarized.request.context?.messages.some(message => message.id === "h0")).toBe(false);
  });

  it("refuses as irreducible when even the newest span cannot be covered, before any paid call", async () => {
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    await expect(executeContextSummary({
      adapter: adapter([json("never")], calls), receipts: recorded.hooks,
      request: request({ maxOutputTokens: 256, window: 4_000, messages: [
        text(`old ${"o".repeat(4_000)}`, "old"), text(`HUGE_CURRENT ${"c".repeat(240_000)}`, "current")
      ] })
    })).rejects.toMatchObject({ code: "context_too_large" });
    expect(calls).toHaveLength(0);
    expect(recorded.claims).toHaveLength(0);
  });

  it("re-summarizes incrementally: earlier notes come first and a rare early fact and its handle survive", async () => {
    const handle = `tor1_${"c".repeat(32)}`;
    const settled = [projectObservationForProvider({ callId: "early", content: [{ text: "early result", type: "text" }],
      name: "read_record", status: "complete", observation: { byteSize: 20_000, checksum: "c".repeat(64), encoding: "json-utf8-v1",
        handle, maskable: true, source: "mcp", sourceTruncated: false, version: 1 } })];
    const observations = contextObservationsFromResults(settled);
    const masked = openAIResponsesToolBridge.appendToolResult(undefined, { callId: "early", name: "read_record", status: "complete",
      content: [{ type: "json", value: { observation: settled[0]!.observation, reader: "read_tool_result" } }] });
    // Extractive fake summarizer: keeps every FACT token its input carries.
    const extractive = (next: ProviderRunRequest) =>
      json([...new Set(envelopeText(next).match(/FACT_[A-Z0-9]+/gu) ?? [])].join(" ") || "no facts");
    const history = [
      text(`FACT_RARE7731 ${"a".repeat(3_000)}`, "h0"), text(`${"b".repeat(3_000)}`, "h1", "assistant"),
      text(`FACT_MIDDLE ${"c".repeat(3_000)}`, "h2"), text("Noted.", "h3", "assistant"), text("current one", "current-1")
    ];
    const calls: ProviderRunRequest[] = [];
    const first = await executeContextSummary({
      adapter: adapter([extractive], calls), observations,
      request: request({ messages: history, overrides: { providerToolMessages: [
        { call_id: "early", name: "read_record", type: "function_call" }, masked] } })
    });
    expect(first.summary.notes).toContain("FACT_RARE7731");
    expect(first.summary.sourceRefs).toContain(handle);

    // A later cycle: new history after the kept tail, a new current message,
    // and the early observation no longer in the provider transcript.
    const delta = Array.from({ length: 3 }, (_, index) => text(`FACT_LATE${index} ${"d".repeat(2_400)}`, `n${index}`,
      index % 2 ? "assistant" : "user"));
    const later: ProviderRunRequest = { ...first.request,
      context: { mode: "branch_path", messages: [...first.request.context!.messages.slice(0, -1), ...delta, text("current two", "current-2")] },
      providerToolMessages: [] };
    const second = await executeContextSummary({
      adapter: adapter([extractive], calls), existingAttempts: first.attempts, existingSummary: first.summary, observations, request: later
    });
    const body = envelopeText(calls.at(-1)!);
    expect(body.indexOf("<previous-notes")).toBe("<context-source>\n".length);
    expect(body).toContain(handle);
    expect(second.summary.notes).toContain("FACT_RARE7731");
    expect(second.summary.notes).toContain("FACT_LATE0");
    expect(second.summary.sourceRefs).toContain(handle);
    expect(second.request.context?.messages.some(message => message.id === `__context-summary-${first.summary.id}`)).toBe(false);
  });

  it("joins earlier notes to the reduction verbatim when the source needs several calls", async () => {
    const earlier: ContextSummary = { formatVersion: 1, id: "cs1_earlier", notes: "FACT_RARE7731 from the first third",
      sourceDigest: "e".repeat(64), sourceRefs: ["h-first"] };
    const messages = [
      text(`Model-derived context notes (verify against exact sources):\n${earlier.notes}`, "__context-summary-cs1_earlier", "assistant"),
      ...Array.from({ length: 8 }, (_, index) => text(`FACT_DELTA${index} ${"x".repeat(2_000)}`, `d${index}`,
        index % 2 ? "assistant" : "user")),
      text("current", "current")
    ];
    const calls: ProviderRunRequest[] = [];
    const summarized = await executeContextSummary({
      adapter: adapter([(next) => json([...new Set(envelopeText(next).match(/FACT_[A-Z0-9]+/gu) ?? [])].join(" "))], calls),
      existingSummary: earlier,
      request: request({ maxOutputTokens: 256, messages, window: 4_000, overrides: { contextCompactionSummary: earlier } })
    });
    const bodies = calls.map(envelopeText);
    expect(bodies.slice(0, -1).every(body => !body.includes("<previous-notes"))).toBe(true);
    expect(bodies.at(-1)).toContain("<previous-notes");
    expect(summarized.summary.notes).toContain("FACT_RARE7731");
    expect(summarized.summary.sourceRefs).toContain("h-first");
  });

  it("never keeps a superseded summary note as recent history", () => {
    const old: ContextSummary = { formatVersion: 1, id: "cs1_old", notes: "old notes", sourceDigest: "a".repeat(64), sourceRefs: [] };
    const next: ContextSummary = { formatVersion: 1, id: "cs1_new", notes: "new notes", sourceDigest: "b".repeat(64), sourceRefs: [] };
    const source = request({ messages: [text("old notes", "__context-summary-cs1_old", "assistant"), text("recent", "recent"),
      text("current", "current")], overrides: { contextCompactionSummary: old } });
    expect(applyContextSummaryToRequest(source, next).context?.messages.map(message => message.id))
      .toEqual(["__context-summary-cs1_new", "recent", "current"]);
  });

  describe("notes carried from an earlier turn", () => {
    const carriedNotes: ContextSummary = { formatVersion: 1, id: "cs1_carried", notes: "FACT_RARE7731 was agreed in turn one.",
      sourceDigest: "c".repeat(64), sourceRefs: ["u1", "u2"] };
    // Budget 3,200: the exact tail may hold four messages within 640 tokens.
    const branch = [
      text("FACT_RARE7731 " + "o".repeat(2_000), "u1"), text("a".repeat(2_000), "a1", "assistant"),
      text("second question", "u2"), text("second answer", "a2", "assistant"),
      text("third question", "u3"), text("third answer", "a3", "assistant"),
      text("exact pin", "skill-context:v1", "user", "skill_context"),
      text("current request", "current-user-message")
    ];
    const reused = (coveredMessageId = "u2") => {
      const base = request({ messages: branch });
      return { ...base, contextCompactionPolicy: { ...base.contextCompactionPolicy!,
        reuse: { coveredMessageId, runId: "run-2", summary: carriedNotes } } };
    };

    it("stands only for the covered prefix: later branch messages stay exact and pins stay before the current input", () => {
      const projected = applyReusedContextSummary(reused())!;
      expect(projected.context?.messages.map((message) => message.id)).toEqual([
        "__context-summary-cs1_carried", "u2", "a2", "u3", "a3", "skill-context:v1", "current-user-message"
      ]);
      expect(projected.contextCompactionSummary).toBe(carriedNotes);
      expect(JSON.stringify(projected.context)).not.toContain("o".repeat(64));
      expect(applyReusedContextSummary(reused("u2-sibling"))).toBeNull();
      // Recovery re-applies the checkpoint's carried notes to the exact branch identically.
      expect(applyContextSummaryToRequest(reused(), carriedNotes)).toEqual(projected);
    });

    it("is never current in the carrying run, even for an identical current message", () => {
      const base = reused();
      const revision = contextSummarySource(base).revision;
      const identical = { ...carriedNotes, sourceRefs: [revision] };
      const request = { ...base, contextCompactionPolicy: { ...base.contextCompactionPolicy!,
        reuse: { ...base.contextCompactionPolicy!.reuse!, summary: identical } } };
      const projected = applyContextSummaryToRequest(request, identical);
      expect(contextSummaryIsCurrent(projected)).toBe(false);
      // The same notes bought by this run would be current.
      const { reuse: _reuse, ...own } = projected.contextCompactionPolicy!;
      void _reuse;
      expect(contextSummaryIsCurrent({ ...projected, contextCompactionPolicy: own })).toBe(true);
    });

    it("summarizes previous notes plus the exact delta, and the new notes cover everything", async () => {
      const calls: ProviderRunRequest[] = [];
      const projected = applyReusedContextSummary(reused())!;
      const summarized = await executeContextSummary({
        adapter: adapter([json("FACT_RARE7731 still binds; third turn settled.")], calls),
        existingSummary: carriedNotes,
        request: projected
      });
      expect(calls).toHaveLength(1);
      const body = envelopeText(calls[0]!);
      expect(body.indexOf("<previous-notes")).toBeLessThan(body.indexOf("third question"));
      expect(body).toContain("FACT_RARE7731 was agreed");
      expect(body).not.toContain("o".repeat(64));
      // New notes cover the carried notes and every exact message; only the bounded tail stays verbatim.
      expect(summarized.request.context?.messages.map((message) => message.id)).toEqual([
        "__context-summary-" + summarized.summary.id, "u2", "a2", "u3", "a3", "skill-context:v1", "current-user-message"
      ]);
      // Recovery rebuilds the same request from the exact branch and the new checkpoint notes.
      expect(applyContextSummaryToRequest({ ...reused(), contextCompaction: projected.contextCompaction },
        summarized.summary, summarized.attempts).context).toEqual(summarized.request.context);
    });
  });
});
