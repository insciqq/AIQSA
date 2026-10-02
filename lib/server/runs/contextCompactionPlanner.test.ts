import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContextSummary } from "../../contracts/contextCompaction";
import { calculateContextBudgetLimits, estimateApproxTokens } from "../../domain/contextBudget";
import { contextTokenEstimator } from "../../domain/tokenEstimate";
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
import { captureMcpObservation, observationWholeDeliveryBatches, wholeDeliveryAllowance } from "../toolObservations/sourceAdapters";
import { memoryToolObservations } from "@/tests/support/toolObservations";
import {
  contextSummaryMessageId,
  conversationContextPolicy,
  contextCompactionCheckpoint,
  messageCoverageRef
} from "./contextCompactionContract";
import {
  contextObservationsFromResults,
  contextRejectionRebuild,
  maskedObservationHandlesInProviderMessages,
  observationCallIdsInProviderMessages,
  observationHandlesInProviderMessages,
  planContextCompaction,
  toolTranscriptReduction,
  toolTranscriptUnits,
  transcriptCoverageRef,
  unitCoverageRef
} from "./contextCompactionPlanner";
import { contextSummarySource } from "./contextCompactionSummarizer";
import { observationWholeResultTokens } from "./runContextBudget";

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

function result(id: string, seed: string, source?: "mcp" | "workspace" | "search" | "skill", chars = 4_000): ToolExecutionResult {
  return projectObservationForProvider({
    callId: id,
    content: [{ text: `rare fact ${id} ${"x".repeat(chars)}`, type: "text" }],
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
    tools: [readToolResultTool, { capability: "mcp", description: "Read a record.", inputSchema: { type: "object" }, name: "read_record" }]
  };
}

/** A tiny budget makes every fixture cross the masking trigger. */
const TRIGGERING_BUDGET = 100;

const call = (id: string, name = "read_record") => ({ call_id: id, name, type: "function_call" });

/** The hybrid request with notes this run committed for every settled unit
 * of its transcript (`ctxu1_` coverage), applied as its own summary. */
function covered(input: ProviderRunRequest, units = toolTranscriptUnits(input.providerToolMessages ?? []).filter((unit) => unit.settled)):
  ProviderRunRequest {
  const summary: ContextSummary = { formatVersion: 1, id: "cs1_covering", notes: "Covering notes.", sourceDigest: "c".repeat(64),
    sourceRefs: units.map(unitCoverageRef) };
  const messages = input.context!.messages;
  return { ...input,
    context: { ...input.context!, messages: [{ content: { blocks: [{ text: "Covering notes.", type: "text" }] },
      id: contextSummaryMessageId(summary), role: "assistant" }, ...messages] },
    contextCompactionPolicy: input.contextCompactionPolicy ??
      conversationContextPolicy({ leafMessageId: "current", messages }),
    contextCompactionSummary: summary };
}

/** A budget the transcript fits above the trigger share: covered material
 * is released down to the target share. */
function roomyBudget(input: ProviderRunRequest): number {
  return Math.ceil(contextTokenEstimator(input)(input.providerToolMessages ?? []) * 1.2);
}

/** Plans `input` under notes covering its settled units. */
function plan(bridge: ProviderToolBridge, input: ProviderRunRequest, settled: readonly ToolExecutionResult[],
  budgetTokens?: number | null) {
  const request = covered(input);
  return planContextCompaction({ bridge, budgetTokens: budgetTokens === undefined ? roomyBudget(request) : budgetTokens,
    observations: contextObservationsFromResults(settled), request });
}

function reference(bridge: ProviderToolBridge, settled: ToolExecutionResult): unknown {
  return bridge.appendToolResult(undefined, { callId: settled.callId, name: settled.name, status: settled.status,
    content: [{ type: "json", value: { observation: settled.observation, reader: "read_tool_result" } }] });
}

describe("context compaction planner", () => {
  it("turns the fewest unseen newest results into references before refusing a minimum, then only the references' floor", () => {
    const bridge = openAIResponsesToolBridge;
    const settled = [1, 2, 3, 4].map((index) => result(`batch-${index}`, `newest-${index}`, "mcp", 2_000 + index * 1_000));
    const calls = settled.map((entry) => call(entry.callId));
    const messages = [...calls, ...settled.map((entry) => bridge.appendToolResult(undefined, entry))];
    const base = request(messages);
    const hybrid: ProviderRunRequest = { ...base,
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: base.context!.messages }) };
    const estimate = contextTokenEstimator(hybrid);
    const observations = contextObservationsFromResults(settled);
    const planned = (budgetTokens: number, input = hybrid) => planContextCompaction({ bridge, budgetTokens, observations, request: input });
    // Missing the budget by a little: only the largest result arrives as its reference.
    const near = planned(estimate(messages) - 100);
    expect(near.measurement).toMatchObject({ outcome: "masking_applied", maskedObservations: 1 });
    expect(near.measurement.afterTokens).toBeLessThanOrEqual(estimate(messages) - 100);
    expect(near.request.providerToolMessages).toEqual([...calls, ...settled.slice(0, 3).map((entry) =>
      bridge.appendToolResult(undefined, entry)), reference(bridge, settled[3]!)]);
    // Refused only when every result as its reference still does not fit.
    const floor = estimate([...calls, ...settled.map((entry) => reference(bridge, entry))]);
    const refused = planned(floor - 1);
    expect(refused.measurement.outcome).toBe("irreducible_overflow");
    expect(refused.overflow?.transcriptTokens).toBe(floor);
    expect(planned(floor).measurement.outcome).not.toBe("irreducible_overflow");
    // Without a callable reader nothing may become a reference.
    expect(planned(estimate(messages) - 100, { ...hybrid, tools: hybrid.tools!.filter((tool) => tool.name !== "read_tool_result") })
      .measurement.outcome).toBe("irreducible_overflow");
  });

  it("masks covered older results oldest first and releases covered units whole only when masking is not enough", () => {
    const settled = [result("call-1", "a"), result("call-2", "b"), result("call-3", "c"), result("call-4", "d", "mcp", 40)];
    const messages = settled.flatMap((entry) => [call(entry.callId), openAIResponsesToolBridge.appendToolResult(undefined, entry)]);
    const estimate = contextTokenEstimator(request(messages));
    const before = estimate(messages);
    // Masking alone reaches the target: the newest batch and later covered
    // results beyond what the target needs stay exact.
    const masked = plan(openAIResponsesToolBridge, request(messages), settled, before);
    expect(masked.measurement).toMatchObject({ outcome: "masking_applied" });
    expect(masked.measurement.afterTokens).toBeLessThanOrEqual(Math.floor(before * 0.5));
    const transcript = masked.request.providerToolMessages ?? [];
    expect(transcript).toHaveLength(messages.length);
    expect(transcript[1]).toEqual(reference(openAIResponsesToolBridge, settled[0]!));
    expect(JSON.stringify(transcript.at(-1))).toContain("rare fact call-4");
    // Every masked result is older than any exact one: release runs oldest first.
    const firstExact = transcript.findIndex((item, index) => index % 2 === 1 && JSON.stringify(item).includes("rare fact"));
    expect(transcript.slice(1, firstExact).filter((_item, index) => index % 2 === 0).every((item) =>
      !JSON.stringify(item).includes("rare fact"))).toBe(true);
    // Planned again under the same budget, nothing changes: a reference never shrinks.
    const again = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: before,
      observations: contextObservationsFromResults(settled), request: masked.request });
    expect(again.request.providerToolMessages).toEqual(transcript);
    expect(again.measurement.maskedObservations).toBe(0);
    // A tight budget also releases covered units whole, oldest first; the
    // newest batch always stays.
    const tight = plan(openAIResponsesToolBridge, request(messages), settled, estimate(messages.slice(-2)) + 20);
    expect(tight.request.providerToolMessages).toEqual(messages.slice(-2));
    expect(tight.measurement).toMatchObject({ maskedObservations: 0, outcome: "already_fits" });
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
    const newest = result("newest-reader", "newest-reader", "mcp", 40);
    const messages = [
      call("reader-1", "read_tool_result"),
      openAIResponsesToolBridge.appendToolResult(undefined, readerResult),
      call("newest-reader", "read_tool_result"),
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ];
    // Covered by committed notes, the old reader fragment is masked by the
    // descriptor the reader minted; uncovered, it stays exact.
    const planned = plan(openAIResponsesToolBridge, request(messages), [newest]);
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).not.toContain("large exact fragment");
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain(saved.handle);
    const uncovered = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: roomyBudget(request(messages)),
      observations: contextObservationsFromResults([newest]),
      request: { ...request(messages), contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current",
        messages: request([]).context!.messages }) } });
    expect(uncovered.measurement).toMatchObject({ maskedObservations: 0, outcome: "needs_summary" });
    expect(uncovered.request.providerToolMessages).toEqual(messages);
  });

  describe("a parallel batch of whole-delivered MCP results", () => {
    const binding = { version: 1 as const, source: "mcp" as const, serverId: "server", originalName: "records",
      revisionId: "revision", fingerprint: "a".repeat(64) };
    const original = (bytes: number, seed: string) => ({ isError: false, structuredContent: null, unsupportedContentTypes: [],
      text: [Array.from({ length: Math.ceil(bytes / 64) }, (_, index) => createHash("sha256").update(`${seed}:${index}`).digest("hex"))
        .join("").slice(0, bytes - 100)] });
    const windowRequest = (contextWindow: number): ProviderRunRequest => {
      const { defaultMaxOutputTokens: _default, ...capabilities } = request([]).modelCapabilities;
      return { ...request([]), modelCapabilities: { ...capabilities, contextWindow } };
    };
    const isWhole = (result: ToolExecutionResult) => result.content.some(part => part.type === "text");

    // Hex encodes at about 1.76 characters per o200k token.
    it.each([
      { contextWindow: 16_384, bytes: 5_632, whole: 1 },
      { contextWindow: 8_192, bytes: 8 * 1024, whole: 0 }
    ])("stays reducible on a $contextWindow-token window with four $bytes-byte results", async ({ contextWindow, bytes, whole }) => {
      const base = windowRequest(contextWindow);
      const share = observationWholeResultTokens(base);
      const { budgetTokens } = calculateContextBudgetLimits({ contextWindow, maxOutputTokens: 0, provider: "openai" });
      expect(share.tokens).toBe(Math.floor(budgetTokens / 4));
      const calls = [1, 2, 3, 4].map(index => ({ id: `parallel-${index}`, name: "mcp_records", arguments: {} }));
      const capture = (allowance: () => ReturnType<typeof wholeDeliveryAllowance>) => {
        const observations = memoryToolObservations();
        return Promise.all(calls.map(call => captureMcpObservation({ service: observations.service(),
          producer: { runId: "parallel-run", userId: "parallel-owner", toolCallId: call.id }, wholeDelivery: allowance() },
          call, binding, async () => original(bytes, call.id))));
      };
      const plan = (results: readonly ToolExecutionResult[]) => {
        // One provider round's parallel calls, then their results.
        const messages = [...results.map(result => ({ type: "function_call", call_id: result.callId, name: result.name })),
          ...results.map(result => openAIResponsesToolBridge.appendToolResult(undefined, projectObservationForProvider(result)))];
        const hybrid: ProviderRunRequest = { ...base, providerToolMessages: messages,
          contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: base.context!.messages }) };
        // The system prompt, tools and current turn keep a fifth of the budget.
        return planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens, request: hybrid,
          assembledTokens: contextTokenEstimator(hybrid)(messages) + Math.floor(budgetTokens / 5),
          observations: contextObservationsFromResults(results) });
      };
      const batch = observationWholeDeliveryBatches();
      const shared = await capture(() => batch.allowance(1, share));
      expect(shared.filter(isWhole)).toHaveLength(whole);
      expect(shared.filter(isWhole).reduce((sum, result) =>
        sum + share.estimateTokens(projectObservationForProvider(result).content), 0)).toBeLessThanOrEqual(share.tokens);
      expect(plan(shared).measurement.outcome).not.toBe("irreducible_overflow");
      // Each result judged alone (and every inline-sized one) was whole, which
      // left the same newest batch over the budget after every tool had
      // executed; the planner now turns the unseen excess into references.
      const alone = await capture(() => wholeDeliveryAllowance(Number.POSITIVE_INFINITY));
      expect(alone.filter(isWhole)).toHaveLength(4);
      expect(plan(alone).measurement).toMatchObject({ outcome: "masking_applied", maskedObservations: expect.any(Number) });
      expect(plan(alone).measurement.maskedObservations).toBeGreaterThan(0);
    });

    it("still delivers a single 100 KiB result whole on a 400,000-token window", async () => {
      const share = observationWholeResultTokens(windowRequest(400_000));
      const call = { id: "single", name: "mcp_records", arguments: {} };
      const result = await captureMcpObservation({ service: memoryToolObservations().service(),
        producer: { runId: "single-run", userId: "single-owner", toolCallId: call.id },
        wholeDelivery: observationWholeDeliveryBatches().allowance(1, share) }, call, binding, async () => original(100 * 1024, "single"));
      expect(isWhole(result)).toBe(true);
    });
  });

  it("masks an MCP result delivered whole once it is no longer newest, and the reader recalls its exact bytes", async () => {
    const observations = memoryToolObservations();
    const actor = { runId: "whole-run", userId: "whole-owner" };
    const toolCall = { id: "whole-1", name: "mcp_records", arguments: {} };
    const body = Array.from({ length: 1_600 }, (_, index) => createHash("sha256").update(`whole:${index}`).digest("hex")).join("");
    const original = { isError: false, structuredContent: null, text: [`${body} rare-whole-tail`], unsupportedContentTypes: [] };
    // 100 KiB of unique text within a quarter of a 128,000-token budget.
    const whole = await captureMcpObservation({ service: observations.service(), producer: { ...actor, toolCallId: toolCall.id },
      wholeDelivery: wholeDeliveryAllowance(32_000) }, toolCall, { version: 1, source: "mcp", serverId: "server", originalName: "records",
      revisionId: "revision", fingerprint: "a".repeat(64) }, async () => original);
    expect(JSON.stringify(whole.content)).toContain("rare-whole-tail");
    const newest = result("whole-2", "whole-newest");
    const messages = [
      { type: "function_call", call_id: toolCall.id, name: toolCall.name },
      openAIResponsesToolBridge.appendToolResult(undefined, projectObservationForProvider(whole)),
      { type: "function_call", call_id: newest.callId, name: newest.name },
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ];
    const budgetTokens = 128_000;
    const settled = contextObservationsFromResults([whole, newest]);
    const coveredRequest = covered(request(messages));
    // Below the trigger the whole result stays inline.
    const below = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens, assembledTokens: 60_000,
      observations: settled, request: coveredRequest });
    expect(below.measurement.maskedObservations).toBe(0);
    expect(JSON.stringify(below.request.providerToolMessages)).toContain("rare-whole-tail");
    // A later round over the 80% trigger replaces the covered body by its descriptor.
    const later = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens, assembledTokens: 106_000,
      observations: settled, request: coveredRequest });
    expect(later.measurement.maskedObservations).toBe(1);
    const transcript = JSON.stringify(later.request.providerToolMessages);
    expect(transcript).not.toContain("rare-whole-tail");
    expect(transcript).not.toContain(body.slice(0, 64));
    expect(transcript).toContain(whole.observation!.handle);
    expect(later.request.providerToolMessages?.[1]).toEqual(reference(openAIResponsesToolBridge, whole));
    expect(transcript).toContain("rare fact whole-2");
    // Without notes covering it, the same round keeps the original and asks for notes.
    const uncovered = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens, assembledTokens: 106_000,
      observations: settled, request: { ...request(messages), contextCompactionPolicy: coveredRequest.contextCompactionPolicy! } });
    expect(uncovered.measurement).toMatchObject({ maskedObservations: 0, outcome: "needs_summary" });
    expect(JSON.stringify(uncovered.request.providerToolMessages)).toContain("rare-whole-tail");
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

  it("masks nothing when the accepted request has no reader capability, releasing covered units instead", () => {
    const settled = [result("no-reader", "e"), result("no-reader-new", "f", "mcp", 40)];
    const messages = [
      call("no-reader"),
      openAIResponsesToolBridge.appendToolResult(undefined, settled[0]!),
      call("no-reader-new"),
      openAIResponsesToolBridge.appendToolResult(undefined, settled[1]!)
    ];
    const input = { ...request(messages), tools: [] };
    const planned = plan(openAIResponsesToolBridge, input, settled, 1_000_000);
    expect(planned.measurement.outcome).toBe("already_fits");
    expect(planned.measurement.maskedObservations).toBe(0);
    expect(planned.request.providerToolMessages).toEqual(messages);
    // Over the trigger the covered unit leaves whole: no reference is promised.
    const released = plan(openAIResponsesToolBridge, input, settled);
    expect(released.measurement).toMatchObject({ maskedObservations: 0, outcome: "already_fits" });
    expect(released.request.providerToolMessages).toEqual(messages.slice(2));
    // Without covering notes the request is never reported as fitting over budget.
    const tight = Math.ceil(contextTokenEstimator(input)(messages.slice(2)) * 1.5);
    const overBudget = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: tight,
      observations: contextObservationsFromResults(settled), request: { ...input,
        contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: input.context!.messages }) } });
    expect(overBudget.measurement).toMatchObject({ maskedObservations: 0, outcome: "needs_summary" });
    expect(overBudget.measurement.afterTokens).toBeGreaterThan(tight);
  });

  it("preserves error status and leaves model-authored descriptor lookalikes opaque", () => {
    const errorResult = projectObservationForProvider({
      callId: "error-1",
      content: [{ text: `failed ${"e".repeat(8_000)}`, type: "text" }],
      name: "read_record",
      observation: descriptor("f"),
      status: "error"
    });
    const errorCall = { id: "error-1", name: "read_record", type: "function_call" };
    const error = geminiInteractionsToolBridge.appendToolResult(undefined, errorResult);
    const lookalike = {
      arguments: JSON.stringify({ observation: descriptor("i"), reader: "read_tool_result" }),
      id: "model-authored",
      name: "read_record",
      type: "function_call"
    };
    const opaqueNestedLookalike = geminiInteractionsToolBridge.appendToolResult(undefined, {
      callId: "model-authored",
      content: [{ type: "json" as const, value: { observation: descriptor("opaque"), value: "external body" } }],
      name: "read_record",
      status: "complete" as const
    });
    const newestResult = projectObservationForProvider({ ...result("newest-1", "a", "mcp", 40), status: "complete" });
    const newestCall = { id: "newest-1", name: "read_record", type: "function_call" };
    const newest = geminiInteractionsToolBridge.appendToolResult(undefined, newestResult);
    const messages = [errorCall, error, lookalike, opaqueNestedLookalike, newestCall, newest];
    // Only the error result's unit is covered; the lookalike's unit has no
    // server observation and stays exact.
    const units = toolTranscriptUnits(messages).filter((unit) => unit.settled && unit.callIds.includes("error-1"));
    const input = covered({ ...request(messages), provider: "gemini" }, units);
    const planned = planContextCompaction({ bridge: geminiInteractionsToolBridge,
      budgetTokens: roomyBudget(input), observations: contextObservationsFromResults([errorResult, newestResult]),
      request: input });
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(planned.request.providerToolMessages?.[1]).toMatchObject({ is_error: true });
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).toContain("tor1_");
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).not.toContain("eeee");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("model-authored");
    expect(JSON.stringify(planned.request.providerToolMessages?.[3])).toContain("external body");
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
    const observed = result("observed-old", "observed-old", "mcp", 20_000);
    const newest = result("newest-3", "newest-3", "mcp", 40);
    const messages = [
      call("artifact-1", "read_artifact"),
      openAIResponsesToolBridge.appendToolResult(undefined, artifact),
      call("artifact-2", "read_artifact"),
      openAIResponsesToolBridge.appendToolResult(undefined, exactStub),
      call("artifact-3", "read_artifact"),
      openAIResponsesToolBridge.appendToolResult(undefined, readerLike),
      call("observed-old"),
      openAIResponsesToolBridge.appendToolResult(undefined, observed),
      call("newest-3"),
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ];
    const settled = [observed, newest];
    // Notes cover only the observed unit; the artifact lookalikes stay exact.
    const units = toolTranscriptUnits(messages).filter((unit) => unit.settled && unit.callIds.includes("observed-old"));
    const input = covered(request(messages), units);
    const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: roomyBudget(input),
      observations: contextObservationsFromResults(settled), request: input });
    expect(planned.measurement.maskedObservations).toBe(1);
    for (const index of [1, 3, 5]) expect(planned.request.providerToolMessages?.[index]).toEqual(messages[index]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[7])).not.toContain("rare fact observed-old");

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

  it("keeps the newest 512 handles, oldest first, when a transcript names more", () => {
    const settled = Array.from({ length: 600 }, (_, index) => result(`call-${index}`, `cap-${index}`));
    const masked = settled.flatMap((entry) => [
      { call_id: entry.callId, name: "read_record", type: "function_call" },
      reference(openAIResponsesToolBridge, entry)
    ]);
    const observations = contextObservationsFromResults(settled);
    const newest = settled.slice(-512).map((entry) => entry.observation!.handle);
    expect(observationHandlesInProviderMessages(masked, observations)).toEqual(newest);
    expect(maskedObservationHandlesInProviderMessages(masked, observations)).toEqual(newest);
    // A handle read again later counts at its newest occurrence.
    const reread = [...masked, { call_id: "reread", name: "read_record", type: "function_call" },
      openAIResponsesToolBridge.appendToolResult(undefined, { ...settled[0]!, callId: "reread" })];
    const rereadObservations = [...observations, { ...observations[0]!, callId: "reread" }];
    expect(observationHandlesInProviderMessages(reread, rereadObservations).at(-1)).toBe(settled[0]!.observation!.handle);
    expect(observationHandlesInProviderMessages(reread, rereadObservations)).toHaveLength(512);
  });

  it("names a result only by its nearest preceding call item", () => {
    const foreign = descriptor("reused-id");
    const readerBody = (fragment: string) => ({ endOffset: 10, fragment, fragmentKind: "serialized_json_text",
      incomplete: false, observation: foreign, offset: 0 });
    const messages = [
      { type: "function_call", call_id: "reused", name: "read_tool_result" },
      openAIResponsesToolBridge.appendToolResult(undefined, { callId: "reused", name: "read_tool_result", status: "complete",
        content: [{ type: "json", value: readerBody(`reader fragment ${"r".repeat(2_000)}`) }] }),
      { type: "function_call", call_id: "reused", name: "read_artifact" },
      openAIResponsesToolBridge.appendToolResult(undefined, { callId: "reused", name: "read_artifact", status: "complete",
        content: [{ type: "json", value: readerBody("external imitation") }] })
    ];
    expect(observationCallIdsInProviderMessages(messages)).toEqual(["reused"]);
    const last = result("last", "last", "mcp", 40);
    const planned = plan(openAIResponsesToolBridge, request([...messages, call("last", "read_tool_result"),
      openAIResponsesToolBridge.appendToolResult(undefined, last)]), [last]);
    expect(planned.request.providerToolMessages?.[3]).toEqual(messages[3]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).not.toContain("reader fragment");
  });

  it("never masks Knowledge evidence, even under a historical maskable descriptor", () => {
    const knowledge = (id: string, seed: string, maskable: boolean): ToolExecutionResult => {
      const base = result(id, seed);
      return { ...base, name: "search_knowledge",
        observation: { ...base.observation!, source: "knowledge", maskable } };
    };
    const current = knowledge("knowledge-1", "k1", false);
    const historical = knowledge("knowledge-2", "k2", true);
    const old = result("old-3", "e", "mcp", 20_000);
    const newest = result("newest-3", "f", "mcp", 40);
    const messages = [
      call("knowledge-1", "search_knowledge"),
      call("knowledge-2", "search_knowledge"),
      call("old-3"),
      openAIResponsesToolBridge.appendToolResult(undefined, current),
      openAIResponsesToolBridge.appendToolResult(undefined, historical),
      openAIResponsesToolBridge.appendToolResult(undefined, old),
      call("newest-3"),
      openAIResponsesToolBridge.appendToolResult(undefined, newest)
    ];
    const settled = [current, historical, old, newest];
    const input = covered(request(messages));
    const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: roomyBudget(input),
      observations: contextObservationsFromResults(settled), request: input });
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(planned.request.providerToolMessages?.[3]).toEqual(messages[3]);
    expect(planned.request.providerToolMessages?.[4]).toEqual(messages[4]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[5])).not.toContain("rare fact old-3");
  });

  it("keeps an unmaskable result in the same settled batch while masking eligible siblings", () => {
    const skill = result("skill-1", "h", "skill");
    const old = result("old-2", "c", "mcp", 20_000);
    const newest = result("newest-2", "j", "mcp", 40);
    const messages = [call("old-2"), call("skill-1", "load_skill"),
      openAIResponsesToolBridge.appendToolResult(undefined, old),
      openAIResponsesToolBridge.appendToolResult(undefined, skill),
      call("newest-2"),
      openAIResponsesToolBridge.appendToolResult(undefined, newest)];
    const input = covered(request(messages));
    const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: roomyBudget(input),
      observations: contextObservationsFromResults([old, skill, newest]), request: input });
    expect(planned.measurement.maskedBatches).toBe(1);
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).not.toContain("rare fact old-2");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("tor1_");
    expect(JSON.stringify(planned.request.providerToolMessages?.[3])).toContain("skill-1");
  });

  it.each([
    ["openai", openAIResponsesToolBridge, (id: string) => ({ call_id: id, name: "read_record", type: "function_call" })],
    ["openrouter", openRouterChatToolBridge, (id: string) => ({ role: "assistant", tool_calls: [{ function: { arguments: "{}", name: "read_record" }, id, type: "function" }] })],
    ["gemini", geminiInteractionsToolBridge, (id: string) => ({ id, name: "read_record", type: "function_call" })],
    ["anthropic", anthropicMessagesToolBridge, (id: string) => ({ content: [{ id, input: {}, name: "read_record", type: "tool_use" }], role: "assistant" })]
  ] as const)("masks through the %s bridge once without changing its result envelope", (provider, bridge, callItem) => {
    const settled = [result("old-bridge", "c"), result("new-bridge", "d", "mcp", 40)];
    const input = { ...request([callItem("old-bridge"), bridge.appendToolResult(undefined, settled[0]!), callItem("new-bridge"),
      bridge.appendToolResult(undefined, settled[1]!)]), provider };
    const planned = plan(bridge, input, settled);
    expect(planned.measurement.maskedObservations).toBe(1);
    expect(planned.request.providerToolMessages?.[1]).toEqual(reference(bridge, settled[0]!));
    expect(JSON.stringify(planned.request.providerToolMessages?.[3])).toContain("rare fact new-bridge");
    const budgetTokens = contextTokenEstimator(input)(input.providerToolMessages ?? []);
    const again = planContextCompaction({ bridge, budgetTokens, observations: contextObservationsFromResults(settled),
      request: planned.request });
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
      leafMessageId: "current", messages: input.context!.messages }) }]) {
      const planned = plan(openAIResponsesToolBridge, candidate, settled, budgetTokens);
      expect(planned.measurement).toMatchObject({ maskedObservations: 0, outcome: "already_fits" });
      expect(planned.request.providerToolMessages).toEqual(messages);
    }
  });

  it("adds no new reference when the reader cannot be called this round or the window is unknown", () => {
    const settled = [result("stub-1", "n"), result("older-1", "o", "mcp", 20_000), result("newest-5", "p", "mcp", 40)];
    const messages = [
      call("stub-1"),
      reference(openAIResponsesToolBridge, settled[0]!),
      call("older-1"),
      openAIResponsesToolBridge.appendToolResult(undefined, settled[1]!),
      call("newest-5"),
      openAIResponsesToolBridge.appendToolResult(undefined, settled[2]!)
    ];
    const roomy = (input: ProviderRunRequest) => Math.ceil(contextTokenEstimator(input)(messages) * 1.2);
    // The final round promises no recall: covered units may leave whole, but no new reference appears.
    const finalRound = plan(openAIResponsesToolBridge, { ...request(messages), toolChoice: "none" }, settled,
      roomy(request(messages)));
    expect(finalRound.measurement.maskedObservations).toBe(0);
    expect(finalRound.request.providerToolMessages).not.toContainEqual(reference(openAIResponsesToolBridge, settled[1]!));
    for (const budgetTokens of [null, undefined]) {
      const unknown = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens,
        observations: contextObservationsFromResults(settled), request: covered(request(messages)) });
      expect(unknown.measurement).toMatchObject({ budgetTokens: null, maskedObservations: 0, outcome: "already_fits" });
      expect(unknown.request.providerToolMessages).toEqual(messages);
    }
    const auto = plan(openAIResponsesToolBridge, { ...request(messages), toolChoice: "auto" }, settled, roomy(request(messages)));
    expect(auto.measurement.maskedObservations).toBe(1);
  });

  it("asks for notes before anything uncovered leaves, and never masks it", () => {
    const settled = [result("old-a", "q", "mcp", 20_000), result("old-b", "r"), result("newest-b", "s", "mcp", 40)];
    const messages = settled.flatMap((entry) => [call(entry.callId), openAIResponsesToolBridge.appendToolResult(undefined, entry)]);
    const input: ProviderRunRequest = { ...request(messages),
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: request([]).context!.messages }) };
    const before = contextTokenEstimator(input)(messages);
    for (const budgetTokens of [Math.ceil(before / 2), before]) {
      const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens,
        observations: contextObservationsFromResults(settled), request: input });
      expect(planned.measurement).toMatchObject({ legacyFallback: false, maskedObservations: 0, outcome: "needs_summary" });
      expect(planned.request.providerToolMessages).toEqual(messages);
    }
    // Notes covering only the oldest unit release only that unit.
    const oldest = toolTranscriptUnits(messages).filter((unit) => unit.callIds.includes("old-a"));
    const partial = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: roomyBudget(input),
      observations: contextObservationsFromResults(settled), request: covered(input, oldest) });
    expect(partial.request.providerToolMessages?.[1]).toEqual(reference(openAIResponsesToolBridge, settled[0]!));
    expect(partial.request.providerToolMessages?.[3]).toEqual(messages[3]);
  });

  it("keeps an excluded unit between covered units exact and uncovered", () => {
    const observed = [result("first", "t"), result("third", "u"), result("newest-x", "v", "mcp", 40)];
    // A Workspace-like call without a server observation (Observation Off, degraded or unretained).
    const external: ToolExecutionResult = { callId: "second", content: [{ text: `external ${"w".repeat(900)}`, type: "text" }],
      name: "read_record", status: "complete" };
    const messages = [
      call("first"), openAIResponsesToolBridge.appendToolResult(undefined, observed[0]!),
      call("second"), openAIResponsesToolBridge.appendToolResult(undefined, external),
      call("third"), openAIResponsesToolBridge.appendToolResult(undefined, observed[1]!),
      call("newest-x"), openAIResponsesToolBridge.appendToolResult(undefined, observed[2]!)
    ];
    const settled = contextObservationsFromResults(observed);
    const input = { ...request(messages),
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: request([]).context!.messages }) };
    const reduction = toolTranscriptReduction(input, settled);
    const [first, second, third, newest] = reduction.units;
    expect([first, third, newest].every((unit) => reduction.noteable.has(unit!))).toBe(true);
    expect(reduction.noteable.has(second!)).toBe(false);
    // Notes cover the noteable units on both sides; the excluded one is never covered.
    const notes = covered(input, [first!, third!, newest!]);
    const estimate = contextTokenEstimator(input);
    const minimum = estimate(messages.slice(2, 4).concat(messages.slice(6)));
    const planned = planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: minimum + 100,
      observations: settled, request: notes });
    expect(planned.request.providerToolMessages).toEqual(messages.slice(2, 4).concat(messages.slice(6)));
    expect(planned.measurement.outcome).toBe("already_fits");
    // Below that minimum nothing is cut: the excluded unit makes the request irreducible.
    expect(planContextCompaction({ bridge: openAIResponsesToolBridge, budgetTokens: minimum - 100,
      observations: settled, request: notes }).measurement.outcome).toBe("irreducible_overflow");
    // A mixed unit (one observed and one excluded result) is excluded whole.
    const mixed = [call("first"), call("second"), openAIResponsesToolBridge.appendToolResult(undefined, observed[0]!),
      openAIResponsesToolBridge.appendToolResult(undefined, external), call("newest-x"),
      openAIResponsesToolBridge.appendToolResult(undefined, observed[2]!)];
    const mixedReduction = toolTranscriptReduction({ ...input, providerToolMessages: mixed }, settled);
    expect(mixedReduction.noteable.has(mixedReduction.units[0]!)).toBe(false);
  });

  it("classifies units by the accepted capability of each call, never by the result body", () => {
    const tool = (name: string, capability: NonNullable<ProviderRunRequest["tools"]>[number]["capability"]) =>
      ({ capability, description: name, inputSchema: { type: "object" }, name });
    const tools = [readToolResultTool, tool("memory_search", "memory"), tool("search_knowledge", "knowledge"),
      tool("load_skill", "skill"), tool("create_artifact", "artifact"), tool("generate_image", "image"),
      tool("get_session_status", "session"), tool("find_tools", "mcp"), tool("mcp_records", "mcp"),
      tool("workspace_run", "workspace"), tool("web_search", "web_search")];
    const plain = (callId: string, name: string): ToolExecutionResult =>
      ({ callId, content: [{ text: `${name} body`, type: "text" }], name, status: "complete" });
    const names = ["memory_search", "search_knowledge", "load_skill", "create_artifact", "generate_image",
      "get_session_status", "find_tools", "read_tool_result", "mcp_records", "workspace_run", "web_search", "unknown_tool"];
    const messages = names.flatMap((name) => [call(`${name}-call`, name),
      openAIResponsesToolBridge.appendToolResult(undefined, plain(`${name}-call`, name))]);
    const observedMcp = result("observed-mcp", "observed", "mcp");
    const input = { ...request([...messages, call("observed-mcp", "mcp_records"),
      openAIResponsesToolBridge.appendToolResult(undefined, observedMcp)]), tools };
    const reduction = toolTranscriptReduction(input, contextObservationsFromResults([observedMcp]));
    const noteable = reduction.units.map((unit) => reduction.noteable.has(unit));
    expect(noteable).toEqual([true, true, true, true, true, true, true, true, false, false, false, false, true]);
  });

  it("reads notes bought before unit refs as covering the transcript prefix through their newest call", () => {
    const settled = [result("legacy-1", "x1"), result("legacy-2", "x2"), result("legacy-3", "x3", "mcp", 40)];
    const messages = settled.flatMap((entry) => [call(entry.callId), openAIResponsesToolBridge.appendToolResult(undefined, entry)]);
    const summary: ContextSummary = { formatVersion: 1, id: "cs1_legacy", notes: "Legacy notes.", sourceDigest: "d".repeat(64),
      sourceRefs: [transcriptCoverageRef("legacy-2")] };
    const input: ProviderRunRequest = { ...request(messages),
      context: { messages: [{ content: { blocks: [{ text: "Legacy notes.", type: "text" }] }, id: contextSummaryMessageId(summary),
        role: "assistant" }, ...request([]).context!.messages], mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages: request([]).context!.messages }),
      contextCompactionSummary: summary };
    const reduction = toolTranscriptReduction(input);
    expect(reduction.units.map((unit) => reduction.covered.has(unit))).toEqual([true, true, false]);
    // The same notes with a history boundary still read units by their own refs only.
    const withBoundary = { ...input, contextCompactionSummary: { ...summary, sourceRefs: [messageCoverageRef("current"),
      unitCoverageRef(reduction.units[1]!)] } };
    const next = toolTranscriptReduction(withBoundary);
    expect(next.units.map((unit) => next.covered.has(unit))).toEqual([false, true, false]);
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
    const policy = conversationContextPolicy({ leafMessageId: "a4", messages });
    const carried: ProviderRunRequest = { ...base, context: { messages, mode: "branch_path" }, contextCompactionSummary: notes,
      contextCompactionPolicy: { ...policy, reuse: { coveredMessageId: "u2", runId: "run-2", summary: notes } } };
    const estimate = contextTokenEstimator(base);
    const prior = messages.slice(0, -1).reduce((total, message) => total + estimate(message.content), 0);
    const assembledTokens = prior + 100;
    const covered = estimate(messages[1]!.content);
    const plan = (input: ProviderRunRequest, budgetTokens: number) =>
      planContextCompaction({ assembledTokens, budgetTokens, bridge: openAIResponsesToolBridge, request: input });

    // Uncovered history must still leave: new notes before anything leaves.
    expect(plan(carried, assembledTokens - covered + 200).measurement.outcome).toBe("needs_summary");
    expect(plan(carried, assembledTokens - covered - 200).measurement.outcome).toBe("needs_summary");
    // Fits above the trigger with uncovered history older than the exact tail: headroom notes.
    expect(plan(carried, Math.ceil(assembledTokens / 0.8) - 1).measurement.outcome).toBe("needs_summary");
    expect(plan(carried, assembledTokens * 2).measurement.outcome).toBe("already_fits");
    // Notes bought in this run through a4 cover every prior message: over the
    // budget only covered turns leave, oldest first, and the note stays.
    const { reuse: _reuse, ...own } = carried.contextCompactionPolicy!;
    void _reuse;
    const bought = { ...notes, sourceRefs: [messageCoverageRef("a4")] };
    const inRun = plan({ ...carried, contextCompactionPolicy: own, contextCompactionSummary: bought },
      assembledTokens - covered + 200);
    expect(inRun.measurement).toMatchObject({ legacyFallback: false, outcome: "already_fits" });
    expect(inRun.historyTrim).toMatchObject({ droppedMessages: 2 });
    expect(inRun.request.context?.messages.map((message) => message.id)).toEqual([
      "__context-summary-cs1_carried", "u3", "a3", "u4", "a4", "current"
    ]);
    // Own notes bounded at u3 leave a3..a4 uncovered: notes are bought, nothing leaves.
    const partial = plan({ ...carried, contextCompactionPolicy: own,
      contextCompactionSummary: { ...notes, sourceRefs: [messageCoverageRef("u3")] } }, assembledTokens - covered - 200);
    expect(partial.measurement.outcome).toBe("needs_summary");
    expect(partial.request.context?.messages).toEqual(messages);
  });
});

describe("context rejection rebuild", () => {
  it("scales the rejected estimate so the reported prompt fits the reported budget", () => {
    // The provider counted 1.5x the estimate: the budget keeps 180k real tokens.
    expect(contextRejectionRebuild({ budgetTokens: 160_000, promptTokens: 210_000, reportedBudgetTokens: 180_000,
      requestTokens: 140_000, round: 3 })).toEqual({ version: 1, round: 3, budgetTokens: 120_000 });
  });

  it("falls back to the recorded ratio without usable counts and never loosens or keeps the rejected size", () => {
    expect(contextRejectionRebuild({ budgetTokens: 160_000, requestTokens: 100_000, round: 1 }))
      .toEqual({ version: 1, round: 1, budgetTokens: 75_000 });
    // Counts that would not shrink the request (a prompt within the maximum) use the ratio instead.
    expect(contextRejectionRebuild({ budgetTokens: 160_000, promptTokens: 90_000, reportedBudgetTokens: 150_000,
      requestTokens: 100_000, round: 2 })).toEqual({ version: 1, round: 2, budgetTokens: 75_000 });
    // A request over its admitted budget still ends at or below that budget.
    expect(contextRejectionRebuild({ budgetTokens: 50_000, requestTokens: 100_000, round: 1 })?.budgetTokens).toBe(50_000);
    // An output reservation larger than the reported maximum leaves nothing to plan.
    expect(contextRejectionRebuild({ budgetTokens: 160_000, promptTokens: 200_000, reportedBudgetTokens: 0,
      requestTokens: 100_000, round: 1 })?.budgetTokens).toBe(0);
  });

  it("refuses malformed inputs", () => {
    for (const input of [
      { budgetTokens: 1_000, requestTokens: 0, round: 1 },
      { budgetTokens: 1_000, requestTokens: 500, round: 0 },
      { budgetTokens: -1, requestTokens: 500, round: 1 },
      { budgetTokens: 1_000, requestTokens: Number.NaN, round: 1 }
    ]) expect(contextRejectionRebuild(input)).toBeNull();
  });
});
