import { createPrismaShareRepository } from "../shares/prismaRepository";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import { decodeAssistantIdentity, type AssistantIdentity } from "../../contracts/assistants";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { loadAdminUsageQueryRows } from "../auth/adminUsageQueries";
import { mcpRuntimeFingerprint } from "../mcp/access";
import {
  encryptMcpEnvelope,
  mcpRuntimeGenerationEnvelopeContext
} from "../mcp/encryption";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { createPrismaMcpRuntimeRepository } from "../mcp/runtimeRepository";
import { prisma } from "../prisma";
import { createPrismaSettingsRepository } from "../settings/prismaRepository";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import { createKnowledgeFocusedRequest } from "../knowledge/focusedRequest";
import {
  FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
  focusedKnowledgeCallArguments
} from "../knowledge/automaticEvidence";
import { KNOWLEDGE_FOCUSED_OPERATION_NAME } from "../knowledge/retrievalTypes";
import { createPrismaRunRepository } from "./prismaRepository";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AssistantRunConflictError,
  AttachmentLinkConflictError,
  McpRunPlanConflictError,
  type AcceptedRunDefaults,
  type ProjectRunAdmission,
  type RunRepository
} from "./runRepositoryContract";
import {
  parseToolLoopCheckpoint,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";

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

function projectProviderAdmission(userId: string) {
  return loadProviderAdmissionPlan(prisma, {
    executionScope: "project",
    providerConnectionId: providerTemplateIds.fakeConnection,
    providerModelId: providerTemplateIds.fakeModel,
    searchPlan: { mode: "all_selected", optionIds: [] },
    userId
  });
}

function createRunInput(input: {
  assistant?: { assistantId: string; definitionVersion: number; identity: AssistantIdentity };
  attachmentIds?: string[];
  chatId: string;
  defaults?: Partial<AcceptedRunDefaults>;
  nativePdfInput?: boolean;
  project?: ProjectRunAdmission;
  providerAdmissionPlan?: Awaited<ReturnType<typeof projectProviderAdmission>>;
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
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
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
    ...(input.project ? { project: input.project } : {}),
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

  it("admits a Project run with an exact normalized request and no personal Memory binding", async () => {
    await withRunUser(async ({ userId }) => {
      const projectRepository = createPrismaProjectRepository(prisma);
      const createdProject = await projectRepository.create({
        actorDisplayName: "Run Repository Test User",
        description: "Project run admission regression",
        name: `Run project ${randomUUID()}`,
        userId
      });
      if (createdProject.kind !== "ok") throw new Error(`project_create_${createdProject.kind}`);
      const project = createdProject.value;
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Run Repository Test User",
          createdByUserId: userId,
          memoryMode: "EXCLUDED",
          projectId: project.id,
          title: "Project normalized request",
          userId: null
        }
      });
      const recoveryOwnerId = `run-repository-recovery-owner-${randomUUID()}`;

      try {
        const input = createRunInput({
          chatId: chat.id,
          project: {
            accessRevision: project.accessRevision,
            assistantBindings: [],
            defaults: project.defaults,
            instructions: project.instructions,
            instructionsRevision: project.instructionsRevision,
            knowledgeBaseIds: [],
            mcpServerIds: [],
            memoryEnabled: false,
            memoryItems: [],
            memoryRevision: project.memoryRevision,
            modelIds: ["fake-qsa"],
            policy: project.policy,
            policyRevision: project.policyRevision,
            projectId: project.id,
            role: "OWNER",
            searchOptionIds: []
          },
          providerAdmissionPlan: await projectProviderAdmission(userId),
          question: "Keep this request outside Personal Memory",
          userId
        });
        const repository = createPrismaRunRepository(prisma);
        const created = await repository.createRun(input);

        await expect(prisma.modelRun.findUnique({
          select: { normalizedRequest: true, status: true },
          where: { id: created.runId }
        })).resolves.toEqual({
          normalizedRequest: input.normalizedRequest,
          status: "streaming"
        });
        await expect(prisma.projectRunBinding.findUnique({
          where: { modelRunId: created.runId }
        })).resolves.toMatchObject({
          personalMemoryDisabled: true,
          projectId: project.id,
          providerAdmissionFingerprint: input.providerAdmissionPlan?.fingerprint,
          providerConnectionId: providerTemplateIds.fakeConnection,
          providerModelId: providerTemplateIds.fakeModel,
          providerRequiresClientTools: false,
          providerSearchPlan: { mode: "all_selected", optionIds: [] }
        });
        await expect(repository.getRunControlForUser(
          created.runId,
          userId
        )).resolves.toMatchObject({
          project: {
            accessRevision: project.accessRevision,
            projectId: project.id,
            providerAdmissionFingerprint: input.providerAdmissionPlan?.fingerprint,
            providerConnectionId: providerTemplateIds.fakeConnection,
            providerModelId: providerTemplateIds.fakeModel,
            providerSearchPlan: { mode: "all_selected", optionIds: [] }
          }
        });
        await expect(prisma.modelRunMemoryBinding.findUnique({
          where: { modelRunId: created.runId }
        })).resolves.toBeNull();
        await expect(repository.sweepBootOrphanedRuns({
          createdBefore: new Date("2100-01-01T00:00:00.000Z"),
          liveRunIds: []
        })).resolves.toBe(0);
        await expect(prisma.modelRun.findUnique({
          select: { status: true },
          where: { id: created.runId }
        })).resolves.toEqual({ status: "streaming" });

        await repository.appendAssistantText(
          created.assistantMessageId,
          "durable Project partial",
          { runId: created.runId }
        );
        const eventCountBeforeFailure = await prisma.projectEvent.count({
          where: { projectId: project.id }
        });
        await expect(repository.failRun(
          created.runId,
          created.assistantMessageId,
          {
            code: "provider_admission_changed",
            message: "Project provider authority is no longer current."
          },
          { recoveryTerminal: true }
        )).resolves.toBe(true);
        await expect(prisma.message.findUnique({
          select: { content: true },
          where: { id: created.assistantMessageId }
        })).resolves.toEqual({ content: textMessageContent("durable Project partial") });
        await expect(prisma.modelRun.count({
          where: {
            chatId: chat.id,
            status: { in: ["preparing", "queued", "streaming", "in_progress"] }
          }
        })).resolves.toBe(0);
        await expect(prisma.projectEvent.count({
          where: { projectId: project.id }
        })).resolves.toBeGreaterThan(eventCountBeforeFailure);

        await prisma.user.create({
          data: {
            displayName: "Run Recovery Project Owner",
            id: recoveryOwnerId,
            status: "active"
          }
        });
        await prisma.projectGrant.create({
          data: {
            createdByUserId: userId,
            projectId: project.id,
            role: "OWNER",
            userId: recoveryOwnerId
          }
        });
        await prisma.projectGrant.deleteMany({ where: { projectId: project.id, userId } });
        await expect(repository.getRunControlForUser(created.runId, userId)).resolves.toBeNull();
        await expect(repository.getRunControlForRecovery!(created.runId)).resolves.toMatchObject({
          project: { projectId: project.id },
          recoverySettled: true,
          status: "error"
        });

        const legacyRunId = randomUUID();
        await prisma.modelRun.create({
          data: {
            assistantMessageId: created.assistantMessageId,
            chatId: chat.id,
            id: legacyRunId,
            modelId: "fake-qsa",
            normalizedRequest: {},
            projectRunBinding: {
              create: {
                acceptedRole: "OWNER",
                accessRevision: project.accessRevision,
                initiatorUserId: userId,
                instructionsRevision: project.instructionsRevision,
                memoryRevision: project.memoryRevision,
                personalMemoryDisabled: true,
                policyRevision: project.policyRevision,
                projectId: project.id
              }
            },
            provider: "fake",
            status: "streaming",
            userId,
            userMessageId: created.userMessageId
          }
        });
        await expect(repository.getRunControlForRecovery!(legacyRunId)).resolves.toMatchObject({
          projectRecoveryInvalid: true,
          status: "streaming"
        });
        await expect(repository.getRunControlForUser(legacyRunId, userId)).resolves.toBeNull();
        await expect(repository.failRun(
          legacyRunId,
          created.assistantMessageId,
          {
            code: "provider_admission_changed",
            message: "Project provider authority is no longer current."
          },
          { recoveryTerminal: true }
        )).resolves.toBe(true);
        await expect(repository.getRunControlForRecovery!(legacyRunId)).resolves.toMatchObject({
          projectRecoveryInvalid: true,
          recoverySettled: true,
          status: "error"
        });
        await expect(prisma.modelRun.count({
          where: {
            chatId: chat.id,
            status: { in: ["preparing", "queued", "streaming", "in_progress"] }
          }
        })).resolves.toBe(0);
        await expect(repository.getRunControlForRecovery!(created.runId)).resolves.toMatchObject({
          project: { projectId: project.id },
          recoverySettled: true,
          status: "error"
        });
      } finally {
        await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
        await prisma.project.deleteMany({ where: { id: project.id } });
        await prisma.user.deleteMany({ where: { id: recoveryOwnerId } });
      }
    });
  });

  it("keeps persisted Project Memory dormant and never binds it to a new run", async () => {
    await withRunUser(async ({ userId }) => {
      const projectRepository = createPrismaProjectRepository(prisma);
      const createdProject = await projectRepository.create({
        actorDisplayName: "Run Repository Test User",
        description: "Project Memory admission fence",
        name: `Memory-fenced project ${randomUUID()}`,
        userId
      });
      if (createdProject.kind !== "ok") throw new Error(`project_create_${createdProject.kind}`);
      const projectId = createdProject.value.id;

      try {
        const project = await prisma.project.update({
          data: { memoryEnabled: true, memoryRevision: { increment: 1 } },
          where: { id: projectId }
        });
        const chat = await prisma.chat.create({
          data: {
            createdByDisplayName: "Run Repository Test User",
            createdByUserId: userId,
            memoryMode: "EXCLUDED",
            projectId: project.id,
            title: "Project stale Memory item",
            userId: null
          }
        });
        const factId = randomUUID();
        const versionId = randomUUID();
        await prisma.$transaction(async (tx) => {
          await tx.projectMemoryFact.create({
            data: {
              createdByDisplayName: "Run Repository Test User",
              createdByUserId: userId,
              id: factId,
              projectId: project.id
            }
          });
          await tx.projectMemoryFactVersion.create({
            data: {
              createdByDisplayName: "Run Repository Test User",
              createdByUserId: userId,
              factId,
              id: versionId,
              normalizedText: "expired project fact",
              projectId: project.id,
              text: "Expired Project fact",
              validUntil: new Date(0),
              versionNumber: 1
            }
          });
          await tx.projectMemoryFact.update({
            data: { currentVersionId: versionId },
            where: { projectId_id: { id: factId, projectId: project.id } }
          });
        });
        const repository = createPrismaRunRepository(prisma);
        await expect(repository.findOwnedChat(chat.id, userId)).resolves.toMatchObject({
          project: { memoryItems: [] }
        });
        const createdRun = await repository.createRun(createRunInput({
          chatId: chat.id,
          project: {
            accessRevision: project.accessRevision,
            assistantBindings: [],
            defaults: createdProject.value.defaults,
            instructions: project.instructions,
            instructionsRevision: project.instructionsRevision,
            knowledgeBaseIds: [],
            mcpServerIds: [],
            memoryEnabled: true,
            memoryItems: [{
              factId,
              factVersionId: versionId,
              includedText: "Expired Project fact",
              ordinal: 0
            }],
            memoryRevision: project.memoryRevision,
            modelIds: ["fake-qsa"],
            policy: createdProject.value.policy,
            policyRevision: project.policyRevision,
            projectId: project.id,
            role: "OWNER",
            searchOptionIds: []
          },
          providerAdmissionPlan: await projectProviderAdmission(userId),
          question: "Do not admit stale Project Memory",
          userId
        }));
        await expect(prisma.projectMemoryRunItem.count({
          where: { projectRunBindingId: createdRun.runId }
        })).resolves.toBe(0);
        await expect(chatGraph(chat.id)).resolves.toMatchObject({
          _count: { modelRuns: 1 }
        });
      } finally {
        await prisma.modelRun.deleteMany({
          where: { chat: { projectId } }
        });
        await projectRepository.delete({
          actorDisplayName: "Run Repository Test User",
          projectId,
          userId
        });
      }
    });
  });

  it("rechecks exact Assistant provenance inside Project admission", async () => {
    await withRunUser(async ({ userId }) => {
      const projectRepository = createPrismaProjectRepository(prisma);
      const createdProject = await projectRepository.create({
        actorDisplayName: "Run Repository Test User",
        description: "Project Assistant admission fence",
        name: `Assistant-fenced project ${randomUUID()}`,
        userId
      });
      if (createdProject.kind !== "ok") throw new Error(`project_create_${createdProject.kind}`);
      const definition = await prisma.assistantDefinition.create({
        data: {
          ownerUserId: userId,
          avatar: {
            accents: [0, 4],
            backgroundShape: "circle",
            foregroundShape: "diamond",
            kind: "generated",
            paletteId: "ocean",
            recipeVersion: 1,
            rotations: [0, 2]
          },
          name: "Project admission Assistant",
          providerModelId: providerTemplateIds.fakeModel,
          runControls: {},
          searchPlan: { mode: "all_selected", optionIds: [] },
          systemPrompt: "Use only Project context."
        }
      });
      await prisma.assistantDefinition.update({
        data: { archivedAt: new Date() },
        where: { id: definition.id }
      });
      await prisma.projectAssistantBinding.create({
        data: {
          addedByUserId: userId,
          assistantId: definition.id,
          projectId: createdProject.value.id
        }
      });
      const project = await prisma.project.findUniqueOrThrow({ where: { id: createdProject.value.id } });
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Run Repository Test User",
          createdByUserId: userId,
          memoryMode: "EXCLUDED",
          projectId: project.id,
          title: "Project archived Assistant",
          userId: null
        }
      });

      try {
        await expect(createPrismaRunRepository(prisma).createRun(createRunInput({
          assistant: { assistantId: definition.id, definitionVersion: definition.version,
            identity: decodeAssistantIdentity({ name: definition.name, avatar: definition.avatar })! },
          chatId: chat.id,
          project: {
            accessRevision: project.accessRevision,
            assistantBindings: [{ assistantId: definition.id }],
            defaults: createdProject.value.defaults,
            instructions: project.instructions,
            instructionsRevision: project.instructionsRevision,
            knowledgeBaseIds: [],
            mcpServerIds: [],
            memoryEnabled: false,
            memoryItems: [],
            memoryRevision: project.memoryRevision,
            modelIds: ["fake-qsa"],
            policy: createdProject.value.policy,
            policyRevision: project.policyRevision,
            projectId: project.id,
            role: "OWNER",
            searchOptionIds: []
          },
          providerAdmissionPlan: await projectProviderAdmission(userId),
          question: "Do not admit an archived Assistant",
          userId
        }))).rejects.toBeInstanceOf(AssistantRunConflictError);
        await expect(chatGraph(chat.id)).resolves.toMatchObject({
          _count: { messages: 0, modelRuns: 0 },
          activeLeafMessageId: null
        });
      } finally {
        await prisma.project.deleteMany({ where: { id: project.id } });
        await prisma.assistantDefinition.deleteMany({ where: { id: definition.id } });
      }
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

  it("persists idempotent round-zero automatic Knowledge calls before the provider tool loop", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Automatic Knowledge checkpoint");
      const prepare = repository.prepareAutomaticKnowledgeCallBatch;
      const claim = repository.claimAutomaticKnowledgeCall;
      if (!prepare || !claim) throw new Error("automatic Knowledge persistence unavailable");
      const focusedRequest = createKnowledgeFocusedRequest({
        currentUserMessage: "accepted automatic query AX-2026-0842"
      })!;
      const semanticArguments = focusedKnowledgeCallArguments(focusedRequest);
      await prisma.modelRun.update({
        data: {
          normalizedRequest: {
            ...(await prisma.modelRun.findUniqueOrThrow({
              select: { normalizedRequest: true },
              where: { id: created.runId }
            })).normalizedRequest as Record<string, Prisma.JsonValue>,
            knowledgeFocusedRequest: focusedRequest,
            knowledgePlan: {
              baseIds: ["automatic-knowledge-base"],
              mode: "explicit",
              sourceIds: [],
              version: 1
            },
            toolMode: "none"
          }
        },
        where: { id: created.runId }
      });
      const input = {
        calls: [{
          arguments: semanticArguments,
          ordinal: 0,
          providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID
        }],
        runId: created.runId,
        userId
      };

      await prisma.knowledgeRunScope.create({
        data: {
          budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          exclusions: [],
          modelRunId: created.runId,
          resolvedBaseCount: 1,
          resolvedSourceCount: 0,
          selection: {
            baseIds: ["automatic-knowledge-base"],
            mode: "explicit",
            sourceIds: [],
            version: 1
          }
        }
      });

      const prepared = await prepare(input);
      expect(prepared).toMatchObject({ kind: "prepared" });
      if (prepared.kind !== "prepared") throw new Error("automatic Knowledge call not prepared");
      expect(prepared.calls[0]?.arguments).toEqual(semanticArguments);
      await expect(prepare(input)).resolves.toMatchObject({ kind: "reused" });
      await expect(prepare({
        ...input,
        calls: [{
          ...input.calls[0]!,
          arguments: { ...semanticArguments, retrievalQuery: "different query AX-2026-0842" }
        }]
      })).resolves.toEqual({ kind: "conflict" });
      await expect(prepare({
        ...input,
        calls: [...input.calls, { ...input.calls[0]!, ordinal: 1 }]
      })).resolves.toEqual({ kind: "conflict" });

      const claimed = await claim({
        callId: prepared.calls[0]!.id,
        runId: created.runId,
        userId
      });
      expect(claimed).toMatchObject({ kind: "claimed" });
      await expect(claim({
        callId: prepared.calls[0]!.id,
        runId: created.runId,
        userId
      })).resolves.toMatchObject({ kind: "ambiguous" });
      await expect(repository.settleToolLoopCall({
        callId: prepared.calls[0]!.id,
        result: { status: "complete" },
        runId: created.runId,
        state: "complete",
        userId
      })).resolves.toBe("settled");
      await expect(claim({
        callId: prepared.calls[0]!.id,
        runId: created.runId,
        userId
      })).resolves.toMatchObject({ kind: "settled" });

      await expect(repository.beginToolLoopProviderRound({
        providerContinuation: null,
        roundIndex: 1,
        runId: created.runId,
        userId
      })).resolves.toBe("started");
      await expect(prisma.modelRunToolCall.findMany({
        select: { providerCallId: true, roundIndex: true, state: true, toolName: true },
        where: { modelRunId: created.runId }
      })).resolves.toEqual([{
        providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
        roundIndex: 0,
        state: "complete",
        toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
      }]);
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

        await repository.appendAssistantText(
          created.assistantMessageId,
          "discarded draft",
          { runId: created.runId }
        );
        await expect(repository.resetToolLoopAssistantDraft({
          roundIndex: 0,
          runId: created.runId,
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
        })).resolves.toEqual([]);
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
      await expect(repository.completeRun(completionInput(created))).resolves.toBe(false);
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
        await expect(repository.beginToolLoopProviderRound({
          providerContinuation: null,
          roundIndex: 0,
          runId: created.runId,
          userId
        })).resolves.toBe("started");
        const persisted = await repository.persistToolLoopCallBatch({
          calls: [{
            arguments: { goal: "echo a value" },
            ordinal: 0,
            providerCallId: "provider-find-tools-call",
            toolName: "find_tools"
          }],
          providerContinuation: null,
          roundIndex: 0,
          runId: created.runId,
          userId
        });
        if (persisted.kind !== "persisted") throw new Error("expected persisted discovery call");
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

  it("reports whether concrete Search routes are enabled", async () => {
    const enabledStrategyId = `repo-test-enabled-${randomUUID()}`;
    const revisionId = `repo-test-revision-${randomUUID()}`;
    const searchOptionId = `repo-test-option-row-${randomUUID()}`;
    const searchOptionKey = `repo-test-option-${randomUUID()}`;
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
          optionId: searchOptionKey,
          sourceConnectionId
        }
      });
      const strategy = await prisma.searchStrategy.create({
        data: {
          config: { policy: "server-owned" },
          description: "Enabled run admission fixture",
          displayName: "Enabled run admission fixture",
          kind: "openai_native_web_search",
          modelId: "fixture-search-model",
          provider: "system",
          searchOptionId,
          strategyId: enabledStrategyId
        }
      });
      await prisma.searchIntegrationRevision.create({
        data: {
          adapterKind: "answer_provider_hosted",
          configuration: { policy: "server-owned" },
          credentialMode: "answer_provider",
          draftHash: "a".repeat(64),
          id: revisionId,
          revisionNumber: 1,
          searchStrategyId: strategy.id,
          validationEvidence: { status: "available" },
          validationFingerprint: "b".repeat(64)
        }
      });
      await prisma.searchStrategy.update({
        data: { activeRevisionId: revisionId },
        where: { id: strategy.id }
      });

      const repository = createPrismaRunRepository(prisma);

      await expect(repository.isSearchStrategyEnabled(searchOptionKey)).resolves.toBe(true);
      await prisma.searchStrategy.update({
        data: { enabled: false },
        where: { id: strategy.id }
      });
      await expect(repository.isSearchStrategyEnabled(searchOptionKey)).resolves.toBe(false);
      await expect(repository.isSearchStrategyEnabled(`missing-${randomUUID()}`)).resolves.toBe(false);
    } finally {
      await prisma.searchStrategy.updateMany({
        data: { activeRevisionId: null },
        where: { strategyId: enabledStrategyId }
      });
      await prisma.searchIntegrationRevision.deleteMany({
        where: { id: revisionId }
      });
      await prisma.searchStrategy.deleteMany({
        where: { strategyId: enabledStrategyId }
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
        defaultSearchPlan: {
          mode: "model_choice",
          optionIds: ["company-search", "secondary-search"]
        },
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
        defaultSearchPlan: {
          mode: "model_choice",
          optionIds: ["company-search", "secondary-search"]
        },
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

  it("advances source revision once for normal append and once for the winning terminal settlement", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Source counter settlement");

      await expect(prisma.chat.findUniqueOrThrow({
        select: { memoryBranchGeneration: true, memorySourceRevision: true },
        where: { id: created.chatId }
      })).resolves.toEqual({
        memoryBranchGeneration: 0,
        memorySourceRevision: 1
      });
      await repository.appendAssistantText(
        created.assistantMessageId,
        "streamed draft",
        { runId: created.runId }
      );
      await expect(prisma.chat.findUniqueOrThrow({
        select: { memoryBranchGeneration: true, memorySourceRevision: true },
        where: { id: created.chatId }
      })).resolves.toEqual({
        memoryBranchGeneration: 0,
        memorySourceRevision: 1
      });
      await expect(repository.completeRun(completionInput(created))).resolves.toBe(true);
      await expect(repository.completeRun(completionInput(created))).resolves.toBe(false);
      await expect(prisma.chat.findUniqueOrThrow({
        select: { memoryBranchGeneration: true, memorySourceRevision: true },
        where: { id: created.chatId }
      })).resolves.toEqual({
        memoryBranchGeneration: 0,
        memorySourceRevision: 2
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      })).resolves.toEqual({ memoryGeneration: 0, memoryRevision: 0 });
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
        repository.completeRun(completionInput(cancelFirst))
      ).resolves.toBe(false);
      const cancelledState = await expectTerminalState(cancelFirst, "cancelled");
      expect(cancelledState.message.errorMessage).toBe(cancelPayload.message);
      expect(cancelledState.run.errorPayload).toEqual(cancelPayload);

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

  it("atomically marks settled tool-call usage with the replaced run aggregate", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const active = await createActiveRun(repository, userId, "Tool usage checkpoint");
      await expect(repository.beginToolLoopProviderRound({
        providerContinuation: { responseId: "response-before-usage" },
        roundIndex: 0,
        runId: active.runId,
        userId
      })).resolves.toBe("started");
      const persisted = await repository.persistToolLoopCallBatch({
        calls: [{
          arguments: {},
          ordinal: 0,
          providerCallId: "usage-call-1",
          toolName: "lookup"
        }],
        providerContinuation: { responseId: "response-before-usage" },
        roundIndex: 0,
        runId: active.runId,
        userId
      });
      if (persisted.kind !== "persisted") throw new Error("expected tool-call checkpoint");
      const call = persisted.calls[0]!;
      await expect(repository.claimToolLoopCall({
        callId: call.id,
        runId: active.runId,
        userId
      })).resolves.toMatchObject({ kind: "claimed" });
      await expect(repository.settleToolLoopCall({
        callId: call.id,
        result: { status: "complete" },
        runId: active.runId,
        state: "complete",
        userId
      })).resolves.toBe("settled");

      const usageAttributions = [{
        modelId: "tool-model",
        provider: "tool-provider",
        usage: { inputTokens: 3, outputTokens: 0, reasoningTokens: 0, totalTokens: 3 }
      }];
      await expect(repository.recordRunUsageEvents({
        chatId: active.chatId,
        runId: active.runId,
        usageAccountedToolCallIds: [call.id],
        usageAttributions,
        userId
      })).resolves.toBe(true);

      await expect(prisma.modelRunToolCall.findUniqueOrThrow({
        select: { usageAccountedAt: true },
        where: { id: call.id }
      })).resolves.toEqual({ usageAccountedAt: expect.any(Date) });
      await expect(repository.loadRunUsageAttributions({
        runId: active.runId,
        userId
      })).resolves.toEqual([expect.objectContaining({
        modelId: "tool-model",
        provider: "tool-provider",
        usage: expect.objectContaining({ inputTokens: 3, totalTokens: 3 })
      })]);

      await expect(repository.recordRunUsageEvents({
        chatId: active.chatId,
        runId: active.runId,
        usageAccountedToolCallIds: ["missing-tool-call"],
        usageAttributions: [{
          modelId: "incorrect-model",
          provider: "tool-provider",
          usage: { inputTokens: 99, outputTokens: 0, reasoningTokens: 0, totalTokens: 99 }
        }],
        userId
      })).resolves.toBe(false);
      await expect(repository.loadRunUsageAttributions({
        runId: active.runId,
        userId
      })).resolves.toEqual([expect.objectContaining({
        modelId: "tool-model",
        usage: expect.objectContaining({ inputTokens: 3, totalTokens: 3 })
      })]);
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

  it("settles a recovered tool-call error once with output artifacts and usage", async () => {
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
        outputEvents: [
          {
            data: {
              artifactType: "reasoning",
              payload: { text: "Recovered reasoning" }
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
      expect(events).toEqual([{ eventType: "artifact", sequence: 0 }]);
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
          outputEvents: [],
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
          outputEvents: [],
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
        outputEvents: [],
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
          outputEvents: [],
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

  it("persists only reloadable output artifacts across streaming and completion", async () => {
    await withRunUser(async ({ userId }) => {
      const repository = createPrismaRunRepository(prisma);
      const created = await createActiveRun(repository, userId, "Atomic terminal evidence");
      await repository.appendRunOutputEvent(created.runId, {
        data: {
          artifactType: "reasoning",
          payload: { text: "Streamed reasoning" }
        },
        type: "artifact"
      });
      const completion = completionInput(created);
      completion.outputEvents = [
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
        const completion = completionInput(created);
        completion.finalText = "Grounded final";
        completion.outputEvents = [display];
        expect(await repository.completeRun(completion)).toBe(true);
        expect(await repository.completeRun(completion)).toBe(false);
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
        const conversation = await repository.loadConversationContext(created.chatId, userId);
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
