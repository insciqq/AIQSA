import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import {
  anthropicMessagesToolBridge,
  geminiInteractionsToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "../tools/bridges";
import { projectObservationForProvider } from "../toolObservations/projection";
import type { ToolExecutionResult } from "../tools/types";
import { readToolResultTool } from "../tools/readToolResult";
import { conversationContextPolicy, contextCompactionCheckpoint } from "./contextCompactionContract";
import {
  contextCompactionMeasurementWithBudget,
  observationCallIdsInProviderMessages,
  observationHandlesInProviderMessages,
  planContextCompaction
} from "./contextCompactionPlanner";

const descriptor = (seed: string, source: "mcp" | "workspace" | "search" | "skill" = "mcp") => ({
  byteSize: 20_000,
  checksum: createHash("sha256").update(seed).digest("hex"),
  encoding: "json-utf8-v1" as const,
  handle: `tor1_${createHash("sha256").update(`handle:${seed}`).digest("hex").slice(0, 32)}`,
  maskable: source !== "skill",
  source,
  sourceTruncated: false,
  version: 1 as const
});

function result(id: string, seed: string, source?: "mcp" | "workspace" | "search" | "skill"): ToolExecutionResult {
  return projectObservationForProvider({
    callId: id,
    content: [{ text: `rare fact ${id} ${"x".repeat(900)}`, type: "text" }],
    name: "read_record",
    observation: descriptor(seed, source),
    status: "complete"
  });
}

function request(messages: unknown[], version: 0 | 1 = 1): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat",
    content: { blocks: [{ text: "current", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "current", type: "text" }] }, id: "current", role: "user" }], mode: "branch_path" },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 20_000, defaultMaxOutputTokens: 512, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, toolCalling: true },
    modelId: "test",
    params: {},
    prompt: { developer: "trusted", system: "system" },
    provider: "openai",
    providerToolMessages: messages,
    searchPlan: { mode: "all_selected", options: [] },
    toolObservationVersion: version,
    toolMode: "auto",
    tools: [readToolResultTool]
  };
}

describe("context compaction planner", () => {
  it("keeps the newest settled batch and masks complete older results across growing cycles", () => {
    let messages: unknown[] = [result("call-1", "a")].map(value => openAIResponsesToolBridge.appendToolResult(undefined, value));
    const observations: string[] = [];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, request: request(messages) });
      messages = planned.request.providerToolMessages ?? [];
      observations.push(JSON.stringify(messages));
      expect(planned.measurement.maskedObservations).toBe(cycle === 1 ? 0 : cycle - 1);
      const next = result(`call-${cycle + 1}`, String.fromCharCode(96 + cycle + 1));
      messages = [...messages, { type: "function_call", call_id: `call-${cycle + 1}`, name: "read_record" }, openAIResponsesToolBridge.appendToolResult(undefined, next)];
    }
    expect(observations[0]).toContain("rare fact call-1");
    expect(observations[1]).not.toContain("rare fact call-1");
    expect(observations[2]).not.toContain("rare fact call-2");
    expect(JSON.stringify(messages)).toContain("rare fact call-4");
    expect(JSON.stringify(messages)).toContain("tor1_");
  });

  it("recognizes a saved observation descriptor inside a reader result on a later cycle", () => {
    const saved = descriptor("reader-source");
    const readerResult = {
      callId: "reader-1",
      content: [{ type: "json" as const, value: {
        cursor: "next",
        offset: 0,
        fragment: "large exact fragment ".repeat(2_000),
        endOffset: 40_000,
        incomplete: true,
        fragmentKind: "serialized_json_text",
        observation: saved
      } }],
      name: "read_tool_result",
      status: "complete" as const
    };
    const planned = planContextCompaction({
      bridge: openAIResponsesToolBridge,
      request: request([
        openAIResponsesToolBridge.appendToolResult(undefined, result("old-reader-source", "old-reader")),
        { type: "function_call", call_id: "reader-1", name: "read_tool_result" },
        openAIResponsesToolBridge.appendToolResult(undefined, readerResult),
        { type: "function_call", call_id: "newest-reader", name: "read_tool_result" },
        openAIResponsesToolBridge.appendToolResult(undefined, result("newest-reader", "newest-reader"))
      ])
    });
    expect(planned.measurement.maskedObservations).toBe(2);
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).not.toContain("large exact fragment");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain(saved.handle);
  });

  it("does not mask skills, unsupported shapes, agents, or legacy/off requests", () => {
    const skill = result("skill-1", "b");
    const skillValue = { ...skill, observation: { ...skill.observation, source: "skill" as const, maskable: false } as typeof skill.observation };
    const agentRequest = { ...request([openAIResponsesToolBridge.appendToolResult(undefined, result("agent-1", "c"))]), agent: {} as NonNullable<ProviderRunRequest["agent"]> };
    for (const candidate of [
      request([openAIResponsesToolBridge.appendToolResult(undefined, skillValue)]),
      request([{ role: "tool", content: "unrecognized result" }]),
      agentRequest,
      request([openAIResponsesToolBridge.appendToolResult(undefined, result("off-1", "d"))], 0)
    ]) {
      const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, request: candidate });
      expect(planned.measurement.maskedObservations).toBe(0);
      expect(planned.request.providerToolMessages).toEqual(candidate.providerToolMessages);
    }
  });

  it("does not rewrite a remote continuation whose provider owns hidden history", () => {
    const input = request([openAIResponsesToolBridge.appendToolResult(undefined, result("remote-1", "e"))]);
    const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, request: { ...input, previousProviderResponseId: "remote" } });
    expect(planned.measurement.maskedObservations).toBe(0);
    expect(planned.request.providerToolMessages).toEqual(input.providerToolMessages);
  });

  it("keeps the legacy projection when the accepted request has no reader capability", () => {
    const input = request([openAIResponsesToolBridge.appendToolResult(undefined, result("no-reader", "e"))]);
    const planned = planContextCompaction({
      bridge: openAIResponsesToolBridge,
      request: { ...input, tools: [], modelCapabilities: { ...input.modelCapabilities, toolCalling: true } }
    });
    expect(planned.measurement.outcome).toBe("already_fits");
    expect(planned.measurement.maskedObservations).toBe(0);
    expect(planned.request.providerToolMessages).toEqual(input.providerToolMessages);
  });

  it("preserves error status and leaves model-authored descriptor lookalikes opaque", () => {
    const error = geminiInteractionsToolBridge.appendToolResult(undefined, projectObservationForProvider({
      callId: "error-1",
      content: [{ text: "failed", type: "text" }],
      name: "read_record",
      observation: descriptor("f"),
      status: "error"
    }));
    const lookalike = {
      arguments: JSON.stringify({ observation: descriptor("i"), reader: "read_tool_result" }),
      call_id: "model-authored",
      name: "read_record",
      type: "function_call"
    };
    const opaqueNestedLookalike = openAIResponsesToolBridge.appendToolResult(undefined, {
      callId: "opaque-lookalike",
      content: [{ type: "json" as const, value: { observation: descriptor("opaque"), value: "external body" } }],
      name: "remote_tool",
      status: "complete" as const
    });
    const newest = geminiInteractionsToolBridge.appendToolResult(undefined, projectObservationForProvider({
      ...result("newest-1", "a"),
      status: "complete"
    }));
    const planned = planContextCompaction({
      bridge: geminiInteractionsToolBridge,
      request: { ...request([error, lookalike, opaqueNestedLookalike, newest]), provider: "gemini" }
    });
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(planned.request.providerToolMessages?.[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("model-authored");
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("tor1_");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("external body");
  });

  it("keeps an unmaskable result in the same settled batch while masking eligible siblings", () => {
    const skill = result("skill-1", "h", "skill");
    const newest = result("newest-2", "j");
    const oldBatch = [
      openAIResponsesToolBridge.appendToolResult(undefined, result("old-2", "c")),
      openAIResponsesToolBridge.appendToolResult(undefined, skill)
    ];
    const planned = planContextCompaction({
      bridge: openAIResponsesToolBridge,
      request: request([...oldBatch, { type: "function_call", call_id: "newest-2", name: "read_record" },
        openAIResponsesToolBridge.appendToolResult(undefined, newest)])
    });
    expect(planned.measurement.maskedBatches).toBe(1);
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(JSON.stringify(planned.request.providerToolMessages?.[0])).not.toContain("rare fact old-2");
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("tor1_");
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("skill-1");
  });

  it.each([
    ["openai", openAIResponsesToolBridge, { call_id: "new", name: "read_record", type: "function_call" }],
    ["openrouter", openRouterChatToolBridge, { role: "assistant", tool_calls: [{ function: { arguments: "{}", name: "read_record" }, id: "new", type: "function" }] }],
    ["gemini", geminiInteractionsToolBridge, { id: "new", name: "read_record", type: "function_call" }],
    ["anthropic", anthropicMessagesToolBridge, { content: [{ id: "new", input: {}, name: "read_record", type: "tool_use" }], role: "assistant" }]
  ] as const)("masks through the %s bridge without changing its result envelope", (provider, bridge, separator) => {
    const oldResult = bridge.appendToolResult(undefined, result("old-bridge", "c"));
    const newResult = bridge.appendToolResult(undefined, result("new-bridge", "d"));
    const planned = planContextCompaction({
      bridge,
      request: { ...request([oldResult, separator, newResult]), provider }
    });
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(JSON.stringify(planned.request.providerToolMessages?.[0])).not.toContain("rare fact old-bridge");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("rare fact new-bridge");
  });

  it("reports a bounded future-summary state without claiming a summary was produced", () => {
    const measurement = {
      afterTokens: 120,
      beforeTokens: 200,
      budgetTokens: null,
      legacyFallback: false,
      maskedBatches: 1,
      maskedObservations: 2,
      outcome: "masking_applied" as const,
      version: 1 as const
    };
    expect(contextCompactionMeasurementWithBudget(measurement, 100, true)).toMatchObject({
      budgetTokens: 100,
      legacyFallback: true,
      outcome: "needs_summary"
    });
    expect(contextCompactionMeasurementWithBudget(measurement, 100, false)).toMatchObject({
      budgetTokens: 100,
      legacyFallback: false,
      outcome: "irreducible_overflow"
    });
  });

  it("keeps checkpoint identity bounded to the accepted branch and recent references", () => {
    const input = request([openAIResponsesToolBridge.appendToolResult(undefined, result("checkpoint-1", "b"))]);
    const policy = conversationContextPolicy({ leafMessageId: "accepted-leaf", messages: input.context!.messages });
    const withPolicy = { ...input, contextCompactionPolicy: policy };
    const checkpoint = contextCompactionCheckpoint({
      ownerId: "owner",
      request: withPolicy,
      runId: "run",
      observationRefs: observationHandlesInProviderMessages(input.providerToolMessages ?? []),
      recentTailCallIds: observationCallIdsInProviderMessages(input.providerToolMessages ?? []),
      followupRevision: 4,
      followupTexts: ["clarify this"]
    });
    expect(checkpoint).toMatchObject({
      branchId: "accepted-leaf",
      followupRevision: 4,
      sourceDigest: policy.source.digest,
      recentTailCallIds: ["checkpoint-1"]
    });
    expect(JSON.stringify(checkpoint).length).toBeLessThan(512 * 1024);
  });
});
