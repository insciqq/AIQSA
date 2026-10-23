// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
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
import type { RunRepository } from "../runs/runRepositoryContract";
import { createNativeRunExecutionResponse } from "./execution";
import { modelCallRetryDecision } from "./modelCall";
import { CLAUDE_FAMILY_PROMPT } from "./prompts/claude";
import { nativeEngineRoute, parseNativeEngineUsers } from "./routing";
import type { TranscriptItem } from "./transcript";

/**
 * A native Anthropic run end to end on the engine, with the real Messages
 * adapter over a recorded stream per request: routing, the tool loop with
 * its thinking replayed whole, the transcript, a later turn, and the retry
 * of a dropped stream. Content is synthetic.
 */

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };
const ORIGIN = Object.freeze({ model: "claude-haiku-5-5", provider: "connection-anthropic" });
type Body = { messages: { content: Record<string, unknown>[]; role: string }[]; system?: string; tools?: { name: string }[] };

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
function response(input: Readonly<{ calls?: readonly Readonly<{ id: string; input: Record<string, unknown> }>[]; signature: string;
  text?: string; thought: string }>): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [
    { message: { id: `msg_${input.signature}`, model: ORIGIN.model,
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 900, output_tokens: 1 } }, type: "message_start" },
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
    expect(nativeEngineRoute({ allowlist: parseNativeEngineUsers("user-1"), prepared, user: { email: null, id: "user-1" },
      workspacePredecessor: false })).toEqual({ engine: "native" });
    const events = await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never, prepared,
      repository: nativeRunRepository() as unknown as RunRepository, services: {}, userId: "user-1" }));

    expect(events.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(memory.published()).toBe("Checking A-1.\n\nA-1 is open.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.system!.startsWith(CLAUDE_FAMILY_PROMPT)).toBe(true);
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
    expect(bodies[1]!.system).toBe(bodies[0]!.system);
    expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);

    const reasoning = memory.transcriptRows.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(2);
    for (const item of reasoning) {
      expect(item).toMatchObject({ native: { format: "anthropic_messages" }, origin: ORIGIN });
    }
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(expect.arrayContaining(["tool_call", "tool_result",
      "assistant_text"]));
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
