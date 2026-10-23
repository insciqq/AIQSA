import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { createAnthropicMessagesAdapter, type AnthropicMessagesClient } from "../providers/anthropicMessages";
import { buildCompatibleResponsesRequest } from "../providers/compatibleResponses";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { RunTool } from "../tools/types";
import { SUMMARIZER_INSTRUCTIONS } from "./compaction/summaryPrompt";
import { COMPACTION_CALL, compactionModelCall, nativeCompactionRequest, summaryCompactionRequest } from "./compactionCalls";

const tool: RunTool = { capability: "mcp", description: "Look up", inputSchema: { type: "object" }, name: "lookup" };

const runRequest: ProviderRunRequest = {
  attachmentIds: ["a-1"],
  attachments: [{ byteSize: 3, dataUrl: "data:image/png;base64,AAAA", extractedText: null, fileName: "x.png", id: "a-1", kind: "image",
    metadata: {}, mimeType: "image/png", status: "ready" }],
  chatId: "chat",
  content: { blocks: [{ text: "Hi", type: "text" }] },
  history: [{ currentInput: true, text: "Hi", type: "user" }],
  knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
  modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, reasoningEfforts: ["low", "high"],
    streaming: true, toolCalling: true, vision: true },
  modelId: "gpt-6.1-sol",
  params: { background: false, maxOutputTokens: 4_096, reasoning: { effort: "high", summary: "auto" }, store: false, stream: true },
  personalContext: { approxTokens: 3, itemCount: 1, memoryGeneration: 1, memoryRevision: 1, mode: "prefetched",
    text: `${PERSONAL_CONTEXT_HEADING}\nPRIVATE-MEMORY` },
  prompt: { developer: null, system: "Run instructions." },
  provider: "openai_compatible",
  searchPlan: { mode: "all_selected", options: [] },
  toolChoice: "auto",
  toolMode: "auto",
  tools: [tool]
};

const span = [{ text: "Earlier", type: "user" as const }, { text: "Done", type: "assistant_text" as const }];

describe("compaction calls", () => {
  it("send a native compaction as the run's own request ending with the trigger, without attachments or tool use", () => {
    const request = nativeCompactionRequest(runRequest, { history: span, idleTimeoutMs: 1, kind: "native", signal: new AbortController().signal });
    expect(request).toMatchObject({ attachments: [], compactionTrigger: true, history: span, prompt: runRequest.prompt, toolChoice: "none",
      tools: [tool] });
    expect(request.params.maxOutputTokens).toBe(COMPACTION_CALL.nativeOutputTokens);
    const body = buildCompatibleResponsesRequest(request);
    expect((body.input as Record<string, unknown>[]).at(-1)).toEqual({ type: "compaction_trigger" });
    expect(body).toMatchObject({ instructions: expect.stringContaining("Run instructions."), tool_choice: "none" });
  });

  it("send a summary with the summarizer's instructions only: no tools, attachments, Memory or Search", () => {
    const request = summaryCompactionRequest(runRequest, { history: [{ text: "<conversation>…", type: "user" }], idleTimeoutMs: 1,
      instructions: SUMMARIZER_INSTRUCTIONS, kind: "summary", maxOutputTokens: 8_192, reasoningEffort: "low",
      signal: new AbortController().signal });
    expect(request).toMatchObject({ attachments: [], prompt: { developer: null, system: SUMMARIZER_INSTRUCTIONS }, toolChoice: "none",
      toolMode: "none", tools: [] });
    expect(request.personalContext).toBeUndefined();
    expect(request.params).toMatchObject({ maxOutputTokens: 8_192, reasoning: { effort: "low", summary: "auto" }, stream: true });
    const body = buildCompatibleResponsesRequest(request);
    expect(JSON.stringify(body)).not.toContain("PRIVATE-MEMORY");
    expect(body.instructions).toBe(SUMMARIZER_INSTRUCTIONS);
    // An effort the model does not declare is not asked for; the admitted one stays.
    expect(summaryCompactionRequest({ ...runRequest, modelCapabilities: { ...runRequest.modelCapabilities, reasoningEfforts: ["high"] } },
      { history: [], idleTimeoutMs: 1, kind: "summary", reasoningEffort: "low", signal: new AbortController().signal }).params)
      .toMatchObject({ reasoning: { effort: "high" } });
    // The model's declared output ceiling bounds the allowance.
    expect(summaryCompactionRequest({ ...runRequest, modelCapabilities: { ...runRequest.modelCapabilities, maxOutputTokens: 2_000 } },
      { history: [], idleTimeoutMs: 1, kind: "summary", maxOutputTokens: 8_192, signal: new AbortController().signal }).params.maxOutputTokens)
      .toBe(2_000);
  });

  it("send an Anthropic summary through its adapter: the summarizer's instructions, one user turn, no tools, low effort", async () => {
    const anthropicRun: ProviderRunRequest = {
      ...runRequest,
      modelCapabilities: { ...runRequest.modelCapabilities, reasoningEfforts: ["low", "medium", "high"] },
      modelId: "claude-haiku-5-5",
      params: { maxTokens: 32_000, outputConfig: { effort: "high" }, thinking: { budgetTokens: 0, enabled: true, type: "adaptive" } },
      provider: "anthropic"
    };
    const sent: Record<string, unknown>[] = [];
    const client: AnthropicMessagesClient = {
      async *stream(body) {
        sent.push(body);
        yield { message: { id: "msg_1", usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 700,
          output_tokens: 1 } }, type: "message_start" };
        yield { content_block: { signature: "", thinking: "", type: "thinking" }, index: 0, type: "content_block_start" };
        yield { delta: { signature: "SIG", type: "signature_delta" }, index: 0, type: "content_block_delta" };
        yield { index: 0, type: "content_block_stop" };
        yield { content_block: { text: "", type: "text" }, index: 1, type: "content_block_start" };
        yield { delta: { text: "## Goal\n- x", type: "text_delta" }, index: 1, type: "content_block_delta" };
        yield { index: 1, type: "content_block_stop" };
        yield { delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 30 } };
        yield { type: "message_stop" };
      }
    };
    const onUsage = vi.fn();
    const call = compactionModelCall({ adapter: createAnthropicMessagesAdapter({ client }), deadlineAt: Date.now() + 600_000, onUsage },
      () => anthropicRun);
    const result = await call({ history: [{ text: "<conversation>…", type: "user" }], idleTimeoutMs: 1,
      instructions: SUMMARIZER_INSTRUCTIONS, kind: "summary", maxOutputTokens: 8_192, reasoningEffort: "low",
      signal: new AbortController().signal });
    expect(result.text).toBe("## Goal\n- x");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ max_tokens: 8_192, messages: [{ content: [{ text: "<conversation>…", type: "text" }], role: "user" }],
      model: "claude-haiku-5-5", output_config: { effort: "low" }, system: SUMMARIZER_INSTRUCTIONS, thinking: { type: "adaptive" } });
    expect(sent[0]).not.toHaveProperty("tools");
    expect(sent[0]).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(sent[0])).not.toMatch(/PRIVATE-MEMORY|AAAA/u);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 700, outputTokens: 30 }), undefined);
    // An effort the model does not declare is not asked for; the admitted one stays.
    expect(summaryCompactionRequest({ ...anthropicRun, modelCapabilities: { ...anthropicRun.modelCapabilities, reasoningEfforts: ["high"] } },
      { history: [], idleTimeoutMs: 1, kind: "summary", reasoningEffort: "low", signal: new AbortController().signal }).params)
      .toMatchObject({ outputConfig: { effort: "high" } });
  });

  it("go through the run's adapter with transport retries, stream nothing into the answer and account every request", async () => {
    let calls = 0;
    const sent: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
        sent.push(request);
        calls += 1;
        yield { data: { delta: "## Goal" }, type: "token" };
        if (calls === 1) throw Object.assign(new Error("bad gateway"), { status: 502 });
        return { finalProviderResponsePreview: {}, finalText: "## Goal\n- x", history: [{ text: "## Goal\n- x", type: "assistant_text" }],
          usage: { inputTokens: 900, outputTokens: 40 } };
      }
    };
    const onUsage = vi.fn();
    const call = compactionModelCall({ adapter, deadlineAt: Date.now() + 600_000, onUsage }, () => runRequest);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending = call({ history: span, idleTimeoutMs: 1, instructions: SUMMARIZER_INSTRUCTIONS, kind: "summary", maxOutputTokens: 4_096,
        signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toEqual({ history: [{ text: "## Goal\n- x", type: "assistant_text" }], text: "## Goal\n- x",
        usage: { inputTokens: 900, outputTokens: 40 } });
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toHaveLength(2);
    expect(sent.every((request) => request.prompt.system === SUMMARIZER_INSTRUCTIONS)).toBe(true);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 900, outputTokens: 40 }), undefined);
  });
});
