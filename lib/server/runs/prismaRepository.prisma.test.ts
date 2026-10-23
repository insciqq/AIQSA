import { createPrismaShareRepository } from "../shares/prismaRepository";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import { decodeAssistantIdentity, type AssistantIdentity } from "../../contracts/assistants";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { mcpRuntimeFingerprint } from "../mcp/access";
import {
  encryptMcpEnvelope,
  mcpRuntimeGenerationEnvelopeContext
} from "../mcp/encryption";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { createPrismaMcpRuntimeRepository } from "../mcp/runtimeRepository";
import { prisma } from "../prisma";
import { createPrismaSettingsRepository } from "../settings/prismaRepository";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "./prismaRepository";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AssistantRunConflictError,
  AttachmentLinkConflictError,
  McpRunPlanConflictError,
  type AcceptedRunDefaults,
  type RunRepository
} from "./runRepositoryContract";
import { USAGE_MESSAGE_ADMISSION_RETENTION_MS } from "../usageLimits/repository";
import { createToolCallStore } from "../engine/toolCallStore";
import { completeNativeRun, type NativeRunCompletion } from "../../../tests/support/nativeRunCompletion";

const TEST_MCP_KEY = Buffer.alloc(32, 0x61);
const fakeControlKey = `${providerTemplateIds.fakeConnection}:${providerTemplateIds.fakeModel}`;

async function withRunUser<T>(run: (input: { userId: string }) => Promise<T>): Promise<T> {
  const userId = `run-repository-test-${randomUUID()}`;

  await prisma.user.create({
    data: {
      displayName: "Run Repository Test User",
      id: userId,
      status: "active",
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
  assistant?: { assistantId: string; definitionVersion: number; identity: AssistantIdentity };
  attachmentIds?: string[];
  chatId: string;
  defaults?: Partial<AcceptedRunDefaults>;
  nativePdfInput?: boolean;
  providerAdmissionPlan?: ProviderAdmissionPlan;
  question: string;
  userId: string;
}): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent(input.question);
  const defaults: AcceptedRunDefaults = {
    controlDefaults: input.defaults?.controlDefaults ?? {},
    modelId: providerTemplateIds.fakeModel,
    provider: providerTemplateIds.fakeConnection,
    searchPlan: { mode: "all_selected", optionIds: [] },
    userId: input.userId,
    ...input.defaults
  };

  return {
    ...(input.assistant ? { assistant: input.assistant } : {}),
    chatId: input.chatId,
    content,
    defaults,
    expectedActiveLeafId: null,
    modelId: "fake-qsa",
    normalizedRequest: {
      attachmentIds: input.attachmentIds ?? [],
      chatId: input.chatId,
      content,
      toolMode: "auto",
      modelCapabilities: {
        nativePdfInput: input.nativePdfInput ?? false,
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
      searchPlan: { mode: "all_selected", options: [] }
    },
    provider: "fake",
    ...(input.providerAdmissionPlan
      ? { providerAdmissionPlan: input.providerAdmissionPlan }
      : {}),
    providerRequestPreview: {},
    userId: input.userId
  };
}

function createRegenerationInput(
  prepared: Parameters<RunRepository["createRun"]>[0],
  userMessageId: string,
  preSendAssistantMessageId: string | null = null
): Parameters<RunRepository["createRegenerationRun"]>[0] {
  return {
    chatId: prepared.chatId,
    defaults: prepared.defaults,
    modelId: prepared.modelId,
    normalizedRequest: prepared.normalizedRequest,
    preSendAssistantMessageId,
    provider: prepared.provider,
    providerRequestPreview: prepared.providerRequestPreview,
    userId: prepared.userId,
    userMessageId
  };
}

/** An owned Assistant definition for personal admission tests. */
function createRunAssistant(userId: string, name = "Bound chat Assistant") {
  return prisma.assistantDefinition.create({
    data: {
      avatar: {
        accents: [0, 4],
        backgroundShape: "circle",
        foregroundShape: "diamond",
        kind: "generated",
        paletteId: "ocean",
        recipeVersion: 1,
        rotations: [0, 2]
      },
      name,
      ownerUserId: userId,
      providerModelId: providerTemplateIds.fakeModel,
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      systemPrompt: "Answer as the chat's Assistant."
    }
  });
}

function acceptedAssistant(definition: Awaited<ReturnType<typeof createRunAssistant>>) {
  return {
    assistantId: definition.id,
    definitionVersion: definition.version,
    identity: decodeAssistantIdentity({ avatar: definition.avatar, name: definition.name })!
  };
}

/** An Assistant run's input: Assistant runs never carry accepted defaults. */
function assistantRunInput(
  definition: Awaited<ReturnType<typeof createRunAssistant>>,
  chatId: string,
  userId: string,
  question = "Assistant run"
): Parameters<RunRepository["createRun"]>[0] {
  const { defaults: _defaults, ...input } = createRunInput({
    assistant: acceptedAssistant(definition),
    chatId,
    question,
    userId
  });
  return input;
}

function chatAssistantState(chatId: string) {
  return prisma.chat.findUniqueOrThrow({
    select: { assistantId: true, assistantOverrides: true, defaultProviderModelId: true },
    where: { id: chatId }
  });
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

function completionInput(input: {
  assistantMessageId: string;
  chatId: string;
  runId: string;
  userId: string;
}): NativeRunCompletion {
  return {
    ...input,
    estimatedCostMicros: 17,
    finalText: "Completed answer",
    modelId: "fake-qsa",
    provider: "fake",
    usage: { completeness: "complete" as const,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 6
    }
  };
}

const cancelPayload = {
  code: "model_run_cancelled",
  message: "Model run cancelled"
};

describe("Prisma-backed run repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a personal chat, messages, and run in one first-send transaction", async () => {
    await withRunUser(async ({ userId }) => {
      const chatId = randomUUID();
      const repository = createPrismaRunRepository(prisma);
      const input = {
        ...createRunInput({
          chatId,
          question: "Atomic personal first send",
          userId
        }),
        personalChat: {
          // This fixture user has no model grant, so the same catalog-aware
          // first-send lookup used by the route resolves no persisted default.
          // The accepted request still updates the chat default atomically.
          defaultProviderModelId: null,
          folderId: null,
          memoryMode: "NORMAL" as const
        }
      };

      const created = await repository.createRun(input);

      await expect(prisma.chat.findUnique({
        select: {
          _count: { select: { messages: true, modelRuns: true } },
          activeLeafMessageId: true,
          defaultProviderModelId: true,
          title: true,
          workspaceEnabled: true
        },
        where: { id: chatId }
      })).resolves.toEqual({
        _count: { messages: 2, modelRuns: 1 },
        activeLeafMessageId: created.assistantMessageId,
        defaultProviderModelId: providerTemplateIds.fakeModel,
        title: "Atomic personal first send",
        workspaceEnabled: false
      });
    });
  });

  it("logs every interactive send and regeneration with its run and prunes only that user's rows past 25 hours", async () => {
    await withRunUser(async ({ userId }) => {
      const otherUserId = `run-repository-test-${randomUUID()}`;
      await prisma.user.create({ data: { displayName: "Other admission log user", id: otherUserId, status: "active" } });
      try {
        const repository = createPrismaRunRepository(prisma);
        const log = (owner: string) => prisma.usageMessageAdmission.findMany({
          orderBy: { createdAt: "asc" }, select: { createdAt: true }, where: { userId: owner }
        });
        const runCreatedAt = async (runId: string) =>
          (await prisma.modelRun.findUniqueOrThrow({ select: { createdAt: true }, where: { id: runId } })).createdAt;
        const stale = new Date(Date.now() - USAGE_MESSAGE_ADMISSION_RETENTION_MS - 60_000);
        const kept = new Date(Date.now() - USAGE_MESSAGE_ADMISSION_RETENTION_MS + 60 * 60_000);
        await prisma.usageMessageAdmission.createMany({ data: [
          { createdAt: stale, userId }, { createdAt: kept, userId }, { createdAt: stale, userId: otherUserId }
        ] });
        const chat = await prisma.chat.create({
          data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Admission log", userId }
        });
        const sendInput = createRunInput({ chatId: chat.id, question: "A counted send", userId });
        const sent = await repository.createRun(sendInput);
        // The row carries its run's creation time; only this user's rows past the retention went.
        expect(await log(userId)).toEqual([{ createdAt: kept }, { createdAt: await runCreatedAt(sent.runId) }]);
        expect(await log(otherUserId)).toEqual([{ createdAt: stale }]);

        await prisma.modelRun.update({ data: { status: "complete" }, where: { id: sent.runId } });
        const regenerated = await repository.createRegenerationRun(
          createRegenerationInput(sendInput, sent.userMessageId, sent.assistantMessageId)
        );
        expect(await log(userId)).toEqual([
          { createdAt: kept }, { createdAt: await runCreatedAt(sent.runId) }, { createdAt: await runCreatedAt(regenerated.runId) }
        ]);
      } finally {
        await prisma.user.deleteMany({ where: { id: otherUserId } });
      }
      // The log goes with its account.
      expect(await prisma.usageMessageAdmission.count({ where: { userId: otherUserId } })).toBe(0);
    });
  });

  it("rolls back a reserved personal chat when first-send attachment admission conflicts", async () => {
    await withRunUser(async ({ userId }) => {
      const chatId = randomUUID();
      const missingAttachmentId = randomUUID();
      const repository = createPrismaRunRepository(prisma);
      const input = {
        ...createRunInput({
          attachmentIds: [missingAttachmentId],
          chatId,
          question: "This entire graph must roll back",
          userId
        }),
        personalChat: {
          defaultProviderModelId: null,
          folderId: null,
          memoryMode: "NORMAL" as const
        }
      };

      await expect(repository.createRun(input)).rejects.toBeInstanceOf(
        AttachmentLinkConflictError
      );
      await expect(prisma.chat.findUnique({ where: { id: chatId } })).resolves.toBeNull();
      await expect(prisma.message.count({ where: { chatId } })).resolves.toBe(0);
      await expect(prisma.modelRun.count({ where: { chatId } })).resolves.toBe(0);
    });
  });

  it("creates a first-send chat already bound to its Assistant with the run's overrides", async () => {
    await withRunUser(async ({ userId }) => {
      const definition = await createRunAssistant(userId);
      const chatId = randomUUID();
      try {
        const created = await createPrismaRunRepository(prisma).createRun({
          ...assistantRunInput(definition, chatId, userId, "Bound first send"),
          chatAssistant: { assistantId: definition.id, bind: true, overridesPatch: { search: { mode: "off" } } },
          personalChat: { defaultProviderModelId: null, folderId: null, memoryMode: "NORMAL" }
        });

        // The Assistant run writes its overrides, never the chat's ordinary
        // default columns or the user's saved values.
        await expect(chatAssistantState(chatId)).resolves.toEqual({
          assistantId: definition.id,
          assistantOverrides: { search: { mode: "off" } },
          defaultProviderModelId: null
        });
        await expect(prisma.modelRun.findUniqueOrThrow({ select: { assistantId: true }, where: { id: created.runId } }))
          .resolves.toEqual({ assistantId: definition.id });
        await expect(storedDefaults(userId)).resolves.toMatchObject({ defaultControlValues: {} });
        await expect(createPrismaRunRepository(prisma).findOwnedChat(chatId, userId)).resolves.toMatchObject({
          assistantId: definition.id,
          assistantOverrides: { search: { mode: "off" } }
        });
      } finally {
        await prisma.assistantDefinition.deleteMany({ where: { id: definition.id } });
      }
    });
  });

  it("applies a bound chat's override change at admission and refuses a changed binding", async () => {
    await withRunUser(async ({ userId }) => {
      const definition = await createRunAssistant(userId);
      const other = await createRunAssistant(userId, "Another Assistant");
      const repository = createPrismaRunRepository(prisma);
      const chat = (assistantId: string | null, assistantOverrides: Prisma.InputJsonValue | null) => prisma.chat.create({
        data: {
          assistantId,
          assistantOverrides: assistantOverrides ?? Prisma.DbNull,
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Bound chat",
          userId
        }
      });
      try {
        const bound = await chat(definition.id, {
          controls: { temperature: 0.9 },
          model: { mode: "model", modelId: providerTemplateIds.fakeModel },
          search: { mode: "off" }
        });
        await repository.createRun({
          ...assistantRunInput(definition, bound.id, userId),
          chatAssistant: { assistantId: definition.id, bind: false, overridesPatch: { model: null, tools: { mode: "off" } } }
        });
        // Clearing the model also clears the controls set for it.
        await expect(chatAssistantState(bound.id)).resolves.toMatchObject({
          assistantId: definition.id,
          assistantOverrides: { search: { mode: "off" }, tools: { mode: "off" } }
        });

        const unbound = await chat(null, null);
        await repository.createRun({
          ...assistantRunInput(definition, unbound.id, userId),
          chatAssistant: { assistantId: definition.id, bind: true, overridesPatch: {} }
        });
        await expect(chatAssistantState(unbound.id)).resolves.toMatchObject({
          assistantId: definition.id,
          assistantOverrides: null
        });

        for (const changed of [await chat(other.id, null), await chat(null, { assistantDeleted: true })]) {
          await expect(repository.createRun({
            ...assistantRunInput(definition, changed.id, userId),
            chatAssistant: { assistantId: definition.id, bind: true, overridesPatch: { search: { mode: "off" } } }
          })).rejects.toBeInstanceOf(AssistantRunConflictError);
          await expect(chatGraph(changed.id)).resolves.toMatchObject({ _count: { messages: 0, modelRuns: 0 } });
        }
      } finally {
        await prisma.assistantDefinition.deleteMany({ where: { id: { in: [definition.id, other.id] } } });
      }
    });
  });

  it("regenerates from the chat's binding and stores the regeneration's override change", async () => {
    await withRunUser(async ({ userId }) => {
      const definition = await createRunAssistant(userId);
      const repository = createPrismaRunRepository(prisma);
      try {
        const chat = await prisma.chat.create({
          data: { assistantId: definition.id, defaultProviderModelId: providerTemplateIds.fakeModel, title: "Bound chat", userId }
        });
        const prepared = assistantRunInput(definition, chat.id, userId, "Question to regenerate");
        const created = await repository.createRun({
          ...prepared,
          chatAssistant: { assistantId: definition.id, bind: false, overridesPatch: {} }
        });
        await expect(completeNativeRun(prisma, completionInput({
          assistantMessageId: created.assistantMessageId, chatId: chat.id, runId: created.runId, userId
        }))).resolves.toBe(true);

        const source = await repository.findRegenerationSource(created.assistantMessageId, userId);
        expect(source?.chat).toMatchObject({ assistantId: definition.id, assistantOverrides: null });
        const regenerated = await repository.createRegenerationRun({
          ...createRegenerationInput(prepared, created.userMessageId, created.assistantMessageId),
          assistant: acceptedAssistant(definition),
          chatAssistant: { assistantId: definition.id, bind: false, overridesPatch: { search: { mode: "off" } } }
        });

        await expect(prisma.modelRun.findUniqueOrThrow({ select: { assistantId: true }, where: { id: regenerated.runId } }))
          .resolves.toEqual({ assistantId: definition.id });
        await expect(chatAssistantState(chat.id)).resolves.toMatchObject({
          assistantId: definition.id,
          assistantOverrides: { search: { mode: "off" } }
        });
      } finally {
        await prisma.assistantDefinition.deleteMany({ where: { id: definition.id } });
      }
    });
  });

  it("loads server-only attachment integrity and processing metadata", async () => {
    await withRunUser(async ({ userId }) => {
      const storageKey = `${userId}/direct-pdf-${randomUUID()}`;
      const attachment = await prisma.attachment.create({
        data: {
          byteSize: 12,
          checksum: "b".repeat(64),
          extractedText: null,
          fileName: "scan.pdf",
          kind: "pdf",
          metadata: {},
          mimeType: "application/pdf",
          processingErrorCode: "parser_unavailable",
          status: "failed",
          storageKey,
          userId
        }
      });

      await expect(
        createPrismaRunRepository(prisma).loadAttachments(userId, [attachment.id])
      ).resolves.toEqual([expect.objectContaining({
        byteSize: 12,
        checksum: "b".repeat(64),
        id: attachment.id,
        processingErrorCode: "parser_unavailable",
        status: "failed",
        storageKey
      })]);
    });
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
      const assistantUpdate = update?.messages.find(({ id }) => id === assistantMessage.id);
      expect(assistantUpdate).toMatchObject({ id: assistantMessage.id });
      expect(assistantUpdate).not.toHaveProperty("runUsage");
    });
  });

  it("marks a foreground safety failure terminal for recovery without exposing the marker", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Terminal stream safety failure");
      await repository.appendAssistantText(
        created.assistantMessageId,
        "durable partial",
        { runId: created.runId }
      );

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
      await expect(prisma.modelRunEvent.count({
        where: { modelRunId: created.runId }
      })).resolves.toBe(0);
      await expect(completeNativeRun(prisma, completionInput(created))).resolves.toBe(false);
    });
  });

  it("allows recovery to extend partial text while preserving an errored message status", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Refreshable partial recovery");
      await repository.appendAssistantText(
        created.assistantMessageId,
        "durable ",
        { runId: created.runId }
      );
      await repository.failRun(created.runId, created.assistantMessageId, {
        code: "provider_stream_failed",
        message: "Transient provider failure"
      });

      await repository.appendAssistantText(
        created.assistantMessageId,
        "durable recovered",
        { allowErrored: true, runId: created.runId }
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
        const regenerationInput = createRegenerationInput(
          sendInput,
          sent.userMessageId,
          sent.assistantMessageId
        );
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

  it("atomically checkpoints an Auto discovery epoch with its exact runtime binding", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "MCP Auto discovery checkpoint",
          userId
        }
      });
      const fixture = await createReadyMcpBinding(userId);
      try {
        const repository = createPrismaRunRepository(prisma);
        const namespacedName = namespacedMcpToolName(fixture.server.namespace, "echo");
        const runInput = createRunInput({
          chatId: chat.id,
          question: "Discover the echo tool",
          userId
        });
        runInput.normalizedRequest.mcpDiscovery = {
          catalog: {
            servers: [{
              description: fixture.server.description,
              namespace: fixture.server.namespace,
              revisionId: fixture.revision.id,
              serverId: fixture.server.id,
              serverName: fixture.server.displayName,
              tools: [{
                description: "Echo",
                namespacedName,
                originalName: "echo"
              }]
            }],
            version: 1
          },
          epochs: [],
          version: 2
        };
        const created = await repository.createRun(runInput);
        const calls = createToolCallStore(prisma);
        const discoveryCall = (ordinal: number, providerCallId: string) => calls.begin({ arguments: { goal: "echo a value" },
          chatId: chat.id, ordinal, providerCallId, roundIndex: 0, runId: created.runId, toolName: "find_tools", userId });
        const persisted = { calls: await Promise.all([discoveryCall(0, "provider-find-tools-call"),
          discoveryCall(1, "provider-find-tools-call-2")]).then((results) => results.map((result) => {
          if (result.kind !== "running") throw new Error("expected recorded discovery call");
          return result.row;
        })) };
        const modelRunToolCallId = persisted.calls[0]!.id;
        const snapshot = {
          servers: [{
            fingerprint: fixture.binding.fingerprint,
            revisionId: fixture.revision.id,
            serverId: fixture.server.id,
            serverName: fixture.server.displayName
          }],
          tools: [{
            definitionHash: "a".repeat(64),
            description: "Echo",
            inputSchema: { type: "object" },
            name: "echo",
            namespacedName,
            originalName: "echo",
            serverId: fixture.server.id,
            serverName: fixture.server.displayName
          }],
          version: 1 as const
        };
        const append = repository.appendMcpDiscoveryEpoch!;
        const policy = await prisma.mcpToolAccessPolicy.create({ data: {
          serverId: fixture.server.id, toolName: "echo", restricted: true
        } });
        await expect(append({ bindings: [fixture.binding], goal: "echo a value", modelRunToolCallId,
          roundIndex: 0, runId: created.runId, snapshot, toolIds: [namespacedName], userId
        })).rejects.toMatchObject({ code: "mcp_tool_access_denied" });
        expect(await prisma.mcpRunBinding.count({ where: { modelRunId: created.runId } })).toBe(0);
        await prisma.mcpToolAccessPolicy.update({ where: { id: policy.id }, data: { restricted: false } });
        const appended = await append({
          bindings: [fixture.binding],
          goal: "echo a value",
          modelRunToolCallId,
          roundIndex: 0,
          runId: created.runId,
          snapshot,
          toolIds: [namespacedName],
          userId
        });

        expect(appended).toMatchObject({
          discovery: {
            epochs: [{
              epoch: 1,
              goal: "echo a value",
              modelRunToolCallId,
              roundIndex: 0,
              toolIds: [namespacedName]
            }]
          },
          snapshot: { tools: [{ namespacedName }] }
        });
        await expect(prisma.mcpRunBinding.count({
          where: { modelRunId: created.runId }
        })).resolves.toBe(1);
        await prisma.mcpToolAccessPolicy.update({ where: { id: policy.id }, data: { restricted: true } });
        // A new selection on an already accepted binding still checks current rights.
        await expect(append({ bindings: [], goal: "echo a value", modelRunToolCallId: persisted.calls[1]!.id,
          roundIndex: 0, runId: created.runId, snapshot: { servers: [], tools: [], version: 1 },
          toolIds: [namespacedName], userId
        })).rejects.toMatchObject({ code: "mcp_tool_access_denied" });
        // The prior accepted epoch remains immutable and readable.
        await expect(append({
          bindings: [fixture.binding],
          goal: "echo a value",
          modelRunToolCallId,
          roundIndex: 0,
          runId: created.runId,
          snapshot,
          toolIds: [namespacedName],
          userId
        })).resolves.toEqual(appended);
        await expect(prisma.modelRun.findUnique({
          select: { normalizedRequest: true },
          where: { id: created.runId }
        })).resolves.toMatchObject({
          normalizedRequest: {
            mcp: { tools: [{ namespacedName }] },
            mcpDiscovery: { epochs: [{ epoch: 1 }] }
          }
        });
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
          inventory: { exclusions: [], tools: [], version: 1 },
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
        // The message-limit row written with the run rolls back with it.
        await expect(prisma.usageMessageAdmission.count({ where: { userId } })).resolves.toBe(0);
        // The failed acceptance must leave previously stored defaults intact.
        await expect(storedDefaults(userId)).resolves.toMatchObject({
          defaultControlValues: priorControlValues
        });
      } finally {
        await deleteMcpFixture(fixture.server.id);
      }
    });
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
        defaultParams: {},
        displayName: "First pricing model",
        id: modelIds[0],
        inputTokenPriceUsdPerMillion: 11,
        modelId,
        outputTokenPriceUsdPerMillion: 12,
        provider,
        webSearchPriceUsdPerThousand: 14
      }
    });

    try {
      const repository = createPrismaRunRepository(prisma);

      // Run attributions also price the web searches answers and Search engines report.
      await expect(repository.loadModelPricing(provider, modelId)).resolves.toEqual({
        inputTokenPriceUsdPerMillion: 11,
        cachedInputTokenPriceUsdPerMillion: null,
        cacheWriteInputTokenPriceUsdPerMillion: null,
        outputTokenPriceUsdPerMillion: 12,
        webSearchPriceUsdPerThousand: 14
      });

      await prisma.providerModel.create({
        data: {
          capabilities: {},
          connectionId: connectionIds[1],
          defaultParams: {},
          displayName: "Second pricing model",
          id: modelIds[1],
          inputTokenPriceUsdPerMillion: 21,
          modelId,
          outputTokenPriceUsdPerMillion: 22,
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

  it("resolves a Knowledge deployment's own class and stored prices by its id", async () => {
    const connectionId = `repo-cost-basis-${randomUUID()}`;
    const modelId = `${connectionId}-embedding`;
    await prisma.providerConnection.create({ data: { displayName: "Cost basis connection", family: "openrouter", id: connectionId } });
    await prisma.providerModel.create({ data: { capabilities: {}, connectionId, defaultParams: {},
      displayName: "Cost basis embedding", id: modelId, inputTokenPriceUsdPerMillion: 0.13,
      modelClass: "embedding", modelId: "qwen/qwen3-embedding-8b", provider: "openrouter" } });
    try {
      const repository = createPrismaRunRepository(prisma);
      await expect(repository.loadProviderModelCostBasis(modelId)).resolves.toEqual({
        modelClass: "embedding",
        pricing: { inputTokenPriceUsdPerMillion: 0.13, cachedInputTokenPriceUsdPerMillion: null,
          cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null, webSearchPriceUsdPerThousand: null }
      });
      await expect(repository.loadProviderModelCostBasis(`${modelId}-deleted`)).resolves.toBeNull();
    } finally {
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
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

  it("links a processing PDF for an admitted native-PDF run", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Direct PDF processing",
          userId
        }
      });
      const attachment = await prisma.attachment.create({
        data: {
          byteSize: 12,
          checksum: "b".repeat(64),
          extractedText: null,
          fileName: "processing.pdf",
          kind: "pdf",
          metadata: {},
          mimeType: "application/pdf",
          status: "processing",
          storageKey: `${userId}/direct-pdf-processing-${randomUUID()}`,
          userId
        }
      });
      const repository = createPrismaRunRepository(prisma);

      const created = await repository.createRun(createRunInput({
        attachmentIds: [attachment.id],
        chatId: chat.id,
        nativePdfInput: true,
        question: "Use the original PDF while extraction continues",
        userId
      }));

      await expect(prisma.attachment.findUniqueOrThrow({
        select: { chatId: true, messageId: true, status: true },
        where: { id: attachment.id }
      })).resolves.toEqual({
        chatId: chat.id,
        messageId: created.userMessageId,
        status: "processing"
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
        defaultSearchPlan: null,
        defaultSearchStrategyId: "search-disabled"
      });
      expect(afterSendChat).toEqual({
        _count: {
          messages: 2,
          modelRuns: 1
        },
        activeLeafMessageId: sent.assistantMessageId,
        title: "Atomic defaults"
      });
      await expect(prisma.chat.findUniqueOrThrow({
        select: { memoryBranchGeneration: true, memorySourceRevision: true },
        where: { id: chat.id }
      })).resolves.toEqual({
        memoryBranchGeneration: 0,
        memorySourceRevision: 1
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
        createRegenerationInput(
          regenerationPrepared,
          sent.userMessageId,
          sent.assistantMessageId
        )
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
        defaultSearchPlan: null,
        defaultSearchStrategyId: "search-disabled"
      });
      expect(afterRegenerationChat).toEqual({
        _count: {
          messages: 3,
          modelRuns: 2
        },
        activeLeafMessageId: regenerated.assistantMessageId,
        title: "Atomic defaults"
      });
      await expect(Promise.all([
        prisma.chat.findUniqueOrThrow({
          select: { memoryBranchGeneration: true, memorySourceRevision: true },
          where: { id: chat.id }
        }),
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryGeneration: true, memoryRevision: true },
          where: { userId }
        }),
        prisma.memoryJob.findMany({
          select: { kind: true },
          where: {
            chatId: chat.id,
            kind: { in: ["RECONCILE_BRANCH", "RECONCILE_SOURCE"] },
            userId
          }
        })
      ])).resolves.toEqual([
        { memoryBranchGeneration: 1, memorySourceRevision: 2 },
        { memoryGeneration: 0, memoryRevision: 1 },
        []
      ]);
    });
  });

  it("starts the first answer on a newly committed user branch", async () => {
    await withRunUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Edited user branch",
          userId
        }
      });
      const editedUser = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Edited question"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: editedUser.id },
        where: { id: chat.id }
      });
      const prepared = createRunInput({
        chatId: chat.id,
        question: "Edited question",
        userId
      });

      const regenerated = await createPrismaRunRepository(prisma).createRegenerationRun({
        ...createRegenerationInput(prepared, editedUser.id),
        preSendAssistantMessageId: null
      });

      await expect(chatGraph(chat.id)).resolves.toEqual({
        _count: { messages: 2, modelRuns: 1 },
        activeLeafMessageId: regenerated.assistantMessageId,
        title: "Edited user branch"
      });
      await expect(prisma.message.findUniqueOrThrow({
        select: { parentMessageId: true, role: true, status: true },
        where: { id: regenerated.assistantMessageId }
      })).resolves.toEqual({
        parentMessageId: editedUser.id,
        role: "assistant",
        status: "streaming"
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

  it("returns only the owner-authorized run outcome", async () => {
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
      await expect(repository.getRunOutcomeForUser(created.runId, userId)).resolves.toEqual({
        id: created.runId,
        status: "streaming"
      });
      await expect(
        repository.getRunOutcomeForUser(created.runId, "other-user")
      ).resolves.toBeNull();
    });
  });

  it("sets a bounded local title only for a placeholder chat's first run", async () => {
    await withRunUser(async ({ userId }) => {
      const [newChat, alternatePlaceholderChat, namedChat] = await Promise.all([
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
            chatId: alternatePlaceholderChat.id,
            question: "Alternate placeholder gets a local title",
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
            in: [newChat.id, alternatePlaceholderChat.id, namedChat.id]
          }
        }
      });
      const titles = new Map(stored.map((chat) => [chat.id, chat.title]));

      expect(titles.get(newChat.id)).toBe("Explain");
      expect(titles.get(alternatePlaceholderChat.id)).toBe("Alternate placeholder gets a local title");
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

  it("publishes one durable Workspace update when concurrent replay repeats its identity", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Workspace activity replay");
      const event = {
        data: { artifactType: "workspace_activity" as const, payload: { command: { preview: "command" }, id: "command", kind: "command" as const, phase: "running" as const, updateId: "start" } },
        type: "artifact" as const
      };
      const [first, duplicate] = await Promise.all([
        repository.appendRunOutputEvent(created.runId, event),
        repository.appendRunOutputEvent(created.runId, event)
      ]);
      expect(first).toEqual(duplicate);
      expect(first).toMatchObject({ data: { payload: { sequence: 0 } } });
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: created.runId, eventType: "workspace_activity_receipt" } })).toBe(1);
      const chat = await createPrismaChatRepository(prisma).getChat({ chatId: created.chatId, userId });
      const answer = chat?.messages.find((message) => message.id === created.assistantMessageId);
      expect(answer?.workspaceActivity?.entries).toEqual([expect.objectContaining({ id: "command", sequence: 0 })]);
    });
  });

  it("persists only reloadable output artifacts across streaming and completion", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Atomic terminal evidence");
      await repository.appendRunOutputEvent(created.runId, {
        data: {
          artifactType: "reasoning",
          payload: { entry: "start", text: "Streamed reasoning" }
        },
        type: "artifact"
      });
      const completion: NativeRunCompletion = { ...completionInput(created), outputEvents: [
        {
          data: {
            artifactType: "citation",
            payload: {
              index: 1,
              title: "Source",
              url: "https://example.test/source"
            }
          },
          type: "artifact"
        }
      ] };

      await expect(completeNativeRun(prisma, completion)).resolves.toBe(true);
      await expect(
        prisma.modelRunEvent.findMany({
          orderBy: { sequence: "asc" },
          select: { eventType: true, sequence: true },
          where: { modelRunId: created.runId }
        })
      ).resolves.toEqual([
        { eventType: "artifact", sequence: 0 },
        { eventType: "artifact", sequence: 1 }
      ]);
    });
  });

  it.each(["complete", "error", "cancelled"] as const)(
    "retains grounded output through %s with idempotency, reload, and terminal fencing", async (status) => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Grounded lifecycle");
      const display: RunOutputArtifactEvent = { type: "grounding_display", data: {
        provider: "gemini", suggestionsHtml: '<a href="https://www.google.com/search?q=weather">Weather</a>',
        citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.test/source" }]
      } };
      await repository.appendAssistantText(created.assistantMessageId, "Grounded partial", { runId: created.runId });
      await repository.appendRunOutputEvent(created.runId, display);
      await repository.appendRunOutputEvent(created.runId, display);
      await expect(repository.appendRunOutputEvent(created.runId, {
        ...display, data: { ...display.data, runSearch: { callCount: 1, queryCount: 1 } }
      } as never)).rejects.toThrow("run_output_event_invalid");
      if (status === "complete") {
        const completion = { ...completionInput(created), finalText: "Grounded final", outputEvents: [display] };
        expect(await completeNativeRun(prisma, completion)).toBe(true);
        expect(await completeNativeRun(prisma, completion)).toBe(false);
      } else if (status === "error") {
        await repository.failRun(created.runId, created.assistantMessageId,
          { code: "provider_failed", message: "The provider failed." }, { recoveryTerminal: true });
      } else {
        await repository.cancelRun({ payload: cancelPayload, runId: created.runId, userId });
      }
      await repository.appendRunOutputEvent(created.runId, { type: "grounding_display", data: {
        ...display.data, suggestionsHtml: '<a href="https://www.google.com/search?q=late">Late</a>'
      } });
      const events = await prisma.modelRunEvent.findMany({
        orderBy: { sequence: "asc" }, where: { modelRunId: created.runId }
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: "grounding_display", payload: display.data, sequence: 0 });
      const chat = await createPrismaChatRepository(prisma).getChat({ chatId: created.chatId, userId });
      const answer = chat?.messages.find((message) => message.id === created.assistantMessageId);
      expect(answer).toMatchObject({ status,
        content: textMessageContent(status === "complete" ? "Grounded final" : "Grounded partial"),
        artifactSummary: { groundingDisplay: { provider: "gemini", suggestionsHtml: display.data.suggestionsHtml },
          citations: [{ index: 1, title: "Source", url: "https://example.test/source" }] }
      });
      const shares = createPrismaShareRepository(prisma);
      const share = await shares.createChatShare({
        activeLeafMessageId: created.assistantMessageId, chatId: created.chatId,
        shareToken: "synthetic-token", slugHash: randomUUID(), userId
      });
      expect(share && "snapshot" in share ? share.snapshot.messages.at(-1)?.content : null)
        .toEqual(answer?.content);
      expect(JSON.stringify(share)).not.toMatch(/suggestionsHtml|citations|example.test|google.com|runSearch/);
      if (status === "complete") {
        const conversation = await repository.loadConversationContextForExpectedLeaf(created.chatId, userId, created.assistantMessageId);
        expect(JSON.stringify(conversation)).toContain("Grounded final");
      }
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
      ).resolves.toEqual([]);
    });
  });
});
