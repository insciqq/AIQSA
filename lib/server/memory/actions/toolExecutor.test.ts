import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../../providers/types";
import { memorySha256 } from "../persistence/lexical";
import { planMemoryActionFromText } from "./intent";
import { createMemoryActionExecutor } from "./toolExecutor";
import { memoryActionToolForPlan } from "./tools";

const request: ProviderRunRequest = {
  attachmentIds: [],
  attachments: [],
  chatId: "chat-1",
  content: { blocks: [{ text: "Remember that I like tea", type: "text" }] },
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
  searchStrategy: "search-disabled"
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
  it("requires the exact query when exposing a queried list tool", () => {
    expect(memoryActionToolForPlan({
      kind: "LIST",
      query: "preferred editor",
      version: "memory-action-plan-v1"
    }).inputSchema).toMatchObject({ required: ["query"] });
    expect(memoryActionToolForPlan({
      kind: "LIST",
      query: null,
      version: "memory-action-plan-v1"
    }).inputSchema).toMatchObject({
      properties: { query: { type: ["string", "null"] } },
      required: ["query"]
    });
  });

  it("claims hidden run authority and binds a save receipt to the persisted call", async () => {
    const claimForTool = vi.fn(async () => authorization());
    const create = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const executor = createMemoryActionExecutor({
      authorizationRepository: { claimForTool },
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
    const plan = {
      kind: "SAVE" as const,
      sourceEnd: 24,
      sourceStart: 14,
      statement: "I like tea",
      version: "memory-action-plan-v1" as const
    };
    const result = await executor.execute(plan, {
      arguments: { statement: "I like tea" },
      id: "provider-call-1",
      name: "save_memory"
    }, {
      persistedToolCallId: "persisted-call-1",
      request,
      runId: "run-1",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(claimForTool).toHaveBeenCalledWith("user-1", {
      action: "SAVE",
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1"
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

  it("commits a bounded model paraphrase through the current-turn authorization", async () => {
    const claimForTool = vi.fn(async () => authorization());
    const create = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const executor = createMemoryActionExecutor({
      authorizationRepository: { claimForTool },
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
      kind: "SAVE",
      sourceEnd: 24,
      sourceStart: 14,
      statement: "I like tea",
      version: "memory-action-plan-v1"
    }, {
      arguments: { statement: "The user likes tea." },
      id: "provider-call-1",
      name: "save_memory"
    }, {
      persistedToolCallId: "persisted-call-1",
      request,
      runId: "run-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ status: "complete" });
    expect(claimForTool).toHaveBeenCalledWith("user-1", expect.objectContaining({
      action: "SAVE",
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1"
    }));
    expect(create).toHaveBeenCalledWith("user-1", {
      mutationAuthorizationId: "authorization-1",
      scope: { type: "GLOBAL_USER" },
      statement: "The user likes tea."
    }, {
      authorizedPayloadHash: memorySha256("I like tea"),
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1",
      userId: "user-1"
    });
  });

  it("lists authoritative first-party data without mutation authority", async () => {
    const list = vi.fn(async () => ({ memories: [], nextCursor: null }));
    const claimForTool = vi.fn();
    const executor = createMemoryActionExecutor({
      authorizationRepository: { claimForTool },
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
      kind: "LIST",
      query: null,
      version: "memory-action-plan-v1"
    }, {
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
      sourceMode: "EXPLICIT",
      state: "ACTIVE"
    });
    expect(claimForTool).not.toHaveBeenCalled();
  });

  it("binds update and Forget to the exact authorized target version", async () => {
    const updateSource = "Update the memory that my editor is Vim to my editor is Neovim";
    const forgetSource = "Forget that my editor is Neovim";
    const updatePlan = planMemoryActionFromText(updateSource);
    const forgetPlan = planMemoryActionFromText(forgetSource);
    if (updatePlan.kind !== "UPDATE" || forgetPlan.kind !== "FORGET") {
      throw new Error("invalid_memory_action_fixture");
    }
    const claimForTool = vi.fn()
      .mockResolvedValueOnce(authorization({
        action: "EDIT",
        exactSourceEnd: updatePlan.sourceEnd,
        exactSourceStart: updatePlan.sourceStart,
        expectedTargetVersionId: "version-1",
        targetFactId: "fact-1"
      }))
      .mockResolvedValueOnce(authorization({
        action: "FORGET",
        exactSourceEnd: forgetPlan.sourceEnd,
        exactSourceStart: forgetPlan.sourceStart,
        expectedTargetVersionId: "version-2",
        targetFactId: "fact-1"
      }));
    const update = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const forget = vi.fn(async () => ({ memory: { id: "fact-1" } } as never));
    const executor = createMemoryActionExecutor({
      authorizationRepository: { claimForTool },
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

    const updated = await executor.execute(updatePlan, {
      arguments: { statement: updatePlan.replacement },
      id: "provider-update-1",
      name: "update_memory"
    }, {
      persistedToolCallId: "persisted-call-1",
      request: { ...request, content: { blocks: [{ text: updateSource, type: "text" }] } },
      runId: "run-1",
      userId: "user-1"
    });
    const forgotten = await executor.execute(forgetPlan, {
      arguments: { exact_query: forgetPlan.targetQuery },
      id: "provider-forget-1",
      name: "forget_memory"
    }, {
      persistedToolCallId: "persisted-call-1",
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
      persistedToolCallId: "persisted-call-1"
    }));
  });

  it("marks one automatic fact incorrect through consumed target authority without changing truth", async () => {
    const source = "Mark the memory that I prefer coffee as incorrect";
    const plan = planMemoryActionFromText(source);
    if (plan.kind !== "MARK_INCORRECT") throw new Error("invalid_memory_action_fixture");
    const claimForTool = vi.fn(async () => authorization({
      action: "EDIT",
      authorizedPayloadHash: memorySha256("automatic-target"),
      exactSourceEnd: plan.sourceEnd,
      exactSourceStart: plan.sourceStart,
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
      authorizationRepository: { claimForTool },
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

    const result = await executor.execute(plan, {
      arguments: { exact_query: plan.targetQuery },
      id: "provider-feedback-1",
      name: "mark_memory_incorrect"
    }, {
      persistedToolCallId: "persisted-call-1",
      request: { ...request, content: { blocks: [{ text: source, type: "text" }] } },
      runId: "run-1",
      userId: "user-1"
    });

    expect(result.status).toBe("complete");
    expect(claimForTool).toHaveBeenCalledWith("user-1", {
      action: "EDIT",
      modelRunId: "run-1",
      persistedToolCallId: "persisted-call-1"
    });
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
