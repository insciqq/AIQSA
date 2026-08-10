import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import {
  GROUNDED_LIVE_ONLY_PLACEHOLDER,
  groundedLiveOnlyProviderPreview
} from "../../domain/grounding";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { loadAdminUsageQueryRows } from "../auth/adminUsageQueries";
import { mcpRuntimeFingerprint } from "../mcp/access";
import {
  encryptMcpEnvelope,
  mcpRuntimeGenerationEnvelopeContext
} from "../mcp/encryption";
import { createPrismaMcpRuntimeRepository } from "../mcp/runtimeRepository";
import { prisma } from "../prisma";
import { createPrismaSettingsRepository } from "../settings/prismaRepository";
import { createPrismaRunRepository } from "./prismaRepository";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AttachmentLinkConflictError,
  McpRunPlanConflictError,
  type AcceptedRunDefaults,
  type RunRepository
} from "./runRepositoryContract";
import { parseToolLoopCheckpoint } from "./toolLoopPersistence";

const TEST_MCP_KEY = Buffer.alloc(32, 0x61);
const fakeControlKey = `${providerTemplateIds.fakeConnection}:${providerTemplateIds.fakeModel}`;

async function withRunUser<T>(run: (input: { userId: string }) => Promise<T>): Promise<T> {
  const userId = `run-repository-test-${randomUUID()}`;

  await prisma.user.create({
    data: {
      displayName: "Run Repository Test User",
      id: userId,
      settings: {
        create: {
          defaultControlValues: {},
          defaultProviderModelId: providerTemplateIds.fakeModel,
          defaultSearchStrategyId: "search-disabled"
        }
      }
    }
  });

  try {
    return await run({ userId });
  } finally {
    await prisma.user.deleteMany({
      where: {
        id: userId
      }
    });
  }
}

async function createReadyMcpBinding(userId: string) {
  const suffix = randomUUID();
  const configuration = {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 30_000 },
    slots: [],
    source: { kind: "remote", url: "https://mcp.example.test/rpc" },
    transport: "streamable_http"
  };
  const server = await prisma.mcpServer.create({
    data: {
      description: "Run acceptance fixture",
      displayName: "Run acceptance MCP",
      draft: configuration,
      enabled: true,
      namespace: `run_acceptance_${suffix}`
    }
  });
  const revision = await prisma.mcpRevision.create({
    data: {
      configuration,
      draftHash: `draft-${suffix}`,
      identityHash: `identity-${suffix}`,
      revisionNumber: 1,
      serverId: server.id,
      validationEvidence: {}
    }
  });
  await prisma.mcpServer.update({
    data: { activeRevisionId: revision.id },
    where: { id: server.id }
  });
  await prisma.mcpGrant.create({
    data: { canUse: true, serverId: server.id, userId }
  });
  const preference = await prisma.mcpUserServer.create({
    data: { enabled: true, serverId: server.id, userId }
  });
  const generationId = randomUUID();
  const fingerprint = mcpRuntimeFingerprint({
    oauthConnectionRevision: null,
    plan: [],
    revisionId: revision.id,
    userId
  });
  const generation = await prisma.mcpRuntimeGeneration.create({
    data: {
      effectiveConfigEnvelope: encryptMcpEnvelope(
        { plan: [], values: {}, version: 1 },
        TEST_MCP_KEY,
        mcpRuntimeGenerationEnvelopeContext(generationId, fingerprint)
      ),
      fingerprint,
      id: generationId,
      inventory: {
        tools: [{
          definitionHash: "a".repeat(64),
          description: "Echo",
          inputSchema: { type: "object" },
          name: "echo"
        }],
        version: 1
      },
      inventoryUpdatedAt: new Date(),
      revisionId: revision.id,
      state: "ready",
      userServerId: preference.id
    }
  });
  await prisma.mcpUserServer.update({
    data: { desiredRuntimeGenerationId: generation.id },
    where: { id: preference.id }
  });
  return {
    binding: {
      fingerprint: generation.fingerprint,
      runtimeGenerationId: generation.id,
      serverId: server.id
    },
    generation,
    preference,
    revision,
    server
  };
}

async function deleteMcpFixture(serverId: string): Promise<void> {
  await prisma.mcpServer.updateMany({
    data: { activeRevisionId: null },
    where: { id: serverId }
  });
  await prisma.mcpUserServer.deleteMany({ where: { serverId } });
  await prisma.mcpGrant.deleteMany({ where: { serverId } });
  await prisma.mcpRevision.deleteMany({ where: { serverId } });
  await prisma.mcpServer.deleteMany({ where: { id: serverId } });
}

function createRunInput(input: {
  attachmentIds?: string[];
  chatId: string;
  defaults?: Partial<AcceptedRunDefaults>;
  question: string;
  userId: string;
}): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent(input.question);
  const defaults: AcceptedRunDefaults = {
    controlDefaults: input.defaults?.controlDefaults ?? {},
    modelId: providerTemplateIds.fakeModel,
    provider: providerTemplateIds.fakeConnection,
    searchStrategy: "search-disabled",
    userId: input.userId,
    ...input.defaults
  };

  return {
    chatId: input.chatId,
    content,
    defaults,
    expectedActiveLeafId: null,
    modelId: "fake-qsa",
    normalizedRequest: {
      attachmentIds: input.attachmentIds ?? [],
      chatId: input.chatId,
      content,
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      modelId: "fake-qsa",
      params: {},
      prompt: {
        developer: null,
        system: null
      },
      provider: "fake",
      searchStrategy: "search-disabled"
    },
    provider: "fake",
    providerRequestPreview: {},
    userId: input.userId
  };
}

function createRegenerationInput(
  prepared: Parameters<RunRepository["createRun"]>[0],
  userMessageId: string
): Parameters<RunRepository["createRegenerationRun"]>[0] {
  return {
    chatId: prepared.chatId,
    defaults: prepared.defaults,
    modelId: prepared.modelId,
    normalizedRequest: prepared.normalizedRequest,
    provider: prepared.provider,
    providerRequestPreview: prepared.providerRequestPreview,
    userId: prepared.userId,
    userMessageId
  };
}

function chatGraph(chatId: string) {
  return prisma.chat.findUniqueOrThrow({
    select: {
      _count: {
        select: {
          messages: true,
          modelRuns: true
        }
      },
      activeLeafMessageId: true,
      title: true
    },
    where: {
      id: chatId
    }
  });
}

function storedDefaults(userId: string) {
  return prisma.userSettings.findUnique({
    select: {
      defaultControlValues: true,
      defaultProviderModelId: true,
      defaultSearchPlan: true,
      defaultSearchStrategyId: true
    },
    where: {
      userId
    }
  });
}

async function createActiveRun(repository: RunRepository, userId: string, title: string) {
  const chat = await prisma.chat.create({
    data: {
      defaultProviderModelId: providerTemplateIds.fakeModel,
      title,
      userId
    }
  });
  const created = await repository.createRun(
    createRunInput({
      chatId: chat.id,
      question: title,
      userId
    })
  );

  return {
    assistantMessageId: created.assistantMessageId,
    chatId: chat.id,
    runId: created.runId,
    userId
  };
}

async function createRecoverableFreshProviderRound(
  repository: RunRepository,
  userId: string,
  title: string
) {
  const created = await createActiveRun(repository, userId, title);
  await expect(repository.beginToolLoopProviderRound({
    providerContinuation: { responseId: "response-before-tools" },
    roundIndex: 0,
    runId: created.runId,
    userId
  })).resolves.toBe("started");
  const persisted = await repository.persistToolLoopCallBatch({
    calls: [{ arguments: {}, ordinal: 0, providerCallId: "call-1", toolName: "lookup" }],
    providerContinuation: { responseId: "response-before-tools" },
    roundIndex: 0,
    runId: created.runId,
    userId
  });
  if (persisted.kind !== "persisted") throw new Error("expected persisted recovery batch");
  const claimed = await repository.claimToolLoopCall({
    callId: persisted.calls[0]!.id,
    runId: created.runId,
    userId
  });
  if (claimed.kind !== "claimed") throw new Error("expected claimed recovery call");
  await expect(repository.settleToolLoopCall({
    callId: claimed.call.id,
    result: { output: "settled" },
    runId: created.runId,
    state: "complete",
    userId
  })).resolves.toBe("settled");
  await expect(repository.failRun(
    created.runId,
    created.assistantMessageId,
    { code: "recoverable_failure", message: "Resume the saved tool loop" }
  )).resolves.toBe(true);
  await expect(repository.advanceToolLoopCallBatch({
    roundIndex: 0,
    runId: created.runId,
    userId
  })).resolves.toBe("advanced");

  return created;
}

function completionInput(input: {
  assistantMessageId: string;
  chatId: string;
  runId: string;
  userId: string;
}): Parameters<RunRepository["completeRun"]>[0] {
  return {
    ...input,
    estimatedCostMicros: 17,
    finalProviderResponsePreview: {},
    finalText: "Completed answer",
    modelId: "fake-qsa",
    provider: "fake",
    usage: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 6
    }
  };
}

async function terminalState(input: {
  assistantMessageId: string;
  chatId: string;
  runId: string;
}) {
  const [run, message, usageCount, chat] = await Promise.all([
    prisma.modelRun.findUniqueOrThrow({
      select: {
        errorPayload: true,
        status: true
      },
      where: {
        id: input.runId
      }
    }),
    prisma.message.findUniqueOrThrow({
      select: {
        errorMessage: true,
        status: true
      },
      where: {
        id: input.assistantMessageId
      }
    }),
    prisma.usageEvent.count({
      where: {
        modelRunId: input.runId
      }
    }),
    prisma.chat.findUniqueOrThrow({
      select: {
        totalInputTokens: true,
        totalOutputTokens: true,
        totalReasoningTokens: true
      },
      where: {
        id: input.chatId
      }
    })
  ]);

  return { chat, message, run, usageCount };
}

async function expectTerminalState(
  input: Parameters<typeof terminalState>[0],
  status: "cancelled" | "complete"
) {
  const state = await terminalState(input);
  const complete = status === "complete";

  expect(state).toMatchObject({
    chat: {
      totalInputTokens: complete ? 2 : 0,
      totalOutputTokens: complete ? 3 : 0,
      totalReasoningTokens: complete ? 1 : 0
    },
    message: { status },
    run: { status },
    usageCount: complete ? 1 : 0
  });

  return state;
}

const cancelPayload = {
  code: "model_run_cancelled",
  message: "Model run cancelled"
};

describe("Prisma run repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("serializes a missing chat default as a paired null run update", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          title: "Run update without a chat default",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Question"),
          role: "user"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Answer"),
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: assistantMessage.id },
        where: { id: chat.id }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: chat.id,
          inputTokens: 8,
          modelId: "fake-qsa",
          normalizedRequest: {},
          outputTokens: 5,
          provider: "fake",
          providerRequestPreview: {},
          reasoningTokens: 0,
          status: "complete",
          totalTokens: 0,
          userId,
          userMessageId: userMessage.id
        }
      });

      const update = await createPrismaRunRepository(prisma).getChatUpdateForRun({
        assistantMessageId: assistantMessage.id,
        chatId: chat.id,
        userId,
        userMessageId: userMessage.id
      });

      expect(update?.chat).toMatchObject({
        contextStats: {
          approximateActiveBranchInputTokens: expect.any(Number)
        },
        defaultModelId: null,
        defaultProvider: null,
        id: chat.id,
        messageCount: 2
      });
      expect(update?.chat.contextStats.approximateActiveBranchInputTokens).toBeGreaterThan(0);
      expect(update?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: assistantMessage.id,
          runUsage: { totalTokens: 13 }
        })
      ]));
    });
  });

  it("checkpoints tool batches before dispatch and resumes every call state deterministically", async () => {
    await withRunUser(async ({ userId }) => {
      await prisma.user.update({ data: { status: "active" }, where: { id: userId } });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Durable tool loop",
          userId
        }
      });
      const fixture = await createReadyMcpBinding(userId);
      try {
        const repository = createPrismaRunRepository(prisma);
        const runInput = createRunInput({
          chatId: chat.id,
          question: "Checkpoint these calls",
          userId
        });
        runInput.mcpBindings = [fixture.binding];
        const created = await repository.createRun(runInput);

        await expect(repository.beginToolLoopProviderRound({
          providerContinuation: { responseId: "response-1" },
          providerCursor: "cursor-1",
          roundIndex: 0,
          runId: created.runId,
          userId
        })).resolves.toBe("started");
        const batchInput: Parameters<RunRepository["persistToolLoopCallBatch"]>[0] = {
          calls: [
            {
              arguments: { query: "first" },
              ordinal: 0,
              providerCallId: "call-1",
              runtimeGenerationFingerprint: fixture.binding.fingerprint,
              toolName: "echo"
            },
            {
              arguments: { query: "second" },
              ordinal: 1,
              providerCallId: "call-2",
              toolName: "local_search"
            }
          ],
          providerContinuation: { responseId: "response-1" },
          providerCursor: "cursor-1",
          roundIndex: 0,
          runId: created.runId,
          userId
        };
        const persisted = await repository.persistToolLoopCallBatch(batchInput);
        expect(persisted.kind).toBe("persisted");
        if (persisted.kind !== "persisted") throw new Error("expected persisted tool batch");
        await expect(repository.persistToolLoopCallBatch(batchInput)).resolves.toMatchObject({
          kind: "reused"
        });
        await expect(prisma.modelRunToolCall.findMany({
          orderBy: { ordinal: "asc" },
          select: { mcpRunBindingId: true, state: true },
          where: { modelRunId: created.runId }
        })).resolves.toEqual([
          { mcpRunBindingId: expect.any(String), state: "pending" },
          { mcpRunBindingId: null, state: "pending" }
        ]);

        await repository.appendAssistantText(created.assistantMessageId, "discarded draft");
        await expect(repository.resetToolLoopAssistantDraft({
          roundIndex: 0,
          runId: created.runId,
          sequence: 0,
          userId
        })).resolves.toBe(true);
        await expect(prisma.message.findUniqueOrThrow({
          select: { content: true },
          where: { id: created.assistantMessageId }
        })).resolves.toMatchObject({ content: textMessageContent("") });

        const firstClaim = await repository.claimToolLoopCall({
          callId: persisted.calls[0]!.id,
          runId: created.runId,
          userId
        });
        expect(firstClaim.kind).toBe("claimed");
        await expect(repository.claimToolLoopCall({
          callId: persisted.calls[0]!.id,
          runId: created.runId,
          userId
        })).resolves.toMatchObject({ kind: "ambiguous" });
        await expect(repository.settleToolLoopCall({
          callId: persisted.calls[0]!.id,
          result: { content: "first result" },
          runId: created.runId,
          state: "complete",
          userId
        })).resolves.toBe("settled");
        await expect(repository.settleToolLoopCall({
          callId: persisted.calls[0]!.id,
          result: { content: "first result" },
          runId: created.runId,
          state: "complete",
          userId
        })).resolves.toBe("reused");

        await expect(repository.claimToolLoopCall({
          callId: persisted.calls[1]!.id,
          runId: created.runId,
          userId
        })).resolves.toMatchObject({ kind: "claimed" });
        await expect(repository.settleToolLoopCall({
          callId: persisted.calls[1]!.id,
          result: { code: "tool_failed" },
          runId: created.runId,
          state: "error",
          userId
        })).resolves.toBe("settled");
        await expect(repository.advanceToolLoopCallBatch({
          roundIndex: 0,
          runId: created.runId,
          userId
        })).resolves.toBe("advanced");

        await expect(repository.loadCheckpointedToolLoopRun({
          runId: created.runId,
          userId
        })).resolves.toMatchObject({
          assistantText: "",
          calls: [
            { providerCallId: "call-1", state: "complete" },
            { providerCallId: "call-2", state: "error" }
          ],
          checkpoint: {
            phase: "provider_running",
            providerContinuation: { responseId: "response-1" },
            providerCursor: "cursor-1",
            roundIndex: 1,
            version: 2
          }
        });
        await expect(prisma.modelRunEvent.findMany({
          select: { eventType: true, payload: true, sequence: true },
          where: { modelRunId: created.runId }
        })).resolves.toEqual([{
          eventType: "message_reset",
          payload: { round: 0 },
          sequence: 0
        }]);
      } finally {
        await deleteMcpFixture(fixture.server.id);
      }
    });
  });

  it("atomically cancels pending checkpointed calls while preserving ambiguous running calls", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Cancel checkpointed calls");
      await repository.beginToolLoopProviderRound({
        providerContinuation: null,
        roundIndex: 0,
        runId: created.runId,
        userId
      });
      const persisted = await repository.persistToolLoopCallBatch({
        calls: [
          { arguments: {}, ordinal: 0, providerCallId: "running", toolName: "first" },
          { arguments: {}, ordinal: 1, providerCallId: "pending", toolName: "second" }
        ],
        providerContinuation: null,
        roundIndex: 0,
        runId: created.runId,
        userId
      });
      if (persisted.kind !== "persisted") throw new Error("expected persisted tool batch");
      await repository.claimToolLoopCall({
        callId: persisted.calls[0]!.id,
        runId: created.runId,
        userId
      });

      await expect(repository.cancelRun({
        payload: cancelPayload,
        runId: created.runId,
        userId
      })).resolves.toMatchObject({ kind: "cancelled" });
      await expect(prisma.modelRunToolCall.findMany({
        orderBy: { ordinal: "asc" },
        select: { state: true },
        where: { modelRunId: created.runId }
      })).resolves.toEqual([{ state: "running" }, { state: "cancelled" }]);
      await expect(repository.claimToolLoopCall({
        callId: persisted.calls[0]!.id,
        runId: created.runId,
        userId
      })).resolves.toMatchObject({ kind: "ambiguous" });
    });
  });

  it("cancels pending checkpointed calls when a run fails while preserving ambiguous running calls", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Fail checkpointed calls");
      await repository.beginToolLoopProviderRound({
        providerContinuation: null,
        roundIndex: 0,
        runId: created.runId,
        userId
      });
      const persisted = await repository.persistToolLoopCallBatch({
        calls: [
          { arguments: {}, ordinal: 0, providerCallId: "running", toolName: "first" },
          { arguments: {}, ordinal: 1, providerCallId: "pending", toolName: "second" }
        ],
        providerContinuation: null,
        roundIndex: 0,
        runId: created.runId,
        userId
      });
      if (persisted.kind !== "persisted") throw new Error("expected persisted tool batch");
      await repository.claimToolLoopCall({
        callId: persisted.calls[0]!.id,
        runId: created.runId,
        userId
      });

      await expect(repository.failRun(created.runId, created.assistantMessageId, {
        code: "tool_loop_checkpoint_failed",
        message: "Tool-loop persistence failed"
      })).resolves.toBe(true);
      await expect(prisma.modelRunToolCall.findMany({
        orderBy: { ordinal: "asc" },
        select: { completedAt: true, startedAt: true, state: true },
        where: { modelRunId: created.runId }
      })).resolves.toEqual([
        { completedAt: null, startedAt: expect.any(Date), state: "running" },
        { completedAt: expect.any(Date), startedAt: null, state: "cancelled" }
      ]);
      await expect(repository.getRunControlForUser(created.runId, userId)).resolves.toMatchObject({
        status: "error"
      });
    });
  });

  it("marks a foreground safety failure terminal for recovery without exposing the marker", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Terminal stream safety failure");
      await repository.appendAssistantText(created.assistantMessageId, "durable partial");

      await expect(repository.failRun(
        created.runId,
        created.assistantMessageId,
        {
          code: "provider_stream_too_large",
          message: "The provider stream exceeded a safety limit."
        },
        { recoveryTerminal: true }
      )).resolves.toBe(true);

      await expect(repository.getRunControlForUser(created.runId, userId)).resolves.toMatchObject({
        recoverySettled: true,
        status: "error"
      });
      await expect(prisma.modelRun.findUnique({
        select: { errorPayload: true },
        where: { id: created.runId }
      })).resolves.toMatchObject({
        errorPayload: {
          code: "provider_stream_too_large",
          message: "The provider stream exceeded a safety limit.",
          recoveryTerminal: true
        }
      });
      await expect(prisma.message.findUnique({
        select: { content: true, errorMessage: true },
        where: { id: created.assistantMessageId }
      })).resolves.toMatchObject({
        content: textMessageContent("durable partial"),
        errorMessage: "The provider stream exceeded a safety limit."
      });
      await expect(prisma.modelRunEvent.findFirst({
        orderBy: { sequence: "desc" },
        select: { payload: true },
        where: { eventType: "error", modelRunId: created.runId }
      })).resolves.toEqual({
        payload: {
          code: "provider_stream_too_large",
          message: "The provider stream exceeded a safety limit."
        }
      });
      await expect(repository.completeRun(completionInput(created))).resolves.toBe(false);
    });
  });

  it("allows recovery to extend partial text while preserving an errored message status", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Refreshable partial recovery");
      await repository.appendAssistantText(created.assistantMessageId, "durable ");
      await repository.failRun(created.runId, created.assistantMessageId, {
        code: "provider_stream_failed",
        message: "Transient provider failure"
      });

      await repository.appendAssistantText(
        created.assistantMessageId,
        "durable recovered",
        { allowErrored: true }
      );

      await expect(prisma.message.findUnique({
        select: { content: true, status: true },
        where: { id: created.assistantMessageId }
      })).resolves.toEqual({
        content: textMessageContent("durable recovered"),
        status: "error"
      });
      await expect(repository.getRunControlForUser(created.runId, userId)).resolves.toMatchObject({
        recoverySettled: false,
        status: "error"
      });
    });
  });

  it("atomically binds the exact ready MCP generation for sends and regenerations", async () => {
    await withRunUser(async ({ userId }) => {
      await prisma.user.update({ data: { status: "active" }, where: { id: userId } });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "MCP acceptance",
          userId
        }
      });
      const fixture = await createReadyMcpBinding(userId);
      try {
        const repository = createPrismaRunRepository(prisma);
        const sendInput = createRunInput({
          chatId: chat.id,
          question: "Use the exact MCP generation",
          userId
        });
        sendInput.mcpBindings = [fixture.binding];
        const sent = await repository.createRun(sendInput);

        await expect(prisma.mcpRunBinding.findMany({
          select: {
            modelRunId: true,
            runtimeGenerationFingerprint: true,
            runtimeGenerationId: true
          },
          where: { modelRunId: sent.runId }
        })).resolves.toEqual([{
          modelRunId: sent.runId,
          runtimeGenerationFingerprint: fixture.binding.fingerprint,
          runtimeGenerationId: fixture.binding.runtimeGenerationId
        }]);

        await prisma.modelRun.update({ data: { status: "complete" }, where: { id: sent.runId } });
        const regenerationInput = createRegenerationInput(sendInput, sent.userMessageId);
        regenerationInput.mcpBindings = [fixture.binding];
        const regenerated = await repository.createRegenerationRun(regenerationInput);

        await expect(prisma.mcpRunBinding.findMany({
          orderBy: { modelRunId: "asc" },
          select: { modelRunId: true, runtimeGenerationId: true },
          where: { modelRunId: { in: [sent.runId, regenerated.runId] } }
        })).resolves.toEqual([
          { modelRunId: sent.runId, runtimeGenerationId: fixture.binding.runtimeGenerationId },
          { modelRunId: regenerated.runId, runtimeGenerationId: fixture.binding.runtimeGenerationId }
        ].sort((left, right) => left.modelRunId.localeCompare(right.modelRunId)));
      } finally {
        await deleteMcpFixture(fixture.server.id);
      }
    });
  });

  it("restores a no-longer-desired generation only while an active run still binds it", async () => {
    await withRunUser(async ({ userId }) => {
      await prisma.user.update({ data: { status: "active" }, where: { id: userId } });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Accepted generation recovery",
          userId
        }
      });
      const fixture = await createReadyMcpBinding(userId);
      try {
        const runs = createPrismaRunRepository(prisma);
        const input = createRunInput({
          chatId: chat.id,
          question: "Keep the accepted generation",
          userId
        });
        input.mcpBindings = [fixture.binding];
        const created = await runs.createRun(input);
        await prisma.mcpUserServer.update({
          data: { desiredRuntimeGenerationId: null, enabled: false },
          where: { id: fixture.preference.id }
        });
        await prisma.mcpServer.update({
          data: { activeRevisionId: null, enabled: false },
          where: { id: fixture.server.id }
        });
        const runtime = createPrismaMcpRuntimeRepository({
          encryptionKey: () => TEST_MCP_KEY,
          prisma
        });
        const now = new Date("2026-07-22T20:00:00.000Z");

        await expect(runtime.loadAcceptedGeneration(fixture.generation.id, now)).resolves.toMatchObject({
          fingerprint: fixture.generation.fingerprint,
          generationId: fixture.generation.id,
          headers: {},
          url: "https://mcp.example.test/rpc"
        });
        await expect(runtime.markStarting({
          fingerprint: fixture.generation.fingerprint,
          generationId: fixture.generation.id,
          now
        })).resolves.toBe(true);
        await expect(runtime.markReady({
          fingerprint: fixture.generation.fingerprint,
          generationId: fixture.generation.id,
          inventory: { tools: [], version: 1 },
          now
        })).resolves.toBe(true);

        await prisma.modelRun.update({ data: { status: "complete" }, where: { id: created.runId } });
        await expect(runtime.loadAcceptedGeneration(fixture.generation.id, now)).resolves.toBeNull();
        await expect(runtime.markStarting({
          fingerprint: fixture.generation.fingerprint,
          generationId: fixture.generation.id,
          now
        })).resolves.toBe(false);
      } finally {
        await deleteMcpFixture(fixture.server.id);
      }
    });
  });

  it("rolls back the complete run graph when an MCP binding loses eligibility before acceptance", async () => {
    await withRunUser(async ({ userId }) => {
      await prisma.user.update({ data: { status: "active" }, where: { id: userId } });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "MCP race rollback",
          userId
        }
      });
      const fixture = await createReadyMcpBinding(userId);
      try {
        const repository = createPrismaRunRepository(prisma);
        const priorControlValues = { "other:model": { temperature: "0.5" } };
        await prisma.userSettings.update({
          data: { defaultControlValues: priorControlValues },
          where: { userId }
        });
        const sendInput = createRunInput({
          chatId: chat.id,
          defaults: { controlDefaults: { temperature: "0.2" } },
          question: "This graph must roll back",
          userId
        });
        sendInput.mcpBindings = [fixture.binding];
        await prisma.mcpUserServer.update({
          data: { enabled: false },
          where: { id: fixture.preference.id }
        });

        await expect(repository.createRun(sendInput)).rejects.toBeInstanceOf(McpRunPlanConflictError);
        await expect(chatGraph(chat.id)).resolves.toEqual({
          _count: { messages: 0, modelRuns: 0 },
          activeLeafMessageId: null,
          title: "MCP race rollback"
        });
        await expect(prisma.mcpRunBinding.count({
          where: { runtimeGenerationId: fixture.generation.id }
        })).resolves.toBe(0);
        // The failed acceptance must leave previously stored defaults intact.
        await expect(storedDefaults(userId)).resolves.toMatchObject({
          defaultControlValues: priorControlValues
        });
      } finally {
        await deleteMcpFixture(fixture.server.id);
      }
    });
  });

  it("loads only the selected ancestor path in root-to-leaf order", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Branched context",
          userId
        }
      });
      const root = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Root"),
          role: "user",
          status: "complete"
        }
      });
      const ignoredRole = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Tool trace"),
          parentMessageId: root.id,
          role: "tool",
          status: "complete"
        }
      });
      const ignoredStatus = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Failed answer"),
          parentMessageId: ignoredRole.id,
          role: "assistant",
          status: "error"
        }
      });
      const activeLeaf = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Active leaf"),
          parentMessageId: ignoredStatus.id,
          role: "assistant",
          status: "streaming"
        }
      });
      const sibling = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Sibling"),
          parentMessageId: root.id,
          role: "assistant",
          status: "complete"
        }
      });
      const siblingLeaf = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Sibling leaf"),
          parentMessageId: sibling.id,
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: activeLeaf.id
        },
        where: {
          id: chat.id
        }
      });
      const repository = createPrismaRunRepository(prisma);

      await expect(repository.loadConversationContext(chat.id, userId)).resolves.toMatchObject([
        { id: root.id, role: "user" },
        { id: activeLeaf.id, role: "assistant" }
      ]);
      await expect(
        repository.loadConversationContextForExpectedLeaf(chat.id, userId, activeLeaf.id)
      ).resolves.toMatchObject([
        { id: root.id, role: "user" },
        { id: activeLeaf.id, role: "assistant" }
      ]);
      await expect(
        repository.loadConversationContextForExpectedLeaf(chat.id, userId, siblingLeaf.id)
      ).resolves.toBeNull();
      await expect(
        repository.loadConversationContextForLeaf(chat.id, userId, siblingLeaf.id)
      ).resolves.toMatchObject([
        { id: root.id, role: "user" },
        { id: sibling.id, role: "assistant" },
        { id: siblingLeaf.id, role: "user" }
      ]);
    });
  });

  it("preserves missing, unowned, archived, and empty-chat context contracts", async () => {
    await withRunUser(async ({ userId }) => {
      await withRunUser(async ({ userId: otherUserId }) => {
        const [emptyChat, archivedChat, otherChat] = await Promise.all([
          prisma.chat.create({
            data: {
              defaultProviderModelId: providerTemplateIds.fakeModel,
              title: "Empty context",
              userId
            }
          }),
          prisma.chat.create({
            data: {
              archived: true,
              defaultProviderModelId: providerTemplateIds.fakeModel,
              title: "Archived context",
              userId
            }
          }),
          prisma.chat.create({
            data: {
              defaultProviderModelId: providerTemplateIds.fakeModel,
              title: "Foreign context",
              userId: otherUserId
            }
          })
        ]);
        const repository = createPrismaRunRepository(prisma);
        const missingChatId = randomUUID();
        const missingLeafId = randomUUID();

        await expect(repository.loadConversationContext(emptyChat.id, userId)).resolves.toEqual([]);
        await expect(
          repository.loadConversationContextForExpectedLeaf(emptyChat.id, userId, null)
        ).resolves.toEqual([]);
        await expect(
          repository.loadConversationContextForExpectedLeaf(emptyChat.id, userId, missingLeafId)
        ).resolves.toBeNull();
        await expect(
          repository.loadConversationContextForLeaf(emptyChat.id, userId, missingLeafId)
        ).resolves.toEqual([]);

        for (const unavailableChatId of [missingChatId, archivedChat.id, otherChat.id]) {
          await expect(repository.loadConversationContext(unavailableChatId, userId)).resolves.toEqual([]);
          await expect(
            repository.loadConversationContextForExpectedLeaf(unavailableChatId, userId, null)
          ).resolves.toBeNull();
          await expect(
            repository.loadConversationContextForLeaf(unavailableChatId, userId, missingLeafId)
          ).resolves.toEqual([]);
        }
      });
    });
  });

  it("terminates an ancestor query when malformed parentage contains a cycle", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Cyclic context",
          userId
        }
      });
      const first = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("First"),
          role: "user",
          status: "complete"
        }
      });
      const second = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Second"),
          parentMessageId: first.id,
          role: "assistant",
          status: "complete"
        }
      });

      try {
        await prisma.message.update({
          data: {
            parentMessageId: second.id
          },
          where: {
            id: first.id
          }
        });
        await prisma.chat.update({
          data: {
            activeLeafMessageId: first.id
          },
          where: {
            id: chat.id
          }
        });

        const repository = createPrismaRunRepository(prisma);
        await expect(repository.loadConversationContext(chat.id, userId)).resolves.toMatchObject([
          { id: second.id, role: "assistant" },
          { id: first.id, role: "user" }
        ]);
      } finally {
        await prisma.message.update({
          data: {
            parentMessageId: null
          },
          where: {
            id: first.id
          }
        });
      }
    });
  });

  it("loads capabilities only for enabled provider-model catalog rows", async () => {
    const provider = `repo-test-${randomUUID()}`;
    const enabledModelId = "enabled-model";
    const disabledModelId = "disabled-model";
    const connection = await prisma.providerConnection.create({
      data: {
        displayName: provider,
        family: provider,
        id: provider
      }
    });
    await prisma.providerModel.createMany({
      data: [
        {
          capabilities: {
            streaming: true
          },
          connectionId: connection.id,
          contextWindow: 12345,
          defaultParams: {
            maxOutputTokens: 512
          },
          displayName: "Enabled Model",
          enabled: true,
          modelId: enabledModelId,
          provider,
          supportsNativeSearch: true,
          supportsPdf: true,
          supportsReasoning: true,
          supportsVision: true
        },
        {
          capabilities: {
            streaming: true
          },
          connectionId: connection.id,
          contextWindow: 12345,
          defaultParams: {},
          displayName: "Disabled Model",
          enabled: false,
          modelId: disabledModelId,
          provider,
          supportsNativeSearch: true,
          supportsPdf: true,
          supportsReasoning: true,
          supportsVision: true
        }
      ]
    });

    try {
      const repository = createPrismaRunRepository(prisma);

      await expect(repository.loadModelConfiguration(provider, enabledModelId)).resolves.toMatchObject({
        capabilities: {
          contextWindow: 12345,
          defaultMaxOutputTokens: 512,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          streaming: true,
          vision: true
        },
        defaultParams: {
          maxOutputTokens: 512
        }
      });
      await expect(repository.loadModelConfiguration(provider, disabledModelId)).resolves.toBeNull();
      await expect(repository.loadModelConfiguration(provider, "unknown-model")).resolves.toBeNull();
    } finally {
      await prisma.providerModel.deleteMany({
        where: {
          provider
        }
      });
      await prisma.providerConnection.delete({ where: { id: connection.id } });
    }
  });

  it("fails closed when historical provider and model identities have ambiguous pricing", async () => {
    const provider = `repo-pricing-${randomUUID()}`;
    const modelId = "shared-model";
    const connectionIds = [`${provider}-first`, `${provider}-second`];
    const modelIds = [`${provider}-model-first`, `${provider}-model-second`];

    await prisma.providerConnection.createMany({
      data: connectionIds.map((id, index) => ({
        displayName: `Pricing connection ${index + 1}`,
        family: provider,
        id
      }))
    });
    await prisma.providerModel.create({
      data: {
        capabilities: {},
        connectionId: connectionIds[0],
        contextWindow: 4096,
        defaultParams: {},
        displayName: "First pricing model",
        id: modelIds[0],
        inputTokenPriceMicros: 11,
        modelId,
        outputTokenPriceMicros: 12,
        provider
      }
    });

    try {
      const repository = createPrismaRunRepository(prisma);

      await expect(repository.loadModelPricing(provider, modelId)).resolves.toEqual({
        inputTokenPriceMicros: 11,
        outputTokenPriceMicros: 12
      });

      await prisma.providerModel.create({
        data: {
          capabilities: {},
          connectionId: connectionIds[1],
          contextWindow: 4096,
          defaultParams: {},
          displayName: "Second pricing model",
          id: modelIds[1],
          inputTokenPriceMicros: 21,
          modelId,
          outputTokenPriceMicros: 22,
          provider
        }
      });

      await expect(repository.loadModelPricing(provider, modelId)).resolves.toBeNull();
    } finally {
      await prisma.providerModel.deleteMany({
        where: { id: { in: modelIds } }
      });
      await prisma.providerConnection.deleteMany({
        where: { id: { in: connectionIds } }
      });
    }
  });

  it("loads only enabled concrete search strategies for run admission", async () => {
    const enabledStrategyId = `repo-test-enabled-${randomUUID()}`;
    const disabledStrategyId = `repo-test-disabled-${randomUUID()}`;
    const searchOptionId = `repo-test-option-row-${randomUUID()}`;
    const sourceConnectionId = `repo-test-option-source-${randomUUID()}`;
    try {
      await prisma.providerConnection.create({
        data: {
          displayName: "Run repository Search fixture source",
          family: "run_repository_search_fixture",
          id: sourceConnectionId
        }
      });
      await prisma.searchOption.create({
        data: {
          description: "Run repository Search fixture.",
          displayName: "Run repository Search fixture",
          id: searchOptionId,
          kind: "web_search",
          optionId: `repo-test-option-${randomUUID()}`,
          sourceConnectionId
        }
      });
      await prisma.searchStrategy.createMany({
        data: [
          {
            config: { policy: "server-owned" },
            description: "Enabled run admission fixture",
            displayName: "Enabled run admission fixture",
            kind: "openai_native_web_search",
            modelId: "fixture-search-model",
            provider: "system",
            searchOptionId,
            strategyId: enabledStrategyId
          },
          {
            config: {},
            description: "Disabled run admission fixture",
            displayName: "Disabled run admission fixture",
            adapterKind: "provider_model_client",
            credentialMode: "provider_model",
            enabled: false,
            kind: "openai_native_web_search",
            provider: "system",
            searchOptionId,
            strategyId: disabledStrategyId
          }
        ]
      });

      const repository = createPrismaRunRepository(prisma);

      await expect(repository.isSearchStrategyEnabled(enabledStrategyId)).resolves.toBe(true);
      await expect(repository.isSearchStrategyEnabled(disabledStrategyId)).resolves.toBe(false);
      await expect(repository.isSearchStrategyEnabled(`missing-${randomUUID()}`)).resolves.toBe(false);
      await expect(
        repository.loadSearchStrategyConfiguration(enabledStrategyId)
      ).resolves.toEqual({
        config: { policy: "server-owned" },
        kind: "openai_native_web_search",
        modelId: "fixture-search-model",
        provider: "system",
        strategyId: enabledStrategyId
      });
      await expect(
        repository.loadSearchStrategyConfiguration(disabledStrategyId)
      ).resolves.toBeNull();
      await expect(
        repository.loadSearchStrategyConfiguration(`missing-${randomUUID()}`)
      ).resolves.toBeNull();
    } finally {
      await prisma.searchStrategy.deleteMany({
        where: {
          strategyId: {
            in: [enabledStrategyId, disabledStrategyId]
          }
        }
      });
      await prisma.searchOption.deleteMany({ where: { id: searchOptionId } });
      await prisma.providerConnection.deleteMany({ where: { id: sourceConnectionId } });
    }
  });

  it("rejects run creation when the active leaf changed after context preparation", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Branch conflict",
          userId
        }
      });
      const originalLeaf = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Original branch"),
          role: "user",
          status: "complete"
        }
      });
      const selectedLeaf = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Selected branch"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: originalLeaf.id
        },
        where: {
          id: chat.id
        }
      });

      const repository = createPrismaRunRepository(prisma);
      const prepared = createRunInput({
        chatId: chat.id,
        question: "Must stay on original branch",
        userId
      });
      prepared.expectedActiveLeafId = originalLeaf.id;
      await prisma.chat.update({
        data: {
          activeLeafMessageId: selectedLeaf.id
        },
        where: {
          id: chat.id
        }
      });

      await expect(repository.createRun(prepared)).rejects.toBeInstanceOf(ActiveLeafConflictError);
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: {
            _count: {
              select: {
                messages: true,
                modelRuns: true
              }
            },
            activeLeafMessageId: true
          },
          where: {
            id: chat.id
          }
        })
      ).resolves.toEqual({
        _count: {
          messages: 2,
          modelRuns: 0
        },
        activeLeafMessageId: selectedLeaf.id
      });
    });
  });

  it("rolls back a run when an attachment was linked after preparation", async () => {
    await withRunUser(async ({ userId }) => {
      const [targetChat, otherChat] = await Promise.all([
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Attachment target",
            userId
          }
        }),
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Attachment winner",
            userId
          }
        })
      ]);
      const otherMessage = await prisma.message.create({
        data: {
          chatId: otherChat.id,
          content: textMessageContent("Already linked"),
          role: "user",
          status: "complete"
        }
      });
      const attachment = await prisma.attachment.create({
        data: {
          byteSize: 12,
          chatId: otherChat.id,
          extractedText: "private text",
          fileName: "race.txt",
          kind: "document",
          messageId: otherMessage.id,
          metadata: {},
          mimeType: "text/plain",
          status: "ready",
          storageKey: `${userId}/attachment-race-${randomUUID()}`,
          userId
        }
      });
      const prepared = createRunInput({
        attachmentIds: [attachment.id],
        chatId: targetChat.id,
        question: "Use the raced attachment",
        userId
      });
      const repository = createPrismaRunRepository(prisma);

      await expect(repository.createRun(prepared)).rejects.toBeInstanceOf(AttachmentLinkConflictError);
      await expect(chatGraph(targetChat.id)).resolves.toEqual({
        _count: { messages: 0, modelRuns: 0 },
        activeLeafMessageId: null,
        title: "Attachment target"
      });
      await expect(
        prisma.attachment.findUniqueOrThrow({
          select: { chatId: true, messageId: true },
          where: { id: attachment.id }
        })
      ).resolves.toEqual({
        chatId: otherChat.id,
        messageId: otherMessage.id
      });
    });
  });

  it("commits run graphs and preferred Search defaults atomically", async () => {
    await withRunUser(async ({ userId }) => {
      await prisma.userSettings.update({
        data: {
          defaultControlValues: {
            [fakeControlKey]: {
              maxOutputTokens: "1024"
            },
            "other:model": {
              temperature: "0.4"
            }
          }
        },
        where: {
          userId
        }
      });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "New Chat",
          userId
        }
      });
      const repository = createPrismaRunRepository(prisma);
      const sendInput = createRunInput({
        chatId: chat.id,
        defaults: {
          controlDefaults: {
            temperature: "0.2"
          },
          searchPreferencePlan: {
            mode: "model_choice",
            optionIds: ["company-search", "secondary-search"]
          }
        },
        question: "Atomic defaults",
        userId
      });
      const sent = await repository.createRun(sendInput);

      const [afterSend, afterSendChat] = await Promise.all([
        storedDefaults(userId),
        chatGraph(chat.id)
      ]);

      expect(afterSend).toMatchObject({
        defaultControlValues: {
          [fakeControlKey]: {
            maxOutputTokens: "1024",
            temperature: "0.2"
          },
          "other:model": {
            temperature: "0.4"
          }
        },
        defaultSearchPlan: {
          mode: "model_choice",
          optionIds: ["company-search", "secondary-search"]
        },
        defaultSearchStrategyId: "company-search"
      });
      expect(afterSendChat).toEqual({
        _count: {
          messages: 2,
          modelRuns: 1
        },
        activeLeafMessageId: sent.assistantMessageId,
        title: "Atomic defaults"
      });
      await expect(
        prisma.message.findMany({
          orderBy: { createdAt: "asc" },
          select: { id: true },
          where: { chatId: chat.id }
        })
      ).resolves.toEqual([
        { id: sent.userMessageId },
        { id: sent.assistantMessageId }
      ]);

      await prisma.modelRun.update({
        data: {
          status: "complete"
        },
        where: {
          id: sent.runId
        }
      });
      const regenerationPrepared = createRunInput({
        chatId: chat.id,
        defaults: {
          controlDefaults: {
            reasoningEffort: "high"
          }
        },
        question: "Atomic defaults",
        userId
      });
      const regenerated = await repository.createRegenerationRun(
        createRegenerationInput(regenerationPrepared, sent.userMessageId)
      );

      const [afterRegeneration, afterRegenerationChat] = await Promise.all([
        storedDefaults(userId),
        chatGraph(chat.id)
      ]);

      expect(afterRegeneration).toMatchObject({
        defaultControlValues: {
          [fakeControlKey]: {
            maxOutputTokens: "1024",
            reasoningEffort: "high",
            temperature: "0.2"
          },
          "other:model": {
            temperature: "0.4"
          }
        },
        defaultSearchPlan: {
          mode: "model_choice",
          optionIds: ["company-search", "secondary-search"]
        },
        defaultSearchStrategyId: "company-search"
      });
      expect(afterRegenerationChat).toEqual({
        _count: {
          messages: 3,
          modelRuns: 2
        },
        activeLeafMessageId: regenerated.assistantMessageId,
        title: "Atomic defaults"
      });
    });
  });

  it("fails closed and rolls back run writes when the settings row is missing", async () => {
    await withRunUser(async ({ userId }) => {
      const [sendChat, regenerationChat] = await Promise.all([
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "New Chat",
            userId
          }
        }),
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Regeneration source",
            userId
          }
        })
      ]);
      const source = await prisma.message.create({
        data: {
          chatId: regenerationChat.id,
          content: textMessageContent("Source"),
          role: "user",
          status: "complete"
        }
      });
      const sourceAssistant = await prisma.message.create({
        data: {
          chatId: regenerationChat.id,
          content: textMessageContent("Existing answer"),
          parentMessageId: source.id,
          role: "assistant",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: sourceAssistant.id
        },
        where: {
          id: regenerationChat.id
        }
      });
      const attachment = await prisma.attachment.create({
        data: {
          byteSize: 7,
          fileName: "rollback.txt",
          kind: "text",
          metadata: {},
          mimeType: "text/plain",
          storageKey: `rollback/${randomUUID()}`,
          userId
        }
      });
      const repository = createPrismaRunRepository(prisma);
      await prisma.userSettings.delete({
        where: {
          userId
        }
      });
      const missingSettingsInput = createRunInput({
        attachmentIds: [attachment.id],
        chatId: sendChat.id,
        defaults: {
          controlDefaults: {
            temperature: "0.2"
          }
        },
        question: "Missing settings",
        userId
      });

      await expect(repository.createRun(missingSettingsInput)).rejects.toThrow(
        "Run defaults persistence failed: not_found"
      );
      const [sendAfter, attachmentAfter, defaultsAfter] = await Promise.all([
        chatGraph(sendChat.id),
        prisma.attachment.findUniqueOrThrow({
          select: {
            chatId: true,
            messageId: true
          },
          where: {
            id: attachment.id
          }
        }),
        storedDefaults(userId)
      ]);

      expect(sendAfter).toEqual({
        _count: {
          messages: 0,
          modelRuns: 0
        },
        activeLeafMessageId: null,
        title: "New Chat"
      });
      expect(attachmentAfter).toEqual({ chatId: null, messageId: null });
      expect(defaultsAfter).toBeNull();

      const regenerationPrepared = createRunInput({
        chatId: regenerationChat.id,
        question: "Source",
        userId
      });
      await expect(
        repository.createRegenerationRun({
          ...createRegenerationInput(regenerationPrepared, source.id),
          preSendAssistantMessageId: sourceAssistant.id
        })
      ).rejects.toThrow("Run defaults persistence failed: not_found");

      await expect(chatGraph(regenerationChat.id)).resolves.toEqual({
        _count: {
          messages: 2,
          modelRuns: 0
        },
        activeLeafMessageId: sourceAssistant.id,
        title: "Regeneration source"
      });
    });
  });

  it("preserves concurrent keyed settings patches while a run accepts defaults", async () => {
    await withRunUser(async ({ userId }) => {
      await prisma.userSettings.update({
        data: {
          defaultControlValues: {
            [fakeControlKey]: {
              maxOutputTokens: "1024"
            }
          }
        },
        where: {
          userId
        }
      });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Concurrent settings",
          userId
        }
      });
      const runRepository = createPrismaRunRepository(prisma);
      const settingsRepository = createPrismaSettingsRepository(prisma);
      let createPromise: ReturnType<RunRepository["createRun"]> | undefined;
      let patchPromise: ReturnType<typeof settingsRepository.updateSettings> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "UserSettings"
          WHERE "userId" = ${userId}
          FOR UPDATE
        `;
        patchPromise = settingsRepository.updateSettings(
          userId,
          {
            defaultControlValues: {
              "other:model": {
                reasoningEffort: "low"
              }
            },
            defaultProviderModelId: null
          },
          []
        );
        createPromise = runRepository.createRun(
          createRunInput({
            chatId: chat.id,
            defaults: {
              controlDefaults: {
                temperature: "0.2"
              }
            },
            question: "Serialize these defaults",
            userId
          })
        );
      });

      await expect(Promise.all([createPromise, patchPromise])).resolves.toEqual([
        expect.objectContaining({
          assistantMessageId: expect.any(String),
          runId: expect.any(String),
          userMessageId: expect.any(String)
        }),
        expect.objectContaining({
          kind: "updated"
        })
      ]);
      await expect(storedDefaults(userId)).resolves.toMatchObject({
        defaultControlValues: {
          [fakeControlKey]: {
            maxOutputTokens: "1024",
            temperature: "0.2"
          },
          "other:model": {
            reasoningEffort: "low"
          }
        },
        defaultProviderModelId: null
      });
    });
  });

  it("returns the ordered client projection only for the owning user", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Run projection chat",
          userId
        }
      });
      const repository = createPrismaRunRepository(prisma);
      const created = await repository.createRun(
        createRunInput({
          chatId: chat.id,
          question: "Inspect this run",
          userId
        })
      );
      await repository.appendRunEvent(created.runId, 2, {
        data: {
          artifactType: "summary",
          payload: {
            status: "streaming"
          }
        },
        type: "artifact"
      });
      await repository.appendRunEvent(created.runId, 1, {
        data: {
          delta: "First"
        },
        type: "token"
      });
      const startedAt = new Date("2026-07-23T12:00:00.000Z");
      await prisma.modelRunToolCall.create({
        data: {
          arguments: { apiKey: "sk-private-secret", query: "repository" },
          completedAt: new Date("2026-07-23T12:00:00.025Z"),
          modelRunId: created.runId,
          ordinal: 0,
          providerCallId: "call-repository",
          result: {
            callId: "call-repository",
            content: [{ text: "found", type: "text" }],
            name: "local_search",
            rawPreview: {
              finalProviderResponsePreview: {
                searchExecutions: [{
                  displayName: "Web Search · Sol",
                  durationMs: 145_800,
                  invocationId: "opaque-repository-invocation",
                  modelId: "gpt-5.6-sol",
                  optionId: "web-search-sol",
                  provider: "openai-compatible",
                  providerOperations: [{
                    id: "ws-1",
                    kind: "search",
                    ordinal: 0,
                    pattern: null,
                    queries: ["Moscow latest news"],
                    status: "complete",
                    url: null
                  }],
                  providerOperationsTruncated: false,
                  query: "latest news in Moscow",
                  revisionId: "revision-1",
                  sources: [{ title: "Moscow news", url: "https://example.com/moscow" }],
                  status: "complete",
                  usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
                }]
              }
            },
            status: "complete"
          },
          roundIndex: 1,
          startedAt,
          state: "complete",
          toolName: "local_search"
        }
      });

      const run = await repository.getRunForUser(created.runId, userId);

      expect(run).toMatchObject({
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        events: [
          {
            eventType: "memory_retrieval",
            payload: {
              degradationCode: null,
              itemCount: 0,
              outcome: "DISABLED"
            },
            sequence: 0
          },
          {
            eventType: "token",
            sequence: 1
          },
          {
            eventType: "artifact",
            sequence: 2
          }
        ],
        id: created.runId,
        inputTokens: 0,
        modelId: "fake-qsa",
        outputTokens: 0,
        provider: "fake",
        reasoningTokens: 0,
        searchRuns: [],
        status: "streaming",
        toolCalls: [{
          argumentsPreview: { apiKey: "[redacted]", query: "repository" },
          callId: "call-repository",
          capability: "web_search",
          durationMs: 25,
          resultPreview: { content: [{ text: "found", type: "text" }] },
          searchExecutions: [{
            displayName: "Web Search · Sol",
            providerOperations: [{
              kind: "search",
              queries: ["Moscow latest news"]
            }],
            query: "latest news in Moscow",
            sourceCount: 1
          }],
          serverName: null,
          status: "complete",
          toolName: "local_search"
        }],
        totalTokens: 0
      });
      expect(JSON.stringify(run?.toolCalls)).not.toContain("private-secret");
      expect(JSON.stringify(run?.toolCalls)).not.toContain("opaque-repository-invocation");
      await expect(repository.getRunForUser(created.runId, "other-user")).resolves.toBeNull();
    });
  });

  it("sets a bounded local title only for a placeholder chat's first run", async () => {
    await withRunUser(async ({ userId }) => {
      const [newChat, legacyPlaceholderChat, namedChat] = await Promise.all([
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "New Chat",
            userId
          }
        }),
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Untitled QSA",
            userId
          }
        }),
        prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Operator title",
            userId
          }
        })
      ]);
      const repository = createPrismaRunRepository(prisma);

      await Promise.all([
        repository.createRun(
          createRunInput({
            chatId: newChat.id,
            question: "  Explain\ntransaction   isolation  ",
            userId
          })
        ),
        repository.createRun(
          createRunInput({
            chatId: legacyPlaceholderChat.id,
            question: "Legacy placeholder gets a local title",
            userId
          })
        ),
        repository.createRun(
          createRunInput({
            chatId: namedChat.id,
            question: "This must not replace the chosen title",
            userId
          })
        )
      ]);

      const stored = await prisma.chat.findMany({
        orderBy: {
          title: "asc"
        },
        select: {
          id: true,
          title: true
        },
        where: {
          id: {
            in: [newChat.id, legacyPlaceholderChat.id, namedChat.id]
          }
        }
      });
      const titles = new Map(stored.map((chat) => [chat.id, chat.title]));

      expect(titles.get(newChat.id)).toBe("Explain transaction isolation");
      expect(titles.get(legacyPlaceholderChat.id)).toBe("Legacy placeholder gets a local title");
      expect(titles.get(namedChat.id)).toBe("Operator title");
    });
  });

  it("maps a second same-chat active run to the neutral conflict and rolls back its messages", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Run conflict chat",
          userId
        }
      });
      const originalMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Existing branch root"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: originalMessage.id
        },
        where: {
          id: chat.id
        }
      });
      const repository = createPrismaRunRepository(prisma);
      const firstInput = createRunInput({
        chatId: chat.id,
        question: "First active question",
        userId
      });
      firstInput.expectedActiveLeafId = originalMessage.id;
      const first = await repository.createRun(firstInput);

      const [beforeConflict, settingsBeforeConflict] = await Promise.all([
        chatGraph(chat.id),
        storedDefaults(userId)
      ]);

      expect(beforeConflict).toEqual({
        _count: {
          messages: 3,
          modelRuns: 1
        },
        activeLeafMessageId: first.assistantMessageId,
        title: "Run conflict chat"
      });
      const conflictingInput = createRunInput({
        chatId: chat.id,
        defaults: {
          controlDefaults: {
            reasoningEffort: "high"
          }
        },
        question: "Conflicting active question",
        userId
      });
      conflictingInput.expectedActiveLeafId = first.assistantMessageId;
      await expect(repository.createRun(conflictingInput)).rejects.toBeInstanceOf(ActiveRunConflictError);

      const [afterConflict, runs, settingsAfterConflict] = await Promise.all([
        chatGraph(chat.id),
        prisma.modelRun.findMany({
          select: {
            assistantMessageId: true,
            id: true,
            status: true,
            userMessageId: true
          },
          where: {
            chatId: chat.id
          }
        }),
        storedDefaults(userId)
      ]);

      expect(afterConflict).toEqual(beforeConflict);
      expect(settingsAfterConflict).toEqual(settingsBeforeConflict);
      expect(runs).toEqual([
        {
          assistantMessageId: first.assistantMessageId,
          id: first.runId,
          status: "streaming",
          userMessageId: first.userMessageId
        }
      ]);
    });
  });

  it("keeps completion and cancellation mutually exclusive in either winner order", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const completionFirst = await createActiveRun(repository, userId, "Completion first");
      const completion = completionInput(completionFirst);

      await expect(repository.completeRun(completion)).resolves.toBe(true);
      await expect(repository.completeRun(completion)).resolves.toBe(false);
      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: completionFirst.runId,
          userId
        })
      ).resolves.toMatchObject({
        kind: "current",
        run: {
          status: "complete"
        }
      });
      await expect(
        repository.updateCancelledRunProviderPreview({
          providerCancelPreview: { status: "must_not_persist" },
          runId: completionFirst.runId,
          userId
        })
      ).resolves.toBe(false);
      const completedState = await expectTerminalState(completionFirst, "complete");
      expect(completedState.message.errorMessage).toBeNull();
      expect(completedState.run.errorPayload).toBeNull();

      const cancelFirst = await createActiveRun(repository, userId, "Cancellation first");
      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: cancelFirst.runId,
          userId
        })
      ).resolves.toMatchObject({
        kind: "cancelled",
        run: {
          status: "cancelled"
        }
      });
      await expect(
        repository.updateCancelledRunProviderPreview({
          providerCancelPreview: { provider: "cancelled" },
          runId: cancelFirst.runId,
          userId
        })
      ).resolves.toBe(true);
      await expect(
        repository.completeRun(completionInput(cancelFirst))
      ).resolves.toBe(false);
      const cancelledState = await expectTerminalState(cancelFirst, "cancelled");
      expect(cancelledState.message.errorMessage).toBe(cancelPayload.message);
      expect(cancelledState.run.errorPayload).toEqual({
        ...cancelPayload,
        providerCancelPreview: {
          provider: "cancelled"
        }
      });

      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: cancelFirst.runId,
          userId: "another-user"
        })
      ).resolves.toEqual({ kind: "not_found" });
      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: randomUUID(),
          userId
        })
      ).resolves.toEqual({ kind: "not_found" });
    });
  });

  it("records split provider usage on a non-complete run without incrementing completed chat totals", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const active = await createActiveRun(repository, userId, "Partial attributed usage");
      const usageAttributions = [
        {
          estimatedCostMicros: 11,
          modelId: "answer-model",
          provider: "openai",
          usage: {
            inputTokens: 2,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 3
          }
        },
        {
          estimatedCostMicros: 13,
          modelId: "perplexity/sonar-pro-search",
          provider: "openrouter",
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            reasoningTokens: 1,
            totalTokens: 5
          }
        }
      ];

      await expect(
        repository.recordRunUsageEvents({
          chatId: active.chatId,
          runId: active.runId,
          usageAttributions,
          userId
        })
      ).resolves.toBe(true);
      await expect(
        repository.recordRunUsageEvents({
          chatId: active.chatId,
          runId: active.runId,
          usageAttributions,
          userId
        })
      ).resolves.toBe(true);

      const [run, chat, usageEvents, adminUsage] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({
          select: {
            estimatedCostMicros: true,
            inputTokens: true,
            outputTokens: true,
            reasoningTokens: true,
            status: true,
            totalTokens: true
          },
          where: { id: active.runId }
        }),
        prisma.chat.findUniqueOrThrow({
          select: {
            totalInputTokens: true,
            totalOutputTokens: true,
            totalReasoningTokens: true
          },
          where: { id: active.chatId }
        }),
        prisma.usageEvent.findMany({
          orderBy: { provider: "asc" },
          select: {
            inputTokens: true,
            modelId: true,
            outputTokens: true,
            provider: true,
            reasoningTokens: true,
            totalTokens: true
          },
          where: { modelRunId: active.runId }
        }),
        loadAdminUsageQueryRows(prisma)
      ]);

      expect(run).toEqual({
        estimatedCostMicros: 24,
        inputTokens: 5,
        outputTokens: 3,
        reasoningTokens: 1,
        status: "streaming",
        totalTokens: 8
      });
      expect(chat).toEqual({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0
      });
      expect(usageEvents).toEqual([
        {
          inputTokens: 2,
          modelId: "answer-model",
          outputTokens: 1,
          provider: "openai",
          reasoningTokens: 0,
          totalTokens: 3
        },
        {
          inputTokens: 3,
          modelId: "perplexity/sonar-pro-search",
          outputTokens: 2,
          provider: "openrouter",
          reasoningTokens: 1,
          totalTokens: 5
        }
      ]);
      expect(adminUsage.userRows.find((row) => row.userId === userId)?._count._all).toBe(1);
      expect(
        adminUsage.providerModelRows
          .filter((row) => row.userId === userId)
          .map((row) => row._count._all)
      ).toEqual([1, 1]);

      await prisma.modelRun.delete({ where: { id: active.runId } });
      const detachedUsage = await loadAdminUsageQueryRows(prisma);
      expect(detachedUsage.userRows.find((row) => row.userId === userId)).toMatchObject({
        _count: { _all: 0 },
        _sum: { totalTokens: 8 }
      });
      expect(
        detachedUsage.providerModelRows
          .filter((row) => row.userId === userId)
          .map((row) => row._count._all)
      ).toEqual([0, 0]);
    });
  });

  it("atomically replaces partial answer-round usage and rejects terminal conflicts", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const active = await createActiveRun(repository, userId, "Answer usage checkpoint");
      await expect(repository.beginToolLoopProviderRound({
        providerContinuation: { providerResponseId: null, providerToolMessages: [] },
        roundIndex: 1,
        runId: active.runId,
        userId
      })).resolves.toBe("started");

      const partialUsage = {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 2,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 3
      };
      const terminalUsage = { ...partialUsage, outputTokens: 3, totalTokens: 5 };
      await expect(repository.recordRunUsageEvents({
        answerRoundUsage: { completeness: "partial", roundIndex: 1, usage: partialUsage },
        chatId: active.chatId,
        runId: active.runId,
        usageAttributions: [{
          modelId: "gpt-test",
          provider: "openai",
          usage: { inputTokens: 12, outputTokens: 6, reasoningTokens: 0, totalTokens: 18 }
        }],
        userId
      })).resolves.toBe(true);
      await expect(repository.recordRunUsageEvents({
        answerRoundUsage: { completeness: "terminal", roundIndex: 1, usage: terminalUsage },
        chatId: active.chatId,
        runId: active.runId,
        usageAttributions: [{
          modelId: "gpt-test",
          provider: "openai",
          usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 0, totalTokens: 20 }
        }],
        userId
      })).resolves.toBe(true);
      await expect(repository.recordRunUsageEvents({
        answerRoundUsage: { completeness: "terminal", roundIndex: 1, usage: terminalUsage },
        chatId: active.chatId,
        runId: active.runId,
        usageAttributions: [{
          modelId: "gpt-test",
          provider: "openai",
          usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 0, totalTokens: 20 }
        }],
        userId
      })).resolves.toBe(true);
      await expect(repository.recordRunUsageEvents({
        answerRoundUsage: {
          completeness: "terminal",
          roundIndex: 1,
          usage: { ...terminalUsage, outputTokens: 4, totalTokens: 6 }
        },
        chatId: active.chatId,
        runId: active.runId,
        usageAttributions: [{
          modelId: "gpt-test",
          provider: "openai",
          usage: { inputTokens: 12, outputTokens: 9, reasoningTokens: 0, totalTokens: 21 }
        }],
        userId
      })).resolves.toBe(false);

      const [storedRun, events] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({
          select: { inputTokens: true, outputTokens: true, toolLoopState: true, totalTokens: true },
          where: { id: active.runId }
        }),
        prisma.usageEvent.findMany({
          select: { inputTokens: true, outputTokens: true, totalTokens: true },
          where: { modelRunId: active.runId }
        })
      ]);
      expect(storedRun).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
      expect(parseToolLoopCheckpoint(storedRun.toolLoopState)).toMatchObject({
        answerRoundUsage: [{
          completeness: "terminal",
          roundIndex: 1,
          usage: terminalUsage
        }],
        version: 2
      });
      expect(events).toEqual([{ inputTokens: 12, outputTokens: 8, totalTokens: 20 }]);
    });
  });

  it("settles concurrent terminal writers and duplicate cancels exactly once", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const duplicateCancel = await createActiveRun(repository, userId, "Duplicate cancel");
      const cancelInput = {
        payload: cancelPayload,
        runId: duplicateCancel.runId,
        userId
      };
      const cancelResults = await Promise.all([
        repository.cancelRun(cancelInput),
        repository.cancelRun(cancelInput)
      ]);

      expect(cancelResults.map((result) => result.kind).sort()).toEqual(["cancelled", "current"]);
      expect(cancelResults.find((result) => result.kind === "current")).toMatchObject({
        run: {
          status: "cancelled"
        }
      });
      await expectTerminalState(duplicateCancel, "cancelled");

      const terminalRace = await createActiveRun(repository, userId, "Terminal race");
      const [completed, cancelled] = await Promise.all([
        repository.completeRun(completionInput(terminalRace)),
        repository.cancelRun({
          payload: cancelPayload,
          runId: terminalRace.runId,
          userId
        })
      ]);

      if (completed) {
        expect(cancelled).toMatchObject({ kind: "current", run: { status: "complete" } });
        await expectTerminalState(terminalRace, "complete");
      } else {
        expect(cancelled).toMatchObject({ kind: "cancelled", run: { status: "cancelled" } });
        await expectTerminalState(terminalRace, "cancelled");
      }
    });
  });

  it("settles a recovered tool-call error once with atomic events and usage", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const recovered = await createActiveRun(repository, userId, "Recovered tool call");
      const independent = await createActiveRun(repository, userId, "Independent recovery");
      await repository.updateRunProviderResponseId(recovered.runId, "response-tool");
      await repository.failRun(recovered.runId, recovered.assistantMessageId, {
        code: "provider_refresh_failed",
        message: "Transient refresh failure"
      });
      const settlement: Parameters<RunRepository["settleRecoveredRunError"]>[0] = {
        error: {
          code: "tool_loop_recovery_required",
          message: "Outstanding tool calls require a new run."
        },
        events: [
          {
            data: {
              artifactType: "summary",
              payload: { status: "provider_complete" }
            },
            type: "artifact"
          }
        ],
        providerResponseId: "response-tool",
        runId: recovered.runId,
        usageAttributions: [
          {
            estimatedCostMicros: 19,
            modelId: "fake-qsa",
            provider: "fake",
            usage: {
              inputTokens: 7,
              outputTokens: 2,
              reasoningTokens: 1,
              totalTokens: 9
            }
          }
        ],
        userId
      };

      const settlements = await Promise.all([
        repository.settleRecoveredRunError(settlement),
        repository.settleRecoveredRunError(settlement)
      ]);

      expect(settlements.sort()).toEqual([false, true]);
      await expect(
        repository.settleRecoveredRunError({ ...settlement, userId: "another-user" })
      ).resolves.toBe(false);
      const [run, message, events, usageEvents, chats, controls] = await Promise.all([
        prisma.modelRun.findUniqueOrThrow({
          select: {
            errorPayload: true,
            inputTokens: true,
            outputTokens: true,
            reasoningTokens: true,
            status: true,
            totalTokens: true
          },
          where: { id: recovered.runId }
        }),
        prisma.message.findUniqueOrThrow({
          select: { errorMessage: true, status: true },
          where: { id: recovered.assistantMessageId }
        }),
        prisma.modelRunEvent.findMany({
          orderBy: { sequence: "asc" },
          select: { eventType: true, sequence: true },
          where: { modelRunId: recovered.runId }
        }),
        prisma.usageEvent.findMany({
          select: {
            estimatedCostMicros: true,
            inputTokens: true,
            outputTokens: true,
            totalTokens: true
          },
          where: { modelRunId: recovered.runId }
        }),
        prisma.chat.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            totalInputTokens: true,
            totalOutputTokens: true,
            totalReasoningTokens: true
          },
          where: { id: { in: [recovered.chatId, independent.chatId] } }
        }),
        Promise.all([
          repository.getRunControlForUser(recovered.runId, userId),
          repository.getRunControlForUser(independent.runId, userId)
        ])
      ]);

      expect(run).toEqual({
        errorPayload: {
          code: "tool_loop_recovery_required",
          message: "Outstanding tool calls require a new run.",
          recoveryTerminal: true
        },
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: 1,
        status: "error",
        totalTokens: 9
      });
      expect(message).toEqual({
        errorMessage: "Outstanding tool calls require a new run.",
        status: "error"
      });
      expect(events).toEqual([
        { eventType: "error", sequence: 0 },
        { eventType: "artifact", sequence: 1 },
        { eventType: "error", sequence: 2 }
      ]);
      expect(usageEvents).toEqual([
        {
          estimatedCostMicros: 19,
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9
        }
      ]);
      expect(chats).toEqual(
        [recovered.chatId, independent.chatId]
          .sort()
          .map((id) => ({
            id,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalReasoningTokens: 0
          }))
      );
      expect(controls).toEqual([
        expect.objectContaining({ recoverySettled: true, status: "error" }),
        expect.objectContaining({ recoverySettled: false, status: "streaming" })
      ]);
      await expect(
        repository.completeRun({
          ...completionInput(recovered),
          providerResponseId: "response-tool"
        })
      ).resolves.toBe(false);
    });
  });

  it("preserves completion and cancellation winners against recovered-error settlement", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const completionWinner = await createActiveRun(
        repository,
        userId,
        "Recovered completion winner"
      );
      await repository.updateRunProviderResponseId(
        completionWinner.runId,
        "response-complete"
      );
      await repository.failRun(
        completionWinner.runId,
        completionWinner.assistantMessageId,
        { code: "provider_refresh_failed", message: "Transient failure" }
      );
      await expect(
        repository.completeRun({
          ...completionInput(completionWinner),
          providerResponseId: "response-complete"
        })
      ).resolves.toBe(true);
      await expect(
        repository.settleRecoveredRunError({
          error: { code: "late_error", message: "Must not replace completion" },
          events: [],
          runId: completionWinner.runId,
          usageAttributions: [],
          userId
        })
      ).resolves.toBe(false);
      await expectTerminalState(completionWinner, "complete");

      const cancellationWinner = await createActiveRun(
        repository,
        userId,
        "Recovered cancellation winner"
      );
      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: cancellationWinner.runId,
          userId
        })
      ).resolves.toMatchObject({ kind: "cancelled" });
      await expect(
        repository.settleRecoveredRunError({
          error: { code: "late_error", message: "Must not replace cancellation" },
          events: [],
          runId: cancellationWinner.runId,
          usageAttributions: [],
          userId
        })
      ).resolves.toBe(false);
      await expectTerminalState(cancellationWinner, "cancelled");
    });
  });

  it("preserves an existing provider response id when completing without a new one", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Run chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Question"),
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(""),
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "streaming"
        }
      });
      const runId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "ModelRun" (
          "id",
          "chatId",
          "userId",
          "userMessageId",
          "assistantMessageId",
          "provider",
          "modelId",
          "status",
          "normalizedRequest",
          "providerRequestPreview",
          "providerResponseId",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${runId},
          ${chat.id},
          ${userId},
          ${userMessage.id},
          ${assistantMessage.id},
          ${"fake"},
          ${"fake-qsa"},
          ${"streaming"}::"ModelRunStatus",
          ${JSON.stringify({})}::jsonb,
          ${JSON.stringify({})}::jsonb,
          ${"resp-existing"},
          now(),
          now()
        )
      `;
      const repository = createPrismaRunRepository(prisma);

      const completed = await repository.completeRun({
        assistantMessageId: assistantMessage.id,
        chatId: chat.id,
        estimatedCostMicros: null,
        finalProviderResponsePreview: {},
        finalText: "Done",
        modelId: "fake-qsa",
        provider: "fake",
        runId,
        usage: {
          cachedInputTokens: 4,
          cacheWriteInputTokens: 1,
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 3,
          totalTokens: 7
        },
        userId
      });

      expect(completed).toBe(true);
      await expect(
        prisma.modelRun.findUniqueOrThrow({
          select: {
            cachedInputTokens: true,
            cacheWriteInputTokens: true,
            providerResponseId: true,
            totalTokens: true
          },
          where: {
            id: runId
          }
        })
      ).resolves.toEqual({
        cachedInputTokens: 4,
        cacheWriteInputTokens: 1,
        providerResponseId: "resp-existing",
        totalTokens: 7
      });
    });
  });

  it("publishes provider response ids only while active and reports a cancellation winner", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const cancelledFirst = await createActiveRun(repository, userId, "Cancellation before response id");

      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: cancelledFirst.runId,
          userId
        })
      ).resolves.toMatchObject({ kind: "cancelled" });
      await expect(
        repository.updateRunProviderResponseId(cancelledFirst.runId, "response-late")
      ).resolves.toBe("cancelled");
      await expect(repository.getRunControlForUser(cancelledFirst.runId, userId)).resolves.toMatchObject({
        providerResponseId: null,
        status: "cancelled"
      });

      const publishedFirst = await createActiveRun(repository, userId, "Response id before cancellation");
      await expect(
        repository.updateRunProviderResponseId(publishedFirst.runId, "response-published")
      ).resolves.toBe("published");
      await expect(
        repository.cancelRun({
          payload: cancelPayload,
          runId: publishedFirst.runId,
          userId
        })
      ).resolves.toMatchObject({
        kind: "cancelled",
        run: {
          providerResponseId: "response-published"
        }
      });
    });
  });

  it("publishes and completes a fresh round on a recoverable error-status run", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const recovered = await createRecoverableFreshProviderRound(
        repository,
        userId,
        "Publish recovered response"
      );

      await expect(
        repository.updateRunProviderResponseId(recovered.runId, "response-recovered")
      ).resolves.toBe("published");
      await expect(
        prisma.modelRun.findUniqueOrThrow({
          select: { providerResponseId: true, status: true },
          where: { id: recovered.runId }
        })
      ).resolves.toEqual({ providerResponseId: "response-recovered", status: "error" });
      await expect(repository.completeRun({
        ...completionInput(recovered),
        providerResponseId: "response-foreign"
      })).resolves.toBe(false);
      await expect(repository.completeRun({
        ...completionInput(recovered),
        providerResponseId: "response-recovered"
      })).resolves.toBe(true);
      await expectTerminalState(recovered, "complete");
    });
  });

  it("completes a recovered fresh round when the adapter has no response id", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const recovered = await createRecoverableFreshProviderRound(
        repository,
        userId,
        "Complete recovered response without native id"
      );

      await expect(repository.completeRun(completionInput(recovered))).resolves.toBe(true);
      await expect(
        prisma.modelRun.findUniqueOrThrow({
          select: { providerResponseId: true, status: true },
          where: { id: recovered.runId }
        })
      ).resolves.toEqual({ providerResponseId: null, status: "complete" });
      await expectTerminalState(recovered, "complete");
    });
  });

  it("rejects publication and completion after recovered error settlement", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const recovered = await createRecoverableFreshProviderRound(
        repository,
        userId,
        "Reject late recovered publication"
      );
      await expect(repository.settleRecoveredRunError({
        error: { code: "recovery_terminal", message: "Recovery is terminal" },
        events: [],
        runId: recovered.runId,
        usageAttributions: [],
        userId
      })).resolves.toBe(true);

      await expect(
        repository.updateRunProviderResponseId(recovered.runId, "response-too-late")
      ).resolves.toBe("terminal");
      await expect(repository.completeRun({
        ...completionInput(recovered),
        providerResponseId: "response-too-late"
      })).resolves.toBe(false);
      await expect(
        prisma.modelRun.findUniqueOrThrow({
          select: { errorPayload: true, providerResponseId: true, status: true },
          where: { id: recovered.runId }
        })
      ).resolves.toMatchObject({
        errorPayload: { recoveryTerminal: true },
        providerResponseId: null,
        status: "error"
      });
    });
  });

  it("serializes response publication against cancellation and recovered settlement", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const cancellationRace = await createActiveRun(
        repository,
        userId,
        "Publication cancellation race"
      );
      const [publication, cancellation] = await Promise.all([
        repository.updateRunProviderResponseId(cancellationRace.runId, "response-racing-cancel"),
        repository.cancelRun({
          payload: cancelPayload,
          runId: cancellationRace.runId,
          userId
        })
      ]);
      expect(cancellation).toMatchObject({ kind: "cancelled" });
      expect(["cancelled", "published"]).toContain(publication);
      await expect(
        prisma.modelRun.findUniqueOrThrow({
          select: { providerResponseId: true, status: true },
          where: { id: cancellationRace.runId }
        })
      ).resolves.toEqual({
        providerResponseId: publication === "published" ? "response-racing-cancel" : null,
        status: "cancelled"
      });

      const settlementRace = await createRecoverableFreshProviderRound(
        repository,
        userId,
        "Publication settlement race"
      );
      const [recoveredPublication, settled] = await Promise.all([
        repository.updateRunProviderResponseId(settlementRace.runId, "response-racing-settlement"),
        repository.settleRecoveredRunError({
          error: { code: "recovery_terminal", message: "Terminal recovery writer" },
          events: [],
          runId: settlementRace.runId,
          usageAttributions: [],
          userId
        })
      ]);
      expect(settled).toBe(true);
      expect(["published", "terminal"]).toContain(recoveredPublication);
      await expect(
        prisma.modelRun.findUniqueOrThrow({
          select: { errorPayload: true, providerResponseId: true, status: true },
          where: { id: settlementRace.runId }
        })
      ).resolves.toEqual({
        errorPayload: {
          code: "recovery_terminal",
          message: "Terminal recovery writer",
          recoveryTerminal: true
        },
        providerResponseId: recoveredPublication === "published"
          ? "response-racing-settlement"
          : null,
        status: "error"
      });
      await expect(
        repository.updateRunProviderResponseId(settlementRace.runId, "response-later")
      ).resolves.toBe("terminal");
    });
  });

  it("sweeps only active runs created before the process boot boundary", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const preBoot = await createActiveRun(repository, userId, "Pre-boot orphan");
      const checkpointed = await createActiveRun(repository, userId, "Pre-boot checkpointed run");
      const background = await createActiveRun(repository, userId, "Pre-boot background run");
      const postBoot = await createActiveRun(repository, userId, "Post-boot live run");
      await repository.beginToolLoopProviderRound({
        providerContinuation: { responseId: "accepted-response" },
        roundIndex: 0,
        runId: checkpointed.runId,
        userId
      });
      await repository.updateRunProviderResponseId(background.runId, "response-background");
      await Promise.all([
        prisma.modelRun.update({
          data: { createdAt: new Date("2026-07-12T09:59:00.000Z") },
          where: { id: preBoot.runId }
        }),
        prisma.modelRun.update({
          data: { createdAt: new Date("2026-07-12T09:58:00.000Z") },
          where: { id: checkpointed.runId }
        }),
        prisma.modelRun.update({
          data: { createdAt: new Date("2026-07-12T09:57:00.000Z") },
          where: { id: background.runId }
        }),
        prisma.modelRun.update({
          data: { createdAt: new Date("2026-07-12T10:01:00.000Z") },
          where: { id: postBoot.runId }
        })
      ]);

      await expect(
        repository.sweepBootOrphanedRuns({
          createdBefore: new Date("2026-07-12T10:00:00.000Z"),
          liveRunIds: []
        })
      ).resolves.toBe(1);
      await expect(repository.findInstallationRecoverableRuns!({
        bootedBefore: new Date("2026-07-12T10:00:00.000Z"),
        limit: 100,
        staleBefore: new Date("2026-07-12T09:00:00.000Z")
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: checkpointed.runId, userId }),
        expect.objectContaining({ id: background.runId, userId })
      ]));
      await expect(
        prisma.modelRun.findMany({
          orderBy: { createdAt: "asc" },
          select: { id: true, status: true },
          where: { id: { in: [preBoot.runId, checkpointed.runId, background.runId, postBoot.runId] } }
        })
      ).resolves.toEqual([
        { id: background.runId, status: "streaming" },
        { id: checkpointed.runId, status: "streaming" },
        { id: preBoot.runId, status: "error" },
        { id: postBoot.runId, status: "streaming" }
      ]);
    });
  });

  it("commits completion with provider artifacts followed by durable usage and done evidence", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Atomic terminal evidence");
      await repository.appendRunEvent(created.runId, 0, {
        data: {
          artifactType: "summary",
          payload: { status: "in_progress" }
        },
        type: "artifact"
      });
      const completion = completionInput(created);
      completion.eventsBeforeTerminal = [
        {
          data: {
            artifactType: "summary",
            payload: { status: "completed" }
          },
          type: "artifact"
        }
      ];

      await expect(repository.completeRun(completion)).resolves.toBe(true);
      await expect(
        prisma.modelRunEvent.findMany({
          orderBy: { sequence: "asc" },
          select: { eventType: true, sequence: true },
          where: { modelRunId: created.runId }
        })
      ).resolves.toEqual([
        { eventType: "artifact", sequence: 0 },
        { eventType: "artifact", sequence: 1 },
        { eventType: "usage", sequence: 2 },
        { eventType: "done", sequence: 3 }
      ]);
    });
  });

  it("purges grounded provider content and keeps complete and failed runs live-only", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const completed = await createActiveRun(repository, userId, "Grounded completion");
      await repository.appendAssistantText(completed.assistantMessageId, "grounded-draft-secret");
      await repository.appendRunEvent(completed.runId, 0, {
        data: { delta: "grounded-token-secret" },
        type: "token"
      });
      await repository.appendRunEvent(completed.runId, 1, {
        data: {
          artifactType: "citation",
          payload: {
            suggestionsHtml: "<div>grounded-suggestion-secret</div>",
            url: "https://grounded-source.example/secret"
          }
        },
        type: "artifact"
      });

      await expect(repository.markAssistantMessageGroundedLiveOnly({
        assistantMessageId: completed.assistantMessageId,
        groundedAt: new Date("2026-07-26T12:00:00.000Z"),
        provider: "gemini",
        runId: completed.runId,
        strategy: "gemini-google-search"
      })).resolves.toBe(true);
      await repository.appendAssistantText(completed.assistantMessageId, "late-grounded-secret");
      await expect(repository.appendRunEvent(completed.runId, 0, {
        data: {
          citations: [],
          provider: "gemini",
          runSearch: { callCount: 1, queryCount: 1 },
          suggestionsHtml: "<div>must-stay-transient</div>"
        },
        type: "grounding_display"
      })).rejects.toThrow("grounding_display_event_is_transient");

      const completion = completionInput(completed);
      completion.finalText = "grounded-final-secret";
      completion.finalProviderResponsePreview = {
        suggestionsHtml: "<div>completion-preview-secret</div>",
        url: "https://completion-source.example/secret"
      };
      completion.eventsBeforeTerminal = [{
        data: {
          artifactType: "citation",
          payload: { url: "https://terminal-source.example/secret" }
        },
        type: "artifact"
      }];
      await expect(repository.completeRun(completion)).resolves.toBe(true);

      const completedState = await prisma.modelRun.findUniqueOrThrow({
        select: {
          events: {
            orderBy: { sequence: "asc" },
            select: { eventType: true, payload: true }
          },
          finalProviderResponsePreview: true,
          assistantMessage: {
            select: {
              content: true,
              groundedAt: true,
              groundingProvider: true,
              groundingStrategy: true,
              status: true
            }
          }
        },
        where: { id: completed.runId }
      });
      expect(completedState).toMatchObject({
        events: [{ eventType: "usage" }, { eventType: "done" }],
        finalProviderResponsePreview: groundedLiveOnlyProviderPreview(),
        assistantMessage: {
          content: textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER),
          groundedAt: new Date("2026-07-26T12:00:00.000Z"),
          groundingProvider: "gemini",
          groundingStrategy: "gemini-google-search",
          status: "complete"
        }
      });
      expect(JSON.stringify(completedState)).not.toMatch(
        /grounded-(?:draft|token|suggestion|final)-secret|(?:completion|terminal)-source\.example|completion-preview-secret|late-grounded-secret/
      );

      const failed = await createActiveRun(repository, userId, "Grounded failure");
      await repository.appendAssistantText(failed.assistantMessageId, "failed-grounded-draft-secret");
      await repository.appendRunEvent(failed.runId, 0, {
        data: { delta: "failed-grounded-token-secret" },
        type: "token"
      });
      await repository.appendRunEvent(failed.runId, 1, {
        data: {
          artifactType: "citation",
          payload: { url: "https://failed-grounded-source.example/secret" }
        },
        type: "artifact"
      });
      await expect(repository.markAssistantMessageGroundedLiveOnly({
        assistantMessageId: failed.assistantMessageId,
        groundedAt: new Date("2026-07-26T12:01:00.000Z"),
        provider: "gemini",
        runId: failed.runId,
        strategy: "gemini-google-search"
      })).resolves.toBe(true);
      await expect(repository.failRun(failed.runId, failed.assistantMessageId, {
        code: "provider_failed",
        message: "failed-grounded-answer-secret https://failed-error.example/secret"
      })).resolves.toBe(true);

      const failedState = await prisma.modelRun.findUniqueOrThrow({
        select: {
          errorPayload: true,
          events: {
            orderBy: { sequence: "asc" },
            select: { eventType: true, payload: true }
          },
          finalProviderResponsePreview: true,
          assistantMessage: {
            select: { content: true, errorMessage: true, status: true }
          }
        },
        where: { id: failed.runId }
      });
      expect(failedState).toMatchObject({
        errorPayload: { code: "provider_failed", message: "Grounded live-only run failed." },
        events: [{
          eventType: "error",
          payload: { code: "provider_failed", message: "Grounded live-only run failed." }
        }],
        finalProviderResponsePreview: groundedLiveOnlyProviderPreview(),
        assistantMessage: {
          content: textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER),
          errorMessage: "Grounded live-only run failed.",
          status: "error"
        }
      });
      expect(JSON.stringify(failedState)).not.toMatch(
        /failed-grounded-(?:draft|token|answer)-secret|failed-(?:grounded-source|error)\.example/
      );
    });
  });

  it("reports whether failure settlement won the active-status CAS", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const cancelled = await createActiveRun(repository, userId, "Cancelled before failure");
      await repository.cancelRun({ payload: cancelPayload, runId: cancelled.runId, userId });

      await expect(
        repository.failRun(cancelled.runId, cancelled.assistantMessageId, {
          code: "late_failure",
          message: "Must not replace cancellation"
        })
      ).resolves.toBe(false);
      await expect(repository.getRunControlForUser(cancelled.runId, userId)).resolves.toMatchObject({
        status: "cancelled"
      });

      const active = await createActiveRun(repository, userId, "Failure winner");
      await expect(
        repository.failRun(active.runId, active.assistantMessageId, {
          code: "provider_failed",
          message: "Failure wins"
        })
      ).resolves.toBe(true);
      await expect(repository.getRunControlForUser(active.runId, userId)).resolves.toMatchObject({
        status: "error"
      });
      await expect(
        prisma.modelRunEvent.findMany({
          orderBy: { createdAt: "asc" },
          select: { eventType: true, modelRunId: true },
          where: { modelRunId: { in: [cancelled.runId, active.runId] } }
        })
      ).resolves.toEqual([{ eventType: "error", modelRunId: active.runId }]);
    });
  });
});
