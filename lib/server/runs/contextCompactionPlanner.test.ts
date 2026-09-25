import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContextSummary } from "../../contracts/contextCompaction";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  anthropicMessagesToolBridge,
  geminiInteractionsToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "../tools/bridges";
import { projectObservationForProvider } from "../toolObservations/projection";
import type { ProviderToolBridge, ToolExecutionResult } from "../tools/types";
import { executeReadToolResult, readToolResultTool } from "../tools/readToolResult";
import { captureMcpObservation } from "../toolObservations/sourceAdapters";
import { memoryToolObservations } from "@/tests/support/toolObservations";
import { conversationContextPolicy, contextCompactionCheckpoint } from "./contextCompactionContract";
import {
  contextCompactionMeasurementWithBudget,
  contextObservationsFromResults,
  observationCallIdsInProviderMessages,
  observationHandlesInProviderMessages,
  planContextCompaction
} from "./contextCompactionPlanner";
import { contextSummarySource } from "./contextCompactionSummarizer";

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

/** A tiny budget makes every fixture cross the masking trigger. */
const TRIGGERING_BUDGET = 100;

function plan(bridge: ProviderToolBridge, input: ProviderRunRequest, settled: readonly ToolExecutionResult[],
  budgetTokens: number | null = TRIGGERING_BUDGET) {
  return planContextCompaction({ bridge, budgetTokens, observations: contextObservationsFromResults(settled), request: input });
}

function reference(bridge: ProviderToolBridge, settled: ToolExecutionResult): unknown {
  return bridge.appendToolResult(undefined, { callId: settled.callId, name: settled.name, status: settled.status,
    content: [{ type: "json", value: { observation: settled.observation, reader: "read_tool_result" } }] });
}

describe("context compaction planner", () => {
  it("keeps the newest settled batch and masks each older result once across growing cycles", () => {
    const settled = [result("call-1", "a")];
    let messages: unknown[] = settled.map(value => openAIResponsesToolBridge.appendToolResult(undefined, value));
    const observations: string[] = [];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const planned = plan(openAIResponsesToolBridge, request(messages), settled);
      messages = planned.request.providerToolMessages ?? [];
      observations.push(JSON.stringify(messages));
      // An earlier reference is never masked again; each cycle masks only the
      // batch that has just stopped being the newest one.
      expect(planned.measurement.maskedObservations).toBe(cycle === 1 ? 0 : 1);
      const next = result(`call-${cycle + 1}`, String.fromCharCode(96 + cycle + 1));
      settled.push(next);
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
    const oldSource = result("old-reader-source", "old-reader");
    const newest = result("newest-reader", "newest-reader");
    const planned = plan(openAIResponsesToolBridge, request([
      openAIResponsesToolBridge.appendToolResult(undefined, oldSource),
      { type: "function_call", call_id: "reader-1", name: "read_tool_result" },
      openAIResponsesToolBridge.appendToolResult(undefined, readerResult),
      { type: "function_call", call_id: "newest-reader", name: "read_tool_result" },
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ]), [oldSource, newest]);
    expect(planned.measurement.maskedObservations).toBe(2);
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).not.toContain("large exact fragment");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain(saved.handle);
  });

  it("masks an MCP result delivered whole once it is no longer newest, and the reader recalls its exact bytes", async () => {
    const observations = memoryToolObservations();
    const actor = { runId: "whole-run", userId: "whole-owner" };
    const call = { id: "whole-1", name: "mcp_records", arguments: {} };
    const body = Array.from({ length: 1_600 }, (_, index) => createHash("sha256").update(`whole:${index}`).digest("hex")).join("");
    const original = { isError: false, structuredContent: null, text: [`${body} rare-whole-tail`], unsupportedContentTypes: [] };
    // 100 KiB of unique text within a quarter of a 128,000-token budget.
    const whole = await captureMcpObservation({ service: observations.service(), producer: { ...actor, toolCallId: call.id },
      wholeResultTokens: 32_000 }, call, { version: 1, source: "mcp", serverId: "server", originalName: "records",
      revisionId: "revision", fingerprint: "a".repeat(64) }, async () => original);
    expect(JSON.stringify(whole.content)).toContain("rare-whole-tail");
    const newest = result("whole-2", "whole-newest");
    const messages = [
      { type: "function_call", call_id: call.id, name: call.name },
      openAIResponsesToolBridge.appendToolResult(undefined, projectObservationForProvider(whole)),
      { type: "function_call", call_id: newest.callId, name: newest.name },
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ];
    const budgetTokens = 128_000;
    const settled = contextObservationsFromResults([whole, newest]);
    // Below the trigger the whole result stays inline.
    const below = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens, assembledTokens: 60_000,
      observations: settled, request: request(messages) });
    expect(below.measurement.maskedObservations).toBe(0);
    expect(JSON.stringify(below.request.providerToolMessages)).toContain("rare-whole-tail");
    // A later round over 75% of the budget replaces the body by its descriptor.
    const later = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens, assembledTokens: 100_000,
      observations: settled, request: request(messages) });
    expect(later.measurement.maskedObservations).toBe(1);
    const transcript = JSON.stringify(later.request.providerToolMessages);
    expect(transcript).not.toContain("rare-whole-tail");
    expect(transcript).not.toContain(body.slice(0, 64));
    expect(transcript).toContain(whole.observation!.handle);
    expect(later.request.providerToolMessages?.[1]).toEqual(reference(openAIResponsesToolBridge, whole));
    expect(transcript).toContain("rare fact whole-2");
    const fragments: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 32; index += 1) {
      const read = await executeReadToolResult(observations.service(), { id: `read-${index}`, name: "read_tool_result",
        arguments: { handle: whole.observation!.handle, ...(cursor ? { cursor } : {}) } }, actor);
      const value = read.content[0]?.type === "json" ? read.content[0].value as { fragment: string; cursor: string | null } : null;
      expect(read.status).toBe("complete");
      fragments.push(value!.fragment);
      if (!value!.cursor) break;
      cursor = value!.cursor;
    }
    expect(fragments.join("")).toBe(JSON.stringify(original));
  });

  it("does not mask skills, unsupported shapes, agents, or legacy/off requests", () => {
    const skill = result("skill-1", "b");
    const skillValue = { ...skill, observation: { ...skill.observation, source: "skill" as const, maskable: false } as typeof skill.observation };
    const agentResult = result("agent-1", "c");
    const offResult = result("off-1", "d");
    const agentRequest = { ...request([openAIResponsesToolBridge.appendToolResult(undefined, agentResult)]), agent: {} as NonNullable<ProviderRunRequest["agent"]> };
    for (const candidate of [
      request([openAIResponsesToolBridge.appendToolResult(undefined, skillValue)]),
      request([{ role: "tool", content: "unrecognized result" }]),
      agentRequest,
      request([openAIResponsesToolBridge.appendToolResult(undefined, offResult)], 0)
    ]) {
      const planned = plan(openAIResponsesToolBridge, candidate, [skillValue, agentResult, offResult]);
      expect(planned.measurement.maskedObservations).toBe(0);
      expect(planned.request.providerToolMessages).toEqual(candidate.providerToolMessages);
    }
  });

  it("does not rewrite a remote continuation whose provider owns hidden history", () => {
    const remote = result("remote-1", "e");
    const input = request([openAIResponsesToolBridge.appendToolResult(undefined, remote)]);
    const planned = plan(openAIResponsesToolBridge, { ...input, previousProviderResponseId: "remote" }, [remote]);
    expect(planned.measurement.maskedObservations).toBe(0);
    expect(planned.request.providerToolMessages).toEqual(input.providerToolMessages);
  });

  it("keeps the legacy projection when the accepted request has no reader capability", () => {
    const settled = [result("no-reader", "e"), result("no-reader-new", "f")];
    const input = request([
      openAIResponsesToolBridge.appendToolResult(undefined, settled[0]!),
      { type: "function_call", call_id: "no-reader-new", name: "read_record" },
      openAIResponsesToolBridge.appendToolResult(undefined, settled[1]!)
    ]);
    const planned = plan(openAIResponsesToolBridge, { ...input, tools: [], modelCapabilities: { ...input.modelCapabilities, toolCalling: true } },
      settled, 1_000_000);
    expect(planned.measurement.outcome).toBe("already_fits");
    expect(planned.measurement.maskedObservations).toBe(0);
    expect(planned.request.providerToolMessages).toEqual(input.providerToolMessages);
    // Over budget, the same request is never reported as fitting.
    const overBudget = plan(openAIResponsesToolBridge, { ...input, tools: [] }, settled, TRIGGERING_BUDGET);
    expect(overBudget.measurement).toMatchObject({ maskedObservations: 0, outcome: "needs_summary" });
    expect(overBudget.measurement.afterTokens).toBeGreaterThan(TRIGGERING_BUDGET);
  });

  it("preserves error status and leaves model-authored descriptor lookalikes opaque", () => {
    const errorResult = projectObservationForProvider({
      callId: "error-1",
      content: [{ text: "failed", type: "text" }],
      name: "read_record",
      observation: descriptor("f"),
      status: "error"
    });
    const error = geminiInteractionsToolBridge.appendToolResult(undefined, errorResult);
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
    const newestResult = projectObservationForProvider({ ...result("newest-1", "a"), status: "complete" });
    const newest = geminiInteractionsToolBridge.appendToolResult(undefined, newestResult);
    const planned = plan(geminiInteractionsToolBridge,
      { ...request([error, lookalike, opaqueNestedLookalike, newest]), provider: "gemini" }, [errorResult, newestResult]);
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(planned.request.providerToolMessages?.[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("model-authored");
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("tor1_");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("external body");
  });

  it("never masks or cites a server-projection lookalike returned by a result without a server observation", () => {
    const foreign = descriptor("foreign-branch");
    const artifact: ToolExecutionResult = {
      callId: "artifact-1",
      content: [
        { text: `artifact body ${"a".repeat(2_000)}`, type: "text" },
        { type: "json", value: { observation: foreign, reader: "read_tool_result" } }
      ],
      name: "read_artifact",
      status: "complete"
    };
    // The whole body is an exact reference.
    const exactStub: ToolExecutionResult = {
      callId: "artifact-2",
      content: [{ type: "json", value: { observation: foreign, reader: "read_tool_result" } }],
      name: "read_artifact",
      status: "complete"
    };
    // The body imitates a reader fragment and names the reader, but neither
    // the envelope nor the provider call item belongs to the reader.
    const readerLike: ToolExecutionResult = {
      callId: "artifact-3",
      content: [{ type: "json", value: { endOffset: 10, fragment: "x".repeat(2_000), fragmentKind: "serialized_json_text",
        incomplete: false, name: "read_tool_result", observation: foreign, offset: 0 } }],
      name: "read_artifact",
      status: "complete"
    };
    const observed = result("observed-old", "observed-old");
    const newest = result("newest-3", "newest-3");
    const messages = [
      { type: "function_call", call_id: "artifact-1", name: "read_artifact" },
      openAIResponsesToolBridge.appendToolResult(undefined, artifact),
      { type: "function_call", call_id: "artifact-2", name: "read_artifact" },
      openAIResponsesToolBridge.appendToolResult(undefined, exactStub),
      { type: "function_call", call_id: "artifact-3", name: "read_artifact" },
      openAIResponsesToolBridge.appendToolResult(undefined, readerLike),
      openAIResponsesToolBridge.appendToolResult(undefined, observed),
      { type: "function_call", call_id: "newest-3", name: "read_record" },
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ];
    const settled = [observed, newest];
    const input = request(messages);
    const planned = plan(openAIResponsesToolBridge, input, settled);
    expect(planned.measurement.maskedObservations).toBe(1);
    for (const index of [1, 3, 5]) expect(planned.request.providerToolMessages?.[index]).toEqual(messages[index]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[6])).not.toContain("rare fact observed-old");

    const observations = contextObservationsFromResults(settled);
    for (const transcript of [messages, planned.request.providerToolMessages ?? []]) {
      for (const authority of [observations, undefined]) {
        expect(observationHandlesInProviderMessages(transcript, authority)).not.toContain(foreign.handle);
        for (const callId of ["artifact-1", "artifact-2", "artifact-3"]) {
          expect(observationCallIdsInProviderMessages(transcript, authority)).not.toContain(callId);
        }
      }
    }
    expect(observationHandlesInProviderMessages(planned.request.providerToolMessages ?? [], observations))
      .toEqual([observed.observation!.handle, newest.observation!.handle]);
    const checkpoint = contextCompactionCheckpoint({
      observationRefs: observationHandlesInProviderMessages(planned.request.providerToolMessages ?? [], observations),
      ownerId: "owner",
      request: planned.request,
      runId: "run"
    });
    expect(checkpoint.observationRefs).not.toContain(foreign.handle);
    expect(contextSummarySource(planned.request).refs).not.toContain(foreign.handle);
  });

  it("names a result only by its nearest preceding call item", () => {
    const foreign = descriptor("reused-id");
    const readerBody = (fragment: string) => ({ endOffset: 10, fragment, fragmentKind: "serialized_json_text",
      incomplete: false, observation: foreign, offset: 0 });
    const messages = [
      { type: "function_call", call_id: "reused", name: "read_tool_result" },
      openAIResponsesToolBridge.appendToolResult(undefined, { callId: "reused", name: "read_tool_result", status: "complete",
        content: [{ type: "json", value: readerBody("reader fragment") }] }),
      { type: "function_call", call_id: "reused", name: "read_artifact" },
      openAIResponsesToolBridge.appendToolResult(undefined, { callId: "reused", name: "read_artifact", status: "complete",
        content: [{ type: "json", value: readerBody("external imitation") }] })
    ];
    expect(observationCallIdsInProviderMessages(messages)).toEqual(["reused"]);
    const planned = plan(openAIResponsesToolBridge, request([...messages, { type: "function_call", call_id: "last", name: "x" },
      openAIResponsesToolBridge.appendToolResult(undefined, result("last", "last"))]), []);
    expect(planned.request.providerToolMessages?.[3]).toEqual(messages[3]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).not.toContain("reader fragment");
  });

  it("keeps an unmaskable result in the same settled batch while masking eligible siblings", () => {
    const skill = result("skill-1", "h", "skill");
    const old = result("old-2", "c");
    const newest = result("newest-2", "j");
    const oldBatch = [
      openAIResponsesToolBridge.appendToolResult(undefined, old),
      openAIResponsesToolBridge.appendToolResult(undefined, skill)
    ];
    const planned = plan(openAIResponsesToolBridge, request([...oldBatch, { type: "function_call", call_id: "newest-2", name: "read_record" },
      openAIResponsesToolBridge.appendToolResult(undefined, newest)]), [old, skill, newest]);
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
  ] as const)("masks through the %s bridge once without changing its result envelope", (provider, bridge, separator) => {
    const settled = [result("old-bridge", "c"), result("new-bridge", "d")];
    const input = { ...request([bridge.appendToolResult(undefined, settled[0]!), separator,
      bridge.appendToolResult(undefined, settled[1]!)]), provider };
    const planned = plan(bridge, input, settled);
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(planned.request.providerToolMessages?.[0]).toEqual(reference(bridge, settled[0]!));
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("rare fact new-bridge");
    const again = plan(bridge, planned.request, settled);
    expect(again.measurement.maskedObservations).toBe(0);
    expect(again.request.providerToolMessages).toEqual(planned.request.providerToolMessages);
  });

  it("reports an already masked projection that fits as already_fits instead of a summary request", () => {
    const settled = [result("masked-1", "k"), result("masked-2", "l"), result("newest-4", "m")];
    const messages = [
      reference(openAIResponsesToolBridge, settled[0]!),
      reference(openAIResponsesToolBridge, settled[1]!),
      { type: "function_call", call_id: "newest-4", name: "read_record" },
      openAIResponsesToolBridge.appendToolResult(undefined, settled[2]!)
    ];
    const input = request(messages);
    const size = planContextCompaction({ request: input }).measurement.beforeTokens;
    // 75–100% of the budget with nothing left to mask.
    const budgetTokens = Math.ceil(size / 0.8);
    for (const candidate of [input, { ...input, contextCompactionPolicy: conversationContextPolicy({
      leafMessageId: "current", messages: input.context!.messages, mode: "hybrid" }) }]) {
      const planned = plan(openAIResponsesToolBridge, candidate, settled, budgetTokens);
      expect(planned.measurement).toMatchObject({ maskedObservations: 0, outcome: "already_fits" });
      expect(planned.request.providerToolMessages).toEqual(messages);
    }
  });

  it("adds no new reference when the reader cannot be called this round or the window is unknown", () => {
    const settled = [result("stub-1", "n"), result("older-1", "o"), result("newest-5", "p")];
    const messages = [
      reference(openAIResponsesToolBridge, settled[0]!),
      openAIResponsesToolBridge.appendToolResult(undefined, settled[1]!),
      { type: "function_call", call_id: "newest-5", name: "read_record" },
      openAIResponsesToolBridge.appendToolResult(undefined, settled[2]!)
    ];
    const finalRound = plan(openAIResponsesToolBridge, { ...request(messages), toolChoice: "none" }, settled);
    expect(finalRound.measurement.maskedObservations).toBe(0);
    expect(finalRound.request.providerToolMessages).toEqual(messages);
    expect(finalRound.measurement.outcome).not.toBe("already_fits");
    for (const budgetTokens of [null, undefined]) {
      const unknown = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens,
        observations: contextObservationsFromResults(settled), request: request(messages) });
      expect(unknown.measurement).toMatchObject({ budgetTokens: null, maskedObservations: 0, outcome: "already_fits" });
      expect(unknown.request.providerToolMessages).toEqual(messages);
    }
    const auto = plan(openAIResponsesToolBridge, { ...request(messages), toolChoice: "auto" }, settled);
    expect(auto.measurement.maskedObservations).toBe(1);
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
    const settled = result("checkpoint-1", "b");
    const input = request([openAIResponsesToolBridge.appendToolResult(undefined, settled)]);
    const observations = contextObservationsFromResults([settled]);
    const policy = conversationContextPolicy({ leafMessageId: "accepted-leaf", messages: input.context!.messages });
    const withPolicy = { ...input, contextCompactionPolicy: policy };
    const checkpoint = contextCompactionCheckpoint({
      ownerId: "owner",
      request: withPolicy,
      runId: "run",
      observationRefs: observationHandlesInProviderMessages(input.providerToolMessages ?? [], observations),
      recentTailCallIds: observationCallIdsInProviderMessages(input.providerToolMessages ?? [], observations),
      followupRevision: 4,
      followupTexts: ["clarify this"]
    });
    expect(checkpoint).toMatchObject({
      branchId: "accepted-leaf",
      followupRevision: 4,
      observationRefs: [settled.observation!.handle],
      sourceDigest: policy.source.digest,
      recentTailCallIds: ["checkpoint-1"]
    });
    expect(JSON.stringify(checkpoint).length).toBeLessThan(512 * 1024);
  });

  it("drops covered turns before asking for new notes and summarizes only history the carried notes do not cover", () => {
    const notes: ContextSummary = { formatVersion: 1, id: "cs1_carried", notes: "Carried notes.", sourceDigest: "c".repeat(64), sourceRefs: [] };
    const say = (id: string, role: "assistant" | "user", chars: number): ProviderConversationMessage =>
      ({ content: { blocks: [{ text: `${id} ${"t".repeat(chars)}`, type: "text" }] }, id, role });
    const messages = [
      { ...say("note", "assistant", 0), id: "__context-summary-cs1_carried" },
      say("u2", "user", 4_000),
      ...["a2", "u3", "a3", "u4", "a4"].map((id) => say(id, id.startsWith("u") ? "user" : "assistant", 1_000)),
      say("current", "user", 0)
    ];
    const base = request([]);
    const policy = conversationContextPolicy({ leafMessageId: "a4", messages, mode: "hybrid" });
    const carried: ProviderRunRequest = { ...base, context: { messages, mode: "branch_path" }, contextCompactionSummary: notes,
      contextCompactionPolicy: { ...policy, reuse: { coveredMessageId: "u2", runId: "run-2", summary: notes } } };
    const prior = messages.slice(0, -1).reduce((total, message) => total + estimateApproxTokens(message.content), 0);
    const assembledTokens = prior + 100;
    const covered = estimateApproxTokens(messages[1]!.content);
    const plan = (input: ProviderRunRequest, budgetTokens: number) =>
      planContextCompaction({ assembledTokens, budgetTokens, bridge: openAIResponsesToolBridge, request: input });

    // Over budget, and dropping the covered turn is enough: nothing is bought.
    const trimmed = plan(carried, assembledTokens - covered + 200);
    expect(trimmed.measurement).toMatchObject({ legacyFallback: true, outcome: "already_fits" });
    expect(trimmed.historyTrim).toMatchObject({ droppedMessages: 1 });
    expect(trimmed.request.context?.messages.map((message) => message.id)).toEqual([
      "__context-summary-cs1_carried", "a2", "u3", "a3", "u4", "a4", "current"
    ]);
    // Uncovered history must still leave: new notes, never a legacy trim of it.
    expect(plan(carried, assembledTokens - covered - 200).measurement.outcome).toBe("needs_summary");
    // Fits above the trigger with uncovered history older than the exact tail: headroom notes.
    expect(plan(carried, Math.floor(assembledTokens / 0.8)).measurement.outcome).toBe("needs_summary");
    expect(plan(carried, assembledTokens * 2).measurement.outcome).toBe("already_fits");
    // Notes bought in this run cover every prior message: covered turns leave instead.
    const { reuse: _reuse, ...own } = carried.contextCompactionPolicy!;
    void _reuse;
    const inRun = plan({ ...carried, contextCompactionPolicy: own }, assembledTokens - covered - 200);
    expect(inRun.measurement.outcome).toBe("already_fits");
    expect(inRun.request.context?.messages[0]!.id).toBe("__context-summary-cs1_carried");
  });
});
