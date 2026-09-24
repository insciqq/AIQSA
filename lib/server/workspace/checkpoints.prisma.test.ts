// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { prisma } from "../prisma";
import { createWorkspaceCheckpoints } from "./checkpoints";
import { createWorkspaceCheckpointStore } from "./checkpointStore";
import { parseWorkspaceCheckpointInput } from "./checkpointInput";
import { failWorkspaceExportsForLostDisk } from "./sessionOperation";
import { createPrismaAttachmentDownloadRepository } from "../uploads/downloadRepository";
import { createWorkspaceExportHistoryRepository } from "./exportHistoryRepository";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";
import type { ProviderRunRequest } from "../providers/types";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { createWorkspaceSelectedCaptures } from "./selectedCapture";

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
    await prisma.attachment.deleteMany({ where: { chatId: chat.id } });
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
  return { service, runtime, raw, storage, scope, write, nextRun, current, session, live, chat, projectRow, userId, answer };
}


async function invocation(f: Awaited<ReturnType<typeof fixture>>, ordinal = 0) {
  const call = { id: `checkpoint-${ordinal}`, name: "checkpoint_outputs", arguments: { files: ["project/design.psd"], description: "Intermediate design" } };
  const tool = await prisma.modelRunToolCall.create({ data: { modelRunId: f.current.runId, workspaceRunBindingId: f.current.runId,
    providerCallId: call.id, toolName: call.name, arguments: call.arguments, state: "running", roundIndex: 1, ordinal } });
  const context = { runId: f.current.runId, userId: f.userId, persistedToolCallId: tool.id,
    request: { workspace: {}, workspaceCheckpoints: true, toolMode: "auto" } as ProviderRunRequest };
  return { call, tool, context, service: createWorkspaceCheckpoints(prisma, f.service, config.outputTotalMaxBytes) };
}

describe("Workspace draft checkpoint persistence", () => {
  it("rejects an export lease before reserving a checkpoint for the still-active run", async () => {
    const f = await fixture();
    const inv = await invocation(f);
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: {
      operationOwner: `export:${f.current.runId}:fixture`, version: { increment: 1 },
      operationExpiresAt: new Date(Date.now() + 120_000)
    } });
    await expect(inv.service.execute(inv.call, inv.context)).rejects.toThrow("workspace_checkpoint_unavailable");
    expect(await prisma.workspaceOutputCheckpoint.count({ where: { modelRunId: f.current.runId } })).toBe(0);
  });

  it.each(["error", "cancelled"] as const)("keeps independently recorded bytes through %s and failed final export/disk loss", async status => {
    const f = await fixture();
    await f.write("project", "design.psd", "version-one-independent-oracle");
    const first = await invocation(f);
    await first.service.execute(first.call, first.context);
    // This receipt is read before failure, outside guest/model prose.
    const receipt = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: first.tool.id }, include: { files: { include: { attachment: true } } } });
    expect(receipt.state).toBe("SETTLED");
    const version = receipt.files[0]!.attachment;
    const before = await f.storage.getObject(version.storageKey);
    expect(createHash("sha256").update(before.body).digest("hex")).toBe(version.checksum);
    await f.write("project", "design.psd", "later-changed-version");
    await prisma.modelRun.update({ where: { id: f.current.runId }, data: { status } });
    await prisma.$transaction(tx => failWorkspaceExportsForLostDisk(tx, f.session.id));
    await f.raw.removeSession({ sessionId: f.session.id, runtimeSandboxId: f.live.runtimeSandboxId });
    expect(await prisma.workspaceRunBinding.findUnique({ where: { modelRunId: f.current.runId } })).toMatchObject({ exportState: "FAILED", lastExportErrorCode: "workspace_session_lost" });
    const download = await createPrismaAttachmentDownloadRepository(prisma).resolve({ attachmentId: version.id, userId: f.userId });
    expect(download?.storageKey).toBe(version.storageKey);
    expect((await f.storage.getObject(download!.storageKey)).body).toEqual(before.body);
    expect(await createPrismaAttachmentDownloadRepository(prisma).resolve({ attachmentId: version.id, userId: "foreign" })).toBeNull();
    await prisma.chat.update({ where: { id: f.chat.id }, data: { activeLeafMessageId: f.answer.id } });
    const history = await createWorkspaceExportHistoryRepository(prisma).list({ chatId: f.chat.id, userId: f.userId, cursor: null });
    expect(history?.exports[0]?.files[0]).toMatchObject({ attachmentId: version.id, checkpoint: { id: receipt.id } });
    // A later accepted branch descendant discovers the exact saved attachment.
    const continuation = await prisma.message.create({ data: { chatId: f.chat.id, parentMessageId: f.answer.id, role: "user", status: "complete", content: textMessageContent("Continue") } });
    const nextAnswer = await prisma.message.create({ data: { chatId: f.chat.id, parentMessageId: continuation.id, role: "assistant", status: "streaming", content: textMessageContent("") } });
    const nextRun = await prisma.modelRun.create({ data: { chatId: f.chat.id, userId: f.userId, userMessageId: continuation.id,
      assistantMessageId: nextAnswer.id, provider: "fake", modelId: "fake-qsa", normalizedRequest: {}, status: "in_progress" } });
    const oldBinding = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: f.current.runId } });
    await prisma.workspaceRunBinding.create({ data: { modelRunId: nextRun.id, workspaceSessionId: f.session.id,
      imageRef: oldBinding.imageRef, internetEnabled: false, policyRevision: oldBinding.policyRevision, runtimeVersion: oldBinding.runtimeVersion,
      mcpVersion: oldBinding.mcpVersion, toolCatalogHash: oldBinding.toolCatalogHash, toolDefinitions: oldBinding.toolDefinitions as never,
      outputDirectory: workspaceRunOutputDirectory(nextRun.id) } });
    const next = { runId: nextRun.id };
    const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
    const binding = await repository.binding({ runId: next.runId, userId: f.userId });
    expect(await repository.attachments(binding!)).toContainEqual(expect.objectContaining({ attachmentId: version.id, checksum: version.checksum, storageKey: version.storageKey }));
  });

  it("keeps two same-name versions immutable and never lets an unsuccessful new checkpoint replace them", async () => {
    const f = await fixture();
    const saved = [];
    for (let i = 0; i < 2; i++) {
      await f.write("project", "design.psd", `independent-version-${i}`);
      const inv = await invocation(f, i);
      await inv.service.execute(inv.call, inv.context);
      saved.push(await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: inv.tool.id }, include: { files: { include: { attachment: true } } } }));
    }
    expect(saved[0]!.captureId).not.toBe(saved[1]!.captureId);
    expect(saved[0]!.files[0]!.attachmentId).not.toBe(saved[1]!.files[0]!.attachmentId);
    const failed = await invocation(f, 2);
    vi.spyOn(f.storage, "putObjectStream").mockRejectedValueOnce(new Error("synthetic-storage-failure"));
    await expect(failed.service.execute(failed.call, failed.context)).rejects.toThrow();
    expect(await prisma.workspaceCheckpointFile.count({ where: { checkpoint: { modelRunId: f.current.runId } } })).toBe(2);
    for (const receipt of saved) {
      const file = receipt.files[0]!.attachment;
      expect(createHash("sha256").update((await f.storage.getObject(file.storageKey)).body).digest("hex")).toBe(file.checksum);
    }
  });

  it("recovers an already retained declared publication after restart and Stop without guest I/O", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "retained-before-crash");
    const inv = await invocation(f);
    const store = createWorkspaceCheckpointStore(prisma, config.outputTotalMaxBytes);
    const c = { runId: f.current.runId, userId: f.userId, toolCallId: inv.tool.id, call: inv.call };
    const input = parseWorkspaceCheckpointInput(inv.call.arguments, c.runId);
    await store.reserve(c, input);
    const ref = { runId: c.runId, userId: c.userId, consumerKey: c.toolCallId };
    const capture = await f.service.create({ ...ref, requestKey: c.toolCallId, files: input.files });
    await store.bind(c, capture.id, ["project/design.psd"]);
    await f.service.retain({ ...ref, captureId: capture.id });
    await prisma.modelRun.update({ where: { id: c.runId }, data: { status: "cancelled" } });
    await prisma.$transaction(tx => failWorkspaceExportsForLostDisk(tx, f.session.id));
    const collect = vi.spyOn(f.runtime, "collectOutputs");
    const restarted = createWorkspaceCheckpoints(prisma, createWorkspaceSelectedCaptures({ prisma, runtime: f.runtime, storage: f.storage, config }), config.outputTotalMaxBytes);
    expect(await restarted.recover()).toEqual({ completed: 1 });
    expect(await restarted.recover()).toEqual({ completed: 0 });
    expect(collect).not.toHaveBeenCalled();
    expect(await prisma.workspaceOutputCheckpoint.findUnique({ where: { toolCallId: inv.tool.id } })).toMatchObject({ state: "SETTLED", captureId: capture.id });
    expect(await prisma.modelRun.findUnique({ where: { id: c.runId } })).toMatchObject({ status: "cancelled" });
  });

  it("fences a new publication after Project access revocation without changing an earlier checkpoint", async () => {
    const f = await fixture(true); await f.write("project", "design.psd", "authorized-version");
    const first = await invocation(f);
    await first.service.execute(first.call, first.context);
    const receipt = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: first.tool.id }, include: { files: true } });
    const remainingOwner = await prisma.user.create({ data: {
      id: `checkpoint-owner-${randomUUID()}`, displayName: "Synthetic remaining owner", status: "active"
    } });
    cleanups.unshift(async () => { await prisma.user.deleteMany({ where: { id: remainingOwner.id } }); });
    await prisma.projectGrant.create({ data: { projectId: f.projectRow!.id, userId: remainingOwner.id, role: "OWNER" } });
    await prisma.projectGrant.deleteMany({ where: { projectId: f.projectRow!.id, userId: f.userId } });
    const later = await invocation(f, 1);
    const capture = vi.spyOn(f.service, "create");
    await expect(later.service.execute(later.call, later.context)).rejects.toMatchObject({ code: "workspace_checkpoint_unavailable" });
    expect(capture).not.toHaveBeenCalled();
    expect(await prisma.workspaceOutputCheckpoint.findUnique({ where: { id: receipt.id } })).toMatchObject({ state: "SETTLED" });
    expect(await createPrismaAttachmentDownloadRepository(prisma).resolve({ attachmentId: receipt.files[0]!.attachmentId, userId: f.userId })).toBeNull();
  });

  it("bounds total checkpoint bytes and replays one immutable publication without duplicate events", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "12345678");
    const first = await invocation(f);
    const service = createWorkspaceCheckpoints(prisma, f.service, 12);
    const retain = f.service.retain.bind(f.service);
    let ready!: () => void, release!: () => void;
    const reserved = new Promise<void>(resolve => { ready = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const retaining = vi.spyOn(f.service, "retain").mockImplementationOnce(async input => {
      ready(); await proceed; return retain(input);
    });
    const publishing = service.execute(first.call, first.context);
    await reserved;
    try {
      const concurrent = await invocation(f, 1);
      await expect(service.execute(concurrent.call, concurrent.context)).rejects.toMatchObject({ code: "workspace_checkpoint_limit_exceeded" });
      expect(retaining).toHaveBeenCalledOnce();
    } finally { release(); await publishing; }
    const saved = await publishing;
    expect(await service.restore(first.call, first.context)).toEqual(saved);
    expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.current.runId, eventType: "artifact",
      payload: { path: ["artifactType"], equals: "workspace_checkpoint" } } })).toBe(1);
    const later = await invocation(f, 2);
    await expect(service.execute(later.call, later.context)).rejects.toMatchObject({ code: "workspace_checkpoint_limit_exceeded" });
    expect(await prisma.workspaceCheckpointFile.count({ where: { checkpoint: { modelRunId: f.current.runId } } })).toBe(1);
  });

  it("rejects explicit capture publication from a sibling branch of the same chat", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "branch-private-version");
    const first = await invocation(f); await first.service.execute(first.call, first.context);
    const receipt = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: first.tool.id } });
    await f.nextRun();
    const sibling = await prisma.message.create({ data: { chatId: f.chat.id, role: "assistant", status: "streaming",
      parentMessageId: f.answer.parentMessageId, content: textMessageContent("") } });
    await prisma.modelRun.update({ where: { id: f.current.runId }, data: { assistantMessageId: sibling.id } });
    const later = await invocation(f);
    const call = { ...later.call, arguments: { ...later.call.arguments, capture_id: receipt.captureId! } };
    await prisma.modelRunToolCall.update({ where: { id: later.tool.id }, data: { arguments: call.arguments } });
    const retain = vi.spyOn(f.service, "retain");
    await expect(later.service.execute(call, later.context)).rejects.toMatchObject({ code: "workspace_checkpoint_unavailable" });
    expect(retain).not.toHaveBeenCalled();
    expect(await prisma.workspaceCheckpointFile.count({ where: { checkpoint: { modelRunId: f.current.runId } } })).toBe(0);
  });
});
