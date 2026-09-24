// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { prisma } from "../prisma";
import { createPrismaRetentionRepository } from "../retention/prune";
import { createS3StorageAdapter } from "../uploads/storage";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { createWorkspaceSelectedCaptures, type WorkspaceCaptureReference } from "./selectedCapture";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function fixture(project = false) {
  const userId = `selected-capture-${randomUUID()}`;
  const actor = await prisma.user.create({ data: { id: userId, displayName: "Synthetic capture owner", status: "active" } });
  const projectRow = project ? await prisma.project.create({ data: {
    name: "Synthetic capture Project", createdByUserId: userId, createdByDisplayName: actor.displayName,
    grants: { create: { userId, role: "OWNER" } }
  } }) : null;
  const chat = await prisma.chat.create({ data: { title: "Synthetic captured evidence", workspaceEnabled: true,
    ...(projectRow ? { projectId: projectRow.id, createdByUserId: userId, createdByDisplayName: actor.displayName, memoryMode: "EXCLUDED" as const } : { userId }) } });
  let runtimeForCleanup: DeterministicWorkspaceRuntime | undefined;
  let sessionForCleanup: string | undefined;
  let runtimeIdForCleanup: string | undefined;
  cleanups.push(async () => {
    if (runtimeForCleanup && sessionForCleanup) await runtimeForCleanup.removeSession({ sessionId: sessionForCleanup, runtimeSandboxId: runtimeIdForCleanup ?? null });
    const captures = sessionForCleanup ? await prisma.workspaceSelectedCapture.findMany({ where: { workspaceSessionId: sessionForCleanup }, select: { id: true } }) : [];
    await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
    if (sessionForCleanup) await prisma.workspaceSession.deleteMany({ where: { id: sessionForCleanup } });
    await prisma.chat.updateMany({ where: { id: chat.id }, data: { activeLeafMessageId: null } });
    await prisma.message.deleteMany({ where: { chatId: chat.id } });
    await prisma.chat.deleteMany({ where: { id: chat.id } });
    if (captures.length) await prisma.attachmentDeletionJob.deleteMany({ where: {
      OR: captures.map(capture => ({ storageKey: { startsWith: `workspace-captures/${capture.id}/` } }))
    } });
    if (projectRow) await prisma.project.deleteMany({ where: { id: projectRow.id } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });
  const message = await prisma.message.create({ data: {
    chatId: chat.id, role: "user", status: "complete", content: textMessageContent("Capture selected files"),
    ...(projectRow ? { authorUserId: userId, authorDisplayName: actor.displayName, authorProjectRole: "OWNER" as const } : {})
  } });
  const answer = await prisma.message.create({ data: {
    chatId: chat.id, role: "assistant", status: "streaming", parentMessageId: message.id, content: textMessageContent("")
  } });
  const makeRun = () => prisma.modelRun.create({ data: {
    chatId: chat.id, userId, userMessageId: message.id, assistantMessageId: answer.id,
    provider: "fake", modelId: "fake-qsa", normalizedRequest: {}, status: "in_progress",
    ...(projectRow ? { projectRunBinding: { create: { projectId: projectRow.id, initiatorUserId: userId,
      acceptedRole: "OWNER", accessRevision: 1, policyRevision: 1, instructionsRevision: 1, memoryRevision: 0, personalMemoryDisabled: true } } } : {})
  } });
  const run = await makeRun();
  const operation = { generation: 1, owner: `run:${run.id}` };
  const session = await prisma.workspaceSession.create({ data: {
    chatId: chat.id, sandboxName: `aiqsa-ws-${randomUUID()}`, imageRef: config.imageRef, internetEnabled: false,
    policyRevision: 1, state: "RUNNING", version: 1, operationOwner: operation.owner,
    operationExpiresAt: null, expiresAt: new Date(Date.now() + 600_000)
  } });
  sessionForCleanup = session.id;
  const raw = new DeterministicWorkspaceRuntime(config);
  runtimeForCleanup = raw;
  const runtime = fenceDeterministicWorkspaceRuntime(raw);
  await runtime.claimSessionOperation!({ operation, sessionId: session.id, runtimeSandboxId: null });
  const live = await runtime.ensureSession({ operation, sessionId: session.id, runtimeSandboxId: null,
    sandboxName: session.sandboxName, imageRef: config.imageRef, internetEnabled: false, cpus: 1, diskMiB: config.diskMiB, memoryMiB: 1024 });
  runtimeIdForCleanup = live.runtimeSandboxId;
  await prisma.workspaceSession.update({ where: { id: session.id }, data: { runtimeSandboxId: live.runtimeSandboxId } });
  const catalog = await runtime.loadBoundTools({ operation, sessionId: session.id, runtimeSandboxId: live.runtimeSandboxId });
  const bind = (runId: string) => prisma.workspaceRunBinding.create({ data: {
    modelRunId: runId, workspaceSessionId: session.id, imageRef: config.imageRef, internetEnabled: false, policyRevision: 1,
    runtimeVersion: catalog.runtimeVersion, mcpVersion: catalog.mcpVersion, toolCatalogHash: catalog.hash,
    toolDefinitions: JSON.parse(JSON.stringify(catalog.tools)), outputDirectory: workspaceRunOutputDirectory(runId)
  } });
  await bind(run.id);
  const storage = createMemoryStorageAdapter();
  const service = createWorkspaceSelectedCaptures({ prisma, runtime, storage, config });
  const current = { runId: run.id, operation };
  const scope = () => ({ runId: current.runId, userId, consumerKey: "initial" });
  const write = async (root: "project" | "output", path: string, content: string) => {
    await runtime.callBoundTool({ operation: current.operation, sessionId: session.id, runtimeSandboxId: live.runtimeSandboxId,
      modelRunId: current.runId, modelRunToolCallId: randomUUID(), originalName: "sandbox_fs_write",
      arguments: { path: root === "project" ? `/workspace/project/${path}` : `${workspaceRunOutputDirectory(current.runId)}/${path}`, content } });
  };
  const nextRun = async () => {
    await prisma.modelRun.update({ where: { id: current.runId }, data: { status: "complete" } });
    const next = await makeRun();
    await bind(next.id);
    current.runId = next.id;
    current.operation = { owner: `run:${next.id}`, generation: current.operation.generation + 1 };
    await prisma.workspaceSession.update({ where: { id: session.id }, data: {
      version: current.operation.generation, operationOwner: current.operation.owner, state: "RUNNING",
      operationExpiresAt: null
    } });
    await runtime.claimSessionOperation!({ operation: current.operation, sessionId: session.id, runtimeSandboxId: live.runtimeSandboxId });
    return scope();
  };
  return { service, runtime, raw, storage, scope, write, nextRun, current, session, live, chat, projectRow, userId };
}

const selection = [{ root: "project" as const, relativePath: "данные.txt" }];
const create = async (f: Awaited<ReturnType<typeof fixture>>, requestKey = "request") => {
  const captured = await f.service.create({ ...f.scope(), requestKey, files: selection });
  return { ...f.scope(), captureId: captured.id };
};
const read = async (f: Awaited<ReturnType<typeof fixture>>, ref: WorkspaceCaptureReference, path = "project/данные.txt") =>
  new Response(await f.service.openFile({ ...ref, relativePath: path })).text();

describe("selected capture durable ownership", () => {
  it("rejects a timed export owner while the originating run is still active", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "private selected bytes");
    const collect = vi.spyOn(f.runtime, "collectOutputs");
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: {
      operationOwner: `export:${f.current.runId}:fixture`, version: { increment: 1 },
      operationExpiresAt: new Date(Date.now() + 120_000)
    } });
    await expect(create(f)).rejects.toThrow("workspace_capture_stale");
    expect(collect).not.toHaveBeenCalled();
  });

  it("freezes exact bytes, permits independent consumers and never recaptures a changed request", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "original");
    const collect = vi.spyOn(f.runtime, "collectOutputs");
    const ref = await create(f);
    await f.write("project", "данные.txt", "changed later");
    expect(await create(f)).toEqual(ref);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(await read(f, ref)).toBe("original");
    await expect(f.service.create({ ...f.scope(), requestKey: "request", files: [{ root: "output", relativePath: "different.txt" }] }))
      .rejects.toThrow("workspace_capture_unavailable");
    const second = { ...ref, consumerKey: "second" };
    await f.service.acquire(second);
    await f.service.release(ref);
    expect(await read(f, second)).toBe("original");
    await expect(f.service.acquire(ref)).rejects.toThrow("workspace_capture_unavailable");
    await f.service.release(second);
    await f.service.release(second);
    await expect(f.service.lookup(second)).rejects.toThrow("workspace_capture_unavailable");
  });

  it("recovers a runner-committed capture after a lost response without replaying its source read", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "before response loss");
    const collect = f.runtime.collectOutputs.bind(f.runtime);
    const spy = vi.spyOn(f.runtime, "collectOutputs").mockImplementationOnce(async input => {
      const outputs = await collect(input);
      await Promise.all(outputs.map(file => file.body.cancel()));
      throw new Error("synthetic_response_lost");
    });
    await expect(create(f)).rejects.toThrow("synthetic_response_lost");
    await f.write("project", "данные.txt", "after response loss");
    const ref = await create(f);
    expect(spy.mock.calls.map(([input]) => input.capture?.create)).toEqual([true, false]);
    expect(await read(f, ref)).toBe("before response loss");
  });

  it("leaves an unfinished capture unavailable instead of starting it on replay", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "must not be recaptured");
    vi.spyOn(f.runtime, "collectOutputs").mockRejectedValueOnce(new Error("synthetic_before_receiver"));
    await expect(create(f)).rejects.toThrow("synthetic_before_receiver");
    await expect(create(f)).rejects.toThrow();
    expect(await prisma.workspaceCapturedFile.count({ where: { capture: { workspaceSessionId: f.session.id } } })).toBe(0);
  });

  it("retains one canonical object for several consumers and reads it after guest loss on a later admitted run", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "durable bytes");
    const ref = await create(f);
    expect((await f.service.lookup(ref)).readiness).toBe("captured");
    expect((await f.service.retain(ref)).readiness).toBe("durable");
    await f.service.retain(ref);
    expect(f.storage.objects.size).toBe(1);
    const later = { ...await f.nextRun(), captureId: ref.captureId };
    await f.service.acquire(later);
    await f.raw.removeSession({ sessionId: f.session.id, runtimeSandboxId: f.live.runtimeSandboxId });
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { runtimeSandboxId: null, state: "PENDING" } });
    expect(await read(f, later)).toBe("durable bytes");
    const privateFile = await f.service.settleRetained(later, async (_tx, files) => files[0]!);
    expect(f.storage.objects.get(privateFile.storageKey)?.body.toString()).toBe("durable bytes");
    await f.service.release(ref);
    expect(await read(f, later)).toBe("durable bytes");
  });

  it("settles verified streamed bytes in the disposable object store and reads them after guest removal", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "synthetic durable object bytes");
    const ref = await create(f);
    const storage = createS3StorageAdapter();
    const real = createWorkspaceSelectedCaptures({ prisma, runtime: f.runtime, storage, config });
    const keys: string[] = [];
    cleanups.push(async () => { for (const storageKey of keys) await storage.deleteObject(storageKey); });
    try {
      expect((await real.retain(ref)).readiness).toBe("durable");
      const later = { ...await f.nextRun(), captureId: ref.captureId };
      await real.acquire(later);
      await f.raw.removeSession({ sessionId: f.session.id, runtimeSandboxId: f.live.runtimeSandboxId });
      await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { runtimeSandboxId: null, state: "PENDING" } });
      expect(await new Response(await real.openFile({ ...later, relativePath: "project/данные.txt" })).text())
        .toBe("synthetic durable object bytes");
      await real.release(ref);
      await real.release(later);
    } finally {
      keys.push(...(await prisma.workspaceCapturedFile.findMany({ where: { captureId: ref.captureId }, select: { storageKey: true } }))
        .flatMap(file => file.storageKey ? [file.storageKey] : []));
    }
  });

  it("rejects captured-only bytes after disk loss and does not ask the new guest for the old path", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "volatile capture");
    const ref = await create(f);
    const later = { ...await f.nextRun(), captureId: ref.captureId };
    await f.service.acquire(later);
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { runtimeSandboxId: "different-disk" } });
    const collect = vi.spyOn(f.runtime, "collectOutputs");
    await expect(read(f, later)).rejects.toThrow("workspace_capture_unavailable");
    expect(collect).not.toHaveBeenCalled();
  });

  it("keeps upload uncertainty private and uses a fresh attempt key without re-reading mutable guest files", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "source");
    const ref = await create(f);
    const put = f.storage.putObjectStream!.bind(f.storage);
    vi.spyOn(f.storage, "putObjectStream").mockImplementationOnce(async input => { await put(input); throw new Error("synthetic_unknown_store_outcome"); });
    await expect(f.service.retain(ref)).rejects.toThrow("workspace_capture_unavailable");
    expect((await f.service.lookup(ref)).readiness).toBe("captured");
    const pending = await prisma.workspaceCapturedFile.findFirstOrThrow({ where: { captureId: ref.captureId } });
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: pending.storageKey! } })).toBe(1);
    await expect(f.service.retain(ref)).rejects.toThrow("workspace_capture_busy");
    await prisma.workspaceCapturedFile.update({ where: { id: pending.id }, data: { storageLeaseExpiresAt: new Date(0) } });
    await f.write("project", "данные.txt", "changed source");
    expect((await f.service.retain(ref)).readiness).toBe("durable");
    expect(await read(f, ref)).toBe("source");
    const ready = await prisma.workspaceCapturedFile.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ready.storageKey).not.toBe(pending.storageKey);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { in: [pending.storageKey!, ready.storageKey!] } } })).toBe(2);
  });

  it("does not let final release delete a still-open transfer", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "in-flight bytes");
    const ref = await create(f);
    await f.service.retain(ref);
    const body = await f.service.openFile({ ...ref, relativePath: "project/данные.txt" });
    const file = await prisma.workspaceCapturedFile.findFirstOrThrow({ where: { captureId: ref.captureId } });
    await f.service.release(ref);
    const repository = createPrismaRetentionRepository(prisma);
    const now = new Date();
    const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: file.storageKey! } });
    const dry = await repository.findClaimableAttachmentDeletionJobIds({ now, claimableBefore: new Date(now.getTime() + 1000), limit: 100 });
    expect(dry).not.toContain(job.id);
    const first = await repository.claimAttachmentDeletionJobs({ now, claimableBefore: new Date(now.getTime() + 1000), limit: 100 });
    expect(first.some(job => job.storageKey === file.storageKey)).toBe(false);
    expect(await new Response(body).text()).toBe("in-flight bytes");
    expect(await prisma.workspaceCaptureReadLease.count({ where: { captureId: ref.captureId } })).toBe(0);
    const next = await repository.claimAttachmentDeletionJobs({ now: new Date(), claimableBefore: new Date(Date.now() + 1000), limit: 100 });
    expect(next.some(job => job.storageKey === file.storageKey)).toBe(true);
  });

  it("never marks a late upload durable after Stop", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "stop during store");
    const ref = await create(f);
    const put = f.storage.putObjectStream!.bind(f.storage);
    vi.spyOn(f.storage, "putObjectStream").mockImplementationOnce(async input => {
      await put(input);
      await prisma.modelRun.update({ where: { id: f.scope().runId }, data: { status: "cancelled" } });
    });
    await expect(f.service.retain(ref)).rejects.toThrow("workspace_capture_stale");
    const file = await prisma.workspaceCapturedFile.findFirstOrThrow({ where: { captureId: ref.captureId } });
    expect(file.storageState).toBe("STORING");
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: file.storageKey! } })).toBe(1);
  });

  it("fences delayed storage opening and already-open readers after Stop", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "private delayed bytes");
    const ref = await create(f);
    await f.service.retain(ref);
    const stream = await f.service.openFile({ ...ref, relativePath: "project/данные.txt" });
    const get = f.storage.getObjectStream!.bind(f.storage);
    vi.spyOn(f.storage, "getObjectStream").mockImplementationOnce(async (...args) => {
      const object = await get(...args);
      await prisma.modelRun.update({ where: { id: ref.runId }, data: { status: "cancelled" } });
      return object;
    });
    await expect(f.service.openFile({ ...ref, relativePath: "project/данные.txt" })).rejects.toThrow("workspace_capture_stale");
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("workspace_capture_stale");
    expect(await prisma.workspaceCaptureReadLease.count({ where: { captureId: ref.captureId } })).toBe(0);
  });

  it("resolves concurrent image sources without a lock-upgrade deadlock", async () => {
    const f = await fixture();
    await f.write("project", "left.txt", "left bytes");
    await f.write("project", "right.txt", "right bytes");
    const captured = await f.service.create({ ...f.scope(), requestKey: "concurrent-images", files: [
      { root: "project", relativePath: "left.txt" }, { root: "project", relativePath: "right.txt" }
    ] });
    const ref = { ...f.scope(), captureId: captured.id };
    let reads: Promise<Array<PromiseSettledResult<Awaited<ReturnType<typeof f.service.imageSource>>>>> | undefined;
    try {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${f.chat.id} FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        reads = Promise.allSettled(["project/right.txt", "project/left.txt"].map(relativePath => f.service.imageSource({ ...ref, relativePath })));
        // Queue both real transactions behind the same owner. Include indirect
        // waiters because a correct authority lock may serialize before Chat.
        await expect.poll(async () => {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
          const [row] = await tx.$queryRaw<Array<{ count: number }>>`
            WITH RECURSIVE waiting(pid) AS (
              SELECT ${pid}::int
              UNION
              SELECT activity.pid FROM pg_stat_activity activity JOIN waiting
                ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
            ) SELECT (count(*) - 1)::int AS count FROM waiting`;
          return row.count;
        }, { timeout: 3000, interval: 10 }).toBe(2);
      }, { timeout: 5000 });
      const results = await reads!;
      expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") throw result.reason;
        expect(await new Response(await result.value.open()).text()).toBe(index === 0 ? "right bytes" : "left bytes");
      }
      expect(await prisma.workspaceSelectedCapture.count({ where: { modelRunId: ref.runId } })).toBe(1);
    } finally { await reads; }
  });

  it("orders a concurrent user revocation after guarded consumer settlement", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "owned before revocation");
    const ref = await create(f);
    await f.service.retain(ref);
    let entered!: () => void, proceed!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const settlement = f.service.settleRetained(ref, async tx => {
      entered();
      await gate;
      return (await tx.user.findUniqueOrThrow({ where: { id: f.userId }, select: { status: true } })).status;
    });
    await inside;
    const disabled = prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
      await tx.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
    });
    try { await expect(disabled).rejects.toThrow(); } finally { proceed(); }
    expect(await settlement).toBe("active");
    await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
    await expect(f.service.lookup(ref)).rejects.toThrow("workspace_capture_stale");
  });

  it("enforces current user, Project access and cross-chat identity before opening bytes", async () => {
    const f = await fixture(true);
    await f.write("project", "данные.txt", "private Project bytes");
    const ref = await create(f);
    const other = await fixture();
    const collect = vi.spyOn(f.runtime, "collectOutputs");
    await expect(f.service.lookup({ ...ref, userId: other.userId })).rejects.toThrow("workspace_capture_stale");
    await expect(f.service.acquire({ ...other.scope(), captureId: ref.captureId })).rejects.toThrow("workspace_capture_unavailable");
    await prisma.project.update({ where: { id: f.projectRow!.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await expect(read(f, ref)).rejects.toThrow("workspace_capture_stale");
    expect(collect).not.toHaveBeenCalled();
  });

  it("enforces relational immutability and keeps cleanup obligations through parent deletion", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "retained");
    const ref = await create(f);
    await f.service.retain(ref);
    const file = await prisma.workspaceCapturedFile.findFirstOrThrow({ where: { captureId: ref.captureId } });
    await expect(prisma.workspaceSelectedCapture.update({ where: { id: ref.captureId }, data: { runtimeSandboxId: "forged-disk" } })).rejects.toThrow();
    await expect(prisma.workspaceCapturedFile.update({ where: { id: file.id }, data: { checksum: "f".repeat(64) } })).rejects.toThrow();
    await expect(prisma.workspaceCapturedFile.delete({ where: { id: file.id } })).rejects.toThrow();
    const other = await fixture();
    await expect(prisma.workspaceCaptureReference.create({ data: { captureId: ref.captureId, consumerRunId: other.scope().runId, consumerKey: "forged" } })).rejects.toThrow();
    await prisma.attachmentDeletionJob.delete({ where: { storageKey: file.storageKey! } });
    await prisma.modelRun.delete({ where: { id: f.scope().runId } });
    expect(await prisma.workspaceSelectedCapture.count({ where: { id: ref.captureId } })).toBe(0);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: file.storageKey! } })).toBe(1);
    // Parent deletion already removed the capture; retain its exact key for cleanup.
    cleanups.push(async () => { await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: file.storageKey! } }); });
  });

  it("keeps empty regular files captured and refuses an unsupported durable path before any upload", async () => {
    const f = await fixture();
    await f.write("project", "данные.txt", "");
    const ref = await create(f);
    expect(await read(f, ref)).toBe("");
    await expect(f.service.retain(ref)).rejects.toThrow("workspace_capture_unavailable");
    expect((await f.service.lookup(ref)).readiness).toBe("captured");
    expect(f.storage.objects.size).toBe(0);
  });
});
