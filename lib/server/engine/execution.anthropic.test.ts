// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveStandardChatBaseline } from "@/lib/domain/promptTemplates";
import {
  memoryNativeEngine, NATIVE_MCP_SNAPSHOT, nativePrepared, nativeRunRepository, nativeSay, nativeSseEvents
} from "@/tests/support/nativeRunExecution";
import {
  createAnthropicMessagesAdapter,
  type AnthropicMessagesClient,
  type AnthropicStreamEvent
} from "../providers/anthropicMessages";
import type { ProviderRunRequest } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { createNativeRunExecutionResponse } from "./execution";
import { modelCallRetryDecision } from "./modelCall";
import { CLAUDE_FAMILY_PROMPT } from "./prompts/claude";
import { engineAdmissionRefusal } from "./handlerSupport";
import type { TranscriptItem } from "./transcript";

/**
 * A native Anthropic run end to end on the engine, with the real Messages
 * adapter over a recorded stream per request: routing, the tool loop with
 * its thinking replayed whole, the transcript, a later turn, and the retry
 * of a dropped stream. Content is synthetic.
 */

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };
const ORIGIN = Object.freeze({ model: "claude-haiku-5-5", provider: "connection-anthropic" });
type Body = { messages: { content: Record<string, unknown>[]; role: string }[]; system?: { text: string; type: string }[];
  tools?: { name: string }[] };

function anthropicPrepared(extra: Partial<ProviderRunRequest> = {}): MaterializedPreparedRunData {
  return nativePrepared({
    mcp: NATIVE_MCP_SNAPSHOT,
    modelCapabilities: { nativePdfInput: true, nativeSearch: false, pdf: true, reasoning: true, reasoningEfforts: ["low", "high"],
      toolCalling: true, vision: true },
    modelId: "claude-haiku-5-5",
    params: { maxTokens: 4_096, outputConfig: { effort: "low" }, thinking: { budgetTokens: 0, enabled: true, type: "adaptive" } },
    provider: "anthropic",
    ...extra
  }, {
    providerAdmissionPlan: { answer: { snapshot: { connection: { responseTimeoutMs: 60_000 }, connectionId: ORIGIN.provider,
      model: { adapterKind: "anthropic_messages", upstreamModelId: "claude-haiku-5-5" }, providerFamily: "anthropic",
      providerModelId: "model-claude" } } } as never
  });
}

/** One recorded Messages response: `thinking` (with its signature), then text, then tool calls. */
function response(input: Readonly<{ cache?: Readonly<{ read: number; write: number }>; calls?: readonly Readonly<{ id: string;
  input: Record<string, unknown> }>[]; signature: string; text?: string; thought: string }>): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [
    { message: { id: `msg_${input.signature}`, model: ORIGIN.model,
      usage: { cache_creation_input_tokens: input.cache?.write ?? 0, cache_read_input_tokens: input.cache?.read ?? 0,
        input_tokens: input.cache ? 50 : 900, output_tokens: 1 } }, type: "message_start" },
    { content_block: { signature: "", thinking: "", type: "thinking" }, index: 0, type: "content_block_start" },
    { delta: { thinking: input.thought, type: "thinking_delta" }, index: 0, type: "content_block_delta" },
    { delta: { signature: input.signature, type: "signature_delta" }, index: 0, type: "content_block_delta" },
    { index: 0, type: "content_block_stop" }
  ];
  let index = 1;
  if (input.text) {
    events.push({ content_block: { text: "", type: "text" }, index, type: "content_block_start" },
      { delta: { text: input.text, type: "text_delta" }, index, type: "content_block_delta" }, { index, type: "content_block_stop" });
    index += 1;
  }
  for (const call of input.calls ?? []) {
    events.push({ content_block: { id: call.id, input: {}, name: "mcp_jira_get_issue", type: "tool_use" }, index, type: "content_block_start" },
      { delta: { partial_json: JSON.stringify(call.input), type: "input_json_delta" }, index, type: "content_block_delta" },
      { index, type: "content_block_stop" });
    index += 1;
  }
  events.push({ delta: { stop_reason: input.calls?.length ? "tool_use" : "end_turn" }, type: "message_delta",
    usage: { output_tokens: 60 } }, { type: "message_stop" });
  return events;
}

/** The Anthropic adapter over recorded responses, in order; `bodies` are the request bodies it sent. */
function recordedAdapter(responses: readonly AnthropicStreamEvent[][]) {
  const bodies: Body[] = [];
  const client: AnthropicMessagesClient = {
    async *stream(body) {
      bodies.push(JSON.parse(JSON.stringify(body)) as Body);
      for (const event of responses[Math.min(bodies.length - 1, responses.length - 1)]!) yield event;
    }
  };
  return { adapter: createAnthropicMessagesAdapter({ client }), bodies };
}

const thinkingBlocks = (body: Body | undefined) => (body?.messages ?? []).flatMap((message) =>
  message.content.filter((block) => block.type === "thinking"));

describe("native Anthropic on the engine", () => {
  it("goes native and loops through a tool call with its thinking sent back whole, then answers", async () => {
    const { adapter, bodies } = recordedAdapter([
      response({ calls: [{ id: "toolu_1", input: { key: "A-1" } }], signature: "SIG-1", text: "Checking A-1.", thought: "Read the issue." }),
      response({ signature: "SIG-2", text: "A-1 is open.", thought: "It is open." })
    ]);
    const memory = memoryNativeEngine();
    const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
    const prepared = anthropicPrepared();
    expect(engineAdmissionRefusal(prepared)).toBeNull();
    const events = await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never, prepared,
      repository: nativeRunRepository() as unknown as RunRepository, services: {}, userId: "user-1" }));

    expect(events.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(memory.published()).toBe("Checking A-1.\n\nA-1 is open.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.system![0]!.text.startsWith(CLAUDE_FAMILY_PROMPT)).toBe(true);
    expect(bodies[0]!.tools!.map((tool) => tool.name)).toContain("mcp_jira_get_issue");
    expect(bodies[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(bodies[1]!.messages[1]!.content).toEqual([
      { signature: "SIG-1", thinking: "Read the issue.", type: "thinking" },
      { text: "Checking A-1.", type: "text" },
      { id: "toolu_1", input: { key: "A-1" }, name: "mcp_jira_get_issue", type: "tool_use" }
    ]);
    expect(bodies[1]!.messages[2]!.content).toEqual([expect.objectContaining({ tool_use_id: "toolu_1", type: "tool_result" })]);
    expect(bodies[1]!.messages[2]!.content[0]!.content).toContain("A-1: open");
    // The run's requests repeat one system prompt and tool set, so the replayed block's prefix holds.
    expect(bodies[1]!.system).toEqual(bodies[0]!.system);
    expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);

    const reasoning = memory.transcriptRows.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(2);
    for (const item of reasoning) {
      expect(item).toMatchObject({ native: { format: "anthropic_messages" }, origin: ORIGIN });
    }
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(expect.arrayContaining(["tool_call", "tool_result",
      "assistant_text"]));
  });

  it("records each round's cache reads and writes and prices them at the model's cache prices", async () => {
    const { adapter, bodies } = recordedAdapter([
      response({ cache: { read: 0, write: 850 }, calls: [{ id: "toolu_1", input: { key: "A-1" } }], signature: "SIG-1",
        thought: "Read the issue." }),
      response({ cache: { read: 850, write: 300 }, signature: "SIG-2", text: "A-1 is open.", thought: "It is open." })
    ]);
    const memory = memoryNativeEngine();
    // Claude Haiku 5.5's prices.
    const repository = { ...nativeRunRepository(), loadModelPricing: vi.fn(async () => ({ cacheWriteInputTokenPriceUsdPerMillion: 0.125,
      cachedInputTokenPriceUsdPerMillion: 0.01, inputTokenPriceUsdPerMillion: 0.1, outputTokenPriceUsdPerMillion: 0.5 })) };
    const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never, prepared: anthropicPrepared(),
      repository: repository as unknown as RunRepository, services: {}, userId: "user-1" }));

    // The second round reads the first round's prompt at the marker the first one wrote last.
    expect(bodies[1]!.messages[0]!.content.at(-1)).toHaveProperty("cache_control", { type: "ephemeral" });
    const written = (memory.runs.writeUsageRows.mock.calls as unknown as [unknown, readonly { attribution: RunUsageAttribution }[]][])
      .flatMap(([, rows]) => rows.map((row) => row.attribution)).filter((attribution) => attribution.purpose === "chat_answer");
    expect(written.map((attribution) => [attribution.usage, attribution.estimatedCostMicros])).toEqual([
      [expect.objectContaining({ cachedInputTokens: 0, cacheWriteInputTokens: 850, inputTokens: 900, outputTokens: 60 }),
        Math.round(50 * 0.1 + 850 * 0.125 + 60 * 0.5)],
      [expect.objectContaining({ cachedInputTokens: 850, cacheWriteInputTokens: 300, inputTokens: 1_200, outputTokens: 60 }),
        Math.round(50 * 0.1 + 850 * 0.01 + 300 * 0.125 + 60 * 0.5)]
    ]);
  });

  it("sends a later turn its earlier turns' calls, results and text but none of their thinking", async () => {
    const previous: TranscriptItem[] = [
      { id: "p1", kind: "reasoning", native: { fields: { binding: { prefix: "x", previous: null },
        block: { signature: "SIG-OLD", thinking: "Old thought.", type: "thinking" } }, format: "anthropic_messages" }, origin: ORIGIN },
      { arguments: "{\"key\":\"A-1\"}", callId: "toolu_0", id: "p2", kind: "tool_call", name: "mcp_jira_get_issue", origin: ORIGIN },
      { callId: "toolu_0", id: "p3", kind: "tool_result", name: "mcp_jira_get_issue", outcome: "complete", output: "A-1: open" },
      { id: "p4", kind: "assistant_text", origin: ORIGIN, text: "A-1 is open." }
    ];
    const { adapter, bodies } = recordedAdapter([response({ signature: "SIG-NEW", text: "Still open.", thought: "Same answer." })]);
    const memory = memoryNativeEngine();
    memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["previous-answer", "run-0"]]));
    memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", previous]]));
    const context = { messages: [nativeSay("previous-user", "user", "Check A-1"), nativeSay("previous-answer", "assistant", "A-1 is open."),
      nativeSay("current-user-message", "user", "And now?")], mode: "branch_path" as const };
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: anthropicPrepared({ content: { blocks: [{ text: "And now?", type: "text" }] }, context }),
      repository: nativeRunRepository() as unknown as RunRepository, services: {}, userId: "user-1" }));

    expect(thinkingBlocks(bodies[0])).toEqual([]);
    expect(bodies[0]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(bodies[0]!.messages[1]!.content).toEqual([{ id: "toolu_0", input: { key: "A-1" }, name: "mcp_jira_get_issue", type: "tool_use" }]);
    expect(memory.published()).toBe("Still open.");
  });

  it("sends a chat's next turn the same system prompt and tools, with the time and the turn's own guidance only before its input",
    async () => {
      const zone = "Europe/Moscow";
      const chatGuidance = "A Workspace is available in this chat.\nWorking directory: /workspace/project";
      // One chat, two turns on one day, each admitted with its own baseline time and output directory.
      const admitted = (at: Date, output: string, messages: ReturnType<typeof nativeSay>[]) => {
        const baseline = resolveStandardChatBaseline({ now: at, timeZone: zone }).renderedSystemPrompt;
        return anthropicPrepared({ content: messages.at(-1)!.content, context: { messages, mode: "branch_path" },
          prompt: { baseline: { source: "standard_chat", timeZone: zone, timeZoneSource: "client" }, developer: null,
            system: [baseline, chatGuidance, output].join("\n\n"), turnGuidance: [output] } });
      };
      const morning = new Date("2026-10-23T06:05:00Z");
      const evening = new Date("2026-10-23T17:40:00Z");
      const first = recordedAdapter([
        response({ calls: [{ id: "toolu_1", input: { key: "A-1" } }], signature: "SIG-1", text: "Checking A-1.", thought: "Read it." }),
        response({ signature: "SIG-2", text: "A-1 is open.", thought: "Open." })
      ]);
      const memory = memoryNativeEngine();
      const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
      await nativeSseEvents(createNativeRunExecutionResponse({ adapter: first.adapter, created,
        engine: { ...memory.engine, now: () => morning.getTime() },
        mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
        prepared: admitted(morning, "This turn's output directory: /workspace/outputs/run-1.",
          [nativeSay("current-user-message", "user", "Check A-1")]),
        repository: nativeRunRepository() as unknown as RunRepository, services: {}, userId: "user-1" }));

      const second = recordedAdapter([response({ signature: "SIG-3", text: "Still open.", thought: "Same." })]);
      const later = memoryNativeEngine();
      later.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-1", "run-1"]]));
      later.transcripts.loadRuns.mockResolvedValue(new Map([["run-1", memory.transcriptRows]]));
      await nativeSseEvents(createNativeRunExecutionResponse({ adapter: second.adapter,
        created: { assistantMessageId: "answer-2", runId: "run-2", userMessageId: "question-2" },
        engine: { ...later.engine, now: () => evening.getTime() },
        mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
        prepared: admitted(evening, "This turn's output directory: /workspace/outputs/run-2.", [nativeSay("question-1", "user", "Check A-1"),
          nativeSay("answer-1", "assistant", "A-1 is open."), nativeSay("current-user-message", "user", "And now?")]),
        repository: nativeRunRepository() as unknown as RunRepository, services: {}, userId: "user-1" }));

      const [morningBody, eveningBody] = [first.bodies[0]!, second.bodies[0]!];
      // Byte for byte, markers included: the next turn reads the system prompt and tools the first one cached.
      expect(JSON.stringify(eveningBody.system)).toBe(JSON.stringify(morningBody.system));
      expect(JSON.stringify(eveningBody.tools)).toBe(JSON.stringify(morningBody.tools));
      const system = morningBody.system![0]!.text;
      expect(system).toContain(`${chatGuidance}\n\n# Environment\nToday is October 23, 2026 in the user's time zone (${zone}).`);
      expect(system).not.toMatch(/09:05|08:40|outputs\/run-|<turn_context>/u);
      // The time and the output directory come just before each run's input, and a later turn never sees an earlier one's.
      expect(morningBody.messages.at(-1)!.content.slice(0, 2)).toEqual([
        { text: `<turn_context>\nCurrent local time: 09:05 AM GMT+3 (${zone}).\n\n` +
          "This turn's output directory: /workspace/outputs/run-1.\n</turn_context>", type: "text" },
        expect.objectContaining({ text: "Check A-1", type: "text" })]);
      expect(eveningBody.messages.at(-1)!.content[0]).toEqual({ text: `<turn_context>\nCurrent local time: 08:40 PM GMT+3 (${zone}).\n\n` +
        "This turn's output directory: /workspace/outputs/run-2.\n</turn_context>", type: "text" });
      expect(JSON.stringify(eveningBody.messages.slice(0, -1))).not.toContain("<turn_context>");
      expect(memory.transcriptRows.some((item) => item.kind === "user")).toBe(false);
    });

  it("has the engine send a dropped Anthropic stream again: one ended early or with an error event", async () => {
    const drop = async (events: AnthropicStreamEvent[]) => {
      const adapter = createAnthropicMessagesAdapter({ client: { async *stream() { for (const event of events) yield event; } } });
      const stream = adapter.stream(anthropicPrepared().providerRequest);
      try {
        for (let next = await stream.next(); !next.done; next = await stream.next()) { /* drain */ }
      } catch (error) {
        return error;
      }
      return null;
    };
    const started = response({ signature: "SIG-1", text: "Partial", thought: "x" }).slice(0, 6);
    const truncated = await drop(started);
    const overloaded = await drop([...started, { error: { message: "PRIVATE", type: "overloaded_error" }, type: "error" }]);
    for (const failure of [truncated, overloaded]) {
      expect(failure).toBeInstanceOf(Error);
      expect(modelCallRetryDecision(failure, new AbortController().signal)).toEqual({ retryAfterMs: null });
    }
    expect(String(overloaded)).not.toContain("PRIVATE");
  });
});
