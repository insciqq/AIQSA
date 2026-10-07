// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { prisma } from "@/lib/server/prisma";
import { getWorkspaceConfig } from "./config";
import {
  reconcileWorkspaceAfterRestore,
  runWorkspaceMaintenance
} from "./cleanup";
import type { WorkspaceRuntime } from "./runtime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { namespacedWorkspaceToolName } from "./toolCatalog";
import { scheduledTaskScheduleColumns } from "../scheduledTasks/store";

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

const TEST_USER_PREFIX = "workspace-maintenance-test-";

async function cleanupWorkspaceMaintenanceFixtures(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { id: { startsWith: TEST_USER_PREFIX } }
  });
  const userIds = users.map(({ id }) => id);
  if (userIds.length === 0) return;
  const chats = await prisma.chat.findMany({
    select: { id: true },
    where: { userId: { in: userIds } }
  });
  const chatIds = chats.map(({ id }) => id);
  const sessions = await prisma.workspaceSession.findMany({
    select: { id: true },
    where: { chatId: { in: chatIds } }
  });
  const sessionIds = sessions.map(({ id }) => id);

  await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.chat.updateMany({
    data: { activeLeafMessageId: null },
    where: { id: { in: chatIds } }
  });
  await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.workspaceCleanupJob.deleteMany({
    where: { workspaceSessionId: { in: sessionIds } }
  });
  await prisma.workspaceSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function unused(): never {
  throw new Error("unused");
}

describe("Prisma Workspace maintenance", () => {
  beforeAll(cleanupWorkspaceMaintenanceFixtures);

  afterAll(async () => {
    await cleanupWorkspaceMaintenanceFixtures();
    await prisma.$disconnect();
  });

  it("stops idle sessions, retries durable expiry cleanup, fences restore, and skips active runs", async () => {
    const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
    const now = new Date();
    const staleOperationAt = new Date(now.getTime() - 6 * 60 * 1_000);
    const idleAt = new Date(
      now.getTime() - (config.idleTtlSeconds + 60) * 1_000
    );
    const future = new Date(now.getTime() + config.retentionSeconds * 1_000);
    const expiredAt = new Date(now.getTime() - 60_000);
    const removeSession = vi
      .fn<WorkspaceRuntime["removeSession"]>()
      .mockRejectedValueOnce(new Error("synthetic runner outage"))
      .mockResolvedValue(undefined);
    const stopSession = vi.fn<WorkspaceRuntime["stopSession"]>(async () => undefined);
    const runtime: WorkspaceRuntime = fenceDeterministicWorkspaceRuntime({
      callBoundTool: unused,
      cancelToolCall: unused,
      collectOutputs: unused,
      createProjectArchive: unused,
      ensureSession: unused,
      health: unused,
      listStagedAttachments: unused,
      loadBoundTools: unused,
      removeSession,
      stageAttachments: unused,
      syncPersonalSecrets: unused,
      prepareSkillRun: unused,
      installSkillBundle: unused,
      completeSkillRunPreparation: unused,
      collectBrowserSessions: unused,
      stopSession,
      terminateExecutions: unused
    });

    const user = await prisma.user.create({
      data: { displayName: "Workspace Maintenance Test", id: userId }
    });
    const [expiredChat, idleChat, interruptedChat, activeChat] =
      await Promise.all([
        prisma.chat.create({
          data: { title: "Expired workspace", userId: user.id, workspaceEnabled: true }
        }),
        prisma.chat.create({
          data: { title: "Idle workspace", userId: user.id, workspaceEnabled: true }
        }),
        prisma.chat.create({
          data: { title: "Interrupted workspace", userId: user.id, workspaceEnabled: true }
        }),
        prisma.chat.create({
          data: { title: "Active workspace", userId: user.id, workspaceEnabled: true }
        })
      ]);
    const sessionData = (chatId: string, suffix: string) => ({
      chatId,
      expiresAt: future,
      imageRef: config.imageRef,
      internetEnabled: true,
      policyRevision: 1,
      runtimeSandboxId: `runtime-${suffix}-${randomUUID()}`,
      sandboxName: `aiqsa-ws-${randomUUID()}`
    });
    const expired = await prisma.workspaceSession.create({
      data: {
        ...sessionData(expiredChat.id, "expired"),
        expiresAt: expiredAt,
        lastActiveAt: idleAt,
        state: "READY"
      }
    });
    const idle = await prisma.workspaceSession.create({
      data: {
        ...sessionData(idleChat.id, "idle"),
        lastActiveAt: idleAt,
        state: "RUNNING"
      }
    });
    const interrupted = await prisma.workspaceSession.create({
      data: {
        ...sessionData(interruptedChat.id, "interrupted"),
        lastActiveAt: staleOperationAt,
        lastErrorCode: "workspace_archive_in_progress",
        state: "CREATING",
        updatedAt: staleOperationAt
      }
    });
    const active = await prisma.workspaceSession.create({
      data: {
        ...sessionData(activeChat.id, "active"),
        expiresAt: expiredAt,
        lastActiveAt: idleAt,
        state: "RUNNING"
      }
    });
    const userMessage = await prisma.message.create({
      data: {
        chatId: activeChat.id,
        content: textMessageContent("Keep this session active"),
        modelId: "fake-qsa",
        provider: "fake",
        role: "user",
        status: "complete"
      }
    });
    const assistantMessage = await prisma.message.create({
      data: {
        chatId: activeChat.id,
        content: textMessageContent(""),
        modelId: "fake-qsa",
        parentMessageId: userMessage.id,
        provider: "fake",
        role: "assistant",
        status: "streaming"
      }
    });
    const activeRun = await prisma.modelRun.create({
      data: {
        assistantMessageId: assistantMessage.id,
        chatId: activeChat.id,
        modelId: "fake-qsa",
        normalizedRequest: {},
        provider: "fake",
        status: "streaming",
        userId,
        userMessageId: userMessage.id
      }
    });

    try {
      await expect(runWorkspaceMaintenance({
        config,
        now,
        prisma,
        runtime
      })).resolves.toEqual({
        cleanupClaimed: 1,
        cleanupCompleted: 0,
        cleanupFailed: 1,
        expiredFenced: 1,
        idleFailed: 0,
        idleStopped: 1,
        staleOperationsRecovered: 1,
        staleSessionsSettled: 0,
        staleSessionsStopped: 1
      });
      expect(stopSession).toHaveBeenCalledWith(expect.objectContaining({
        runtimeSandboxId: idle.runtimeSandboxId,
        sessionId: idle.id
      }));
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { lastActiveAt: true, runtimeSandboxId: true, state: true, stoppedAt: true },
        where: { id: idle.id }
      })).resolves.toMatchObject({
        lastActiveAt: idleAt,
        runtimeSandboxId: idle.runtimeSandboxId,
        state: "STOPPED",
        stoppedAt: now
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { state: true },
        where: { id: active.id }
      })).resolves.toEqual({ state: "RUNNING" });

      const failedJob = await prisma.workspaceCleanupJob.findUniqueOrThrow({
        where: { workspaceSessionId: expired.id }
      });
      expect(failedJob).toMatchObject({
        attemptCount: 1,
        claimToken: null,
        lastErrorCode: "workspace_remove_failed",
        state: "FAILED"
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { runtimeSandboxId: true, state: true },
        where: { id: expired.id }
      })).resolves.toEqual({
        runtimeSandboxId: expired.runtimeSandboxId,
        state: "DELETING"
      });

      await expect(runWorkspaceMaintenance({
        config,
        now: failedJob.nextAttemptAt,
        prisma,
        runtime
      })).resolves.toMatchObject({
        cleanupClaimed: 1,
        cleanupCompleted: 1,
        cleanupFailed: 0,
        expiredFenced: 0
      });
      expect(removeSession).toHaveBeenCalledTimes(2);
      await expect(prisma.workspaceCleanupJob.findUnique({
        where: { workspaceSessionId: expired.id }
      })).resolves.toBeNull();
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { lastErrorCode: true, runtimeSandboxId: true, state: true },
        where: { id: expired.id }
      })).resolves.toEqual({
        lastErrorCode: null,
        runtimeSandboxId: null,
        state: "PENDING"
      });

      // The restore reconciler is global; sessions left by other lanes in the
      // shared disposable database count too, so only the fixture rows are exact.
      await prisma.workspaceSession.update({ data: {
        operationOwner: "run:restore_before_first_dispatch", operationExpiresAt: future
      }, where: { id: expired.id } });
      await expect(reconcileWorkspaceAfterRestore(prisma, now)).resolves.toBeGreaterThanOrEqual(4);
      await expect(prisma.workspaceSession.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          lastErrorCode: true,
          operationOwner: true, operationExpiresAt: true,
          runtimeSandboxId: true,
          state: true,
          stoppedAt: true
        },
        where: { id: { in: [expired.id, idle.id, interrupted.id, active.id] } }
      })).resolves.toEqual(
        [expired.id, idle.id, interrupted.id, active.id]
          .sort()
          .map((id) => ({
            id,
            lastErrorCode: "workspace_restored_without_disk",
            operationOwner: null, operationExpiresAt: null,
            runtimeSandboxId: null,
            state: "PENDING",
            stoppedAt: null
          }))
      );
    } finally {
      await prisma.modelRun.deleteMany({ where: { id: activeRun.id } });
      await prisma.chat.updateMany({
        data: { activeLeafMessageId: null },
        where: { id: activeChat.id }
      });
      await prisma.message.deleteMany({ where: { chatId: activeChat.id } });
      await prisma.workspaceCleanupJob.deleteMany({
        where: { workspaceSessionId: { in: [expired.id, idle.id, interrupted.id, active.id] } }
      });
      await prisma.workspaceSession.deleteMany({
        where: { id: { in: [expired.id, idle.id, interrupted.id, active.id] } }
      });
      await prisma.chat.deleteMany({
        where: {
          id: { in: [expiredChat.id, idleChat.id, interruptedChat.id, activeChat.id] }
        }
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("keeps expired overflow out of the idle-stop batch", async () => {
    const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
    const now = new Date();
    const lastActiveAt = new Date(
      now.getTime() - (config.idleTtlSeconds + 120) * 1_000
    );
    const oldestExpiry = new Date(now.getTime() - 120_000);
    const overflowExpiry = new Date(now.getTime() - 60_000);
    const removeSession = vi.fn<WorkspaceRuntime["removeSession"]>(async () => undefined);
    const stopSession = vi.fn<WorkspaceRuntime["stopSession"]>(async () => undefined);
    const runtime: WorkspaceRuntime = fenceDeterministicWorkspaceRuntime({
      callBoundTool: unused,
      cancelToolCall: unused,
      collectOutputs: unused,
      createProjectArchive: unused,
      ensureSession: unused,
      health: unused,
      listStagedAttachments: unused,
      loadBoundTools: unused,
      removeSession,
      stageAttachments: unused,
      syncPersonalSecrets: unused,
      prepareSkillRun: unused,
      installSkillBundle: unused,
      completeSkillRunPreparation: unused,
      collectBrowserSessions: unused,
      stopSession,
      terminateExecutions: unused
    });
    const user = await prisma.user.create({
      data: { displayName: "Workspace Maintenance Overflow Test", id: userId }
    });
    const [oldestChat, overflowChat] = await Promise.all([
      prisma.chat.create({
        data: { title: "Oldest expired workspace", userId, workspaceEnabled: true }
      }),
      prisma.chat.create({
        data: { title: "Overflow expired workspace", userId, workspaceEnabled: true }
      })
    ]);
    const createExpiredSession = (
      chatId: string,
      expiresAt: Date,
      suffix: string
    ) => prisma.workspaceSession.create({
      data: {
        chatId,
        expiresAt,
        imageRef: config.imageRef,
        internetEnabled: true,
        lastActiveAt,
        policyRevision: 1,
        runtimeSandboxId: `runtime-${suffix}-${randomUUID()}`,
        sandboxName: `aiqsa-ws-${randomUUID()}`,
        state: "READY"
      }
    });
    const [oldest, overflow] = await Promise.all([
      createExpiredSession(oldestChat.id, oldestExpiry, "oldest"),
      createExpiredSession(overflowChat.id, overflowExpiry, "overflow")
    ]);

    try {
      await expect(runWorkspaceMaintenance({
        config,
        limit: 1,
        now,
        prisma,
        runtime
      })).resolves.toEqual({
        cleanupClaimed: 1,
        cleanupCompleted: 1,
        cleanupFailed: 0,
        expiredFenced: 1,
        idleFailed: 0,
        idleStopped: 0,
        staleOperationsRecovered: 0,
        staleSessionsSettled: 0,
        staleSessionsStopped: 0
      });
      expect(removeSession).toHaveBeenCalledWith(expect.objectContaining({
        runtimeSandboxId: oldest.runtimeSandboxId,
        sessionId: oldest.id
      }));
      expect(stopSession).toHaveBeenCalledTimes(2);
      expect(stopSession.mock.calls.every(([input]) => input.sessionId === oldest.id)).toBe(true);
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { runtimeSandboxId: true, state: true },
        where: { id: overflow.id }
      })).resolves.toEqual({
        runtimeSandboxId: overflow.runtimeSandboxId,
        state: "READY"
      });
    } finally {
      await prisma.workspaceCleanupJob.deleteMany({
        where: { workspaceSessionId: { in: [oldest.id, overflow.id] } }
      });
      await prisma.workspaceSession.deleteMany({
        where: { id: { in: [oldest.id, overflow.id] } }
      });
      await prisma.chat.deleteMany({
        where: { id: { in: [oldestChat.id, overflowChat.id] } }
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

describe("Prisma Workspace maintenance backstop", () => {
  const BACKSTOP_USER_PREFIX = `${TEST_USER_PREFIX}backstop-`;

  afterEach(async () => {
    const users = await prisma.user.findMany({
      select: { id: true },
      where: { id: { startsWith: BACKSTOP_USER_PREFIX } }
    });
    const userIds = users.map(({ id }) => id);
    if (userIds.length === 0) return;
    const chats = await prisma.chat.findMany({ select: { id: true }, where: { userId: { in: userIds } } });
    const chatIds = chats.map(({ id }) => id);
    await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.chat.updateMany({ data: { activeLeafMessageId: null }, where: { id: { in: chatIds } } });
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  // The 257-execution case takes 4–5 s against PostgreSQL on a loaded host, near the default limit.
  it.each([
    { command: "sandbox_exec_start", state: "running", registeredCount: 1 },
    { command: "sandbox_exec_start", state: "error", registeredCount: 257 },
    { command: "sandbox_shell", state: "complete", registeredCount: 1 },
    { command: "sandbox_exec", state: "error", registeredCount: 1 }
  ] as const)("settles abandoned sessions including unregistered $command/$state and $registeredCount registered executions", async ({ command, state, registeredCount }) => {
    const userId = `${BACKSTOP_USER_PREFIX}${randomUUID()}`;
    const now = new Date();
    const staleAt = new Date(now.getTime() - 6 * 60 * 1_000);
    const future = new Date(now.getTime() + config.retentionSeconds * 1_000);
    const terminateExecutions = vi.fn<WorkspaceRuntime["terminateExecutions"]>(async (input) =>
      input.executions.map((execution) => ({
        outcome: "closed" as const,
        runtimeExecSessionId: execution.runtimeExecSessionId
      })));
    const stopSession = vi.fn<WorkspaceRuntime["stopSession"]>(async () => undefined);
    const runtime: WorkspaceRuntime = fenceDeterministicWorkspaceRuntime({
      callBoundTool: unused,
      cancelToolCall: unused,
      collectOutputs: unused,
      createProjectArchive: unused,
      ensureSession: unused,
      health: unused,
      listStagedAttachments: unused,
      loadBoundTools: unused,
      removeSession: unused,
      stageAttachments: unused,
      syncPersonalSecrets: unused,
      prepareSkillRun: unused,
      installSkillBundle: unused,
      completeSkillRunPreparation: unused,
      collectBrowserSessions: unused,
      stopSession,
      terminateExecutions
    });
    await prisma.user.create({ data: { displayName: "Workspace Backstop Test", id: userId } });
    const chat = async (title: string) => prisma.chat.create({
      data: { title, userId, workspaceEnabled: true }
    });
    const [registeredChat, creatingChat, ambiguousChat] = await Promise.all([
      chat("Registered execution"),
      chat("Creating without runtime"),
      chat("Ambiguous exec start")
    ]);
    const session = (chatId: string, data: Record<string, unknown>) => prisma.workspaceSession.create({
      data: {
        chatId,
        expiresAt: future,
        imageRef: config.imageRef,
        internetEnabled: true,
        lastActiveAt: staleAt,
        policyRevision: 1,
        sandboxName: `aiqsa-ws-${randomUUID()}`,
        updatedAt: staleAt,
        ...data
      }
    });
    const registered = await session(registeredChat.id, {
      runtimeSandboxId: `runtime-registered-${randomUUID()}`,
      state: "RUNNING"
    });
    const creating = await session(creatingChat.id, { runtimeSandboxId: null, state: "CREATING" });
    const ambiguous = await session(ambiguousChat.id, {
      runtimeSandboxId: `runtime-ambiguous-${randomUUID()}`,
      state: "RUNNING"
    });
    const cancelledRun = async (chatId: string, sessionId: string) => {
      const userMessage = await prisma.message.create({
        data: {
          chatId,
          content: textMessageContent("Start a long command"),
          modelId: "fake-qsa",
          provider: "fake",
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId,
          content: textMessageContent("Stopped."),
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "cancelled"
        }
      });
      const run = await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          status: "cancelled",
          userId,
          userMessageId: userMessage.id
        }
      });
      await prisma.workspaceRunBinding.create({
        data: {
          imageRef: config.imageRef,
          internetEnabled: true,
          mcpVersion: "0.6.16",
          modelRunId: run.id,
          outputDirectory: `/workspace/output/${run.id}`,
          policyRevision: 1,
          runtimeVersion: "0.6.16",
          toolCatalogHash: "a".repeat(64),
          toolDefinitions: [{ name: "fixture" }],
          workspaceSessionId: sessionId
        }
      });
      return run;
    };
    const registeredRun = await cancelledRun(registeredChat.id, registered.id);
    const registeredCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: {},
        modelRunId: registeredRun.id,
        ordinal: 0,
        providerCallId: `call_${randomUUID()}`,
        roundIndex: 1,
        state: "complete",
        toolName: namespacedWorkspaceToolName("sandbox_exec_start"),
        workspaceRunBindingId: registeredRun.id
      }
    });
    const execution = await prisma.workspaceExecution.create({
      data: {
        modelRunId: registeredRun.id,
        modelRunToolCallId: registeredCall.id,
        runtimeExecSessionId: "exec-registered",
        workspaceSessionId: registered.id
      }
    });
    const extraCalls = Array.from({ length: registeredCount - 1 }, (_, index) => ({
      id: randomUUID(), arguments: {}, modelRunId: registeredRun.id, ordinal: index + 1,
      providerCallId: `call_${randomUUID()}`, roundIndex: 1, state: "complete" as const,
      toolName: namespacedWorkspaceToolName("sandbox_exec_start"), workspaceRunBindingId: registeredRun.id
    }));
    if (extraCalls.length) {
      await prisma.modelRunToolCall.createMany({ data: extraCalls });
      await prisma.workspaceExecution.createMany({ data: extraCalls.map((call) => ({
        modelRunId: registeredRun.id, modelRunToolCallId: call.id,
        runtimeExecSessionId: `exec-${call.ordinal}`, workspaceSessionId: registered.id
      })) });
    }
    const ambiguousRun = await cancelledRun(ambiguousChat.id, ambiguous.id);
    await prisma.modelRunToolCall.create({
      data: {
        arguments: {},
        modelRunId: ambiguousRun.id,
        ordinal: 0,
        providerCallId: `call_${randomUUID()}`,
        roundIndex: 1,
        state,
        toolName: namespacedWorkspaceToolName(command),
        workspaceRunBindingId: ambiguousRun.id
      }
    });

    await expect(runWorkspaceMaintenance({ config, now, prisma, runtime })).resolves.toMatchObject({
      staleSessionsSettled: 3,
      staleSessionsStopped: 2
    });
    expect(terminateExecutions).toHaveBeenCalledWith(expect.objectContaining({
      executions: expect.arrayContaining([{ modelRunId: registeredRun.id, runtimeExecSessionId: "exec-registered" }]),
      runtimeSandboxId: registered.runtimeSandboxId,
      sessionId: registered.id
    }));
    expect(terminateExecutions.mock.calls.flatMap(([input]) => input.executions)).toHaveLength(registeredCount);
    expect(await prisma.workspaceExecution.count({ where: {
      workspaceSessionId: registered.id, state: { in: ["ACTIVE", "TERMINATING"] }
    } })).toBe(0);
    expect(stopSession).toHaveBeenCalledTimes(7);
    expect(stopSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeSandboxId: ambiguous.runtimeSandboxId,
      sessionId: ambiguous.id
    }));
    await expect(prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { id: registered.id }
    })).resolves.toEqual({ state: "STOPPED" });
    await expect(prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { id: creating.id }
    })).resolves.toEqual({ state: "PENDING" });
    await expect(prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true, stoppedAt: true },
      where: { id: ambiguous.id }
    })).resolves.toEqual({ state: "STOPPED", stoppedAt: now });
    await expect(prisma.workspaceExecution.findUniqueOrThrow({
      select: { state: true },
      where: { id: execution.id }
    })).resolves.toEqual({ state: "CLOSED" });

    await expect(prisma.workspaceExecution.count({ where: {
      workspaceSessionId: ambiguous.id, state: "LOST", lastErrorCode: "workspace_execution_stopped"
    } })).resolves.toBe(1);

    // Nothing left to settle: the backstop is idempotent.
    await expect(runWorkspaceMaintenance({ config, now, prisma, runtime })).resolves.toMatchObject({
      staleSessionsSettled: 0,
      staleSessionsStopped: 0
    });
  }, 20_000);
});

describe("Prisma Workspace residency and retention of scheduled tasks", () => {
  beforeAll(cleanupWorkspaceMaintenanceFixtures);
  afterAll(cleanupWorkspaceMaintenanceFixtures);

  it("keeps a same-chat task's disk past expiry, stops every VM after an unattended run settles and lifts the pin on pause", async () => {
    const now = new Date();
    const stopSession = vi.fn<WorkspaceRuntime["stopSession"]>(async () => undefined);
    const removeSession = vi.fn<WorkspaceRuntime["removeSession"]>(async () => undefined);
    const runtime: WorkspaceRuntime = fenceDeterministicWorkspaceRuntime({
      callBoundTool: unused, cancelToolCall: unused, collectOutputs: unused, createProjectArchive: unused, ensureSession: unused,
      health: unused, listStagedAttachments: unused, loadBoundTools: unused, removeSession, stageAttachments: unused,
      syncPersonalSecrets: unused, prepareSkillRun: unused, installSkillBundle: unused, completeSkillRunPreparation: unused,
      collectBrowserSessions: unused, stopSession, terminateExecutions: unused
    });
    const recent = new Date(now.getTime() - 60_000);
    /** An owner's chat whose Workspace VM is up; its newest run is `scheduled` or the owner's own, settled. */
    async function residentChat(input: Readonly<{ expired: boolean; scheduled: boolean; task?: "active" | "paused" }>) {
      const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
      await prisma.user.create({ data: { displayName: "Workspace residency test", id: userId } });
      const chat = await prisma.chat.create({ data: { title: "Synthetic task chat", userId, workspaceEnabled: true } });
      const task = input.task ? await prisma.scheduledTask.create({ data: {
        ...scheduledTaskScheduleColumns({ kind: "weekly", time: "09:00", days: ["mon"] }), chatId: chat.id, chatMode: "SAME",
        modelId: "fake-qsa", nextRunAt: input.task === "active" ? new Date(now.getTime() + 6 * 86_400_000) : null,
        prompt: "Synthetic weekly prompt", provider: "fake", status: input.task === "active" ? "ACTIVE" : "PAUSED",
        timeZone: "Europe/Moscow", title: "Synthetic weekly task", userId, workspaceEnabled: true
      } }) : null;
      const session = await prisma.workspaceSession.create({ data: {
        chatId: chat.id, expiresAt: input.expired ? new Date(now.getTime() - 60_000) : new Date(now.getTime() + 3_600_000),
        imageRef: config.imageRef, internetEnabled: true, lastActiveAt: recent, policyRevision: 1,
        runtimeSandboxId: `runtime-${randomUUID()}`, sandboxName: `aiqsa-ws-${randomUUID()}`, state: "READY"
      } });
      const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic question"),
        modelId: "fake-qsa", provider: "fake", role: "user", status: "complete" } });
      const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic answer"),
        modelId: "fake-qsa", parentMessageId: question.id, provider: "fake", role: "assistant", status: "complete" } });
      const run = await prisma.modelRun.create({ data: {
        assistantMessageId: answer.id, chatId: chat.id, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "complete",
        userId, userMessageId: question.id,
        ...(input.scheduled ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: task?.id ?? randomUUID() } : {})
      } });
      await prisma.workspaceRunBinding.create({ data: {
        imageRef: config.imageRef, internetEnabled: true, mcpVersion: "fixture", modelRunId: run.id, outputDirectory: `/workspace/output/${run.id}`,
        policyRevision: 1, runtimeVersion: "fixture", toolCatalogHash: "a".repeat(64), toolDefinitions: [{ name: "fixture" }], workspaceSessionId: session.id
      } });
      return { chat, run, session, task, userId };
    }

    // A burst of two owners whose unattended runs just settled, one with an expired disk its weekly task pins.
    const pinned = await residentChat({ expired: true, scheduled: true, task: "active" });
    const other = await residentChat({ expired: false, scheduled: true, task: "active" });
    // The same weekly task, paused: its disk returns to the normal retention, which has passed.
    const paused = await residentChat({ expired: true, scheduled: true, task: "paused" });
    // The owner's own conversation keeps its VM until the idle timer.
    const interactive = await residentChat({ expired: false, scheduled: false });
    const sessions = [pinned, other, paused, interactive].map(({ session }) => session.id);
    try {
      await runWorkspaceMaintenance({ config, now, prisma, runtime });
      const state = async () => Object.fromEntries((await prisma.workspaceSession.findMany({
        select: { id: true, runtimeSandboxId: true, state: true }, where: { id: { in: sessions } }
      })).map((row) => [row.id, row]));
      const after = await state();
      // No VM of a settled unattended run stays resident; their disks stay.
      expect(after[pinned.session.id]).toMatchObject({ runtimeSandboxId: pinned.session.runtimeSandboxId, state: "STOPPED" });
      expect(after[other.session.id]).toMatchObject({ runtimeSandboxId: other.session.runtimeSandboxId, state: "STOPPED" });
      expect(stopSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: pinned.session.id }));
      expect(stopSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: other.session.id }));
      expect(await prisma.workspaceCleanupJob.count({ where: { workspaceSessionId: pinned.session.id } })).toBe(0);
      // The paused task's disk is cleaned up; the interactive VM keeps running.
      expect(removeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: paused.session.id }));
      expect(after[interactive.session.id]).toMatchObject({ state: "READY" });
      const resident = Object.values(after).filter((row) => row.runtimeSandboxId !== null && ["READY", "RUNNING"].includes(row.state));
      expect(resident.map((row) => row.id)).toEqual([interactive.session.id]);

      // Once the task stops pinning (switched off), the expired disk follows the normal retention.
      await prisma.scheduledTask.update({ data: { workspaceEnabled: false }, where: { id: pinned.task!.id } });
      await runWorkspaceMaintenance({ config, now, prisma, runtime });
      expect(removeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: pinned.session.id }));
    } finally {
      const all = [pinned, other, paused, interactive];
      await prisma.scheduledTask.deleteMany({ where: { userId: { in: all.map(({ userId }) => userId) } } });
      await prisma.workspaceRunBinding.deleteMany({ where: { workspaceSessionId: { in: sessions } } });
      await prisma.modelRun.deleteMany({ where: { id: { in: all.map(({ run }) => run.id) } } });
      await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: { in: sessions } } });
      await prisma.workspaceSession.deleteMany({ where: { id: { in: sessions } } });
    }
  });
});
