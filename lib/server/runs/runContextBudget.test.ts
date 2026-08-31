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
  PERSONAL_CONTEXT_HEADING
} from "../providers/personalContext";
import type { ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import {
  applyProviderRequestContextBudget,
  normalizedRequestPersonalContextTokenLimit,
  providerFacingSerializedTools,
  UNKNOWN_CONTEXT_ATTACHMENT_TEXT_BUDGET_TOKENS
} from "./runContextBudget";

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
  afterEach(() => vi.unstubAllEnvs());

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
        code: "context_too_large",
        message: expect.stringContaining("Reduce selected context")
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
