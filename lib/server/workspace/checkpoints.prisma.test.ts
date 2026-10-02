// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { createSavedFileRepository } from "../uploads/savedFileRepository";
import { createPrismaRetentionRepository } from "../retention/prune";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";

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
    // Saved and reused copies are chat-less; remove them before the run cascade
    // so the capture trigger restages the captured keys for the cleanup below.
    await prisma.attachment.deleteMany({ where: { userId, chatId: null } });
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

async function published(toolCallId: string) {
  const receipt = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId }, include: { files: { include: { attachment: true } } } });
  return { receipt, attachment: receipt.files[0]!.attachment };
}

/** Save (save=true) and Use (save=false) share copy(); both must succeed. */
async function expectCopies(attachmentId: string, userId: string) {
  const repository = createSavedFileRepository(prisma);
  const source = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
  const savedCopy = await repository.copy({ attachmentId, save: true, userId });
  const reusedCopy = await repository.copy({ attachmentId, save: false, userId });
  expect(savedCopy).not.toBeNull();
  expect(reusedCopy).not.toBeNull();
  const saved = await prisma.attachment.findUniqueOrThrow({ where: { id: savedCopy!.id } });
  const reused = await prisma.attachment.findUniqueOrThrow({ where: { id: reusedCopy!.id } });
  expect(saved).toMatchObject({ savedAt: expect.any(Date), chatId: null, userId, storageKey: source.storageKey });
  expect(reused).toMatchObject({ savedAt: null, chatId: null, userId, storageKey: source.storageKey });
  return { saved, reused };
}

async function retained(f: Awaited<ReturnType<typeof fixture>>, inv: Awaited<ReturnType<typeof invocation>>) {
  const store = createWorkspaceCheckpointStore(prisma, config.outputTotalMaxBytes);
  const c = { runId: f.current.runId, userId: f.userId, toolCallId: inv.tool.id, call: inv.call };
  const input = parseWorkspaceCheckpointInput(inv.call.arguments, c.runId);
  await store.reserve(c, input);
  const ref = { runId: c.runId, userId: c.userId, consumerKey: c.toolCallId };
  const capture = await f.service.create({ ...ref, requestKey: c.toolCallId, files: input.files });
  await store.bind(c, capture.id, ["project/design.psd"]);
  await f.service.retain({ ...ref, captureId: capture.id });
  const file = await prisma.workspaceCapturedFile.findFirstOrThrow({ where: { captureId: capture.id } });
  return { store, c, ref: { ...ref, captureId: capture.id }, storageKey: file.storageKey! };
}

async function unpublishedState(runId: string, toolCallId: string, storageKey: string) {
  // A live retry rebinds the same capture, which only touches updatedAt.
  const { updatedAt: _rebound, ...checkpoint } = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId } });
  return {
    attachments: await prisma.attachment.count({ where: { storageKey } }),
    checkpoint,
    events: await prisma.modelRunEvent.findMany({ where: { modelRunId: runId }, orderBy: { id: "asc" } }),
    files: await prisma.workspaceCheckpointFile.count({ where: { checkpoint: { toolCallId } } }),
    job: await prisma.attachmentDeletionJob.findUnique({ where: { storageKey } }),
    tool: await prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: toolCallId } })
  };
}

describe("Workspace checkpoint deletion obligations", () => {
  it("settles the retained-capture job on live publication so Save and Use succeed", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "live-version");
    const inv = await invocation(f);
    await inv.service.execute(inv.call, inv.context);
    const { receipt, attachment } = await published(inv.tool.id);
    expect(receipt.state).toBe("SETTLED");
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: attachment.storageKey } })).toBe(0);
    const copies = await expectCopies(attachment.id, f.userId);
    expect(await expectCopies(copies.saved.id, f.userId)).toMatchObject({ saved: { id: copies.saved.id } });
  });

  it("settles the retained-capture job on restart recovery after the run ended", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "recovered-version");
    const inv = await invocation(f);
    const { storageKey } = await retained(f, inv);
    expect(await prisma.attachmentDeletionJob.findUnique({ where: { storageKey } })).toMatchObject({ claimToken: null });
    await prisma.modelRun.update({ where: { id: f.current.runId }, data: { status: "complete" } });
    expect(await inv.service.recover()).toEqual({ completed: 1 });
    const { attachment } = await published(inv.tool.id);
    expect(attachment.storageKey).toBe(storageKey);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(0);
    await expectCopies(attachment.id, f.userId);
  });

  it("fails closed while the captured key's deletion job is claimed and recovers once the claim is gone", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "claimed-version");
    const inv = await invocation(f);
    const { storageKey } = await retained(f, inv);
    await prisma.attachmentDeletionJob.update({ where: { storageKey }, data: { claimToken: "synthetic-claim", claimedAt: new Date() } });
    const before = await unpublishedState(f.current.runId, inv.tool.id, storageKey);
    await expect(inv.service.execute(inv.call, inv.context)).rejects.toMatchObject({ code: "workspace_checkpoint_unavailable" });
    const after = await unpublishedState(f.current.runId, inv.tool.id, storageKey);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ attachments: 0, files: 0, checkpoint: { state: "PENDING" }, tool: { state: "running", result: null },
      job: { claimToken: "synthetic-claim" } });
    await prisma.modelRun.update({ where: { id: f.current.runId }, data: { status: "complete" } });
    const blocked = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: inv.tool.id } });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await inv.service.recover()).toEqual({ completed: 0 });
    const deferred = await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: inv.tool.id } });
    expect(deferred.state).toBe("PENDING");
    expect(deferred.updatedAt.getTime()).toBeGreaterThan(blocked.updatedAt.getTime());
    expect(await prisma.attachmentDeletionJob.findUnique({ where: { storageKey } })).toEqual(before.job);
    await prisma.attachmentDeletionJob.update({ where: { storageKey }, data: { claimToken: null, claimedAt: null } });
    expect(await inv.service.recover()).toEqual({ completed: 1 });
    expect((await published(inv.tool.id)).receipt.state).toBe("SETTLED");
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(0);
  });

  it("rolls the job delete back with every other publication write", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "rollback-version");
    const inv = await invocation(f);
    const { store, c, ref, storageKey } = await retained(f, inv);
    const before = await unpublishedState(c.runId, inv.tool.id, storageKey);
    expect(before.job).toMatchObject({ claimToken: null });
    await expect(f.service.settleRetained(ref, async (tx, files) => {
      await store.publish(tx, c, files);
      throw new Error("synthetic-rollback");
    })).rejects.toThrow("synthetic-rollback");
    const after = await unpublishedState(c.runId, inv.tool.id, storageKey);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ attachments: 0, files: 0, checkpoint: { state: "PENDING" } });
    await f.service.settleRetained(ref, (tx, files) => store.publish(tx, c, files));
    expect((await published(inv.tool.id)).receipt.state).toBe("SETTLED");
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(0);
  });

  it("republishes a shared capture without its settled job and replays a settled checkpoint unchanged", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "shared-version");
    const first = await invocation(f);
    await first.service.execute(first.call, first.context);
    const original = await published(first.tool.id);
    await f.nextRun();
    const later = await invocation(f);
    const call = { ...later.call, arguments: { ...later.call.arguments, capture_id: original.receipt.captureId! } };
    await prisma.modelRunToolCall.update({ where: { id: later.tool.id }, data: { arguments: call.arguments } });
    await later.service.execute(call, later.context);
    const republished = await published(later.tool.id);
    expect(republished.receipt).toMatchObject({ state: "SETTLED", captureId: original.receipt.captureId });
    expect(republished.attachment.storageKey).toBe(original.attachment.storageKey);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: original.attachment.storageKey } })).toBe(0);
    await expectCopies(republished.attachment.id, f.userId);

    const store = createWorkspaceCheckpointStore(prisma, config.outputTotalMaxBytes);
    const c = { runId: f.current.runId, userId: f.userId, toolCallId: later.tool.id, call };
    const ref = { runId: c.runId, userId: c.userId, consumerKey: c.toolCallId, captureId: original.receipt.captureId! };
    const snapshot = async () => ({
      attachments: await prisma.attachment.findMany({ where: { storageKey: original.attachment.storageKey }, orderBy: { id: "asc" } }),
      checkpoint: await prisma.workspaceOutputCheckpoint.findUniqueOrThrow({ where: { toolCallId: later.tool.id } }),
      events: await prisma.modelRunEvent.count({ where: { modelRunId: f.current.runId } }),
      jobs: await prisma.attachmentDeletionJob.count({ where: { storageKey: original.attachment.storageKey } })
    });
    const settled = await snapshot();
    await f.service.settleRetained(ref, (tx, files) => store.publish(tx, c, files));
    expect(await snapshot()).toEqual(settled);
  });

  it.each(["message deletion", "chat permanent deletion"] as const)("keeps a saved checkpoint copy usable through source %s", async source => {
    const f = await fixture(); await f.write("project", "design.psd", "saved-version");
    const inv = await invocation(f);
    await inv.service.execute(inv.call, inv.context);
    const { attachment } = await published(inv.tool.id);
    const key = attachment.storageKey;
    // Runs last: the capture is gone by then, so its prefix cleanup misses this key.
    cleanups.unshift(async () => { await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: key } }); });
    const { saved } = await expectCopies(attachment.id, f.userId);
    await prisma.modelRun.update({ where: { id: f.current.runId }, data: { status: "complete" } });
    await prisma.message.update({ where: { id: f.answer.id }, data: { status: "complete" } });
    if (source === "message deletion") {
      await expect(createPrismaMessageBranchRepository(prisma).deleteMessageSubtree({ messageId: f.answer.parentMessageId!, userId: f.userId }))
        .resolves.toMatchObject({ chatId: f.chat.id });
    } else {
      // Chat permanent deletion keeps the shared object, then removes the chat's
      // Attachments before its runs (permanentDeletion/cleanup.ts order).
      await prisma.$transaction(async tx => {
        await tx.attachment.deleteMany({ where: { chatId: f.chat.id, userId: f.userId } });
        await tx.modelRun.deleteMany({ where: { chatId: f.chat.id, userId: f.userId } });
      });
    }
    expect(await prisma.modelRun.count({ where: { chatId: f.chat.id } })).toBe(0);
    expect(await prisma.workspaceCapturedFile.count({ where: { storageKey: key } })).toBe(0);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: key } })).toBe(0);
    expect(f.storage.objects.has(key)).toBe(true);
    const fromSaved = await expectCopies(saved.id, f.userId);
    expect(fromSaved.saved.id).toBe(saved.id);

    expect(await createSavedFileRepository(prisma).remove({ attachmentId: saved.id, userId: f.userId })).toBe(true);
    await prisma.attachment.updateMany({ where: { storageKey: key }, data: { createdAt: new Date("1990-01-01T00:00:00.000Z") } });
    const retention = createPrismaRetentionRepository(prisma);
    await retention.stageOrphanedAttachments({ cutoff: new Date("1990-01-02T00:00:00.000Z"), limit: 100 });
    expect(await prisma.attachment.count({ where: { storageKey: key } })).toBe(0);
    const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: key } });
    const now = new Date();
    expect(await retention.findClaimableAttachmentDeletionJobIds({ now, claimableBefore: new Date(now.getTime() + 1000), limit: 1000 })).toContain(job.id);
  });

  it("repairs a published key that still carries the pre-upgrade job with the migration's statement", async () => {
    const f = await fixture(); await f.write("project", "design.psd", "pre-upgrade-version");
    const inv = await invocation(f);
    await inv.service.execute(inv.call, inv.context);
    const { attachment } = await published(inv.tool.id);
    await prisma.attachmentDeletionJob.create({ data: { storageKey: attachment.storageKey } });
    const repository = createSavedFileRepository(prisma);
    for (const save of [true, false]) expect(await repository.copy({ attachmentId: attachment.id, save, userId: f.userId })).toBeNull();
    const migration = readFileSync("prisma/migrations/20261002120000_workspace_checkpoint_deletion_job_repair/migration.sql", "utf8");
    const statements = migration.match(/^DELETE FROM "AttachmentDeletionJob"[^;]*;/gmu) ?? [];
    expect(statements).toHaveLength(1);
    await prisma.$executeRawUnsafe(statements[0]!);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: attachment.storageKey } })).toBe(0);
    await expectCopies(attachment.id, f.userId);
  });
});
