import { describe, expect, it } from "vitest";
import type { ContextSummary, ContextSummaryAttempt } from "../../contracts/contextCompaction";
import { calculateContextBudgetLimits, estimateApproxTokens } from "../../domain/contextBudget";
import type { NormalizedTokenUsage } from "../../domain/usage";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { ProviderRequestTimeoutError } from "../providers/network";
import type { NormalizedSearchPlanOption, ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  anthropicMessagesToolBridge,
  geminiInteractionsToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import {
  CONTEXT_COMPACTION_LIMITS,
  CONTEXT_SUMMARY_NOT_DISPATCHED,
  CONTEXT_SUMMARY_REFS_INCOMPLETE,
  contextSummaryCoverage,
  conversationContextPolicy,
  messageCoverageRef
} from "./contextCompactionContract";
import { contextObservationsFromResults, isUnitCoverageRef, toolTranscriptUnits, unitCoverageRef } from "./contextCompactionPlanner";
import {
  applyContextSummaryToRequest,
  applyReusedContextSummary,
  contextSummarySource,
  ContextSummaryError,
  executeContextSummary,
  type ContextSummaryAdapter,
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
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: messages.at(-1)!.id, messages }),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: input.window ?? 16_000, defaultMaxOutputTokens: 256, maxOutputTokens: input.maxOutputTokens ?? 1_024,
      nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
    modelId: "answer-model", params: { reasoning: { effort: "low" } }, prompt: { developer: null, system: "ordinary prompt" }, provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", toolObservationVersion: 1,
    // Server-owned tools: their results may enter notes without an observation handle.
    tools: [readToolResultTool, ...["read_record", "write_file"].map((name) =>
      ({ capability: "artifact" as const, description: name, inputSchema: { type: "object" }, name }))],
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
  const dispatched: ContextSummaryAttempt[] = [];
  const settled: Array<{ attempt: ContextSummaryAttempt; summary?: ContextSummary; usage: NormalizedTokenUsage | null }> = [];
  const hooks: ContextSummaryReceipts = {
    async claim(attempt) { claims.push(attempt); log.push(`claim:${attempt.attempt}`); },
    async dispatch(attempt) { dispatched.push(attempt); log.push(`dispatched:${attempt.attempt}`); },
    async settle(attempt, usage, summary) {
      settled.push({ attempt, usage, ...(summary ? { summary } : {}) });
      log.push(`settle:${attempt.state}:${attempt.attempt}`);
    }
  };
  return { claims, dispatched, hooks, settled };
}

const json = (notes: string, sourceRefs: readonly string[] = []) => JSON.stringify({ notes, sourceRefs });
const envelopeText = (value: ProviderRunRequest) => (value.content.blocks[0] as { text: string }).text;

describe("context compaction summarizer", () => {
  it("keeps the summary as derived context with the current input and a token-bounded tail", async () => {
    const calls: ProviderRunRequest[] = [];
    const pin = text("exact pinned evidence", "knowledge-evidence:v1", "user", "knowledge_evidence");
    // About 1,000 tokens, beyond the 640-token tail share ("h" fills four characters per o200k token).
    const source = request({ messages: [
      text(`old rare fact ${"h".repeat(4_000)}`, "message-old"), text("Acknowledged.", "reply-old", "assistant"),
      pin, text("current request", "message-current")
    ] });
    const summarized = await executeContextSummary({
      adapter: adapter([json("Rare fact is preserved; user correction wins.", ["message-old"])], calls),
      request: source
    });
    expect(calls).toHaveLength(1);
    expect(summarized.summary.sourceDigest).toBe(contextSummarySource(source).digest);
    expect(summarized.summary.sourceRefs).toEqual(expect.arrayContaining(["message-current", "reply-old", "message-old"]));
    // The notes stand for the history through the newest prior message they read.
    expect(summarized.summary.sourceRefs[0]).toBe(messageCoverageRef("reply-old"));
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

  it("fails after a second output that is not the JSON object, each call settled invalid with its usage", async () => {
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    const failure = await executeContextSummary({
      adapter: adapter(["not json", "{\"notes\":\"missing refs\"}"], calls),
      receipts: recorded.hooks,
      request: request()
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "context_compaction_summary_invalid" });
    expect(calls).toHaveLength(2);
    expect(recorded.settled.map(({ attempt, usage }) => [attempt.state, usage?.inputTokens]))
      .toEqual([["invalid", 10], ["invalid", 10]]);
    // The failure carries the receipts the cycle settled, for a request that continues.
    expect((failure as ContextSummaryError).attempts).toEqual(recorded.settled.map(({ attempt }) => attempt));
  });

  it("drops model-cited references that name no source instead of repairing the notes", async () => {
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    const summarized = await executeContextSummary({
      adapter: adapter([json("bounded notes", ["message-current", "call_3cnAbc", "call_ABSxyz", "invented"])], calls),
      receipts: recorded.hooks,
      request: request()
    });
    expect(calls).toHaveLength(1);
    expect(summarized.attempts.map(({ state }) => state)).toEqual(["committed"]);
    expect(summarized.summary.notes).toBe("bounded notes");
    // The kept refs are minted from the actual source, never from the model.
    expect(summarized.summary.sourceRefs).toEqual(contextSummarySource(request()).refs);
    expect(summarized.summary.sourceRefs).not.toContain("call_3cnAbc");
    expect(summarized.summary.sourceRefs).not.toContain("invented");
  });

  it("names the valid reference forms and excludes provider call ids", async () => {
    const calls: ProviderRunRequest[] = [];
    await executeContextSummary({ adapter: adapter([json("bounded notes")], calls), request: request() });
    const system = calls[0]!.prompt.system!;
    expect(system).toContain("id attribute of a <message> element");
    expect(system).toContain("tor1_ observation handle");
    expect(system).toContain("tcr1_ call reference");
    expect(system).toMatch(/unknown outcome into success or failure/u);
    expect(system).toMatch(/call ids .* are not references/u);
  });

  it("does not pay again when the committed summary already covers everything", async () => {
    const calls: ProviderRunRequest[] = [];
    const recorded = receipts();
    const first = await executeContextSummary({ adapter: adapter([json("once", ["message-old"])], calls), request: request() });
    await expect(executeContextSummary({
      adapter: adapter([json("should not run")], calls),
      existingAttempts: first.attempts,
      existingSummary: first.summary,
      receipts: recorded.hooks,
      request: first.request
    })).rejects.toMatchObject({ code: "context_compaction_summary_no_progress" });
    expect(calls).toHaveLength(1);
    expect(recorded.claims).toHaveLength(0);
  });

  it("claims every paid call durably before dispatch and settles it with its usage", async () => {
    const log: string[] = [];
    const recorded = receipts(log);
    const summarized = await executeContextSummary({
      adapter: adapter([json("bounded notes", ["message-old"])], [], log),
      receipts: recorded.hooks,
      request: request()
    });
    expect(log).toEqual(["claim:1", "dispatched:1", "dispatch", "settle:committed:1"]);
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

  it.each(["claim", "dispatched", "unknown"] as const)("never repeats a %s call for the same source", async state => {
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

  describe("dispatch receipts", () => {
    /** Mirrors the run's summary egress: authority and egress checks, then the
     * dispatched mark, then the provider request. */
    function egress(log: string[], calls: ProviderRunRequest[], check: () => void = () => undefined): ContextSummaryAdapter {
      return {
        reportsDispatch: true,
        async *stream(next, options) {
          check();
          log.push("checked");
          await options?.beforeDispatch?.();
          calls.push(next);
          log.push("dispatch");
          const output = json("bounded notes", ["message-old"]);
          yield { data: { delta: output }, type: "token" };
          yield { data: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, type: "usage" };
          return { finalProviderResponsePreview: {}, finalText: output, usage: {} };
        }
      };
    }

    it("marks the call dispatched after the pre-dispatch checks and immediately before the provider request", async () => {
      const log: string[] = [];
      const recorded = receipts(log);
      await executeContextSummary({ adapter: egress(log, []), receipts: recorded.hooks, request: request() });
      expect(log).toEqual(["claim:1", "checked", "dispatched:1", "dispatch", "settle:committed:1"]);
      expect(recorded.dispatched).toEqual([expect.objectContaining({ attempt: 1, id: recorded.claims[0]!.id, state: "dispatched" })]);
      expect(recorded.dispatched[0]).not.toHaveProperty("usage");
    });

    it("settles a refusal before dispatch without usage or an operation and keeps the owner's error", async () => {
      const log: string[] = [];
      const calls: ProviderRunRequest[] = [];
      const recorded = receipts(log);
      const denied = Object.assign(new Error("model gone"), { code: "model_not_available" });
      await expect(executeContextSummary({ adapter: egress(log, calls, () => { throw denied; }), receipts: recorded.hooks, request: request() }))
        .rejects.toBe(denied);
      expect(calls).toHaveLength(0);
      expect(recorded.dispatched).toHaveLength(0);
      expect(recorded.settled).toEqual([{ attempt: expect.objectContaining({ attempt: 1, state: "failed" }), usage: null }]);
      expect(recorded.settled[0]!.attempt).not.toHaveProperty("usage");
    });

    it("never commits notes whose stream completed as Stop landed, but keeps the call's usage", async () => {
      const controller = new AbortController();
      const recorded = receipts();
      const late: ContextSummaryAdapter = { async *stream() {
        const output = json("bought after Stop", ["message-old"]);
        yield { data: { delta: output }, type: "token" };
        yield { data: { inputTokens: 9, outputTokens: 3, totalTokens: 12 }, type: "usage" };
        controller.abort();
        return { finalProviderResponsePreview: {}, finalText: output, usage: {} };
      } };
      const failure = await executeContextSummary({ adapter: late, receipts: recorded.hooks, request: request(), signal: controller.signal })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "AbortError" });
      expect(recorded.settled).toEqual([{ attempt: expect.objectContaining({ state: "settled",
        usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } }), usage: expect.objectContaining({ inputTokens: 9, outputTokens: 3 }) }]);
    });

    it("buys the summary with a later claim after a claim recovery found never sent", async () => {
      const source = request();
      const calls: ProviderRunRequest[] = [];
      const recorded = receipts();
      const notSent: ContextSummaryAttempt = { attempt: 1, bindingDigest: "b".repeat(64), errorCode: CONTEXT_SUMMARY_NOT_DISPATCHED,
        id: "csa1_not_sent", sourceDigest: contextSummarySource(source).digest, state: "failed" };
      const summarized = await executeContextSummary({ adapter: adapter([json("bought after restart", ["message-old"])], calls),
        existingAttempts: [notSent], receipts: recorded.hooks, request: source });
      expect(calls).toHaveLength(1);
      expect(recorded.claims.map(({ attempt }) => attempt)).toEqual([2]);
      expect(summarized.attempts.map(({ attempt, state }) => [attempt, state])).toEqual([[1, "failed"], [2, "committed"]]);
    });
  });

  describe("canonical identity and bounded refs", () => {
    const reordered = <T,>(value: T): T => Array.isArray(value) ? value.map(reordered) as T
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reordered((value as Record<string, unknown>)[key])])) as T
        : value;

    it("keeps the source digest, revision and binding after a jsonb key reorder of the request and transcript", () => {
      const source = request({ overrides: { providerToolMessages: [
        { arguments: "{\"value\":\"alpha\"}", call_id: "call-1", name: "read_record", type: "function_call" },
        { call_id: "call-1", output: "RESULT", type: "function_call_output" }
      ] } });
      const stored = reordered(source);
      expect(JSON.stringify(stored.providerToolMessages)).not.toBe(JSON.stringify(source.providerToolMessages));
      expect(contextSummarySource(stored).digest).toBe(contextSummarySource(source).digest);
      expect(contextSummarySource(stored).refs).toEqual(contextSummarySource(source).refs);
      expect(contextSummarySource(source).units.at(-1)?.text).toContain("RESULT");
    });

    it("keeps the newest tool handles and refuses cross-turn reuse instead of dropping handles over the cap", () => {
      const handle = (index: number) => `tor1_${index.toString(16).padStart(32, "0")}`;
      // 300 handles carried by earlier notes plus 300 new results: 600 on the branch.
      const results = Array.from({ length: 300 }, (_, index) => projectObservationForProvider({ callId: `call-${index}`,
        content: [{ text: `result ${index}`, type: "text" }], name: "read_record", status: "complete",
        observation: { byteSize: 20, checksum: "a".repeat(64), encoding: "json-utf8-v1", handle: handle(1_000 + index),
          maskable: true, source: "mcp", sourceTruncated: false, version: 1 } }));
      const carriedHandles = Array.from({ length: 300 }, (_, index) => handle(index));
      const previous: ContextSummary = { formatVersion: 1, id: "cs1_previous", notes: "Earlier notes.", sourceDigest: "e".repeat(64),
        sourceRefs: ["ctxr1_earlier", ...carriedHandles] };
      const overflowing = request({
        messages: [text("Earlier notes.", "__context-summary-cs1_previous", "assistant"), text("recent", "recent"), text("current", "current")],
        overrides: { contextCompactionSummary: previous, providerToolMessages: results.flatMap((result) => [
          { call_id: result.callId, name: "read_record", type: "function_call" },
          openAIResponsesToolBridge.appendToolResult(undefined, result)
        ]) }
      });
      const source = contextSummarySource(overflowing, contextObservationsFromResults(results));
      expect(source.refs).toHaveLength(CONTEXT_COMPACTION_LIMITS.summarySourceRefs);
      // Coverage refs come first and are never cut: the history boundary and one ref per unit.
      expect(source.refs[0]).toBe(messageCoverageRef("recent"));
      expect(source.refs.slice(1, 301).every(isUnitCoverageRef)).toBe(true);
      expect(source.refs[301]).toBe(CONTEXT_SUMMARY_REFS_INCOMPLETE);
      expect(source.refs.filter((ref) => ref.startsWith("tor1_"))[0]).toBe(handle(1_299));
      // Every carried handle is still rechecked in this run, whatever the refs keep.
      expect(source.referencedHandles).toEqual(expect.arrayContaining(carriedHandles));
      // Within the cap: no marker, newest tool results first, then carried handles.
      const fitting = contextSummarySource({ ...overflowing, providerToolMessages: overflowing.providerToolMessages!.slice(-4),
        contextCompactionSummary: { ...previous, sourceRefs: previous.sourceRefs.slice(0, 3) } },
      contextObservationsFromResults(results));
      expect(fitting.refs.slice(0, 3).map((ref) => ref.slice(0, 6))).toEqual(["ctxm1_", "ctxu1_", "ctxu1_"]);
      expect(fitting.refs.filter((ref) => ref.startsWith("tor1_")).slice(0, 4)).toEqual([handle(1_299), handle(1_298), handle(0), handle(1)]);
      expect(fitting.refs).not.toContain(CONTEXT_SUMMARY_REFS_INCOMPLETE);
    });
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
    const recorded = receipts();
    const failure = await executeContextSummary({
      adapter: adapter([json("never")], calls),
      observations: contextObservationsFromResults(settled),
      receipts: recorded.hooks,
      request: request({ overrides: { providerToolMessages: [{ call_id: "older", name: "read_record", type: "function_call" }, masked] } }),
      sourceAvailable: async handles => { checked.push([...handles]); return false; }
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "context_compaction_source_unavailable" });
    expect(checked).toEqual([[`tor1_${"a".repeat(32)}`]]);
    expect(calls).toHaveLength(0);
    // The refused cycle leaves durable evidence: one claim never sent, settled
    // failed with its code and no operation.
    expect(recorded.dispatched).toHaveLength(0);
    expect(recorded.settled).toEqual([{ attempt: expect.objectContaining({ attempt: 1, errorCode: "context_compaction_source_unavailable",
      state: "failed" }), usage: null }]);
    expect(recorded.settled[0]!.attempt).not.toHaveProperty("usage");
    expect((failure as ContextSummaryError).attempts).toEqual([recorded.settled[0]!.attempt]);
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
    // Coverage refs are server-owned locators, not source content.
    for (const ref of summarized.summary.sourceRefs.filter(ref => !ref.startsWith("ctxm1_") && !ref.startsWith("ctxu1_"))) {
      expect(bodies.some(body => body.includes(ref))).toBe(true);
    }
    expect(summarized.attempts.map(({ state }) => state)).toEqual([...partials.map(() => "settled"), "committed"]);
  });

  it("covers a source longer than one plan in oldest-first passes without dropping anything", async () => {
    // 4,000-token window: about 3,000 input tokens per call; 30,000 tokens of history.
    const history = Array.from({ length: 60 }, (_, index) =>
      text(`TURN_${index} ${String(index % 10).repeat(2_000)}`, `h${index}`, index % 2 ? "assistant" : "user"));
    const source = request({ maxOutputTokens: 256, window: 4_000, messages: [...history, text("CURRENT_QUESTION", "current")],
      overrides: { providerToolMessages: [{ call_id: "tool-1", name: "read_record", type: "function_call" },
        { call_id: "tool-1", output: "NEWEST_TOOL_RESULT", type: "function_call_output" }] } });
    const calls: ProviderRunRequest[] = [];
    let current = source;
    let attempts: readonly ContextSummaryAttempt[] = [];
    const boundaries: string[] = [];
    const bodiesByPass: string[][] = [];
    for (let pass = 0; pass < 10; pass += 1) {
      const before = calls.length;
      let summarized: Awaited<ReturnType<typeof executeContextSummary>>;
      try {
        summarized = await executeContextSummary({ adapter: adapter([json(`pass notes ${pass}`)], calls), existingAttempts: attempts,
          ...(current.contextCompactionSummary ? { existingSummary: current.contextCompactionSummary } : {}), request: current });
      } catch (error) {
        expect(error).toMatchObject({ code: "context_compaction_summary_no_progress" });
        break;
      }
      expect(calls.length - before).toBeLessThanOrEqual(CONTEXT_COMPACTION_LIMITS.summaryPlannedCalls);
      bodiesByPass.push(calls.slice(before).map(envelopeText));
      boundaries.push(summarized.summary.sourceRefs.find((ref) => ref.startsWith("ctxm1_"))!);
      attempts = summarized.attempts;
      current = summarized.request;
      // Uncovered history after the boundary stays exact: nothing leaves uncovered.
      const prior = current.context!.messages.filter((message) => message.id.startsWith("h"));
      const { uncovered } = contextSummaryCoverage(current, summarized.summary, prior);
      const boundary = Number(boundaries.at(-1)!.slice("ctxm1_h".length));
      expect(uncovered.map((message) => message.id)).toEqual(history.slice(boundary + 1).map((message) => message.id));
    }
    expect(bodiesByPass.length).toBeGreaterThan(1);
    // The first pass starts at the oldest turn; every later pass absorbs the earlier notes.
    expect(bodiesByPass[0]!.join("\n")).toContain('id="h0"');
    expect(bodiesByPass.slice(1).every((bodies) => bodies.join("\n").includes("<previous-notes"))).toBe(true);
    expect(bodiesByPass.every((bodies) => bodies.join("\n").includes("CURRENT_QUESTION"))).toBe(true);
    expect(bodiesByPass.at(-1)!.join("\n")).toContain("NEWEST_TOOL_RESULT");
    expect(boundaries.at(-1)).toBe(messageCoverageRef("h59"));
    expect(new Set(boundaries).size).toBe(boundaries.length);
    // The final notes cover every turn and the tool unit; only the exact tail stays.
    expect(current.contextCompactionSummary!.sourceRefs).toContain(
      unitCoverageRef(toolTranscriptUnits(source.providerToolMessages!)[0]!));
    expect(current.context!.messages.some((message) => message.id === "h0")).toBe(false);
    expect(current.context!.messages.at(-1)?.id).toBe("current");
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
    // Notes whose history boundary lies before every message here.
    const earlier: ContextSummary = { formatVersion: 1, id: "cs1_earlier", notes: "FACT_RARE7731 from the first third",
      sourceDigest: "e".repeat(64), sourceRefs: [messageCoverageRef("h-first"), "h-first"] };
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

  it("never lets first-turn notes over tool units stand for the user's first message", async () => {
    // A chat's first turn: no prior message, only tool rounds to cover.
    const first = text("FIRST_TASK list the records", "u1");
    const source = request({ messages: [first], overrides: { providerToolMessages: [
      { call_id: "tool-1", name: "read_record", type: "function_call" },
      { call_id: "tool-1", output: `RECORD ${"r".repeat(2_000)}`, type: "function_call_output" }
    ] } });
    const summarized = await executeContextSummary({ adapter: adapter([json("Record facts.")], []), request: source });
    expect(summarized.summary.sourceRefs.some((ref) => ref.startsWith("ctxu1_"))).toBe(true);
    expect(summarized.summary.sourceRefs.some((ref) => ref.startsWith("ctxm1_"))).toBe(false);
    // A later turn of the same branch keeps u1 exact: the notes cover no prior message.
    const later = { ...summarized.request, context: { mode: "branch_path" as const, messages: [
      ...summarized.request.context!.messages.slice(0, -1), first, text("Answer.", "a1", "assistant"), text("Next.", "u2")] },
      providerToolMessages: [] };
    const prior = later.context.messages.filter((message) => message.id === "u1" || message.id === "a1");
    expect(contextSummaryCoverage(later, summarized.summary, prior).uncovered.map((message) => message.id)).toEqual(["u1", "a1"]);
    expect(applyContextSummaryToRequest(later, summarized.summary).context?.messages.some((message) => message.id === "u1")).toBe(true);
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

  it("covers only through its frozen boundary, whatever history boundary its refs name", () => {
    const base = reused();
    const later = { ...carriedNotes, sourceRefs: [messageCoverageRef("a3")] };
    const request = { ...base, contextCompactionPolicy: { ...base.contextCompactionPolicy!,
      reuse: { ...base.contextCompactionPolicy!.reuse!, summary: later } } };
    const prior = request.context!.messages.filter((message) => message.purpose === undefined).slice(0, -1);
    expect(contextSummaryCoverage(request, later, prior).uncovered.map((message) => message.id)).toEqual(["a2", "u3", "a3"]);
    // The same notes bought by this run stand for the history through their ref.
    const { reuse: _reuse, ...own } = request.contextCompactionPolicy!;
    void _reuse;
    expect(contextSummaryCoverage({ ...request, contextCompactionPolicy: own }, later, prior).uncovered).toEqual([]);
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

  describe("final notes allowance", () => {
    const allowance = (next: ProviderRunRequest) => Number(/under (\d+) UTF-8 bytes/u.exec(next.prompt.system!)?.[1]);
    /** A diligent model: its notes fill every allowance it is given. */
    const filling: Output = (next) => json("n".repeat(allowance(next)));

    it("gives a summary of little history the recorded floor", async () => {
      const calls: ProviderRunRequest[] = [];
      await executeContextSummary({ adapter: adapter([json("bounded notes")], calls), request: request() });
      expect(allowance(calls[0]!)).toBe(CONTEXT_COMPACTION_LIMITS.summaryMinimumNotesBytes);
      expect(CONTEXT_COMPACTION_LIMITS.summaryMinimumNotesBytes).toBeGreaterThanOrEqual(4 * 1024);
    });

    it("never falls below the previous notes or the floor across eight incremental summaries of a 50-turn run", async () => {
      const turns = Array.from({ length: 50 }, (_, index) =>
        text(`TURN_${index} rule ${index}: ${"r".repeat(1_000)}`, `turn-${index}`, index % 2 ? "assistant" : "user"));
      let round = 0;
      /** Tool rounds the run adds after each summary: none of them is covered yet. */
      const rounds = (count: number) => Array.from({ length: count }, () => {
        round += 1;
        return [
          { arguments: JSON.stringify({ content: `ARGS_${round} ${"w".repeat(2_000)}` }), call_id: `call_${round}`, name: "write_file",
            type: "function_call" },
          { call_id: `call_${round}`, output: `RESULT_${round} ${"x".repeat(2_000)}`, type: "function_call_output" }
        ];
      }).flat();
      const calls: ProviderRunRequest[] = [];
      const allowances: number[] = [];
      const notes: number[] = [];
      let next = request({ maxOutputTokens: 4_096, window: 32_000, messages: [...turns, text("Run the migration.", "current")],
        overrides: { providerToolMessages: rounds(3) } });
      let previous: Awaited<ReturnType<typeof executeContextSummary>> | undefined;
      for (let cycle = 1; cycle <= 8; cycle += 1) {
        const summarized = await executeContextSummary({ adapter: adapter([filling], calls), request: next,
          ...(previous ? { existingAttempts: previous.attempts, existingSummary: previous.summary } : {}) });
        allowances.push(allowance(calls.at(-1)!));
        notes.push(Buffer.byteLength(summarized.summary.notes, "utf8"));
        previous = summarized;
        next = { ...summarized.request, providerToolMessages: [...summarized.request.providerToolMessages!, ...rounds(3)] };
      }
      // Every later summary is incremental: the earlier notes plus the uncovered delta.
      expect(calls.map(envelopeText).slice(1).every((body) => body.includes("<previous-notes") && !body.includes("TURN_0 "))).toBe(true);
      // The first summary stands for 50 turns: half of what it replaces.
      expect(allowances[0]).toBeGreaterThan(20_000);
      for (let index = 1; index < allowances.length; index += 1) {
        expect(allowances[index]).toBeGreaterThanOrEqual(allowances[index - 1]!);
        expect(allowances[index]).toBeGreaterThanOrEqual(notes[index - 1]!);
      }
      expect(Math.min(...allowances)).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_LIMITS.summaryMinimumNotesBytes);
      expect(Math.max(...allowances)).toBeLessThanOrEqual(CONTEXT_COMPACTION_LIMITS.summaryNotesBytes);
    });

    it("counts the uncovered tool transcript it replaces", async () => {
      const calls: ProviderRunRequest[] = [];
      const transcript = Array.from({ length: 4 }, (_, index) => [
        { arguments: JSON.stringify({ content: "w".repeat(6_000) }), call_id: `call_${index}`, name: "write_file", type: "function_call" },
        { call_id: `call_${index}`, output: "x".repeat(6_000), type: "function_call_output" }
      ]).flat();
      await executeContextSummary({ adapter: adapter([json("bounded notes")], calls), request: request({ overrides: { providerToolMessages: transcript } }) });
      // The final call's allowance: half of the old message plus about 48 KB of calls and results.
      expect(allowance(calls.at(-1)!)).toBeGreaterThan(24_000);
    });
  });

  it("never sends provider reasoning, signatures, encrypted state or attachment identifiers to the summarizer", async () => {
    const result = (callId: string, value: string) => ({ callId, content: [{ text: value, type: "text" as const }], name: "read_record",
      status: "complete" as const });
    const transcripts: Record<string, unknown[]> = {
      anthropic: [
        { content: [{ signature: "SIG_ANTHROPIC", thinking: "PRIVATE_THINKING", type: "thinking" },
          { data: "REDACTED_DATA", type: "redacted_thinking" },
          { id: "toolu_1", input: { path: "ARG_ANTHROPIC" }, name: "read_record", type: "tool_use" }], role: "assistant" },
        anthropicMessagesToolBridge.appendToolResult(undefined, result("toolu_1", "RESULT_ANTHROPIC"))
      ],
      gemini: [
        { signature: "SIG_GEMINI_THOUGHT", summary: [{ text: "PRIVATE_GEMINI", type: "text" }], type: "thought" },
        { arguments: { path: "ARG_GEMINI" }, id: "fc_1", name: "read_record", signature: "SIG_GEMINI_CALL",
          thoughtSignature: "SIG_GEMINI_PART", thought_signature: "SIG_GEMINI_SNAKE", type: "function_call" },
        geminiInteractionsToolBridge.appendToolResult(undefined, result("fc_1", "RESULT_GEMINI"))
      ],
      openai: [
        { encrypted_content: "ENC_OPENAI", id: "rs_1", summary: [{ text: "PRIVATE_SUMMARY", type: "summary_text" }], type: "reasoning" },
        { arguments: JSON.stringify({ path: "ARG_OPENAI" }), call_id: "call_1", name: "read_record", status: "completed", type: "function_call" },
        openAIResponsesToolBridge.appendToolResult(undefined, result("call_1", "RESULT_OPENAI"))
      ],
      openrouter: [
        { content: null, reasoning: "PRIVATE_CHAT_REASONING", reasoning_content: "PRIVATE_CHAT_CONTENT",
          reasoning_details: [{ data: "ENC_CHAT", signature: "SIG_CHAT", type: "reasoning.encrypted" }], role: "assistant",
          tool_calls: [{ function: { arguments: JSON.stringify({ path: "ARG_CHAT" }), name: "read_record" }, id: "call_c1", type: "function" }] },
        openRouterChatToolBridge.appendToolResult(undefined, result("call_c1", "RESULT_CHAT"))
      ]
    };
    const attached: ProviderConversationMessage = { content: { blocks: [{ text: "See the attached photo and contract.", type: "text" },
      { attachmentId: "att_PRIVATE_IMAGE", label: "photo-PRIVATE.png", type: "image" },
      { attachmentId: "att_PRIVATE_FILE", fileName: "contract-PRIVATE.pdf", type: "file" }] }, id: "with-attachments", role: "user" };
    for (const [provider, providerToolMessages] of Object.entries(transcripts)) {
      const source = request({ messages: [attached, text("Noted.", "reply", "assistant"),
        { ...attached, id: "current-with-attachments" }], overrides: { provider, providerToolMessages } });
      const calls: ProviderRunRequest[] = [];
      await executeContextSummary({ adapter: adapter([json("bounded notes")], calls), request: source });
      for (const sent of [contextSummarySource(source).units.map((unit) => unit.text).join("\n"), envelopeText(calls[0]!)]) {
        expect(sent).not.toMatch(/PRIVATE|SIG_|ENC_|REDACTED|att_|\.png|\.pdf|encrypted_content|reasoning|signature|thinking|thought/u);
        expect(sent).toContain(`ARG_${provider === "openrouter" ? "CHAT" : provider.toUpperCase()}`);
        expect(sent).toContain(`RESULT_${provider === "openrouter" ? "CHAT" : provider.toUpperCase()}`);
        expect(sent).toContain("read_record");
        expect(sent).toContain("See the attached photo and contract.\n[image attachment]\n[file attachment]");
      }
    }
  });

  it("keeps the newest handles of 600 masked results in the refs and the availability check", async () => {
    const handle = (index: number) => `tor1_${index.toString(16).padStart(32, "0")}`;
    const results = Array.from({ length: 600 }, (_, index) => projectObservationForProvider({ callId: `call-${index}`,
      content: [{ text: `result ${index}`, type: "text" }], name: "read_record", status: "complete",
      observation: { byteSize: 20, checksum: "a".repeat(64), encoding: "json-utf8-v1", handle: handle(index),
        maskable: true, source: "mcp", sourceTruncated: false, version: 1 } }));
    const masked = results.flatMap((settled) => [
      { call_id: settled.callId, name: "read_record", type: "function_call" },
      openAIResponsesToolBridge.appendToolResult(undefined, { callId: settled.callId, name: "read_record", status: "complete",
        content: [{ type: "json", value: { observation: settled.observation, reader: "read_tool_result" } }] })
    ]);
    const observations = contextObservationsFromResults(results);
    const source = request({ window: 128_000, overrides: { providerToolMessages: masked } });
    const built = contextSummarySource(source, observations);
    // One pass covers only the units whose coverage refs fit beside the marker;
    // the later ones stay exact for the next pass.
    const covered = built.refs.filter(isUnitCoverageRef).length;
    expect(covered).toBe(CONTEXT_COMPACTION_LIMITS.summarySourceRefs - 2);
    // Coverage refs are never cut, so no handle fits beside them: the marker
    // keeps these notes in this run, whose recheck covers every masked handle.
    expect(built.refs).toHaveLength(CONTEXT_COMPACTION_LIMITS.summarySourceRefs);
    expect(built.refs.at(-1)).toBe(CONTEXT_SUMMARY_REFS_INCOMPLETE);
    expect(built.refs.some((ref) => ref.startsWith("tor1_"))).toBe(false);
    const newest = Array.from({ length: covered }, (_, index) => handle(index));
    expect(built.referencedHandles).toEqual(newest);
    const checked: string[][] = [];
    await executeContextSummary({ adapter: adapter([json("bounded notes")], []), observations, request: source,
      sourceAvailable: async (handles) => { checked.push([...handles]); return true; } });
    expect(checked).toEqual([newest]);
  });

  it("bounds an Anthropic manual thinking budget by the summary call's output allowance and keeps every other binding", async () => {
    const calls: ProviderRunRequest[] = [];
    const thinking = { budgetTokens: 32_000, enabled: true, type: "enabled" };
    const anthropic = (overrides: Partial<ProviderRunRequest>) => request({ maxOutputTokens: 64_000,
      overrides: { modelId: "claude-test", provider: "anthropic", reasoningEffort: "high", ...overrides } });
    await executeContextSummary({ adapter: adapter([json("bounded notes")], calls),
      request: anthropic({ params: { maxOutputTokens: 64_000, outputConfig: { effort: "high" }, thinking } }) });
    const summary = calls[0]!;
    const maxOutputTokens = Number(summary.params.maxOutputTokens);
    expect(maxOutputTokens).toBeLessThan(thinking.budgetTokens);
    expect(summary.params).toEqual({ maxOutputTokens, outputConfig: { effort: "high" },
      thinking: { ...thinking, budgetTokens: Math.floor(maxOutputTokens / 2) } });
    expect(summary.reasoningEffort).toBe("high");
    const body = buildAnthropicMessagesRequest(summary);
    expect(body).toMatchObject({ max_tokens: maxOutputTokens, thinking: { budget_tokens: Math.floor(maxOutputTokens / 2), type: "enabled" } });

    // A call that cannot hold the provider minimum below its allowance runs without thinking.
    await executeContextSummary({ adapter: adapter([json("bounded notes")], calls), request: anthropic({
      generationBudget: { contextWindow: 16_000, maxOutputTokens: 1_000, timeoutMs: 30_000, version: 1 }, params: { thinking } }) });
    expect(calls[1]!.params.thinking).toEqual({ ...thinking, enabled: false });
    expect(buildAnthropicMessagesRequest(calls[1]!)).not.toHaveProperty("thinking");

    // A budget that already fits and adaptive thinking stay as admitted.
    for (const admitted of [{ ...thinking, budgetTokens: 2_048 }, { enabled: true, type: "adaptive" }]) {
      await executeContextSummary({ adapter: adapter([json("bounded notes")], calls), request: anthropic({ params: { thinking: admitted } }) });
      expect(calls.at(-1)!.params.thinking).toEqual(admitted);
      expect(() => buildAnthropicMessagesRequest(calls.at(-1)!)).not.toThrow();
    }
  });
});

describe("tool-history records in summary sources", () => {
  const callRef = (digit: string) => `tcr1_${digit.repeat(32)}`;
  const record = (id: string, detailRefs: readonly string[], value = "record"): ProviderConversationMessage => ({
    content: { blocks: [{ text: `[AIQSA record] ${value}`, type: "text" }] }, historyClass: "tool_history", id, role: "assistant",
    toolHistory: { block: { turnMessageId: id.slice(5), userMessageId: null, header: "h", entries: [], footer: null }, detailRefs }
  });

  it("carries the call references a past turn's record discloses into the notes' refs", async () => {
    const calls: ProviderRunRequest[] = [];
    const source = request({ messages: [
      text(`old question ${"o".repeat(4_000)}`, "q1"), record("tch1_a1", [callRef("1")], "MCP write executed. Arguments: {\"title\":\"x\"}"),
      text("done", "a1", "assistant"), text("current request", "q2")
    ] });
    const summarized = await executeContextSummary({ adapter: adapter([json("A write titled x was executed (tcr1_...).")], calls), request: source });
    expect(envelopeText(calls[0]!)).toContain('<message id="tch1_a1" role="assistant">');
    expect(summarized.summary.sourceRefs).toEqual(expect.arrayContaining([callRef("1"), "tch1_a1"]));
  });

  it("rechecks call references of earlier notes before buying notes that would carry them on", async () => {
    const calls: ProviderRunRequest[] = [];
    const previous: ContextSummary = { formatVersion: 1, id: "cs1_previous", notes: "Earlier write arguments: secret plan.",
      sourceDigest: "e".repeat(64), sourceRefs: [messageCoverageRef("q1"), callRef("2")] };
    const base = request({ messages: [
      { content: { blocks: [{ text: "notes", type: "text" }] }, id: "__context-summary-cs1_previous", role: "assistant" },
      text("q1", "q1"), text(`more ${"m".repeat(4_000)}`, "q1b"), text("ok", "a1b", "assistant"), text("current request", "q2")
    ] });
    const checked: string[][] = [];
    const failure = await executeContextSummary({ adapter: adapter([json("never")], calls),
      request: { ...base, contextCompactionSummary: previous },
      sourceAvailable: async (handles) => { checked.push([...handles]); return false; } }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "context_compaction_source_unavailable" });
    expect(checked).toEqual([[callRef("2")]]);
    expect(calls).toHaveLength(0);
  });

  it("keeps the record of earlier attempts of the current message exact beside it, never a pass or a boundary", async () => {
    const calls: ProviderRunRequest[] = [];
    const current = record("tch1_q2", [callRef("3")], "earlier attempt executed the write");
    const pin = text("exact pin", "skill-context:v1", "user", "skill_context");
    const source = request({ messages: [
      text(`old question ${"o".repeat(4_000)}`, "q1"), text("old answer", "a1", "assistant"), current, pin, text("current request", "q2")
    ] });
    const summarized = await executeContextSummary({ adapter: adapter([json("Old question answered.")], calls), request: source });
    expect(envelopeText(calls[0]!)).not.toContain("earlier attempt executed the write");
    expect(summarized.summary.sourceRefs).not.toContain("tch1_q2");
    expect(summarized.summary.sourceRefs).not.toContain(messageCoverageRef("tch1_q2"));
    const ids = summarized.request.context!.messages.map((message) => message.id);
    expect(ids.slice(-3)).toEqual(["tch1_q2", "skill-context:v1", "q2"]);
  });
});
