// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { runWorkspaceMaintenance } from "../workspace/cleanup";
import { getWorkspaceConfig } from "../workspace/config";
import { createPrismaWorkspaceCoordinatorRepository } from "../workspace/coordinator";
import { DeterministicWorkspaceRuntime } from "../workspace/deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "../workspace/fencedRuntime";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createPrismaScheduledWorkspaceCarryover, scheduledCarryoverOperationOwner } from "./workspaceCarryover";
import { scheduledTaskScheduleColumns } from "./store";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const users: string[] = [];

/** An owner with an active same-chat task with Workspace on, whose October chat has a disk with a project file. */
async function fixture() {
  const userId = `scheduled-carryover-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic Workspace carry-over", email: `${userId}@example.test`, id: userId,
    status: "active" } });
  users.push(userId);
  const october = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Synthetic brief · October 2026", userId,
    workspaceEnabled: true } });
  const task = await prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatId: october.id, chatMode: "SAME", emailNotify: false,
    modelId: "fake-qsa", nextRunAt: new Date(Date.now() + 86_400_000), prompt: "Synthetic scheduled prompt", provider: "fake",
    searchEnabled: false, status: "ACTIVE", timeZone: "Europe/Moscow", title: "Synthetic brief", userId, workspaceEnabled: true
  } });
  await prisma.chat.update({ data: { scheduledTaskId: task.id }, where: { id: october.id } });
  const runtime = new DeterministicWorkspaceRuntime(config);
  const sessionId = `ws_${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
  const sandboxName = `aiqsa-ws-${sessionId}`;
  const disk = await runtime.ensureSession({ ...config, internetEnabled: false, runtimeSandboxId: null, sandboxName, sessionId });
  const session = await prisma.workspaceSession.create({ data: {
    chatId: october.id, expiresAt: new Date(Date.now() + 3_600_000), id: sessionId, imageRef: config.imageRef, internetEnabled: false,
    policyRevision: 1, runtimeSandboxId: disk.runtimeSandboxId, sandboxName, state: "STOPPED", stoppedAt: new Date()
  } });
  await runtime.callBoundTool({ arguments: { content: "carried project bytes", path: "/workspace/project/notes.txt" },
    modelRunId: "fixture", modelRunToolCallId: "write", originalName: "sandbox_fs_write", runtimeSandboxId: disk.runtimeSandboxId,
    sessionId });
  const storage = createMemoryStorageAdapter();
  const fenced = fenceDeterministicWorkspaceRuntime(runtime);
  return { carry: createPrismaScheduledWorkspaceCarryover({ prisma, runtime: fenced, storage }), october, runtime: fenced, session, storage,
    task, userId };
}

/** A settled turn in `chatId`; a scheduled run of `taskId` when given, the owner's own otherwise. */
async function run(chatId: string, userId: string, taskId?: string, status: "complete" | "streaming" = "complete") {
  const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic question"), role: "user" } });
  const answer = await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic answer"),
    parentMessageId: question.id, role: "assistant" } });
  return prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status, userId,
    userMessageId: question.id,
    ...(taskId ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: taskId } : {})
  } });
}

afterEach(async () => {
  const ids = users.splice(0);
  const chatIds = (await prisma.chat.findMany({ select: { id: true }, where: { userId: { in: ids } } })).map(({ id }) => id);
  const seeds = await prisma.chatContinuationWorkspaceSeed.findMany({ select: { id: true, storageKey: true }, where: {
    OR: [{ sourceChatId: { in: chatIds } }, { newChatId: { in: chatIds } }, { scheduledTask: { userId: { in: ids } } }]
  } });
  await prisma.chatContinuationWorkspaceSeed.deleteMany({ where: { id: { in: seeds.map(({ id }) => id) } } });
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  const sessions = (await prisma.workspaceSession.findMany({ select: { id: true }, where: { chatId: { in: chatIds } } }))
    .map(({ id }) => id);
  await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: { in: sessions } } });
  await prisma.workspaceSession.deleteMany({ where: { id: { in: sessions } } });
  await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  const keys = seeds.flatMap(({ storageKey }) => storageKey ? [storageKey] : []);
  await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: keys } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted Workspace carry-over of a scheduled task's rotation", () => {
  it("captures the old chat's project into a private seed and leaves its disk stopped and unowned", async () => {
    const f = await fixture();
    const result = await f.carry({ sourceChatId: f.october.id, taskId: f.task.id, userId: f.userId });
    if (result.kind !== "ready") throw new Error(`carry-over not ready: ${result.kind}`);
    const seed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: result.seedId } });
    expect(seed).toMatchObject({ continuationId: null, newChatId: null, scheduledTaskId: f.task.id, sourceChatId: f.october.id,
      status: "READY", storageKey: `workspace-continuation/${result.seedId}.tar.gz` });
    // Held for the admission that transfers it.
    expect(seed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(f.storage.objects.has(seed.storageKey!)).toBe(true);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.session.id } }))
      .toMatchObject({ operationOwner: null, runtimeSandboxId: f.session.runtimeSandboxId, state: "STOPPED", version: 2 });
    // Maintenance leaves a seed its admission still holds, never an attachment.
    await prisma.chatContinuationWorkspaceSeed.update({ data: { updatedAt: new Date(Date.now() - 600_000) }, where: { id: seed.id } });
    await runWorkspaceMaintenance({ config, prisma, runtime: f.runtime });
    expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: seed.id } })).toMatchObject({ status: "READY" });
    expect(await prisma.attachment.count({ where: { storageKey: seed.storageKey! } })).toBe(0);

    // The next attempt replaces a seed that never reached a new chat and queues its object for deletion.
    const again = await f.carry({ sourceChatId: f.october.id, taskId: f.task.id, userId: f.userId });
    expect(again.kind).toBe("ready");
    expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: seed.id } }))
      .toMatchObject({ leaseExpiresAt: null, status: "ABANDONED" });
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey! } })).toBe(1);
  });

  it("carries nothing without a disk, waits for a busy chat or session, and fails only a project that cannot be archived", async () => {
    const f = await fixture();
    const input = { sourceChatId: f.october.id, taskId: f.task.id, userId: f.userId };
    // No disk at all: the new chat starts empty.
    const bare = await prisma.chat.create({ data: { title: "Synthetic brief · September 2026", userId: f.userId } });
    expect(await f.carry({ ...input, sourceChatId: bare.id })).toEqual({ kind: "none" });
    // Another owner's chat is never read.
    expect(await f.carry({ ...input, userId: `scheduled-carryover-test-${randomUUID()}` })).toEqual({ kind: "none" });
    // A process without the runtime cannot capture: it waits.
    expect(await createPrismaScheduledWorkspaceCarryover({ prisma })(input)).toEqual({ kind: "retry" });

    // The owner's own run in the old chat is still going.
    const busy = await run(f.october.id, f.userId, undefined, "streaming");
    expect(await f.carry(input)).toEqual({ kind: "busy" });
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: busy.id } });
    // The disk is busy with another operation.
    await prisma.workspaceSession.update({ data: { operationExpiresAt: new Date(Date.now() + 60_000), operationOwner: "run:other" },
      where: { id: f.session.id } });
    expect(await f.carry(input)).toEqual({ kind: "retry" });
    await prisma.workspaceSession.update({ data: { operationExpiresAt: null, operationOwner: null }, where: { id: f.session.id } });

    // A runtime outage is retried; a project too large to archive fails the occurrence.
    const capture = vi.spyOn(f.runtime, "createProjectArchive");
    capture.mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
    expect(await f.carry(input)).toEqual({ kind: "retry" });
    capture.mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_archive_limit_exceeded"));
    expect(await f.carry(input)).toEqual({ kind: "failed" });
    const failed = await prisma.chatContinuationWorkspaceSeed.findMany({ where: { scheduledTaskId: f.task.id } });
    expect(failed.map((seed) => [seed.status, seed.failureCode]).sort()).toEqual([
      ["ABANDONED", "workspace_runtime_unavailable"], ["FAILED", "workspace_archive_limit_exceeded"]
    ]);
    // Either way the disk's operation was retired.
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.session.id } })).toMatchObject({ operationOwner: null });
    expect(scheduledCarryoverOperationOwner("seed-1")).toBe("scheduled-carryover:seed-1");
  });

  it("holds every run of the new chat to the carried files until a restore succeeds, keeping them when one fails", async () => {
    const f = await fixture();
    const result = await f.carry({ sourceChatId: f.october.id, taskId: f.task.id, userId: f.userId });
    if (result.kind !== "ready") throw new Error(`carry-over not ready: ${result.kind}`);
    const november = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", scheduledTaskId: f.task.id,
      title: "Synthetic brief · November 2026", userId: f.userId, workspaceEnabled: true } });
    await prisma.scheduledTask.update({ data: { chatId: november.id }, where: { id: f.task.id } });
    await prisma.chatContinuationWorkspaceSeed.update({ data: { leaseExpiresAt: null, newChatId: november.id, status: "TRANSFERRED" },
      where: { id: result.seedId } });
    const scheduled = await run(november.id, f.userId, f.task.id, "streaming");
    const own = await run(november.id, f.userId);
    const destination = await prisma.workspaceSession.create({ data: {
      chatId: november.id, expiresAt: new Date(Date.now() + 3_600_000), imageRef: config.imageRef, internetEnabled: false,
      operationOwner: "run:destination", policyRevision: 1, sandboxName: `aiqsa-ws-${randomUUID()}`, version: 1
    } });
    const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
    const claim = () => repository.claimContinuationSeed!({ chatId: november.id,
      operation: { generation: 1, owner: "run:destination" }, sessionId: destination.id });
    /** A failed restore: the claim is released and the archive kept. */
    const fail = async (claimed: Awaited<ReturnType<typeof claim>>) => {
      expect(await repository.settleContinuationSeed!({ id: claimed!.id, status: "TRANSFERRED", token: claimed!.token })).toBe(true);
      const released = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: result.seedId } });
      expect(released).toMatchObject({ leaseExpiresAt: null, leaseToken: null, status: "TRANSFERRED" });
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: released.storageKey! } })).toBe(0);
      expect(f.storage.objects.has(released.storageKey!)).toBe(true);
    };

    // The task's run restores before its first request; the owner's run restores at its first Workspace use.
    expect(await repository.pendingCarryover!({ chatId: november.id, runId: scheduled.id })).toBe(true);
    expect(await repository.pendingCarryover!({ chatId: november.id, runId: own.id })).toBe(false);
    const first = await claim();
    expect(first).toMatchObject({ id: result.seedId, required: true });
    // While that restore holds the seed, another start fails visibly instead of starting empty.
    await expect(claim()).rejects.toMatchObject({ code: "workspace_carryover_unavailable" });
    await fail(first);
    // The owner's own run is held to the same files: its failed restore discards nothing either.
    const owners = await claim();
    expect(owners).toMatchObject({ id: result.seedId, required: true });
    await fail(owners);
    expect(await repository.pendingCarryover!({ chatId: november.id, runId: scheduled.id })).toBe(true);

    // A successful restore ends the hold.
    const restored = await claim();
    expect(await repository.settleContinuationSeed!({ id: restored!.id, status: "RESTORED", token: restored!.token })).toBe(true);
    expect(await repository.pendingCarryover!({ chatId: november.id, runId: scheduled.id })).toBe(false);
    expect(await claim()).toBeNull();
  });

  it("leaves an ordinary continuation seed once its task is deleted", async () => {
    const f = await fixture();
    const result = await f.carry({ sourceChatId: f.october.id, taskId: f.task.id, userId: f.userId });
    if (result.kind !== "ready") throw new Error(`carry-over not ready: ${result.kind}`);
    const november = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Synthetic brief · November 2026",
      userId: f.userId, workspaceEnabled: true } });
    await prisma.chatContinuationWorkspaceSeed.update({ data: { leaseExpiresAt: null, newChatId: november.id, status: "TRANSFERRED" },
      where: { id: result.seedId } });
    await prisma.scheduledTask.delete({ where: { id: f.task.id } });
    const destination = await prisma.workspaceSession.create({ data: {
      chatId: november.id, expiresAt: new Date(Date.now() + 3_600_000), imageRef: config.imageRef, internetEnabled: false,
      operationOwner: "run:destination", policyRevision: 1, sandboxName: `aiqsa-ws-${randomUUID()}`, version: 1
    } });
    const claimed = await createPrismaWorkspaceCoordinatorRepository(prisma).claimContinuationSeed!({ chatId: november.id,
      operation: { generation: 1, owner: "run:destination" }, sessionId: destination.id });
    expect(claimed).toMatchObject({ id: result.seedId });
    expect(claimed).not.toHaveProperty("required");
  });

  it("keeps the old chat's disk past its expiry until the new chat restored the carried files", async () => {
    const f = await fixture();
    const result = await f.carry({ sourceChatId: f.october.id, taskId: f.task.id, userId: f.userId });
    if (result.kind !== "ready") throw new Error(`carry-over not ready: ${result.kind}`);
    const november = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Synthetic brief · November 2026",
      userId: f.userId, workspaceEnabled: true } });
    await prisma.scheduledTask.update({ data: { chatId: november.id }, where: { id: f.task.id } });
    await prisma.chatContinuationWorkspaceSeed.update({ data: { leaseExpiresAt: null, newChatId: november.id, status: "TRANSFERRED" },
      where: { id: result.seedId } });
    // The old chat's disk is past its expiry; a session never expires before its last activity.
    const expired = new Date(Date.now() - 60_000);
    await prisma.workspaceSession.update({ data: { expiresAt: expired, lastActiveAt: expired }, where: { id: f.session.id } });
    const removeSession = vi.spyOn(f.runtime, "removeSession");
    const removed = () => removeSession.mock.calls.some(([call]) => call.sessionId === f.session.id);

    await runWorkspaceMaintenance({ config, prisma, runtime: f.runtime });
    expect(removed()).toBe(false);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: f.session.id } }))
      .toMatchObject({ runtimeSandboxId: f.session.runtimeSandboxId });

    await prisma.chatContinuationWorkspaceSeed.update({ data: { status: "RESTORED" }, where: { id: result.seedId } });
    await runWorkspaceMaintenance({ config, prisma, runtime: f.runtime });
    expect(removed()).toBe(true);
  });
});
