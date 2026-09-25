import { describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { conversationContextPolicy } from "./contextCompactionContract";
import {
  applyContextSummaryToRequest,
  contextSummarySource,
  ContextSummaryError,
  executeContextSummary
} from "./contextCompactionSummarizer";

function request(): ProviderRunRequest {
  const messages = [
    { content: { blocks: [{ text: "old rare fact and user correction", type: "text" }] }, id: "message-old", role: "user" as const },
    { content: { blocks: [{ text: "current request", type: "text" }] }, id: "message-current", role: "user" as const }
  ];
  return {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "current request", type: "text" }] },
    context: { messages, mode: "branch_path" },
    contextCompaction: { afterTokens: 900, beforeTokens: 1_500, budgetTokens: 1_000, legacyFallback: false, maskedBatches: 2, maskedObservations: 3, outcome: "needs_summary", version: 1 },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "message-current", messages, mode: "hybrid" }),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 4_096, defaultMaxOutputTokens: 256, maxOutputTokens: 256, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
    modelId: "answer-model", params: {}, prompt: { developer: null, system: "ordinary prompt" }, provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", toolObservationVersion: 1
  };
}

function result(text: string): ProviderRunResult {
  return { finalText: text, finalProviderResponsePreview: {}, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
}

function adapter(outputs: readonly string[], calls: ProviderRunRequest[], usage = vi.fn()): ProviderAdapter {
  let index = 0;
  return {
    buildRequestPreview: () => ({}),
    async *stream(nextRequest) {
      calls.push(nextRequest);
      const text = outputs[index++] ?? outputs.at(-1) ?? "{}";
      yield { data: { delta: text }, type: "token" };
      yield { data: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, type: "usage" };
      usage();
      return result(text);
    }
  };
}

describe("context compaction summarizer", () => {
  it("keeps the summary as derived context and retains current input plus recent tail", async () => {
    const calls: ProviderRunRequest[] = [];
    const source = contextSummarySource(request());
    const summarized = await executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "Rare fact is preserved; user correction wins.", sourceRefs: ["message-old"] })], calls),
      request: request()
    });
    expect(summarized.summary.sourceDigest).toBe(source.digest);
    expect(summarized.request.context?.messages.at(-1)?.id).toBe("message-current");
    expect(summarized.request.context?.messages.some((message) => message.id.startsWith("__context-summary-cs1_"))).toBe(true);
    expect(JSON.stringify(summarized.request.context?.messages)).toContain("user correction wins");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.toolChoice).toBe("none");
    expect(calls[0]?.previousProviderResponseId).toBeUndefined();
  });

  it("uses the accepted utility allowance instead of the old 1024-token cap", async () => {
    const calls: ProviderRunRequest[] = [];
    await executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "bounded notes", sourceRefs: ["message-old"] })], calls),
      request: {
        ...request(),
        generationBudget: { version: 1, contextWindow: 4_096, maxOutputTokens: 2_048, timeoutMs: 30_000 }
      }
    });
    expect(calls[0]?.params.maxOutputTokens).toBe(2_048);
  });

  it("repairs one invalid response on the same binding and bounds receipts", async () => {
    const calls: ProviderRunRequest[] = [];
    const onUsage = vi.fn();
    const summarized = await executeContextSummary({
      adapter: adapter(["not-json", JSON.stringify({ notes: "bounded notes", sourceRefs: ["message-old"] })], calls),
      onUsage,
      request: request()
    });
    expect(summarized.attempts).toHaveLength(2);
    expect(summarized.attempts.at(-1)?.state).toBe("committed");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.system).toContain("previous compaction output");
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it("does not pay again when the committed summary is already applied", async () => {
    const calls: ProviderRunRequest[] = [];
    const first = await executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "once", sourceRefs: ["message-old"] })], calls),
      request: request()
    });
    const second = await executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "should not run", sourceRefs: ["message-old"] })], calls),
      existingAttempts: first.attempts,
      existingSummary: first.summary,
      request: first.request
    });
    expect(second.summary.id).toBe(first.summary.id);
    expect(calls).toHaveLength(1);
  });

  it("pays once for a changed provider tail and reuses the prior snapshot otherwise", async () => {
    const calls: ProviderRunRequest[] = [];
    const first = await executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "first snapshot", sourceRefs: ["message-old"] })], calls),
      request: request()
    });
    const nextRequest: ProviderRunRequest = {
      ...first.request,
      contextCompaction: { ...first.request.contextCompaction!, outcome: "needs_summary" },
      providerToolMessages: [{ role: "user", content: "new clarification" }]
    };
    const second = await executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "new snapshot", sourceRefs: ["message-current"] })], calls),
      existingAttempts: first.attempts,
      existingSummary: first.summary,
      request: nextRequest
    });
    expect(calls).toHaveLength(2);
    expect(second.summary.id).not.toBe(first.summary.id);
    expect(second.summary.sourceRefs.some(ref => ref.startsWith("ctxr1_"))).toBe(true);
  });

  it("rejects a provider that invents source references", async () => {
    const calls: ProviderRunRequest[] = [];
    await expect(executeContextSummary({
      adapter: adapter([JSON.stringify({ notes: "unsafe", sourceRefs: ["invented"] }), JSON.stringify({ notes: "still unsafe", sourceRefs: ["invented"] })], calls),
      request: request()
    })).rejects.toMatchObject({ code: "context_compaction_summary_invalid" });
    expect(calls).toHaveLength(2);
  });

  it("settles reported usage when the provider fails after a usage event", async () => {
    const calls: ProviderRunRequest[] = [];
    const onUsage = vi.fn();
    const failingAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(nextRequest) {
        calls.push(nextRequest);
        yield { data: { inputTokens: 14, outputTokens: 1, totalTokens: 15 }, type: "usage" };
        throw new Error("provider_transport");
      }
    };
    await expect(executeContextSummary({ adapter: failingAdapter, onUsage, request: request() }))
      .rejects.toMatchObject({ code: "context_compaction_summary_failed" });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      completeness: "partial", inputTokens: 14, outputTokens: 1, totalTokens: 15
    }));
    expect(calls).toHaveLength(1);
  });

  it("allows explicit summary state to be projected without changing the source contract", () => {
    const summary = {
      formatVersion: 1 as const,
      id: "cs1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      notes: "derived",
      sourceDigest: "a".repeat(64),
      sourceRefs: ["message-old"]
    };
    const projected = applyContextSummaryToRequest(request(), summary);
    expect(projected.contextCompactionSummary).toEqual(summary);
    expect(projected.context?.messages.at(-1)?.id).toBe("message-current");
  });
});
