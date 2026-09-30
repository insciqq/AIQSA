import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { textMessageContent } from "@/lib/domain/content";
import { WORKSPACE_POLICY_ID, workspaceAttachmentPath, workspaceMessageManifestPath, workspaceRunOutputDirectory, workspaceSandboxName,
  type WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { admitPreparingRunWithClient } from "@/lib/server/runs/prismaRepositoryPreparation";
import { createFileSystemStorageAdapter } from "@/lib/server/uploads/storage";
import { runWorkspaceMaintenance } from "@/lib/server/workspace/cleanup";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { createPrismaWorkspaceCoordinatorRepository, createWorkspaceCoordinator } from "@/lib/server/workspace/coordinator";
import { createPrismaWorkspaceExecutionRegistry } from "@/lib/server/workspace/executionRegistry";
import { loadPinnedOfficialWorkspaceToolCatalog } from "@/lib/server/workspace/microsandboxRuntime";
import { RemoteWorkspaceRuntime } from "@/lib/server/workspace/remoteRuntime";
import { WorkspaceRuntimeError } from "@/lib/server/workspace/runtime";
import { namespacedWorkspaceToolName } from "@/lib/server/workspace/toolCatalog";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";

// Run alone in the disposable application role against its real KVM receiver.
// The answer is synthetic: no model choice can hide an unwanted guest dispatch.
assertDisposableStatefulTestTarget(process.env);
assert.equal(process.env.AIQSA_WORKSPACE_LIVE_E2E, "DISPOSABLE");
assert.equal(process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME, "0");
const endpoint = new URL(process.env.AIQSA_WORKSPACE_RUNNER_URL!);
assert.equal(endpoint.protocol, "http:");
assert.equal(endpoint.hostname, "127.0.0.1");
const config = getWorkspaceConfig(process.env);
const raw = new RemoteWorkspaceRuntime(config);
const prisma = new PrismaClient();
const userId = randomUUID();
const sessions = new Set<string>();
const oracle = Buffer.from("Synthetic verified export bytes\n");
const attachmentBytes = Buffer.from("Synthetic deferred attachment bytes\n");
let phase = "preflight";
let guestCalls = 0;
let callOrdinal = 0;
// Count every coordinator dispatch, including retirement/secret sync/staging.
// Inventory observations use raw directly and never mutate the guest.
const runtime = new Proxy(raw, { get(target, key) {
  const value = Reflect.get(target, key);
  return typeof value === "function" ? (...args: unknown[]) => { guestCalls += 1; return value.apply(target, args); } : value;
} });

async function main() {
  const root = await mkdtemp(join(tmpdir(), "aiqsa-untouched-smoke-"));
  const storage = createFileSystemStorageAdapter(root);
  const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
  const coordinator = () => createWorkspaceCoordinator({ config, repository: createPrismaWorkspaceCoordinatorRepository(prisma), runtime,
    registry: createPrismaWorkspaceExecutionRegistry(prisma), storage });
  const oldPolicy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: WORKSPACE_POLICY_ID }, select: { enabled: true } });
  let created = false;
  const inventory = async () => (await raw.listSessions({ signal: AbortSignal.timeout(30_000) })).entries;
  type Run = Awaited<ReturnType<typeof admit>>;

  async function admit(chatId?: string) {
    const chat = chatId ? await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })
      : await prisma.chat.create({ data: { userId, title: "Synthetic untouched Workspace verification", workspaceEnabled: true } });
    const existing = await prisma.workspaceSession.findUnique({ where: { chatId: chat.id } });
    const sessionId = existing?.id ?? `ws_${randomBytes(20).toString("hex")}`;
    sessions.add(sessionId);
    const runId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
    const catalog = await loadPinnedOfficialWorkspaceToolCatalog();
    const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: WORKSPACE_POLICY_ID } });
    const workspace = { enabled: true as const, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
      maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds, mcpVersion: catalog.mcpVersion,
      messageManifestPath: workspaceMessageManifestPath(userMessageId), outputDirectory: workspaceRunOutputDirectory(runId),
      projectDirectory: "/workspace/project", runtimeVersion: catalog.runtimeVersion, sessionId,
      syncToolTimeoutSeconds: config.syncToolTimeoutSeconds, toolCatalogHash: catalog.hash, turnTimeoutSeconds: config.turnTimeoutSeconds };
    const content = textMessageContent("Synthetic Workspace lifecycle verification.");
    await admitPreparingRunWithClient(prisma, {
      admissionKind: "NORMAL_SEND", chatId: chat.id, content, expectedActiveLeafId: chat.activeLeafMessageId,
      modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId, workspaceEnabled: true,
      normalizedRequest: { attachmentIds: [], chatId: chat.id, content, knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 },
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, toolCalling: true },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", workspace },
      workspaceAdmissionPlan: { assistantMessageId, chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), normalized: workspace,
        policyRevision: policy.version, runId, sandboxName: workspaceSandboxName(sessionId), sessionId, toolDefinitions: catalog.tools, userMessageId }
    });
    return { runId, chatId: chat.id, assistantMessageId, userMessageId, userId, workspace };
  }

  async function call(run: Run, name: WorkspaceMcpToolName, args: Record<string, unknown>) {
    const id = randomUUID(), toolName = namespacedWorkspaceToolName(name);
    await prisma.modelRunToolCall.create({ data: { id, modelRunId: run.runId, workspaceRunBindingId: run.runId, roundIndex: 0,
      ordinal: callOrdinal++, providerCallId: id, toolName, arguments: args as Prisma.InputJsonValue, state: "running" } });
    const result = await coordinator().execute({ ...run, call: { id, name: toolName, arguments: args }, modelRunToolCallId: id,
      signal: AbortSignal.timeout(150_000) });
    const parsed = JSON.parse(result.content.find(entry => entry.type === "text")?.text ?? "null") as { ok?: boolean; data?: Record<string, unknown> } | null;
    assert.equal(result.status, "complete");
    assert.equal(parsed?.ok, true);
    assert.notEqual(parsed?.data?.success, false);
    await prisma.modelRunToolCall.update({ where: { id }, data: { state: "complete", completedAt: new Date() } });
    return parsed?.data;
  }

  async function publish(run: Run) {
    await prisma.$transaction(async tx => {
      await tx.memoryRetrievalAttempt.updateMany({ where: { modelRunId: run.runId }, data: { state: "CANCELLED", errorCode: "fixture_preparation_cancelled" } });
      await tx.message.update({ where: { id: run.assistantMessageId }, data: { status: "complete", content: textMessageContent("Synthetic answer.") } });
      await tx.modelRun.update({ where: { id: run.runId }, data: { status: "complete", normalizedRequest: {} } });
    });
  }

  async function finish(run: Run) {
    assert.deepEqual(await coordinator().handoff(run), { status: "ready" });
    await publish(run);
    assert.equal((await coordinator().finalize({ ...run, recovery: true })).status, "complete");
  }

  async function untouched(run: Run, before: Awaited<ReturnType<typeof prisma.workspaceSession.findUniqueOrThrow>>) {
    const callsBefore = guestCalls;
    let activities = 0;
    // Fresh coordinator simulates app loss between answer publication and handoff.
    assert.deepEqual(await coordinator().handoff({ ...run, onActivity: async () => { activities += 1; } }), { status: "ready" });
    await publish(run);
    assert.equal((await coordinator().finalize({ ...run, recovery: true, onActivity: async () => { activities += 1; } })).status, "complete");
    assert.equal(guestCalls, callsBefore);
    assert.equal(activities, 0);
    const after = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: before.id } });
    for (const key of ["state", "runtimeSandboxId", "lastActiveAt", "expiresAt", "stoppedAt"] as const) assert.deepEqual(after[key], before[key]);
    assert.equal(after.operationOwner, null);
    const binding = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.runId } });
    assert.equal(binding.guestUsedAt, null);
    assert.equal(binding.exportState, "COMPLETE");
    assert.equal(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: run.runId } }), 0);
  }

  try {
    assert.equal((await raw.health(AbortSignal.timeout(120_000))).state, "ready");
    assert.equal((await inventory()).length, 0, "requires an empty isolated runner");
    assert.equal(await prisma.workspaceSession.count(), 0, "requires an empty disposable Workspace database");
    await prisma.workspacePolicy.update({ where: { id: WORKSPACE_POLICY_ID }, data: { enabled: true } });
    await prisma.user.create({ data: { id: userId, displayName: "Synthetic untouched Workspace fixture", status: "active" } });
    created = true;
    await prisma.userMemorySettings.update({ where: { userId }, data: { useMemoryFacts: false, learnAutomatically: false, referenceChatHistory: false } });

    phase = "used_export";
    const first = await admit();
    await call(first, "sandbox_fs_write", { path: `${first.workspace.outputDirectory}/oracle.txt`, encoding: "utf8", content: oracle.toString() });
    await finish(first);
    const outputs = await prisma.workspaceRunOutput.findMany({ where: { workspaceRunBindingId: first.runId }, include: { attachment: true } });
    assert.equal(outputs.length, 1);
    assert.deepEqual((await storage.getObject(outputs[0]!.attachment.storageKey)).body, oracle);

    phase = "running_untouched";
    const stopped = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: first.workspace.sessionId } });
    const operation = { generation: stopped.version + 1, owner: "maintenance:untouched-smoke-resume" };
    await raw.ensureSession({ operation, sessionId: stopped.id, runtimeSandboxId: stopped.runtimeSandboxId,
      sandboxName: stopped.sandboxName, imageRef: config.imageRef, internetEnabled: false,
      cpus: config.cpus, diskMiB: config.diskMiB, memoryMiB: config.memoryMiB });
    const ready = await prisma.workspaceSession.update({ where: { id: stopped.id },
      data: { version: operation.generation, state: "READY", stoppedAt: null, operationOwner: null, operationExpiresAt: null } });
    assert.equal((await inventory())[0]!.state, "running");
    await untouched(await admit(first.chatId), ready);
    assert.equal((await inventory())[0]!.state, "running");

    phase = "idle_stop";
    await prisma.workspaceSession.update({ where: { id: stopped.id },
      data: { lastActiveAt: new Date(Date.now() - (config.idleTtlSeconds + 5) * 1_000) } });
    const maintenance = await runWorkspaceMaintenance({ config, prisma, runtime });
    assert.equal(maintenance.idleStopped, 1);
    const idle = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: stopped.id } });
    assert.equal(idle.state, "STOPPED");
    assert.equal((await inventory())[0]!.state, "stopped");

    phase = "stopped_untouched";
    const second = await admit(first.chatId);
    const attachmentId = randomUUID(), storageKey = `${userId}/untouched-input`;
    await storage.putObject({ body: attachmentBytes, storageKey, contentType: "text/plain" });
    await prisma.attachment.create({ data: { id: attachmentId, userId, chatId: first.chatId, messageId: second.userMessageId,
      fileName: "deferred.txt", mimeType: "text/plain", kind: "file", status: "ready", origin: "USER_UPLOAD",
      byteSize: attachmentBytes.length, checksum: createHash("sha256").update(attachmentBytes).digest("hex"), storageKey, metadata: {} } });
    await untouched(second, idle);
    assert.equal((await inventory())[0]!.state, "stopped");

    phase = "deferred_attachment";
    const third = await admit(first.chatId);
    const read = await call(third, "sandbox_fs_read", { path: workspaceAttachmentPath({ messageId: second.userMessageId, attachmentId, originalName: "deferred.txt" }), encoding: "utf8" });
    assert.equal(read?.content, attachmentBytes.toString());
    await finish(third);
    assert.equal((await repository.binding(third))!.guestUsed, true);
    process.stdout.write(JSON.stringify({ ok: true, realKvm: true, usedFileExport: true, idleStop: true,
      untouchedStopped: true, untouchedRunning: true, unchangedActivityWindow: true,
      unusedGuestDispatches: 0, unusedWorkspaceActivities: 0, restartedHandoff: true, deferredAttachment: true }) + "\n");
  } finally {
    const completedPhase = phase;
    phase = "cleanup";
    for (const id of sessions) {
      const session = await prisma.workspaceSession.findUnique({ where: { id } });
      if (!session) continue;
      const operation = { generation: session.version + 1, owner: "maintenance:untouched-smoke-cleanup" };
      await raw.claimSessionOperation({ operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: id });
      await raw.removeSession({ operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: id, signal: AbortSignal.timeout(60_000) });
    }
    if (created) {
      await prisma.attachment.deleteMany({ where: { userId } });
      await prisma.modelRun.deleteMany({ where: { userId } });
      await prisma.chat.updateMany({ where: { userId }, data: { activeLeafMessageId: null } });
      await prisma.message.deleteMany({ where: { chat: { userId } } });
      await prisma.workspaceSession.deleteMany({ where: { id: { in: [...sessions] } } });
      await prisma.chat.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { startsWith: `${userId}/` } } });
    }
    await prisma.workspacePolicy.update({ where: { id: WORKSPACE_POLICY_ID }, data: oldPolicy });
    assert.equal((await inventory()).length, 0);
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ cleanup: true }) + "\n");
    phase = completedPhase;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ ok: false, phase, code: error instanceof WorkspaceRuntimeError ? error.code
    : error instanceof AssertionError ? "assertion_failed" : error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "workspace_untouched_smoke_failed" }) + "\n");
  process.exitCode = 1;
});
