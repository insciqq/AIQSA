import { workspaceImageTokenReserve } from "../workspace/directImageEvidence";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateContextBudgetLimits, estimateApproxTokens } from "../../domain/contextBudget";
import { contextTokenEstimator } from "../../domain/tokenEstimate";
import { TOKEN_ESTIMATE_FIXTURES } from "../../domain/tokenEstimate.testFixtures";
import { providerAttachmentBudgetTokens } from "../providers/attachmentPayload";
import {
  MEMORY_ACTION_NO_COMMIT_RESULT,
  memoryActionAnswerContract
} from "../providers/memoryActionAnswer";
import {
  MEMORY_READER_CONTRACT_CURRENT,
  MEMORY_READER_FINALIZATION_CONTRACT_V1,
  PERSONAL_CONTEXT_HEADING
} from "../providers/personalContext";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import type { ToolExecutionResult } from "../tools/types";
import { projectObservationForProvider } from "../toolObservations/projection";
import type { ContextSummary } from "../../contracts/contextCompaction";
import { contextSummaryMessageId, conversationContextPolicy, messageCoverageRef } from "./contextCompactionContract";
import { contextObservationsFromResults, toolTranscriptUnits, unitCoverageRef } from "./contextCompactionPlanner";
import {
  applyContextSummaryToRequest,
  summaryNeedsProvider
} from "./contextCompactionSummarizer";
import {
  applyProviderRequestContextBudget,
  measureSessionContext,
  normalizedRequestPersonalContextTokenLimit,
  observationBatchShare,
  observationWholeResultTokens,
  providerFacingSerializedTools,
  providerRequestContextRebuild,
  UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS
} from "./runContextBudget";
import { executeSessionStatus, sessionStatusTool } from "../tools/sessionStatus";
import { decodeSessionContextStatus, sessionContextCapacity } from "../../contracts/sessionStatus";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "question", type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: "question", type: "text" }] },
        id: "current",
        role: "user"
      }],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      contextWindow: 100,
      defaultMaxOutputTokens: 0,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    modelId: "gpt-test",
    params: {},
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    ...overrides
  };
}

describe("provider request context budget", () => {
  it("gives one whole observed result a quarter of the admitted input budget, and no share for an unknown window", () => {
    const capabilities = { ...request().modelCapabilities, contextWindow: 160_000, defaultMaxOutputTokens: 8_000 };
    const { budgetTokens } = calculateContextBudgetLimits({ contextWindow: 160_000, maxOutputTokens: 8_000, provider: "openai" });
    expect(observationWholeResultTokens(request({ modelCapabilities: capabilities })).tokens).toBe(Math.floor(budgetTokens / 4));
    const { contextWindow: _window, ...unknownWindow } = capabilities;
    expect(observationWholeResultTokens(request({ modelCapabilities: unknownWindow })).tokens).toBe(Number.POSITIVE_INFINITY);
  });

  it("sizes a tool batch's delivery beside the fixed part, the batch's floor and the notes still to come", () => {
    const messages = [{ content: { blocks: [{ text: "question", type: "text" as const }] }, id: "current", role: "user" as const }];
    const base = request({ context: { messages, mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages }),
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 32_768, defaultMaxOutputTokens: 4_096, toolCalling: true },
      params: {}, toolObservationVersion: 1 });
    const { budgetTokens } = calculateContextBudgetLimits({ contextWindow: 32_768, maxOutputTokens: 4_096, provider: "openai" });
    const calls = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `call-${index}`, name: "mcp_records_details" }));
    const batch = (count: number, system = "") => {
      const sent = { ...base, prompt: { developer: null, system }, providerToolMessages: openAIResponsesToolBridge.serializeAssistantToolCalls({
        calls: calls(count).map((call) => ({ ...call, arguments: { id: call.id } })) }) };
      return observationBatchShare({ bridge: openAIResponsesToolBridge, calls: calls(count), request: sent }).tokens;
    };
    // A small request keeps the quarter share.
    expect(batch(5)).toBe(Math.floor(budgetTokens / 4));
    // A large fixed part leaves less, and more parallel calls (each at its floor) leave less still.
    /** A system prompt that brings the measured request to about `tokens`. */
    const promptOf = (tokens: number) => {
      const text = (words: number) => Array.from({ length: words }, (_, index) => `w${index}`).join(" ");
      for (let words = 100; ; words += 100) {
        const measured = applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge,
          request: { ...base, prompt: { developer: null, system: text(words) } } });
        if (!measured.ok || measured.request.contextCompaction!.beforeTokens >= tokens) return text(words);
      }
    };
    const fixed = promptOf(19_000);
    expect(batch(5, fixed)).toBeLessThan(Math.floor(budgetTokens / 4));
    expect(batch(40, fixed)).toBeLessThan(batch(5, fixed));
    // When the floor alone cannot fit, nothing is delivered beyond references.
    expect(batch(40, promptOf(budgetTokens - 2_000))).toBe(0);
  });

  it("reserves visual tokens for durable references before admitting the next provider request", () => {
    const descriptor = { version: 1, id: "a".repeat(64), byteSize: 2000, checksum: "b".repeat(64), mimeType: "image/png",
      width: 1024, height: 1024, frames: 1, transform: null,
      source: { captureId: "c".repeat(32), relativePath: "project/preview.png", byteSize: 2000, checksum: "b".repeat(64), width: 1024, height: 1024 } };
    const messages = [{ type: "function_call_output", call_id: "view-1", output: [{ type: "workspace_image", value: { consumerKey: "call-1", descriptor } }] }];
    expect(workspaceImageTokenReserve(messages)).toBe(5120);
    const base = request({ modelCapabilities: { ...request().modelCapabilities, contextWindow: 5000 } });
    expect(applyProviderRequestContextBudget({ request: base }).ok).toBe(true);
    expect(applyProviderRequestContextBudget({ request: { ...base, providerToolMessages: messages } }).ok).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("base64");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("admits a large two-page native PDF while preserving reserves and genuine overflow rejection", () => {
    const pdf = { byteSize: 19_088_864, extractedText: null, fileName: "two-pages.pdf", id: "pdf-1",
      kind: "pdf" as const, metadata: { pdfPageCount: 2 }, mimeType: "application/pdf", status: "ready" as const };
    const input = request({ attachments: [pdf], attachmentIds: [pdf.id], modelCapabilities: {
      ...request().modelCapabilities, nativePdfInput: true, contextWindow: 1_050_000, defaultMaxOutputTokens: 65_536
    } });
    expect(calculateContextBudgetLimits({ contextWindow: 1_050_000, maxOutputTokens: 65_536 }).budgetTokens).toBe(879_464);
    expect(applyProviderRequestContextBudget({ request: input })).toMatchObject({ ok: true });
    for (const metadata of [{}, { pdfPageCount: 0 }, { pdfPageCount: 501 }]) {
      expect(applyProviderRequestContextBudget({ request: { ...input, attachments: [{ ...pdf, metadata }] } }))
        .toMatchObject({ ok: false, error: { code: "context_too_large" } });
    }
    expect(applyProviderRequestContextBudget({ request: { ...input,
      modelCapabilities: { ...input.modelCapabilities, contextWindow: 1024, defaultMaxOutputTokens: 0 }
    } })).toMatchObject({ ok: false, error: { code: "context_too_large" } });
  });

  it("shares actual serialized tool/transcript measurements with the read-only session tool", () => {
    const base = request({ modelCapabilities: { ...request().modelCapabilities, contextWindow: 10000 } });
    const input = { ...base, tools: [sessionStatusTool], providerToolMessages: [{ role: "tool", content: "tool result" }] };
    const before = structuredClone(input);
    const status = measureSessionContext({ request: input, bridge: openAIResponsesToolBridge });
    const plain = measureSessionContext({ request: base, bridge: openAIResponsesToolBridge });
    expect(status.loadedTools).toBe(1);
    expect(status.approximateInputTokens).toBeGreaterThan(plain.approximateInputTokens);
    expect(decodeSessionContextStatus(status)).toEqual(status);
    expect(decodeSessionContextStatus({ ...status, secret: "untrusted" })).toBeNull();
    const result = executeSessionStatus({ arguments: {}, id: "status-call", name: sessionStatusTool.name }, input, openAIResponsesToolBridge);
    expect(result).toMatchObject({ status: "complete", content: [{ type: "json", value: {
      contextTokens: status.approximateInputTokens, contextPercent: sessionContextCapacity(status).percent, loadedTools: 1
    } }] });
    expect(input).toEqual(before);
    expect(result).not.toHaveProperty("rawPreview");
    // Unexpected keys cannot redirect the read; they are ignored and only counted.
    const extra = executeSessionStatus({ arguments: { chatId: "other-owner", request: "status" }, id: "extra", name: sessionStatusTool.name },
      input, openAIResponsesToolBridge);
    expect(extra).toEqual({ ...result, callId: "extra", rawPreview: { ignoredArgumentKeys: 2 } });
    expect(JSON.stringify(extra)).not.toContain("other-owner");
    const finished = measureSessionContext({ answerText: "finished answer", request: input, bridge: openAIResponsesToolBridge });
    expect(finished.approximateInputTokens - status.approximateInputTokens).toBe(contextTokenEstimator(input)("finished answer"));
    expect(sessionContextCapacity({ ...status, contextWindow: null }).percent).toBeNull();
  });

  it("derives the future Memory ceiling from the admitted model envelope", () => {
    const input = request({
      context: {
        messages: [{
          content: { blocks: [{ text: "current question", type: "text" }] },
          id: "current",
          role: "user"
        }, {
          content: { blocks: [{ text: "private skill context", type: "text" }] },
          id: "skill-context:current",
          purpose: "skill_context",
          role: "user"
        }],
        mode: "branch_path"
      },
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 10_000 },
      prompt: { developer: "trusted developer", system: "trusted system" }
    });
    const limits = calculateContextBudgetLimits({ contextWindow: 10_000 });
    const estimate = contextTokenEstimator(input);
    const expected = Math.max(0,
      limits.budgetTokens -
      estimate("trusted system") -
      estimate("trusted developer") -
      estimate(MEMORY_READER_CONTRACT_CURRENT) -
      estimate(MEMORY_READER_FINALIZATION_CONTRACT_V1) -
      estimate({ blocks: [{ text: "private skill context", type: "text" }] }) -
      estimate({ blocks: [{ text: "current question", type: "text" }] })
    );

    expect(normalizedRequestPersonalContextTokenLimit(input)).toBe(expected);
    expect(normalizedRequestPersonalContextTokenLimit(request({
      modelCapabilities: { ...request().modelCapabilities, contextWindow: undefined }
    }))).toBeNull();
  });

  it("counts the trusted Memory reader contract in the final provider fence", () => {
    const withoutMemory = request();
    const withMemory = request({
      personalContext: {
        approxTokens: 1,
        itemCount: 1,
        memoryGeneration: 1,
        memoryRevision: 1,
        mode: "prefetched",
        text: `${PERSONAL_CONTEXT_HEADING}\n{}`
      }
    });

    expect(applyProviderRequestContextBudget({ request: withoutMemory }))
      .toMatchObject({ ok: true });
    expect(applyProviderRequestContextBudget({ request: withMemory }))
      .toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("keeps a near-budget ordinary answer dispatchable when Memory result truth replaces the reserve", () => {
    const committed = {
      operation: "SAVE",
      status: "COMMITTED",
      version: 4
    } as const;
    const text = "ordinary-answer-canary";
    const estimate = contextTokenEstimator(request());
    const requiredTokens = estimate(memoryActionAnswerContract(
      MEMORY_ACTION_NO_COMMIT_RESULT
    )) + estimate(text) + 2 * estimate([]);
    let contextWindow = 1;
    while (calculateContextBudgetLimits({ contextWindow }).budgetTokens < requiredTokens) {
      contextWindow += 1;
    }
    const base = request({
      content: { blocks: [{ text, type: "text" }] },
      context: {
        messages: [{
          content: { blocks: [{ text, type: "text" }] },
          id: "current",
          role: "user"
        }],
        mode: "branch_path"
      },
      modelCapabilities: {
        contextWindow,
        defaultMaxOutputTokens: 0,
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      prompt: {
        developer: null,
        memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
        system: null
      }
    });

    expect(calculateContextBudgetLimits({ contextWindow }).budgetTokens - requiredTokens)
      .toBeLessThanOrEqual(1);
    expect(estimate(memoryActionAnswerContract(committed))).toBe(
      estimate(memoryActionAnswerContract(MEMORY_ACTION_NO_COMMIT_RESULT))
    );
    expect(applyProviderRequestContextBudget({ request: base })).toMatchObject({ ok: true });
    expect(applyProviderRequestContextBudget({
      request: {
        ...base,
        prompt: { ...base.prompt, memoryActionAnswerResult: committed }
      }
    })).toMatchObject({ ok: true });
  });

  it("counts the exact serialized provider tool schema", () => {
    const tool = {
      capability: "mcp" as const,
      description: "d".repeat(500),
      inputSchema: { properties: { value: { type: "string" } }, type: "object" },
      name: "mcp_memory_store"
    };
    const input = request({ tools: [tool] });

    expect(providerFacingSerializedTools(input, openAIResponsesToolBridge)).toEqual([
      openAIResponsesToolBridge.serializeTool(tool).tool
    ]);
    expect(applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: input
    })).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("counts provider-hosted tools through the provider bridge", () => {
    const input = request({
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "answer_provider_hosted",
          config: {},
          credentialMode: "answer_provider",
          executionModes: ["model_choice"],
          modelId: null,
          optionId: "openai-native-web-search",
          protocol: "openai_responses_web_search",
          provider: "openai",
          providerModelId: null,
          revisionId: "revision-hosted",
          searchStrategyRowId: "route-hosted"
        }]
      }
    });

    expect(providerFacingSerializedTools(input, openAIResponsesToolBridge)).toEqual([
      { type: "web_search" }
    ]);
  });

  it("counts prompt, current content, and tools when the first turn has no context rows", () => {
    const budgeted = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: request({
        context: { messages: [], mode: "branch_path" },
        tools: [{
          capability: "mcp",
          description: "d".repeat(500),
          inputSchema: { type: "object" },
          name: "mcp_first_turn"
        }]
      })
    });

    expect(budgeted).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("counts the retained provider tool transcript on continuation rounds", () => {
    const budgeted = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: request({
        providerToolMessages: [{
          call_id: "call-1",
          output: "r".repeat(500),
          type: "function_call_output"
        }]
      })
    });

    expect(budgeted).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("plans v1 observation masking before the exact assembled-request guard", () => {
    const descriptor = (seed: string) => ({
      byteSize: 20_000,
      checksum: seed.repeat(64),
      encoding: "json-utf8-v1" as const,
      handle: `tor1_${seed.repeat(32)}`,
      maskable: true,
      source: "mcp" as const,
      sourceTruncated: false,
      version: 1 as const
    });
    const projected = (id: string, seed: string) => projectObservationForProvider({
      callId: id,
      // o200k encodes the "x" fill at eight characters per token.
      content: [{ text: `rare-${id}-${"x".repeat(13_200)}`, type: "text" as const }],
      name: "read_record",
      observation: descriptor(seed),
      status: "complete" as const
    });
    const transcript = [
      { call_id: "old", name: "read_record", type: "function_call" },
      openAIResponsesToolBridge.appendToolResult(undefined, projected("old", "a")),
      { call_id: "new", name: "read_record", type: "function_call" },
      openAIResponsesToolBridge.appendToolResult(undefined, projected("new", "b"))
    ];
    const covering: ContextSummary = { formatVersion: 1, id: `cs1_${"e".repeat(32)}`, notes: "notes", sourceDigest: "e".repeat(64),
      sourceRefs: [unitCoverageRef(toolTranscriptUnits(transcript)[0]!)] };
    const planned = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      observations: contextObservationsFromResults([projected("old", "a"), projected("new", "b")]),
      request: request({
        context: {
          messages: [
            { content: { blocks: [{ text: "notes", type: "text" }] }, id: contextSummaryMessageId(covering), role: "assistant" },
            { content: { blocks: [{ text: "pinned", type: "text" }] }, id: "pinned", purpose: "knowledge_evidence", role: "user" },
            { content: { blocks: [{ text: "current", type: "text" }] }, id: "current", role: "user" }
          ],
          mode: "branch_path"
        },
        contextCompactionPolicy: {
          mode: "hybrid",
          source: { digest: "a".repeat(64), leafMessageId: "leaf", messageCount: 2 },
          version: 1
        },
        // Notes this run committed cover the older unit: only then may it be masked.
        contextCompactionSummary: covering,
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 5_000, toolCalling: true },
        providerToolMessages: transcript,
        toolObservationVersion: 1,
        tools: [readToolResultTool]
      })
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unexpected context rejection");
    expect(planned.request.context?.messages.map(message => message.id)).toEqual([contextSummaryMessageId(covering), "pinned", "current"]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[1])).not.toContain("rare-old");
    expect(JSON.stringify(planned.request.providerToolMessages?.[3])).toContain("rare-new");
    expect(planned.request.contextCompaction).toMatchObject({
      maskedBatches: 1,
      maskedObservations: 1,
      outcome: "masking_applied"
    });
  });

  it("keeps history whole beside the full Skill context directly before current user text", () => {
    const skillText = "s".repeat(120);
    const messages: ProviderConversationMessage[] = [
      { content: { blocks: [{ text: "h".repeat(240), type: "text" }] }, id: "history-user", role: "user" },
      { content: { blocks: [{ text: skillText, type: "text" }] }, id: "skill-context:current", purpose: "skill_context", role: "user" },
      { content: { blocks: [{ text: "q".repeat(40), type: "text" }] }, id: "current", role: "user" }
    ];
    const input = request({
      content: { blocks: [{ text: "q".repeat(40), type: "text" }] },
      context: { messages, mode: "branch_path" }
    });
    // Without the conversation policy nothing may leave: the request is refused
    // (the pinned Skill is what it cannot hold beside the exact history).
    expect(applyProviderRequestContextBudget({ request: input })).toMatchObject({ ok: false, error: { code: "skills_budget_exceeded" } });
    // Under it, the uncovered history waits for notes; the pin stays whole before the current text.
    const budgeted = applyProviderRequestContextBudget({ request: { ...input,
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages }) } });
    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.context?.messages.map(({ id }) => id)).toEqual(["history-user", "skill-context:current", "current"]);
    expect(budgeted.request.context?.messages[1]?.content).toEqual({ blocks: [{ text: skillText, type: "text" }] });
    expect(budgeted.request.contextCompaction).toMatchObject({ outcome: "needs_summary" });
    expect(budgeted.contextTruncation).toBeNull();
  });

  it("rejects an irreducibly oversized Skill context without truncating it", () => {
    const skillText = "s".repeat(400);
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        context: {
          messages: [
            {
              content: { blocks: [{ text: skillText, type: "text" }] },
              id: "skill-context:current",
              purpose: "skill_context",
              role: "user"
            },
            {
              content: { blocks: [{ text: "question", type: "text" }] },
              id: "current",
              role: "user"
            }
          ],
          mode: "branch_path"
        }
      })
    });

    expect(budgeted).toMatchObject({
      error: {
        code: "skills_budget_exceeded",
        message: expect.stringContaining("Unpin Skills"),
        skillBudget: { pinnedTokens: expect.any(Number), catalogTokens: 0, budgetTokens: expect.any(Number) }
      },
      ok: false
    });
    expect(skillText).toHaveLength(400);
  });

  it("keeps hidden Knowledge evidence directly before the current user message", () => {
    const evidenceText = "k".repeat(120);
    const messages: ProviderConversationMessage[] = [
      { content: { blocks: [{ text: "h".repeat(240), type: "text" }] }, id: "history-user", role: "user" },
      { content: { blocks: [{ text: evidenceText, type: "text" }] }, id: "knowledge-evidence:v1", purpose: "knowledge_evidence", role: "user" },
      { content: { blocks: [{ text: "q".repeat(40), type: "text" }] }, id: "current", role: "user" }
    ];
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        content: { blocks: [{ text: "q".repeat(40), type: "text" }] },
        context: { messages, mode: "branch_path" },
        contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages })
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.context?.messages.map(({ id }) => id)).toEqual(["history-user", "knowledge-evidence:v1", "current"]);
    expect(budgeted.request.context?.messages[1]?.content).toEqual({ blocks: [{ text: evidenceText, type: "text" }] });
    expect(budgeted.request.contextCompaction).toMatchObject({ outcome: "needs_summary" });
  });

  it("truncates attachment text before considering the Skill context reducible", () => {
    const skillText = "s".repeat(240);
    const attachment = {
      byteSize: 10_000,
      extractedText: "a".repeat(2_000),
      fileName: "notes.txt",
      id: "attachment-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      status: "ready"
    };
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        context: {
          messages: [
            {
              content: { blocks: [{ text: skillText, type: "text" }] },
              id: "skill-context:current",
              purpose: "skill_context",
              role: "user"
            },
            {
              content: { blocks: [{ text: "question", type: "text" }] },
              id: "current",
              role: "user"
            }
          ],
          mode: "branch_path"
        },
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 200 }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.attachments[0]?.extractedText).toContain(
      "[truncated for model context]"
    );
    expect(budgeted.request.context?.messages[0]?.content).toEqual({
      blocks: [{ text: skillText, type: "text" }]
    });
  });

  it("derives attachment text length from the selected model context window", () => {
    const attachment = {
      byteSize: 100_000,
      extractedText: "a".repeat(30_000),
      fileName: "long.txt",
      id: "attachment-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      status: "ready"
    };
    const small = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        modelCapabilities: {
          ...request().modelCapabilities,
          contextWindow: 1_000
        }
      })
    });
    const large = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        modelCapabilities: {
          ...request().modelCapabilities,
          contextWindow: 100_000
        }
      })
    });

    expect(small.ok).toBe(true);
    expect(large.ok).toBe(true);
    if (!small.ok || !large.ok) throw new Error("unexpected budget rejection");
    expect(small.request.attachments[0]!.extractedText!.length).toBeLessThan(30_000);
    expect(small.request.attachments[0]!.extractedText).toContain("[truncated for model context]");
    expect(large.request.attachments[0]!.extractedText).toBe(attachment.extractedText);
  });

  it.each([undefined, 0])(
    "caps one oversized attachment when contextWindow is %s",
    (contextWindow) => {
      const attachment = {
        byteSize: 1_000_000,
        extractedText: "a".repeat(100_000),
        fileName: "unknown-window.txt",
        id: "attachment-1",
        kind: "document" as const,
        metadata: {},
        mimeType: "text/plain",
        status: "ready" as const
      };
      const capabilities = { ...request().modelCapabilities, contextWindow };
      const budgeted = applyProviderRequestContextBudget({
        request: request({
          attachmentIds: [attachment.id],
          attachments: [attachment],
          modelCapabilities: capabilities
        })
      });

      expect(budgeted.ok).toBe(true);
      if (!budgeted.ok) throw new Error("unexpected budget rejection");
      expect(budgeted.request.attachments[0]!.extractedText).toContain(
        "[truncated for model context]"
      );
      expect(providerAttachmentBudgetTokens({
        attachments: budgeted.request.attachments,
        estimateTokens: contextTokenEstimator(request()),
        modelCapabilities: capabilities
      })).toBeLessThanOrEqual(UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS);
    }
  );

  it("shares the unknown-window fallback across the full attachment set", () => {
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      byteSize: 1_000_000,
      extractedText: String(index % 10).repeat(100_000),
      fileName: `unknown-${index}.txt`,
      id: `attachment-${index}`,
      kind: "document" as const,
      metadata: {},
      mimeType: "text/plain",
      status: "ready" as const
    }));
    const capabilities = { ...request().modelCapabilities, contextWindow: undefined };
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: attachments.map(({ id }) => id),
        attachments,
        modelCapabilities: capabilities
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.attachments).toHaveLength(20);
    expect(budgeted.request.attachments.every((attachment) =>
      Boolean(attachment.extractedText?.length))).toBe(true);
    expect(providerAttachmentBudgetTokens({
      attachments: budgeted.request.attachments,
      estimateTokens: contextTokenEstimator(request()),
      modelCapabilities: capabilities
    })).toBeLessThanOrEqual(UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS);
  });

  it("fits non-ASCII attachment text by estimated tokens rather than raw characters", () => {
    const text = "Пользователь просит подготовить отчёт о продажах за третий квартал, учесть возвраты и не включать тестовые заказы. ".repeat(80);
    const attachment = {
      byteSize: 20_000,
      extractedText: text,
      fileName: "notes.txt",
      id: "attachment-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      status: "ready"
    };
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        attachmentIds: [attachment.id],
        attachments: [attachment],
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 1_000 }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    // Cyrillic prose packs several characters into an o200k token: the text is
    // cut by its estimate (never above the 900-token budget of a 1,000-token
    // window with no output reservation), not by raw characters or the
    // half-token-per-character weight.
    const fitted = budgeted.request.attachments[0]!.extractedText!;
    expect(fitted.length).toBeLessThan(text.length);
    expect(fitted.length).toBeGreaterThan(2_700);
    expect(contextTokenEstimator(request())(fitted)).toBeLessThanOrEqual(900);
  });

  it("honors the reduction-only operator clamp without restoring a fixed provider cap", () => {
    vi.stubEnv("AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS", "10");
    const text = "abcdefghijklmnopqrstuvwxyz";
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        attachments: [{
          byteSize: text.length,
          extractedText: text,
          fileName: "notes.txt",
          id: "attachment-1",
          kind: "document",
          metadata: {},
          mimeType: "text/plain",
          status: "ready"
        }],
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 100_000 }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.attachments[0]!.extractedText).toBe("abcdefghij\n[truncated 16 chars]");
  });
});

it.each(["personalInstructions", "responseReminder"] as const)("reserves the complete %s and fails before trimming it", key => {
  const input = request();
  input.prompt = { ...input.prompt, [key]: "instruction ".repeat(500) };
  const before = JSON.stringify(input.prompt);
  const result = applyProviderRequestContextBudget({ request: input });
  expect(result).toMatchObject({ ok: false, error: { code: "context_too_large" } });
  expect(JSON.stringify(input.prompt)).toBe(before);
});

// Review reproductions: window 20 000, maxOutput 512, OpenAI Responses bridge.
describe("hybrid context budget boundaries", () => {
  const HYBRID_BUDGET = 17_488;
  const capabilities = { ...request().modelCapabilities, contextWindow: 20_000, defaultMaxOutputTokens: 512, toolCalling: true };
  const turn = (id: string, role: "assistant" | "user", chars: number, fill = "h",
    purpose?: ProviderConversationMessage["purpose"]): ProviderConversationMessage => ({
    content: { blocks: [{ text: fill.repeat(chars), type: "text" }] }, id, role, ...(purpose ? { purpose } : {})
  });
  const hybrid = (messages: ProviderConversationMessage[], overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest => request({
    content: messages.at(-1)!.content,
    context: { messages, mode: "branch_path" },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: messages.at(-1)!.id, messages }),
    modelCapabilities: capabilities,
    toolObservationVersion: 1,
    tools: [readToolResultTool],
    ...overrides
  });
  const legacyOf = (input: ProviderRunRequest): ProviderRunRequest => ({
    ...input, contextCompactionPolicy: { ...input.contextCompactionPolicy!, mode: "legacy_compatible" }
  });
  const budgetOf = (input: ProviderRunRequest, observations?: ReturnType<typeof contextObservationsFromResults>) =>
    applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: input, ...(observations ? { observations } : {}) });
  const accepted = (result: ReturnType<typeof budgetOf>) => {
    if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
    return result;
  };
  const assembled = (input: ProviderRunRequest) =>
    measureSessionContext({ bridge: openAIResponsesToolBridge, request: input }).approximateInputTokens;
  // Fills use "h", which o200k encodes at four characters per token like the
  // character weights these reproductions were measured with.
  /** Notes this run bought over the whole source: every prior message and settled unit. */
  const summaryFor = (source: ProviderRunRequest, notes = "h".repeat(2_000)): ContextSummary => {
    const prior = source.context!.messages.filter((message) => message.purpose === undefined).slice(0, -1);
    return { formatVersion: 1, id: `cs1_${"c".repeat(32)}`, notes, sourceDigest: "d".repeat(64), sourceRefs: [
      ...(prior.length > 0 ? [messageCoverageRef(prior.at(-1)!.id)] : []),
      ...toolTranscriptUnits(source.providerToolMessages ?? []).filter((unit) => unit.settled).map(unitCoverageRef)
    ] };
  };
  const hex = (seed: string, length: number) => Buffer.from(seed).toString("hex").padEnd(length, "0").slice(0, length);
  const observed = (id: string, chars = 1_000): ToolExecutionResult => projectObservationForProvider({
    callId: id, content: [{ text: `rare ${id} ${"x".repeat(chars)}`, type: "text" }], name: "read_record", status: "complete",
    observation: { byteSize: 20_000, checksum: hex(id, 64), encoding: "json-utf8-v1", handle: `tor1_${hex(id, 32)}`,
      maskable: true, source: "mcp", sourceTruncated: false, version: 1 }
  });
  const reference = (settled: ToolExecutionResult) => openAIResponsesToolBridge.appendToolResult(undefined, {
    callId: settled.callId, content: [{ type: "json", value: { observation: settled.observation, reader: "read_tool_result" } }],
    name: settled.name, status: settled.status
  });
  const document = (chars: number) => ({
    byteSize: chars, extractedText: "d".repeat(chars), fileName: "large.txt", id: "doc-1",
    kind: "document" as const, metadata: {}, mimeType: "text/plain", status: "ready" as const
  });

  it("uses the reviewed 17 488-token budget", () => {
    expect(calculateContextBudgetLimits({ contextWindow: 20_000, maxOutputTokens: 512, provider: "openai" }).budgetTokens)
      .toBe(HYBRID_BUDGET);
  });

  describe("after a provider context rejection", () => {
    // About half the budget: the planner judged it fitting with no work to do.
    const history = () => [...Array.from({ length: 6 }, (_, index) => turn(`h${index}`, index % 2 ? "assistant" : "user", 5_000)),
      turn("current", "user", 200)];

    it("derives one tightened budget from the stated counts, else the recorded ratio, only for eligible requests", () => {
      const input = hybrid(history());
      const estimate = assembled(input);
      const reported = calculateContextBudgetLimits({ contextWindow: 12_000, maxOutputTokens: 512, provider: "openai" }).budgetTokens;
      expect(providerRequestContextRebuild({ bridge: openAIResponsesToolBridge, request: input, round: 2,
        rejection: { maximumTokens: 12_000, promptTokens: 15_000 } }))
        .toEqual({ version: 1, round: 2, budgetTokens: Math.floor(reported * estimate / 15_000) });
      expect(providerRequestContextRebuild({ bridge: openAIResponsesToolBridge, request: input, round: 1, rejection: {} }))
        .toEqual({ version: 1, round: 1, budgetTokens: Math.floor(estimate * 0.75) });
      const rebuild = { version: 1 as const, round: 1, budgetTokens: 1_000 };
      for (const ineligible of [
        { ...input, contextCompactionRebuild: rebuild },
        { ...input, toolObservationVersion: 0 as const },
        { ...input, modelCapabilities: { ...capabilities, contextWindow: undefined } }
      ]) expect(providerRequestContextRebuild({ bridge: openAIResponsesToolBridge, request: ineligible, round: 1, rejection: {} })).toBeNull();
    });

    it("re-plans a fitting hybrid request under the tightened budget without changing the whole-result share", () => {
      const input = hybrid(history());
      const fitting = accepted(budgetOf(input));
      expect(fitting.request.contextCompaction).toMatchObject({ budgetTokens: HYBRID_BUDGET, outcome: "already_fits" });
      const budgetTokens = Math.floor(assembled(input) * 0.75);
      const rebuilt = accepted(budgetOf({ ...input, contextCompactionRebuild: { version: 1, round: 1, budgetTokens } }));
      // Over the tighter budget with uncovered history: a summary the hybrid policy buys anyway.
      expect(rebuilt.request.contextCompaction).toMatchObject({ budgetTokens, outcome: "needs_summary" });
      expect(summaryNeedsProvider(rebuilt.request)).toBe(true);
      expect(rebuilt.request.contextCompactionRebuild).toEqual({ version: 1, round: 1, budgetTokens });
      expect(observationWholeResultTokens({ ...input, contextCompactionRebuild: { version: 1, round: 1, budgetTokens } }).tokens)
        .toBe(observationWholeResultTokens(input).tokens);
    });

  it("never trims a request without the policy under the tightened budget and never loosens it", () => {
    const input = legacyOf(hybrid(history()));
    const fitting = accepted(budgetOf(input));
    expect(fitting.contextTruncation).toBeNull();
    const budgetTokens = Math.floor(assembled(input) * 0.75);
    expect(budgetOf({ ...input, contextCompactionRebuild: { version: 1, round: 1, budgetTokens } }))
      .toMatchObject({ ok: false, error: { code: "context_too_large" } });
    // A record above the admitted budget is ignored rather than widening it.
    const loose = accepted(budgetOf({ ...input, contextCompactionRebuild: { version: 1, round: 1, budgetTokens: HYBRID_BUDGET * 2 } }));
    expect(loose.request.contextCompaction?.budgetTokens).toBe(HYBRID_BUDGET);
    expect(loose.request.context?.messages).toEqual(input.context?.messages);
  });
  });

  it("rejects an irreducible current message before a run exists, exactly like legacy", () => {
    const current = turn("current", "user", 121_000, "q");
    for (const input of [hybrid([current]), hybrid([turn("old", "user", 40_000), turn("old-answer", "assistant", 400), current])]) {
      for (const candidate of [input, legacyOf(input)]) {
        expect(budgetOf(candidate)).toMatchObject({ ok: false, error: { code: "context_too_large" } });
      }
    }
  });

  it("reports pinned Skills over budget as skills_budget_exceeded", () => {
    const input = hybrid([turn("skill-context:current", "user", 80_000, "s", "skill_context"), turn("current", "user", 100)]);
    for (const candidate of [input, legacyOf(input)]) {
      expect(budgetOf(candidate)).toMatchObject({
        ok: false, error: { code: "skills_budget_exceeded", skillBudget: { budgetTokens: HYBRID_BUDGET } }
      });
    }
  });

  it("accepts a current summary with nothing left to mask at 75-100% without trimming or a second summary", () => {
    const settled = [observed("old-1"), observed("old-2"), observed("new-1")];
    const recent = [turn("u1", "user", 12_500), turn("a1", "assistant", 12_500), turn("u2", "user", 12_500), turn("a2", "assistant", 12_500)];
    const call = (id: string) => ({ call_id: id, name: "read_record", type: "function_call" });
    const base = hybrid([turn("older", "user", 40_000), ...recent, turn("current", "user", 100)], { providerToolMessages: [
      call("old-1"), reference(settled[0]!), call("old-2"), reference(settled[1]!),
      call("new-1"), openAIResponsesToolBridge.appendToolResult(undefined, settled[2]!)
    ] });
    const summarized = applyContextSummaryToRequest(base, summaryFor(base));
    const observations = contextObservationsFromResults(settled);
    const result = accepted(budgetOf(summarized, observations));
    const measurement = result.request.contextCompaction!;
    expect(measurement.beforeTokens).toBeGreaterThan(HYBRID_BUDGET * 0.75);
    expect(measurement.beforeTokens).toBeLessThanOrEqual(HYBRID_BUDGET);
    expect(measurement).toMatchObject({ afterTokens: measurement.beforeTokens, maskedObservations: 0, outcome: "already_fits" });
    expect(result.contextTruncation).toBeNull();
    expect(result.request.context?.messages).toEqual(summarized.context?.messages);
    expect(summaryNeedsProvider(result.request)).toBe(false);

    // A later round over the trigger releases covered material only: the
    // notes already cover every retained turn and unit, so nothing is bought
    // again and the covered older units leave whole toward the target.
    const grown = { ...summarized, providerToolMessages: [
      call("old-1"), reference(settled[0]!), call("old-2"), openAIResponsesToolBridge.appendToolResult(undefined, observed("old-2", 4_000)),
      ...summarized.providerToolMessages!.slice(4)
    ] };
    const released = accepted(budgetOf(grown, observations));
    expect(released.request.contextCompaction).toMatchObject({ outcome: "already_fits" });
    expect(released.request.providerToolMessages).toEqual(summarized.providerToolMessages!.slice(4));
    expect(released.contextTruncation).toBeNull();
    expect(summaryNeedsProvider(released.request)).toBe(false);
  });

  it("keeps a short history beside a large attachment without buying a summary", () => {
    const input = hybrid([turn("u1", "user", 200), turn("a1", "assistant", 200), turn("u2", "user", 200),
      turn("a2", "assistant", 200), turn("current", "user", 200)], { attachmentIds: ["doc-1"], attachments: [document(200_000)] });
    const result = accepted(budgetOf(input));
    expect(result.request.contextCompaction).toMatchObject({ outcome: "already_fits" });
    expect(summaryNeedsProvider(result.request)).toBe(false);
    expect(result.contextTruncation).toBeNull();
    expect(result.request.context?.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2", "a2", "current"]);
    expect(result.request.attachments[0]!.extractedText).toContain("[truncated for model context]");
    expect(assembled(result.request)).toBeLessThanOrEqual(HYBRID_BUDGET);
    // Without the policy the fit check refuses instead of dropping the short turns.
    expect(budgetOf(legacyOf(input))).toMatchObject({ ok: false, error: { code: "context_too_large" } });
  });

  it("fits a large attachment after the summary replaces a long history instead of refusing it", () => {
    const history = Array.from({ length: 12 }, (_, index) => turn(`h${index}`, index % 2 ? "assistant" : "user", 6_000));
    const input = hybrid([...history, turn("current", "user", 200)], { attachmentIds: ["doc-1"], attachments: [document(200_000)] });
    const pending = accepted(budgetOf(input));
    expect(pending.request.contextCompaction).toMatchObject({ outcome: "needs_summary", legacyFallback: false });
    expect(pending.request.contextCompaction!.afterTokens).toBeGreaterThan(HYBRID_BUDGET);
    expect(summaryNeedsProvider(pending.request)).toBe(true);
    expect(pending.contextTruncation).toBeNull();
    expect(pending.request.context?.messages).toHaveLength(13);
    const pendingText = pending.request.attachments[0]!.extractedText!.length;

    const summarized = applyContextSummaryToRequest(pending.request, summaryFor(pending.request));
    const answer = accepted(budgetOf(summarized));
    expect(answer.request.contextCompaction!.outcome).not.toBe("needs_summary");
    expect(summaryNeedsProvider(answer.request)).toBe(false);
    expect(answer.contextTruncation).toBeNull();
    // The exact tail keeps only the newest messages within its token share.
    expect(answer.request.context?.messages.map((message) => message.id))
      .toEqual([`__context-summary-${summarized.contextCompactionSummary!.id}`, "h10", "h11", "current"]);
    const answerText = answer.request.attachments[0]!.extractedText!.length;
    expect(answerText).toBeLessThan(pendingText);
    expect(answerText).toBeGreaterThan(20_000);
    expect(assembled(answer.request)).toBeLessThanOrEqual(HYBRID_BUDGET);
  });

  it("requests a headroom summary for a plain chat above 75% only when older history can be summarized", () => {
    // 80% of the budget, no tool results and therefore nothing to mask.
    const long = hybrid([...Array.from({ length: 10 }, (_, index) => turn(`h${index}`, index % 2 ? "assistant" : "user", 5_600)),
      turn("current", "user", 200)]);
    const pending = accepted(budgetOf(long));
    expect(pending.request.contextCompaction).toMatchObject({ maskedObservations: 0, outcome: "needs_summary" });
    expect(pending.request.contextCompaction!.afterTokens).toBeLessThanOrEqual(HYBRID_BUDGET);
    expect(pending.request.contextCompaction!.afterTokens).toBeGreaterThan(HYBRID_BUDGET * 0.75);
    expect(summaryNeedsProvider(pending.request)).toBe(true);
    expect(pending.contextTruncation).toBeNull();
    // The same load in a current message beside history that stays in the
    // exact tail, or is too small to release room: a summary cannot help.
    for (const history of [
      Array.from({ length: 4 }, (_, index) => turn(`t${index}`, index % 2 ? "assistant" : "user", 3_400)),
      [turn("small-older", "user", 6_000), ...Array.from({ length: 4 }, (_, index) => turn(`t${index}`, index % 2 ? "assistant" : "user", 400))]
    ]) {
      const fits = accepted(budgetOf(hybrid([...history, turn("current", "user", 44_000)])));
      expect(fits.request.contextCompaction).toMatchObject({ outcome: "already_fits" });
      expect(fits.request.contextCompaction!.afterTokens).toBeGreaterThan(HYBRID_BUDGET * 0.75);
      expect(summaryNeedsProvider(fits.request)).toBe(false);
    }
  });

  it("never drops a paid summary note: note plus exact minimum over budget is irreducible", () => {
    const history = [turn("h0", "user", 400), turn("h1", "assistant", 400), turn("h2", "user", 400),
      turn("h3", "assistant", 400), turn("h4", "user", 400)];
    const base = hybrid([...history, turn("current", "user", 12_000, "q")]);
    const summarized = applyContextSummaryToRequest(base, summaryFor(base, "n".repeat(60_000)));
    expect(budgetOf(summarized)).toMatchObject({ ok: false, error: { code: "context_too_large" } });
    // Without the oversized note the same exact minimum fits.
    expect(budgetOf(applyContextSummaryToRequest(base, summaryFor(base))).ok).toBe(true);
  });

  it("keeps exact pins directly before the current message after a summary rebuild", () => {
    const history = Array.from({ length: 12 }, (_, index) => turn(`h${index}`, index % 2 ? "assistant" : "user", 6_000));
    const pin = turn("knowledge-evidence:v1", "user", 400, "k", "knowledge_evidence");
    const pending = accepted(budgetOf(hybrid([...history, pin, turn("current", "user", 200)])));
    expect(pending.request.contextCompaction).toMatchObject({ outcome: "needs_summary" });
    const summarized = applyContextSummaryToRequest(pending.request, summaryFor(pending.request));
    const answer = accepted(budgetOf(summarized));
    expect(answer.request.context?.messages.map((message) => message.id)).toEqual([
      `__context-summary-${summarized.contextCompactionSummary!.id}`, "h10", "h11", pin.id, "current"
    ]);
    expect(answer.request.context?.messages.at(-2)?.content).toEqual(pin.content);
  });

  it("summarizes a large recent turn instead of keeping it in a fixed-count tail", () => {
    // Legacy would trim these turns; a four-message tail would keep 20 000
    // tokens verbatim. The token-bounded tail keeps none of them.
    const history = [turn("h0", "user", 400), turn("h1", "assistant", 400), turn("h2", "user", 400), turn("h3", "assistant", 400),
      turn("h4", "user", 20_000), turn("h5", "assistant", 20_000), turn("h6", "user", 20_000), turn("h7", "assistant", 20_000)];
    const pending = accepted(budgetOf(hybrid([...history, turn("current", "user", 200)])));
    expect(pending.request.contextCompaction).toMatchObject({ outcome: "needs_summary" });
    const summarized = applyContextSummaryToRequest(pending.request, summaryFor(pending.request));
    const answer = accepted(budgetOf(summarized));
    const summaryId = `__context-summary-${summarized.contextCompactionSummary!.id}`;
    expect(answer.contextTruncation).toBeNull();
    expect(answer.request.context?.messages.map((message) => message.id)).toEqual([summaryId, "current"]);
    expect(answer.request.contextCompaction).toMatchObject({ legacyFallback: false, outcome: "already_fits" });
    expect(assembled(answer.request)).toBeLessThanOrEqual(HYBRID_BUDGET);
  });

  it("bounds a covered exact tail after a summary instead of refusing the paid result", () => {
    const history = [turn("h0", "user", 8_000), turn("h1", "assistant", 8_000),
      ...Array.from({ length: 4 }, (_, index) => turn(`t${index}`, index % 2 ? "assistant" : "user", 3_200))];
    const pending = accepted(budgetOf(hybrid([...history, turn("current", "user", 56_000)])));
    expect(pending.request.contextCompaction).toMatchObject({ outcome: "needs_summary" });
    const summarized = applyContextSummaryToRequest(pending.request, summaryFor(pending.request));
    const answer = accepted(budgetOf(summarized));
    const summaryId = `__context-summary-${summarized.contextCompactionSummary!.id}`;
    expect(answer.contextTruncation).toMatchObject({ droppedMessages: 2 });
    expect(answer.request.context?.messages.map((message) => message.id)).toEqual([summaryId, "t2", "t3", "current"]);
    expect(answer.request.contextCompaction).toMatchObject({ legacyFallback: false, outcome: "already_fits" });
    expect(answer.request.contextCompaction!.afterTokens).toBeLessThanOrEqual(HYBRID_BUDGET);
    expect(summaryNeedsProvider(answer.request)).toBe(false);
    expect(assembled(answer.request)).toBeLessThanOrEqual(HYBRID_BUDGET);
  });
});

describe("provider-aware context estimate in the run budget", () => {
  const o200k = (text: string) => countTokens(text, { disallowedSpecial: new Set() });
  const fixture = (name: string) => TOKEN_ESTIMATE_FIXTURES.find((entry) => entry.name === name)!.text;

  it("estimates three ~99 KB MCP JSON results on a 128k window at or above their o200k count", () => {
    const records = (JSON.parse(fixture("mcp_json")) as { structuredContent: { records: Record<string, unknown>[] } })
      .structuredContent.records;
    const mcpResult = (batch: number) => {
      const page: Record<string, unknown>[] = [];
      for (let index = 0; page.length < 230; index += 1) page.push({ ...records[index % records.length], key: `OPS-${batch}-${index}` });
      return JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ records: page }) }], isError: false });
    };
    const transcript = [1, 2, 3].flatMap((batch) => [
      { arguments: "{\"status\":\"open\"}", call_id: `mcp-${batch}`, name: "mcp_tracker_search", type: "function_call" },
      { call_id: `mcp-${batch}`, output: mcpResult(batch), type: "function_call_output" }
    ]);
    for (const entry of transcript) if (entry.type === "function_call_output") expect(entry.output!.length).toBeGreaterThan(95_000);
    const reference = o200k(JSON.stringify(transcript));
    const input = request({
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 128_000, defaultMaxOutputTokens: 16_000, toolCalling: true },
      modelId: "gpt-5.4", provider: "openai_compatible", providerToolMessages: transcript
    });
    // The character weights counted about 0.6 of the real tokens and let the provider reject the request.
    expect(estimateApproxTokens(transcript)).toBeLessThan(reference);
    expect(measureSessionContext({ bridge: openAIResponsesToolBridge, request: input }).approximateInputTokens)
      .toBeGreaterThanOrEqual(reference);
    expect(reference).toBeGreaterThan(calculateContextBudgetLimits({ contextWindow: 128_000, maxOutputTokens: 16_000 }).budgetTokens);
    expect(applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: input }))
      .toMatchObject({ ok: false, error: { code: "context_too_large" } });
    for (const provider of ["anthropic", "gemini", "deepseek", "openrouter"]) {
      expect(measureSessionContext({ bridge: openAIResponsesToolBridge, request: { ...input, provider } }).approximateInputTokens)
        .toBeGreaterThanOrEqual(reference);
    }
  });

  it("measures a Russian chat by the admitted family: codex-lb stays below the trigger where Anthropic needs notes", () => {
    const capabilities = { ...request().modelCapabilities, contextWindow: 20_000, defaultMaxOutputTokens: 512, toolCalling: true };
    const budgetTokens = calculateContextBudgetLimits({ contextWindow: 20_000, maxOutputTokens: 512 }).budgetTokens;
    const russian = fixture("russian_prose");
    const messages: ProviderConversationMessage[] = [
      ...Array.from({ length: 14 }, (_, index): ProviderConversationMessage => ({
        content: { blocks: [{ text: russian, type: "text" }] }, id: `h${index}`, role: index % 2 ? "assistant" : "user"
      })),
      { content: { blocks: [{ text: "Продолжим?", type: "text" }] }, id: "current", role: "user" }
    ];
    const chat = (provider: string, modelId: string) => request({
      content: messages.at(-1)!.content,
      context: { messages, mode: "branch_path" },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages }),
      modelCapabilities: capabilities, modelId, provider, toolObservationVersion: 1, tools: [readToolResultTool]
    });
    const planned = (input: ProviderRunRequest) => {
      const result = applyProviderRequestContextBudget({ bridge: openAIResponsesToolBridge, request: input });
      if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
      return result.request.contextCompaction!;
    };
    const codexLb = planned(chat("openai_compatible", "gpt-5.4"));
    // About 60% of the real o200k budget: no notes are bought on the OpenAI family.
    expect(codexLb.beforeTokens).toBeGreaterThan(budgetTokens * 0.5);
    expect(codexLb.beforeTokens).toBeLessThan(budgetTokens * 0.8);
    expect(codexLb.outcome).toBe("already_fits");
    // The character weights (half a token per Cyrillic character) measured the same chat over the budget.
    expect(messages.reduce((total, message) => total + estimateApproxTokens(message.content), 0)).toBeGreaterThan(budgetTokens);
    // Anthropic's tokenizer spends more on Cyrillic: the same history needs notes there.
    const anthropic = planned(chat("anthropic", "claude-sonnet-5"));
    expect(anthropic.beforeTokens).toBeGreaterThan(codexLb.beforeTokens);
    expect(anthropic.outcome).toBe("needs_summary");
  });
});
