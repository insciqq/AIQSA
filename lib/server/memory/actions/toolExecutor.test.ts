import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../../providers/types";
import { memorySha256 } from "../persistence/lexical";
import { createMemoryActionExecutor } from "./toolExecutor";

const request: ProviderRunRequest = {
  attachmentIds: [],
  attachments: [],
  chatId: "chat-1",
  content: { blocks: [{ text: "Remember that I like tea", type: "text" }] },
  knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
  toolMode: "auto",
  modelCapabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    toolCalling: true,
    vision: false
  },
  modelId: "model-1",
  params: {},
  prompt: { developer: null, system: "System" },
  provider: "fake",
  searchPlan: { mode: "all_selected", options: [] }
};

function authorization(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    action: "SAVE" as const,
    authorizedPayloadHash: memorySha256("I like tea"),
    confirmationCopyVersion: "memory-confirmation-v1",
    consumedAt: null,
    createdAt: now,
    exactSourceEnd: 24,
    exactSourceStart: 14,
    expectedTargetVersionId: null,
    expiresAt: new Date(now.getTime() + 60_000),
    id: "authorization-1",
    modelRunId: "run-1",
    nonceHash: "nonce-hash",
    persistedToolCallId: "persisted-call-1",
    requestId: "request-1",
    sourceChatId: "chat-1",
    sourceMessageId: "message-1",
    targetFactId: null,
    ...overrides
  };
}

describe("first-party Memory tool executor", () => {
  it("mints hidden authority from the exact current USER turn for a model-driven save", async () => {
    const mintForTool = vi.fn(async () => authorization());
    const create = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const executor = createMemoryActionExecutor({
      authorizationRepository: { mintForTool },
      explicitService: {
        create,
        evidence: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        mintAuthorization: vi.fn(),
        resolveConflict: vi.fn(),
        search: vi.fn(),
        undoForget: vi.fn(),
        update: vi.fn()
      },
      lifecycleService: {
        deleteExplicit: vi.fn(),
        forget: vi.fn(),
        status: vi.fn()
      },
      reviewService: { feedback: vi.fn() }
    });
    const result = await executor.execute({
      arguments: {
        scope: { target_id: null, type: "GLOBAL_USER" },
        source_text: "Remember that I like tea",
        statement: "I like tea"
      },
      id: "provider-call-1",
      name: "save_memory"
    }, {
      persistedToolCallId: "persisted-call-1",
      request,
      runId: "run-1",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(mintForTool).toHaveBeenCalledWith("user-1", {
      action: "SAVE",
      authorizedPayloadHash: memorySha256("I like tea"),
      chatId: "chat-1",
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1",
      sourceText: "Remember that I like tea",
      toolName: "save_memory"
    });
    expect(create).toHaveBeenCalledWith("user-1", {
      mutationAuthorizationId: "authorization-1",
      scope: { type: "GLOBAL_USER" },
      statement: "I like tea"
    }, {
      authorizedPayloadHash: memorySha256("I like tea"),
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1",
      userId: "user-1"
    });
  });

  it("lists authoritative first-party data without minting mutation authority", async () => {
    const list = vi.fn(async () => ({ memories: [], nextCursor: null }));
    const mintForTool = vi.fn();
    const executor = createMemoryActionExecutor({
      authorizationRepository: { mintForTool },
      explicitService: {
        create: vi.fn(),
        evidence: vi.fn(),
        get: vi.fn(),
        list,
        mintAuthorization: vi.fn(),
        resolveConflict: vi.fn(),
        search: vi.fn(),
        undoForget: vi.fn(),
        update: vi.fn()
      },
      lifecycleService: {
        deleteExplicit: vi.fn(),
        forget: vi.fn(),
        status: vi.fn()
      },
      reviewService: { feedback: vi.fn() }
    });
    const result = await executor.execute({
      arguments: { query: null },
      id: "provider-list-1",
      name: "list_memories"
    }, {
      persistedToolCallId: "persisted-list-1",
      request,
      runId: "run-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({
      rawPreview: { itemCount: 0, operation: "LIST", result: "complete" },
      status: "complete"
    });
    expect(list).toHaveBeenCalledWith("user-1", {
      pageSize: 20,
      scope: { type: "GLOBAL_USER" },
      state: "ACTIVE"
    });
    expect(mintForTool).not.toHaveBeenCalled();
  });

  it("binds update and Forget to the exact authorized target version", async () => {
    const updateSource = "Update the memory that my editor is Vim to my editor is Neovim";
    const forgetSource = "Forget that my editor is Neovim";
    const mintForTool = vi.fn()
      .mockResolvedValueOnce(authorization({
        action: "EDIT",
        expectedTargetVersionId: "version-1",
        targetFactId: "fact-1"
      }))
      .mockResolvedValueOnce(authorization({
        action: "FORGET",
        expectedTargetVersionId: "version-2",
        targetFactId: "fact-1"
      }));
    const update = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const forget = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const executor = createMemoryActionExecutor({
      authorizationRepository: { mintForTool },
      explicitService: {
        create: vi.fn(),
        evidence: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        mintAuthorization: vi.fn(),
        resolveConflict: vi.fn(),
        search: vi.fn(),
        undoForget: vi.fn(),
        update
      },
      lifecycleService: {
        deleteExplicit: vi.fn(),
        forget,
        status: vi.fn()
      },
      reviewService: { feedback: vi.fn() }
    });

    const updated = await executor.execute({
      arguments: {
        expected_version_id: "version-1",
        source_text: updateSource,
        statement: "my editor is Neovim",
        target_fact_id: "fact-1"
      },
      id: "provider-update-1",
      name: "update_memory"
    }, {
      persistedToolCallId: "persisted-call-1",
      request: { ...request, content: { blocks: [{ text: updateSource, type: "text" }] } },
      runId: "run-1",
      userId: "user-1"
    });
    const forgotten = await executor.execute({
      arguments: {
        expected_version_id: "version-2",
        source_text: forgetSource,
        target_fact_id: "fact-1"
      },
      id: "provider-forget-1",
      name: "forget_memory"
    }, {
      persistedToolCallId: "persisted-call-2",
      request: { ...request, content: { blocks: [{ text: forgetSource, type: "text" }] } },
      runId: "run-1",
      userId: "user-1"
    });

    expect(updated.status).toBe("complete");
    expect(forgotten.status).toBe("complete");
    expect(update).toHaveBeenCalledWith("user-1", "fact-1", {
      expectedVersionId: "version-1",
      mutationAuthorizationId: "authorization-1",
      statement: "my editor is Neovim"
    }, expect.objectContaining({
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1"
    }));
    expect(forget).toHaveBeenCalledWith("user-1", "fact-1", {
      expectedVersionId: "version-2",
      mutationAuthorizationId: "authorization-1"
    }, expect.objectContaining({
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-2"
    }));
  });

  it("marks one automatic fact incorrect through consumed target authority without changing truth", async () => {
    const source = "Mark the memory that I prefer coffee as incorrect";
    const mintForTool = vi.fn(async () => authorization({
      action: "EDIT",
      authorizedPayloadHash: memorySha256("automatic-target"),
      expectedTargetVersionId: "automatic-version-1",
      requestId: "authorization-request-1",
      targetFactId: "automatic-fact-1"
    }));
    const feedback = vi.fn(async () => ({
      createdAt: "2026-08-11T08:00:00.000Z",
      feedbackId: "feedback-1",
      feedbackType: "INCORRECT" as const,
      retractedFeedbackId: null,
      targetVersionId: "automatic-version-1"
    }));
    const update = vi.fn();
    const executor = createMemoryActionExecutor({
      authorizationRepository: { mintForTool },
      explicitService: {
        create: vi.fn(),
        evidence: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        mintAuthorization: vi.fn(),
        resolveConflict: vi.fn(),
        search: vi.fn(),
        undoForget: vi.fn(),
        update
      },
      lifecycleService: {
        deleteExplicit: vi.fn(),
        forget: vi.fn(),
        status: vi.fn()
      },
      reviewService: { feedback }
    });

    const result = await executor.execute({
      arguments: {
        expected_version_id: "automatic-version-1",
        source_text: source,
        target_fact_id: "automatic-fact-1"
      },
      id: "provider-feedback-1",
      name: "mark_memory_incorrect"
    }, {
      persistedToolCallId: "persisted-call-1",
      request: { ...request, content: { blocks: [{ text: source, type: "text" }] } },
      runId: "run-1",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(mintForTool).toHaveBeenCalledWith("user-1", expect.objectContaining({
      action: "EDIT",
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1",
      sourceText: source,
      targetFactId: "automatic-fact-1",
      toolName: "mark_memory_incorrect"
    }));
    expect(feedback).toHaveBeenCalledWith(
      "user-1",
      "automatic-fact-1",
      expect.objectContaining({
        expectedVersionId: "automatic-version-1",
        feedbackType: "INCORRECT",
        modelRunId: "run-1",
        modelRunToolCallId: "persisted-call-1"
      }),
      {
        authorization: {
          action: "EDIT",
          authorizationId: "authorization-1",
          authorizedPayloadHash: memorySha256("automatic-target"),
          expectedTargetVersionId: "automatic-version-1",
          requestId: "authorization-request-1",
          targetFactId: "automatic-fact-1"
        }
      }
    );
    expect(update).not.toHaveBeenCalled();
  });
});
