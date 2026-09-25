import { workspaceImageTokenReserve } from "../workspace/directImageEvidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateContextBudgetLimits,
  estimateApproxTokens
} from "../../domain/contextBudget";
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
import { conversationContextPolicy } from "./contextCompactionContract";
import { contextObservationsFromResults } from "./contextCompactionPlanner";
import {
  applyContextSummaryToRequest,
  contextSummaryIsCurrent,
  contextSummarySourceRevision,
  summaryNeedsProvider
} from "./contextCompactionSummarizer";
import {
  applyProviderRequestContextBudget,
  measureSessionContext,
  normalizedRequestPersonalContextTokenLimit,
  providerFacingSerializedTools,
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
    expect(executeSessionStatus({ arguments: { chatId: "other-owner" }, id: "bad", name: sessionStatusTool.name }, input).status).toBe("error");
    const finished = measureSessionContext({ answerText: "finished answer", request: input, bridge: openAIResponsesToolBridge });
    expect(finished.approximateInputTokens - status.approximateInputTokens).toBe(estimateApproxTokens("finished answer"));
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
    const expected = Math.max(0,
      limits.budgetTokens -
      estimateApproxTokens("trusted system") -
      estimateApproxTokens("trusted developer") -
      estimateApproxTokens(MEMORY_READER_CONTRACT_CURRENT) -
      estimateApproxTokens(MEMORY_READER_FINALIZATION_CONTRACT_V1) -
      estimateApproxTokens({ blocks: [{ text: "private skill context", type: "text" }] }) -
      estimateApproxTokens({ blocks: [{ text: "current question", type: "text" }] })
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
      version: 1
    } as const;
    const text = "ordinary-answer-canary";
    const requiredTokens = estimateApproxTokens(memoryActionAnswerContract(
      MEMORY_ACTION_NO_COMMIT_RESULT
    )) + estimateApproxTokens(text) + 2 * estimateApproxTokens([]);
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
    expect(estimateApproxTokens(memoryActionAnswerContract(committed))).toBe(
      estimateApproxTokens(memoryActionAnswerContract(MEMORY_ACTION_NO_COMMIT_RESULT))
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
      content: [{ text: `rare-${id}-${"x".repeat(6000)}`, type: "text" as const }],
      name: "read_record",
      observation: descriptor(seed),
      status: "complete" as const
    });
    const planned = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      observations: contextObservationsFromResults([projected("old", "a"), projected("new", "b")]),
      request: request({
        context: {
          messages: [
            { content: { blocks: [{ text: "pinned", type: "text" }] }, id: "pinned", purpose: "knowledge_evidence", role: "user" },
            { content: { blocks: [{ text: "current", type: "text" }] }, id: "current", role: "user" }
          ],
          mode: "branch_path"
        },
        contextCompactionPolicy: {
          mode: "legacy_compatible",
          source: { digest: "a".repeat(64), leafMessageId: "leaf", messageCount: 2 },
          version: 1
        },
        modelCapabilities: { ...request().modelCapabilities, contextWindow: 5_000, toolCalling: true },
        providerToolMessages: [
          openAIResponsesToolBridge.appendToolResult(undefined, projected("old", "a")),
          { call_id: "new", name: "read_record", type: "function_call" },
          openAIResponsesToolBridge.appendToolResult(undefined, projected("new", "b"))
        ],
        toolObservationVersion: 1,
        tools: [readToolResultTool]
      })
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unexpected context rejection");
    expect(planned.request.context?.messages.map(message => message.id)).toEqual(["pinned", "current"]);
    expect(JSON.stringify(planned.request.providerToolMessages?.[0])).not.toContain("rare-old");
    expect(JSON.stringify(planned.request.providerToolMessages?.[2])).toContain("rare-new");
    expect(planned.request.contextCompaction).toMatchObject({
      maskedBatches: 1,
      maskedObservations: 1,
      outcome: "masking_applied"
    });
  });

  it("drops older turns while keeping the full Skill context directly before current user text", () => {
    const skillText = "s".repeat(120);
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        content: { blocks: [{ text: "q".repeat(40), type: "text" }] },
        context: {
          messages: [
            {
              content: { blocks: [{ text: "h".repeat(240), type: "text" }] },
              id: "history-user",
              role: "user"
            },
            {
              content: { blocks: [{ text: skillText, type: "text" }] },
              id: "skill-context:current",
              purpose: "skill_context",
              role: "user"
            },
            {
              content: { blocks: [{ text: "q".repeat(40), type: "text" }] },
              id: "current",
              role: "user"
            }
          ],
          mode: "branch_path"
        }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.context?.messages.map(({ id }) => id)).toEqual([
      "skill-context:current",
      "current"
    ]);
    expect(budgeted.request.context?.messages[0]?.content).toEqual({
      blocks: [{ text: skillText, type: "text" }]
    });
    expect(budgeted.contextTruncation).toMatchObject({ droppedMessages: 1, keptMessages: 2 });
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
    const budgeted = applyProviderRequestContextBudget({
      request: request({
        content: { blocks: [{ text: "q".repeat(40), type: "text" }] },
        context: {
          messages: [
            {
              content: { blocks: [{ text: "h".repeat(240), type: "text" }] },
              id: "history-user",
              role: "user"
            },
            {
              content: { blocks: [{ text: evidenceText, type: "text" }] },
              id: "knowledge-evidence:v1",
              purpose: "knowledge_evidence",
              role: "user"
            },
            {
              content: { blocks: [{ text: "q".repeat(40), type: "text" }] },
              id: "current",
              role: "user"
            }
          ],
          mode: "branch_path"
        }
      })
    });

    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) throw new Error("unexpected budget rejection");
    expect(budgeted.request.context?.messages.map(({ id }) => id)).toEqual([
      "knowledge-evidence:v1",
      "current"
    ]);
    expect(budgeted.request.context?.messages[0]?.content).toEqual({
      blocks: [{ text: evidenceText, type: "text" }]
    });
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
      modelCapabilities: capabilities
    })).toBeLessThanOrEqual(UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS);
  });

  it("fits non-ASCII attachment text by estimated tokens rather than raw characters", () => {
    const attachment = {
      byteSize: 10_000,
      extractedText: "Ж".repeat(2_000),
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
    expect(budgeted.request.attachments[0]!.extractedText!.length).toBeLessThan(1_000);
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
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: messages.at(-1)!.id, messages, mode: "hybrid" }),
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
  const summaryFor = (source: ProviderRunRequest, notes = "n".repeat(2_000)): ContextSummary => ({
    formatVersion: 1, id: `cs1_${"c".repeat(32)}`, notes, sourceDigest: "d".repeat(64),
    sourceRefs: [contextSummarySourceRevision(source)]
  });
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
    const base = hybrid([turn("older", "user", 40_000), ...recent, turn("current", "user", 100)], { providerToolMessages: [
      reference(settled[0]!), reference(settled[1]!),
      { call_id: "new-1", name: "read_record", type: "function_call" },
      openAIResponsesToolBridge.appendToolResult(undefined, settled[2]!)
    ] });
    const summarized = applyContextSummaryToRequest(base, summaryFor(base));
    expect(contextSummaryIsCurrent(summarized)).toBe(true);
    const observations = contextObservationsFromResults(settled);
    const result = accepted(budgetOf(summarized, observations));
    const measurement = result.request.contextCompaction!;
    expect(measurement.beforeTokens).toBeGreaterThan(HYBRID_BUDGET * 0.75);
    expect(measurement.beforeTokens).toBeLessThanOrEqual(HYBRID_BUDGET);
    expect(measurement).toMatchObject({ afterTokens: measurement.beforeTokens, maskedObservations: 0, outcome: "already_fits" });
    expect(result.contextTruncation).toBeNull();
    expect(result.request.context?.messages).toEqual(summarized.context?.messages);
    expect(summaryNeedsProvider(result.request)).toBe(false);
    // Regression oracle: legacy admits the same request unchanged.
    const legacy = accepted(budgetOf(legacyOf(summarized), observations));
    expect(legacy.contextTruncation).toBeNull();
    expect(legacy.request.context?.messages).toEqual(result.request.context?.messages);
    expect(legacy.request.providerToolMessages).toEqual(result.request.providerToolMessages);

    // A later round that can still mask stays masking-only: the summary
    // already covers every retained turn, so the 75% trigger cannot buy it again.
    const grown = { ...summarized, providerToolMessages: [
      reference(settled[0]!), openAIResponsesToolBridge.appendToolResult(undefined, observed("old-2", 4_000)),
      ...summarized.providerToolMessages!.slice(2)
    ] };
    const masked = accepted(budgetOf(grown, observations));
    expect(masked.request.contextCompaction).toMatchObject({ maskedObservations: 1, outcome: "masking_applied" });
    expect(masked.contextTruncation).toBeNull();
    expect(summaryNeedsProvider(masked.request)).toBe(false);
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
    // Legacy answers too, by dropping the two short turns.
    const legacy = accepted(budgetOf(legacyOf(input)));
    expect(legacy.contextTruncation).toMatchObject({ droppedMessages: 4 });
    expect(legacy.request.contextCompaction).toMatchObject({ legacyFallback: true, outcome: "needs_summary" });
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
    expect(answer.request.context?.messages.map((message) => message.id))
      .toEqual([`__context-summary-${summarized.contextCompactionSummary!.id}`, "h8", "h9", "h10", "h11", "current"]);
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
    // The same load in the exact tail alone: a summary could not reduce it.
    const tail = hybrid([...Array.from({ length: 4 }, (_, index) => turn(`t${index}`, index % 2 ? "assistant" : "user", 14_000)),
      turn("current", "user", 200)]);
    const fits = accepted(budgetOf(tail));
    expect(fits.request.contextCompaction).toMatchObject({ outcome: "already_fits" });
    expect(fits.request.contextCompaction!.afterTokens).toBeGreaterThan(HYBRID_BUDGET * 0.75);
    expect(summaryNeedsProvider(fits.request)).toBe(false);
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
      `__context-summary-${summarized.contextCompactionSummary!.id}`, "h8", "h9", "h10", "h11", pin.id, "current"
    ]);
    expect(answer.request.context?.messages.at(-2)?.content).toEqual(pin.content);
  });

  it("bounds an oversized exact tail after a summary instead of refusing the paid result", () => {
    const history = [turn("h0", "user", 400), turn("h1", "assistant", 400), turn("h2", "user", 400), turn("h3", "assistant", 400),
      turn("h4", "user", 20_000), turn("h5", "assistant", 20_000), turn("h6", "user", 20_000), turn("h7", "assistant", 20_000)];
    const pending = accepted(budgetOf(hybrid([...history, turn("current", "user", 200)])));
    expect(pending.request.contextCompaction).toMatchObject({ outcome: "needs_summary" });
    const summarized = applyContextSummaryToRequest(pending.request, summaryFor(pending.request));
    const answer = accepted(budgetOf(summarized));
    const summaryId = `__context-summary-${summarized.contextCompactionSummary!.id}`;
    expect(answer.contextTruncation).toMatchObject({ droppedMessages: 2 });
    expect(answer.request.context?.messages.map((message) => message.id)).toEqual([summaryId, "h6", "h7", "current"]);
    expect(answer.request.contextCompaction).toMatchObject({ legacyFallback: true, outcome: "already_fits" });
    expect(answer.request.contextCompaction!.afterTokens).toBeLessThanOrEqual(HYBRID_BUDGET);
    expect(summaryNeedsProvider(answer.request)).toBe(false);
    expect(assembled(answer.request)).toBeLessThanOrEqual(HYBRID_BUDGET);
    expect(budgetOf(legacyOf(summarized)).ok).toBe(true);
  });
});
