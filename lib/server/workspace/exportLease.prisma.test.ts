// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { prisma } from "@/lib/server/prisma";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceCoordinatorRepository, WORKSPACE_EXPORT_MAX_ATTEMPTS, type WorkspaceExportLease } from "./coordinator";
import type { WorkspaceOutputIdentity } from "./outputManifest";
import { createPrismaWorkspaceExecutionRegistry } from "./executionRegistry";
import { namespacedWorkspaceToolName } from "./toolCatalog";
import { createWorkspaceLifecycleService } from "./lifecycle";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createWorkspaceAvailabilityService } from "./availability";
import { createPrismaRetentionRepository } from "@/lib/server/retention/prune";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { reconcileWorkspaceAfterRestore, runWorkspaceMaintenance } from "./cleanup";

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

const TEST_USER_PREFIX = "workspace-export-lease-test-";

async function cleanupFixtures(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { id: { startsWith: TEST_USER_PREFIX } }
  });
  const userIds = users.map(({ id }) => id);
  if (userIds.length === 0) return;
  const chats = await prisma.chat.findMany({
    select: { id: true },
    where: { OR: [{ userId: { in: userIds } }, { project: { createdByUserId: { in: userIds } } }] }
  });
  const chatIds = chats.map(({ id }) => id);
  // Produced outputs restrict run deletion; the output rows cascade from the attachments.
  await prisma.attachment.deleteMany({
    where: { origin: "WORKSPACE_OUTPUT", producerModelRun: { userId: { in: userIds } } }
  });
  await prisma.attachmentDeletionJob.deleteMany({ where: { OR: userIds.map((id) => ({ storageKey: { startsWith: `${id}/workspace-outputs/` } })) } });
  await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.chat.updateMany({
    data: { activeLeafMessageId: null },
    where: { id: { in: chatIds } }
  });
  await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.project.deleteMany({ where: { createdByUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

type Fixture = Readonly<{
  chatId: string;
  generation: number;
  projectId?: string;
  runId: string;
  runtimeSandboxId: string | null;
  sessionId: string;
  toolCallId: string;
  userId: string;
}>;

// A binding is only loadable with the full allowlisted catalog and its hash.
const FIXTURE_TOOL_DEFINITIONS = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => ({
  description: `Fixture ${originalName}`,
  inputSchema: { type: "object" },
  namespacedName: namespacedWorkspaceToolName(originalName),
  originalName
}));

async function createFixture(input: Readonly<{
  exportState?: "EXPORTING" | "FAILED" | "PENDING";
  lastExportErrorCode?: string;
  project?: boolean;
}> = {}): Promise<Fixture> {
  const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
  const user = await prisma.user.create({
    data: { displayName: "Workspace Export Lease Test", id: userId, status: "active" }
  });
  const projectOwner = input.project ? await prisma.user.create({
    data: { displayName: "Export Recovery Owner", id: `${TEST_USER_PREFIX}${randomUUID()}`, status: "active" }
  }) : null;
  const project = projectOwner ? await prisma.project.create({
    data: {
      createdByDisplayName: "Export Recovery Owner", createdByUserId: projectOwner.id,
      grants: { create: { role: "OWNER", userId: projectOwner.id } },
      name: "Export recovery access"
    }
  }) : null;
  if (project) {
    await prisma.projectGrant.create({ data: { projectId: project.id, role: "CONTRIBUTOR", userId } });
  }
  const chat = await prisma.chat.create({
    data: {
      title: "Export lease",
      ...(project ? {
        createdByDisplayName: user.displayName, createdByUserId: userId,
        memoryMode: "EXCLUDED" as const, projectId: project.id
      } : { userId: user.id }),
      workspaceEnabled: true
    }
  });
  const userMessage = await prisma.message.create({
    data: {
      ...(project ? {
        authorDisplayName: user.displayName, authorProjectRole: "CONTRIBUTOR" as const, authorUserId: userId
      } : {}),
      chatId: chat.id,
      content: textMessageContent("Export something"),
      modelId: "fake-qsa",
      provider: "fake",
      role: "user",
      status: "complete"
    }
  });
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Done"),
      modelId: "fake-qsa",
      parentMessageId: userMessage.id,
      provider: "fake",
      role: "assistant",
      status: "complete"
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: chat.id,
      modelId: "fake-qsa",
      normalizedRequest: {},
      ...(project ? { projectRunBinding: { create: {
        acceptedRole: "CONTRIBUTOR" as const, accessRevision: 1, initiatorUserId: userId,
        instructionsRevision: 1, memoryRevision: 0, personalMemoryDisabled: true, policyRevision: 1, projectId: project.id
      } } } : {}),
      provider: "fake",
      status: "complete",
      userId,
      userMessageId: userMessage.id
    }
  });
  const session = await prisma.workspaceSession.create({
    data: {
      chatId: chat.id,
      expiresAt: new Date(Date.now() + config.retentionSeconds * 1_000),
      imageRef: config.imageRef,
      internetEnabled: true,
      policyRevision: 1,
      runtimeSandboxId: `runtime-${randomUUID()}`,
      sandboxName: `aiqsa-ws-${randomUUID()}`,
      state: "RUNNING"
    }
  });
  await prisma.workspaceRunBinding.create({
    data: {
      exportState: input.exportState ?? "PENDING",
      imageRef: config.imageRef,
      internetEnabled: true,
      lastExportErrorCode: input.lastExportErrorCode ?? null,
      mcpVersion: "0.6.16",
      modelRunId: run.id,
      outputDirectory: workspaceRunOutputDirectory(run.id),
      policyRevision: 1,
      runtimeVersion: "0.6.16",
      toolCatalogHash: hashCanonicalMcpValue(FIXTURE_TOOL_DEFINITIONS),
      toolDefinitions: FIXTURE_TOOL_DEFINITIONS,
      workspaceSessionId: session.id
    }
  });
  const toolCall = await prisma.modelRunToolCall.create({
    data: {
      arguments: {},
      modelRunId: run.id,
      ordinal: 0,
      providerCallId: `call_${randomUUID()}`,
      roundIndex: 1,
      state: "complete",
      toolName: "mcp_workspace_sandbox_exec_start_fixture",
      workspaceRunBindingId: run.id
    }
  });
  return { chatId: chat.id, generation: session.version, ...(project ? { projectId: project.id } : {}), runId: run.id,
    runtimeSandboxId: session.runtimeSandboxId, sessionId: session.id, toolCallId: toolCall.id, userId };
}

async function bindingState(runId: string) {
  return prisma.workspaceRunBinding.findUniqueOrThrow({
    select: {
      exportAttemptCount: true,
      exportCompletedAt: true,
      exportLeaseExpiresAt: true,
      exportLeaseToken: true,
      exportState: true,
      lastExportErrorCode: true
    },
    where: { modelRunId: runId }
  });
}

async function captureOutputs(lease: WorkspaceExportLease, outputs: readonly WorkspaceOutputIdentity[] = []) {
  const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
  const capture = await repository.reserveOutputCapture(lease);
  if (!capture) throw new Error("fixture_capture_failed");
  expect(await repository.sealOutputCapture({ ...lease, capture: { id: capture.id, outputs } })).toBe(true);
  return capture;
}

describe("Prisma Workspace export lease", () => {
  const repository = createPrismaWorkspaceCoordinatorRepository(prisma);

  beforeAll(cleanupFixtures);

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  });

  it("keeps a handoff discoverable across answer completion and a fresh repository without spending an export attempt", async () => {
    const fixture = await createFixture();
    const operation = { generation: fixture.generation, owner: `run:${fixture.runId}` };
    await prisma.modelRun.update({ data: { status: "streaming" }, where: { id: fixture.runId } });
    await prisma.workspaceSession.update({ data: { operationOwner: operation.owner }, where: { id: fixture.sessionId } });
    const claim = await repository.claimExport({ ...fixture, operation, handoff: true, leaseMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture_handoff_claim_failed");
    const lease = { ...fixture, operation: claim.operation, token: claim.token };
    expect(await repository.markExportPending(lease)).toBe(false);
    const output = { byteSize: 6, checksum: createHash("sha256").update("report").digest("hex"), mimeType: "text/plain", relativePath: "report.txt" };
    const capture = await captureOutputs(lease, [output]);
    expect(await repository.markExportPending(lease)).toBe(true);
    expect(await repository.outputHandoffReady(fixture)).toBe(false);
    expect(await repository.renewExportLease({ ...lease, leaseMs: 60_000 })).toBe(false);
    expect(await repository.markExportFailed({ ...lease, code: "workspace_output_export_failed" })).toBe(false);
    expect(await repository.settleSession({ ...fixture, operation: claim.operation, outcome: "stopped" })).toBe(true);
    const fresh = createPrismaWorkspaceCoordinatorRepository(prisma);
    expect(await fresh.outputHandoffReady(fixture)).toBe(true);
    expect(await bindingState(fixture.runId)).toMatchObject({ exportState: "PENDING", exportAttemptCount: 0, exportLeaseToken: null });
    expect(await fresh.exportRecoveryCandidates({ limit: 100, staleBefore: new Date() })).not.toContainEqual(expect.objectContaining({ runId: fixture.runId }));
    // Crash after handoff, before completion: the answer still owns its ordinary
    // active-run fence. Once the terminal winner commits, no scheduling record
    // from the vanished process is needed for discovery.
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: fixture.runId } });
    expect(await fresh.exportRecoveryCandidates({ limit: 100, staleBefore: new Date() })).toContainEqual(expect.objectContaining({ runId: fixture.runId }));
    const exportClaim = await fresh.claimExportForRecovery({ ...fixture, generation: claim.operation.generation, leaseMs: 60_000 });
    if (exportClaim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const exportLease = { ...fixture, operation: exportClaim.operation, token: exportClaim.token };
    expect(await fresh.reserveOutputCapture(exportLease)).toEqual({ id: capture.id, outputs: [output], create: false });
    const binding = (await fresh.binding(fixture))!;
    const storageKey = `${fixture.userId}/workspace-outputs/${fixture.runId}/${exportClaim.token}/report`;
    expect(await fresh.prepareOutput({ ...exportLease, storageKey })).toBe(true);
    const file = await fresh.settleOutput({ binding, output, storageKey, token: exportClaim.token });
    expect(await fresh.markExportComplete(exportLease)).toBe(true);
    expect(await fresh.generatedFiles(fixture)).toEqual([file]);
    expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("complete");
  });

  it("resumes only the same expired foreground handoff after a crash before retirement", async () => {
    const fixture = await createFixture();
    const operation = { generation: fixture.generation, owner: `run:${fixture.runId}` };
    await prisma.modelRun.update({ data: { status: "streaming" }, where: { id: fixture.runId } });
    await prisma.workspaceSession.update({ data: { operationOwner: operation.owner }, where: { id: fixture.sessionId } });
    const first = await repository.claimExport({ ...fixture, operation, handoff: true, leaseMs: 60_000 });
    if (first.status !== "claimed") throw new Error("fixture_handoff_claim_failed");
    const firstLease = { ...fixture, operation: first.operation, token: first.token };
    const capture = await captureOutputs(firstLease);
    const request = { ...fixture, handoff: true, operation: first.operation, leaseMs: 60_000 };
    expect(await repository.claimExport(request)).toEqual({ status: "busy" });
    const expired = new Date(Date.now() - 1);
    await prisma.workspaceRunBinding.update({ data: { exportLeaseExpiresAt: expired }, where: { modelRunId: fixture.runId } });
    expect(await repository.claimExport(request)).toEqual({ status: "busy" });
    await prisma.workspaceSession.update({ data: { operationExpiresAt: expired }, where: { id: fixture.sessionId } });
    expect(await repository.claimExport({ ...request, operation: { ...first.operation, owner: `export:another:token` } })).toEqual({ status: "busy" });
    const fresh = createPrismaWorkspaceCoordinatorRepository(prisma);
    const claims = await Promise.all([fresh.claimExport(request), fresh.claimExport(request)]);
    expect(claims.filter((claim) => claim.status === "busy")).toHaveLength(1);
    const winner = claims.find((claim) => claim.status === "claimed");
    if (winner?.status !== "claimed") throw new Error("fixture_resume_claim_failed");
    const lease = { ...fixture, operation: winner.operation, token: winner.token };
    expect(await fresh.reserveOutputCapture(lease)).toEqual({ id: capture.id, outputs: [], create: false });
    expect(await fresh.markExportPending(firstLease)).toBe(false);
    expect(await fresh.markExportPending(lease)).toBe(true);
    expect(await fresh.settleSession({ ...fixture, operation: first.operation, outcome: "stopped" })).toBe(false);
    expect(await fresh.settleSession({ ...fixture, operation: winner.operation, outcome: "stopped" })).toBe(true);
    expect(await fresh.outputHandoffReady(fixture)).toBe(true);
  });

  it("keeps one closed output obligation across competing reservations, partial publication and takeover", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const lease = { ...fixture, operation: claim.operation, token: claim.token };
    expect(await repository.markExportComplete(lease)).toBe(false);
    const reservations = await Promise.all([1, 2, 3].map(() => repository.reserveOutputCapture(lease)));
    expect(reservations.filter((capture) => capture?.create)).toHaveLength(1);
    expect(new Set(reservations.map((capture) => capture?.id)).size).toBe(1);
    const id = reservations[0]!.id;
    const outputs = ["one", "two"].map((name) => ({ byteSize: 3, checksum: createHash("sha256").update(name).digest("hex"), mimeType: "text/plain", relativePath: `${name}.txt` }));
    expect(await repository.sealOutputCapture({ ...lease, capture: { id, outputs } })).toBe(true);
    expect(await repository.sealOutputCapture({ ...lease, capture: { id, outputs: [] } })).toBe(false);
    const binding = (await repository.binding(fixture))!;
    const firstKey = `workspace-lease-fixture/${randomUUID()}`;
    expect(await repository.prepareOutput({ ...lease, storageKey: firstKey })).toBe(true);
    const ready = await repository.settleOutput({ binding, output: outputs[0]!, storageKey: firstKey, token: claim.token });
    expect(await repository.markExportComplete(lease)).toBe(false);
    const expired = new Date(Date.now() - 1);
    await prisma.workspaceRunBinding.update({ data: { exportLeaseExpiresAt: expired }, where: { modelRunId: fixture.runId } });
    await prisma.workspaceSession.update({ data: { operationExpiresAt: expired }, where: { id: fixture.sessionId } });
    const restarted = createPrismaWorkspaceCoordinatorRepository(prisma);
    const next = await restarted.claimExportForRecovery({ ...fixture, generation: claim.operation.generation, leaseMs: 60_000 });
    if (next.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const nextLease = { ...fixture, operation: next.operation, token: next.token };
    expect(await restarted.reserveOutputCapture(nextLease)).toEqual({ id, outputs, create: false });
    expect(await repository.reserveOutputCapture(lease)).toBeNull();
    expect(await repository.sealOutputCapture({ ...lease, capture: { id, outputs } })).toBe(false);
    expect(await restarted.sealOutputCapture({ ...nextLease, capture: { id, outputs: [{ ...outputs[0]!, checksum: "e".repeat(64) }, outputs[1]!] } })).toBe(false);
    expect(await restarted.generatedFiles(fixture)).toEqual([ready]);
    const nextBinding = (await restarted.binding(fixture))!;
    await expect(restarted.settleOutput({ binding: nextBinding, output: { ...outputs[1]!, relativePath: "extra.txt" }, storageKey: "unused", token: next.token }))
      .rejects.toMatchObject({ code: "workspace_output_export_failed" });
    const secondKey = `workspace-lease-fixture/${randomUUID()}`;
    expect(await restarted.prepareOutput({ ...nextLease, storageKey: secondKey })).toBe(true);
    await restarted.settleOutput({ binding: nextBinding, output: outputs[1]!, storageKey: secondKey, token: next.token });
    expect(await restarted.markExportComplete(nextLease)).toBe(true);
    expect((await restarted.generatedFiles(fixture)).map((file) => file.relativePath).sort()).toEqual(["one.txt", "two.txt"]);
    expect((await restarted.generatedFiles(fixture)).find((file) => file.relativePath === "one.txt")?.attachmentId).toBe(ready.attachmentId);
  });

  it("requires a captured empty set before certifying an answer with no outputs", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const lease = { ...fixture, operation: claim.operation, token: claim.token };
    expect(await repository.markExportComplete(lease)).toBe(false);
    const capture = await repository.reserveOutputCapture(lease);
    expect(await repository.markExportComplete(lease)).toBe(false);
    expect(await repository.sealOutputCapture({ ...lease, capture: { id: capture!.id, outputs: [] } })).toBe(true);
    expect(await repository.markExportComplete(lease)).toBe(true);
  });

  it.each(["owner", "runtime", "deleting"] as const)("rejects old export publication after the session %s changes", async (change) => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000, runId: fixture.runId, sessionId: fixture.sessionId });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const binding = (await repository.binding(fixture))!;
    const lease = { operation: claim.operation!, runId: fixture.runId, runtimeSandboxId: binding.runtimeSandboxId,
      sessionId: fixture.sessionId, token: claim.token };
    await prisma.workspaceSession.update({ data: change === "owner"
      ? { operationOwner: "reset:replacement", version: { increment: 1 } }
      : change === "runtime" ? { runtimeSandboxId: "replacement_runtime" } : { state: "DELETING" }, where: { id: fixture.sessionId } });
    const changed = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: fixture.sessionId } });
    const publication = {
      binding, token: claim.token, storageKey: `workspace-lease-fixture/${randomUUID()}`,
      output: { byteSize: 6, checksum: createHash("sha256").update("report").digest("hex"), mimeType: "text/plain", relativePath: "report.txt" }
    };
    await expect(repository.settleOutput(publication)).rejects.toMatchObject({ code: "workspace_operation_stale" });
    await expect(repository.markExportComplete(lease)).resolves.toBe(false);
    await expect(repository.markExportFailed({ ...lease, code: "workspace_output_export_failed" })).resolves.toBe(false);
    await expect(repository.renewExportLease({ ...lease, leaseMs: 60_000 })).resolves.toBe(false);
    expect(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: fixture.runId } })).toBe(0);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: fixture.sessionId } })).toEqual(changed);
    expect((await bindingState(fixture.runId)).exportState).toBe("EXPORTING");
  });

  it("does not renew or complete an expired export even before another worker claims it", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000, runId: fixture.runId, sessionId: fixture.sessionId });
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const binding = (await repository.binding(fixture))!;
    const lease = { operation: claim.operation!, runId: fixture.runId, runtimeSandboxId: binding.runtimeSandboxId,
      sessionId: fixture.sessionId, token: claim.token };
    await prisma.workspaceRunBinding.update({ data: { exportLeaseExpiresAt: new Date(Date.now() - 1) }, where: { modelRunId: fixture.runId } });
    await expect(repository.renewExportLease({ ...lease, leaseMs: 60_000 })).resolves.toBe(false);
    await expect(repository.markExportComplete(lease)).resolves.toBe(false);
    expect((await bindingState(fixture.runId)).exportState).toBe("EXPORTING");
  });

  it.each(["reset", "retention", "restore", "confirmed loss"] as const)("classifies owed exports as lost when %s removes their disk", async (kind) => {
    const fixture = await createFixture();
    const answer = await prisma.message.findFirstOrThrow({ where: { chatId: fixture.chatId, role: "assistant" } });
    const local = new DeterministicWorkspaceRuntime(config);
    const runtime = fenceDeterministicWorkspaceRuntime(local);
    const now = new Date();
    await prisma.workspaceSession.update({ data: { state: "STOPPED", expiresAt: new Date(now.getTime() - 1) }, where: { id: fixture.sessionId } });
    if (kind === "reset") {
      const policy = { async read() { return { enabled: true, internetEnabled: true, version: 1 }; }, async update() { throw new Error("unused"); } };
      const lifecycle = createWorkspaceLifecycleService({ config, prisma, runtime, storage: createMemoryStorageAdapter(), policy,
        availability: createWorkspaceAvailabilityService({ policy, health: { invalidate() {}, async read() { return { state: "ready" }; } } }) });
      await lifecycle.reset(fixture);
    } else if (kind === "retention") {
      expect(await runWorkspaceMaintenance({ config, now, prisma, runtime })).toMatchObject({ cleanupCompleted: 1 });
    } else if (kind === "restore") {
      await reconcileWorkspaceAfterRestore(prisma, now);
    } else {
      // A later run discovers that the old disk disappeared before dispatch.
      const operation = { generation: fixture.generation, owner: "run:replacement" };
      await prisma.workspaceSession.update({ data: { operationOwner: operation.owner }, where: { id: fixture.sessionId } });
      expect(await repository.markSessionLost({ operation, runtimeSandboxId: fixture.runtimeSandboxId!, sessionId: fixture.sessionId }))
        .toEqual({ generation: operation.generation + 1, owner: operation.owner });
    }
    expect(await bindingState(fixture.runId)).toMatchObject({ exportState: "FAILED", lastExportErrorCode: "workspace_session_lost",
      exportCompletedAt: null, exportLeaseToken: null, exportLeaseExpiresAt: null });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: answer.id } })).toEqual(answer);
    expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("complete");
  });

  it.each(["reset", "archive"] as const)("rejects a delayed live-export claim while %s owns the session", async (kind) => {
    const fixture = await createFixture();
    const before = await prisma.workspaceSession.update({ data: { operationOwner: `run:${fixture.runId}` }, where: { id: fixture.sessionId } });
    const captured = { leaseMs: 60_000, operation: { generation: before.version, owner: before.operationOwner! },
      runId: fixture.runId, runtimeSandboxId: before.runtimeSandboxId, sessionId: fixture.sessionId };
    await repository.settleSession({ ...captured, outcome: "stopped" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const local = new DeterministicWorkspaceRuntime(config);
    const bytes = Buffer.from("synthetic archive");
    vi.spyOn(local, "ensureSession").mockImplementation(async (input) => {
      if (kind === "archive") { entered(); await held; }
      return { runtimeSandboxId: before.runtimeSandboxId!, sandboxName: input.sandboxName, state: "ready" };
    });
    vi.spyOn(local, "removeSession").mockImplementation(async () => { if (kind === "reset") { entered(); await held; } });
    vi.spyOn(local, "createProjectArchive").mockImplementation(async () => ({
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "application/gzip", opaqueFileId: "a".repeat(64), relativePath: "workspace.tar.gz"
    }));
    const policy = { async read() { return { enabled: true, internetEnabled: true, version: 1 }; }, async update() { throw new Error("unused"); } };
    const lifecycle = createWorkspaceLifecycleService({ config, prisma, runtime: fenceDeterministicWorkspaceRuntime(local),
      storage: createMemoryStorageAdapter(),
      availability: createWorkspaceAvailabilityService({ policy, health: { invalidate() {}, async read() { return { state: "ready" }; } } }),
      policy
    });
    const pending = lifecycle[kind]({ chatId: fixture.chatId, userId: fixture.userId });
    try {
      await started;
      await expect(repository.claimExport(captured)).resolves.toEqual({ status: "busy" });
      expect((await bindingState(fixture.runId)).exportAttemptCount).toBe(0);
    } finally { release(); await pending; }
  });

  it("keeps a live exporter ahead of reset, workspace archive, chat archival and retention", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const local = new DeterministicWorkspaceRuntime(config);
    const stop = vi.spyOn(local, "stopSession");
    const remove = vi.spyOn(local, "removeSession");
    const ensure = vi.spyOn(local, "ensureSession");
    const archive = vi.spyOn(local, "createProjectArchive");
    const runtime = fenceDeterministicWorkspaceRuntime(local);
    const policy = { async read() { return { enabled: true, internetEnabled: true, version: 1 }; }, async update() { throw new Error("unused"); } };
    const lifecycle = createWorkspaceLifecycleService({ config, prisma, runtime, policy, storage: createMemoryStorageAdapter(),
      availability: createWorkspaceAvailabilityService({ policy, health: { invalidate() {}, async read() { return { state: "ready" }; } } }) });
    await expect(lifecycle.reset({ chatId: fixture.chatId, userId: fixture.userId })).rejects.toMatchObject({ code: "workspace_reset_conflict" });
    await expect(lifecycle.archive({ chatId: fixture.chatId, userId: fixture.userId })).rejects.toMatchObject({ code: "workspace_busy" });
    expect(await createPrismaChatRepository(prisma).archiveChat({ chatId: fixture.chatId, userId: fixture.userId })).toBe(true);
    const now = new Date();
    await prisma.workspaceSession.update({ data: { expiresAt: new Date(now.getTime() - 1), lastActiveAt: new Date(now.getTime() - 3_600_000) }, where: { id: fixture.sessionId } });
    const before = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: fixture.sessionId } });
    await runWorkspaceMaintenance({ config, now, prisma, runtime });
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: fixture.sessionId } })).toEqual(before);
    expect(await prisma.workspaceCleanupJob.count({ where: { workspaceSessionId: fixture.sessionId } })).toBe(0);
    for (const operation of [stop, remove, ensure, archive]) {
      expect(operation.mock.calls.filter(([input]) => input.sessionId === fixture.sessionId)).toHaveLength(0);
    }
    expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("complete");
    expect((await bindingState(fixture.runId)).exportState).toBe("EXPORTING");
  });

  it.each(["idle", "chat archive", "retention"] as const)("defers export while an earlier %s cleanup owns the receiver", async (kind) => {
    const fixture = await createFixture();
    const before = await prisma.workspaceSession.update({ data: { operationOwner: `run:${fixture.runId}` }, where: { id: fixture.sessionId } });
    const captured = { leaseMs: 60_000, operation: { generation: before.version, owner: before.operationOwner! },
      runId: fixture.runId, runtimeSandboxId: before.runtimeSandboxId, sessionId: fixture.sessionId };
    await repository.settleSession({ ...captured, outcome: "ready" });
    const now = new Date();
    await prisma.workspaceSession.update({ data: {
      expiresAt: new Date(now.getTime() + (kind === "retention" ? -1 : 3_600_000)),
      lastActiveAt: new Date(now.getTime() - (kind === "chat archive" ? 0 : (config.idleTtlSeconds + 1) * 1_000))
    }, where: { id: fixture.sessionId } });
    if (kind === "chat archive") expect(await createPrismaChatRepository(prisma).archiveChat(fixture)).toBe(true);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const local = new DeterministicWorkspaceRuntime(config);
    vi.spyOn(local, kind === "retention" ? "removeSession" : "stopSession").mockImplementation(async ({ sessionId }) => {
      if (sessionId === fixture.sessionId) { entered(); await held; }
    });
    const pending = runWorkspaceMaintenance({ config, now, prisma, runtime: fenceDeterministicWorkspaceRuntime(local) });
    try {
      await started;
      await expect(repository.claimExport(captured)).resolves.toEqual({ status: "busy" });
      await expect(repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000 })).resolves.toEqual({ status: "busy" });
      expect((await bindingState(fixture.runId)).exportAttemptCount).toBe(0);
    } finally { release(); await pending; }
    expect((await bindingState(fixture.runId)).exportState).toBe(kind === "retention" ? "FAILED" : "PENDING");
  });

  it("traverses an inaccessible Project head and a busy chat to reach later eligible work", async () => {
    const denied: Fixture[] = [];
    for (let index = 0; index < 10; index += 1) {
      const fixture = await createFixture({ project: true });
      expect(await repository.binding(fixture)).not.toBeNull();
      const grant = { projectId: fixture.projectId!, userId: fixture.userId };
      if (index % 3 === 0) await prisma.projectGrant.deleteMany({ where: grant });
      if (index % 3 === 1) await prisma.projectGrant.updateMany({ data: { role: "VIEWER" }, where: grant });
      if (index % 3 === 2) await prisma.project.update({ data: { archivedAt: new Date(), status: "ARCHIVED" }, where: { id: fixture.projectId! } });
      denied.push(fixture);
    }
    const busy = await createFixture();
    const healthy = await createFixture();
    const headTime = new Date("2001-01-01T00:00:00.000Z");
    await prisma.workspaceRunBinding.updateMany({ data: { updatedAt: headTime }, where: { modelRunId: { in: denied.map((row) => row.runId) } } });
    await prisma.workspaceRunBinding.updateMany({ data: { updatedAt: new Date(headTime.getTime() + 1) }, where: { modelRunId: { in: [busy.runId, healthy.runId] } } });
    const parent = await prisma.modelRun.findUniqueOrThrow({ where: { id: busy.runId } });
    const active = await prisma.modelRun.create({ data: {
      chatId: busy.chatId, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "streaming", userId: busy.userId, userMessageId: parent.userMessageId
    } });
    const first = await repository.exportRecoveryCandidates({ limit: 10, staleBefore: new Date(headTime.getTime() + 2) });
    expect(new Set(first.map((row) => row.runId))).toEqual(new Set(denied.map((row) => row.runId)));
    for (const candidate of first) expect(await repository.binding(candidate)).toBeNull();
    const cursor = first.at(-1)!;
    const second = await repository.exportRecoveryCandidates({ cursor, limit: 10, staleBefore: new Date(headTime.getTime() + 2) });
    expect(new Set(second.map((row) => row.runId))).toEqual(new Set([busy.runId, healthy.runId]));
    expect(await repository.claimExportForRecovery({ ...busy, leaseMs: 10_000, runId: busy.runId, sessionId: busy.sessionId })).toEqual({ status: "busy" });
    expect((await bindingState(busy.runId)).exportAttemptCount).toBe(0);
    expect(await repository.claimExportForRecovery({ ...healthy, leaseMs: 10_000, runId: healthy.runId, sessionId: healthy.sessionId })).toMatchObject({ status: "claimed" });
    // Deferral preserves a legitimate future retry after access is restored.
    const revoked = denied[0]!;
    await prisma.projectGrant.create({ data: { projectId: revoked.projectId!, role: "CONTRIBUTOR", userId: revoked.userId } });
    expect(await repository.binding({ runId: revoked.runId, userId: revoked.userId })).not.toBeNull();
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: active.id } });
  });

  it("enforces the attempt cap even if a selected candidate becomes exhausted before claim", async () => {
    const fixture = await createFixture();
    await prisma.workspaceRunBinding.update({ data: { exportAttemptCount: WORKSPACE_EXPORT_MAX_ATTEMPTS }, where: { modelRunId: fixture.runId } });
    await expect(repository.claimExportForRecovery({ ...fixture, leaseMs: 10_000, runId: fixture.runId, sessionId: fixture.sessionId })).resolves.toEqual({ status: "exhausted" });
    expect((await bindingState(fixture.runId)).exportAttemptCount).toBe(WORKSPACE_EXPORT_MAX_ATTEMPTS);
  });

  it("grants one owner per binding across simultaneous claims", async () => {
    const fixture = await createFixture();
    const claims = await Promise.all(Array.from({ length: 4 }, () => repository.claimExportForRecovery({ ...fixture,
      leaseMs: 60_000,
      runId: fixture.runId,
      sessionId: fixture.sessionId
    })));
    const claimed = claims.filter((claim) => claim.status === "claimed");
    expect(claimed).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "busy")).toHaveLength(3);
    await expect(bindingState(fixture.runId)).resolves.toMatchObject({
      exportAttemptCount: 1,
      exportLeaseToken: claimed[0]!.status === "claimed" ? claimed[0]!.token : null,
      exportState: "EXPORTING"
    });
  });

  it("reclaims an expired or lease-less EXPORTING binding and fences the old owner", async () => {
    const stale = await createFixture({ exportState: "EXPORTING" });
    // A binding migrated while EXPORTING carries no lease and is claimable.
    const first = await repository.claimExportForRecovery({ ...stale,
      leaseMs: 60_000,
      runId: stale.runId,
      sessionId: stale.sessionId
    });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") return;
    const expired = new Date(Date.now() - 1);
    await prisma.workspaceRunBinding.update({ data: { exportLeaseExpiresAt: expired }, where: { modelRunId: stale.runId } });
    await prisma.workspaceSession.update({ data: { operationExpiresAt: expired }, where: { id: stale.sessionId } });
    const second = await repository.claimExportForRecovery({ ...stale, generation: first.operation.generation,
      leaseMs: 60_000,
      runId: stale.runId,
      sessionId: stale.sessionId
    });
    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") return;
    expect(second.token).not.toBe(first.token);

    const lease = { ...stale, operation: first.operation, leaseMs: 60_000 };
    await expect(repository.renewExportLease({ ...lease, token: first.token })).resolves.toBe(false);
    await expect(repository.markExportComplete({ ...lease, token: first.token })).resolves.toBe(false);
    await expect(repository.markExportFailed({
      ...lease,
      code: "workspace_output_export_failed",
      token: first.token
    })).resolves.toBe(false);
    await expect(bindingState(stale.runId)).resolves.toMatchObject({
      exportAttemptCount: 2,
      exportLeaseToken: second.token,
      exportState: "EXPORTING"
    });
    await expect(repository.renewExportLease({ ...lease, operation: second.operation, token: second.token })).resolves.toBe(true);
    await captureOutputs({ ...lease, operation: second.operation, token: second.token });
    await expect(repository.markExportComplete({ ...lease, operation: second.operation, token: second.token })).resolves.toBe(true);
  });

  it("never downgrades COMPLETE and reports permanent failures without reclaiming them", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture,
      leaseMs: 60_000,
      runId: fixture.runId,
      sessionId: fixture.sessionId
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    const lease = { ...fixture, operation: claim.operation, token: claim.token };
    await captureOutputs(lease);
    await expect(repository.markExportComplete(lease)).resolves.toBe(true);
    await expect(repository.markExportFailed({ ...lease, code: "workspace_output_export_failed" }))
      .resolves.toBe(false);
    await expect(repository.claimExportForRecovery({ ...fixture,
      leaseMs: 60_000,
      runId: fixture.runId,
      sessionId: fixture.sessionId
    })).resolves.toEqual({ status: "complete" });
    const settled = await bindingState(fixture.runId);
    expect(settled).toMatchObject({
      exportLeaseExpiresAt: null,
      exportLeaseToken: null,
      exportState: "COMPLETE",
      lastExportErrorCode: null
    });
    expect(settled.exportCompletedAt).toBeInstanceOf(Date);

    const retryable = await createFixture({
      exportState: "FAILED",
      lastExportErrorCode: "workspace_output_export_failed"
    });
    await expect(repository.claimExportForRecovery({ ...retryable,
      leaseMs: 60_000,
      runId: retryable.runId,
      sessionId: retryable.sessionId
    })).resolves.toMatchObject({ status: "claimed" });

    const permanent = await createFixture({
      exportState: "FAILED",
      lastExportErrorCode: "workspace_output_limit_exceeded"
    });
    await expect(repository.claimExportForRecovery({ ...permanent,
      leaseMs: 60_000,
      runId: permanent.runId,
      sessionId: permanent.sessionId
    })).resolves.toEqual({ code: "workspace_output_limit_exceeded", status: "failed" });

    await expect(repository.claimExportForRecovery({ ...permanent,
      leaseMs: 60_000,
      runId: permanent.runId,
      sessionId: fixture.sessionId
    })).rejects.toThrow("workspace_output_export_failed");
  });
});

describe("Prisma Workspace execution registry", () => {
  beforeAll(cleanupFixtures);

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  });

  it("registers idempotently, rejects foreign owners, and survives repository reconstruction", async () => {
    const fixture = await createFixture();
    const registry = createPrismaWorkspaceExecutionRegistry(prisma);
    const registration = {
      modelRunId: fixture.runId,
      modelRunToolCallId: fixture.toolCallId,
      runtimeExecSessionId: `exec-${randomUUID()}`,
      sessionId: fixture.sessionId
    };
    await expect(registry.register(registration)).resolves.toBe("registered");
    await expect(registry.register(registration)).resolves.toBe("registered");
    await expect(registry.register({
      ...registration,
      runtimeExecSessionId: `exec-${randomUUID()}`
    })).resolves.toBe("conflict");
    await expect(registry.register({ ...registration, runtimeExecSessionId: "" }))
      .rejects.toThrow("workspace_runtime_incompatible");

    const other = await createFixture();
    await expect(registry.register({
      modelRunId: other.runId,
      modelRunToolCallId: other.toolCallId,
      runtimeExecSessionId: registration.runtimeExecSessionId,
      sessionId: fixture.sessionId
    })).resolves.toBe("conflict");

    const reconstructed = createPrismaWorkspaceExecutionRegistry(prisma);
    const open = await reconstructed.listOpen({ sessionId: fixture.sessionId });
    expect(open).toEqual([expect.objectContaining({
      modelRunId: fixture.runId,
      modelRunToolCallId: fixture.toolCallId,
      runtimeExecSessionId: registration.runtimeExecSessionId,
      sessionId: fixture.sessionId,
      state: "ACTIVE"
    })]);
    await expect(reconstructed.listOpen({ modelRunId: other.runId, sessionId: fixture.sessionId }))
      .resolves.toEqual([]);
    const found = await reconstructed.find({
      runtimeExecSessionId: registration.runtimeExecSessionId,
      sessionId: fixture.sessionId
    });
    expect(found?.id).toBe(open[0]!.id);

    const id = open[0]!.id;
    await expect(reconstructed.transition({ from: ["CLOSED"], id, to: "ACTIVE" })).resolves.toBe(false);
    await expect(reconstructed.transition({ from: ["ACTIVE"], id, to: "TERMINATING" })).resolves.toBe(true);
    await expect(reconstructed.listOpen({ sessionId: fixture.sessionId })).resolves.toHaveLength(1);
    await expect(reconstructed.transition({
      errorCode: "workspace_execution_cleanup_failed",
      from: ["ACTIVE", "TERMINATING"],
      id,
      to: "CLOSED"
    })).resolves.toBe(true);
    await expect(reconstructed.listOpen({ sessionId: fixture.sessionId })).resolves.toEqual([]);
    await expect(prisma.workspaceExecution.findUniqueOrThrow({
      select: { completedAt: true, lastErrorCode: true, state: true },
      where: { id }
    })).resolves.toMatchObject({
      completedAt: expect.any(Date),
      lastErrorCode: "workspace_execution_cleanup_failed",
      state: "CLOSED"
    });
  });
});

describe("Prisma Workspace export concurrency", () => {
  const repository = createPrismaWorkspaceCoordinatorRepository(prisma);

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  });

  it("reclaims abandoned and redundant attempt objects while preserving the published object", async () => {
    const fixture = await createFixture();
    const storage = createMemoryStorageAdapter();
    const bytes = Buffer.from("report");
    const output = { byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), mimeType: "text/plain", relativePath: "report.txt" };
    const first = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000 });
    if (first.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const firstLease = { ...fixture, operation: first.operation, token: first.token };
    await captureOutputs(firstLease, [output]);
    const firstBinding = (await repository.binding(fixture))!;
    const publishedKey = `${fixture.userId}/workspace-outputs/${fixture.runId}/${first.token}/published`;
    const abandonedKey = `${fixture.userId}/workspace-outputs/${fixture.runId}/${first.token}/abandoned`;
    for (const storageKey of [publishedKey, abandonedKey]) {
      expect(await repository.prepareOutput({ ...firstLease, storageKey })).toBe(true);
      await storage.putObject({ body: bytes, contentType: output.mimeType, storageKey });
    }
    const published = await repository.settleOutput({ binding: firstBinding, output, storageKey: publishedKey, token: first.token });
    // A long upload keeps its crash-cleanup reservation alive as well as the
    // export lease; retention must not claim an object still being written.
    const oldClaim = new Date(Date.now() - 16 * 60_000);
    await prisma.attachmentDeletionJob.update({ data: { claimedAt: oldClaim }, where: { storageKey: abandonedKey } });
    expect(await repository.renewExportLease({ ...firstLease, leaseMs: 60_000 })).toBe(true);
    expect((await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: abandonedKey } })).claimedAt!.getTime())
      .toBeGreaterThan(oldClaim.getTime());
    expect(await createPrismaRetentionRepository(prisma).claimAttachmentDeletionJobs({ claimableBefore: new Date(Date.now() - 15 * 60_000), limit: 20, now: new Date() }))
      .toEqual([]);
    const expired = new Date(Date.now() - 1);
    await prisma.workspaceRunBinding.update({ data: { exportLeaseExpiresAt: expired }, where: { modelRunId: fixture.runId } });
    await prisma.workspaceSession.update({ data: { operationExpiresAt: expired }, where: { id: fixture.sessionId } });
    const second = await repository.claimExportForRecovery({ ...fixture, generation: first.operation.generation, leaseMs: 60_000 });
    if (second.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const secondLease = { ...fixture, operation: second.operation, token: second.token };
    const secondBinding = (await repository.binding(fixture))!;
    const duplicateKey = `${fixture.userId}/workspace-outputs/${fixture.runId}/${second.token}/duplicate`;
    expect(await repository.prepareOutput({ ...secondLease, storageKey: duplicateKey })).toBe(true);
    await storage.putObject({ body: bytes, contentType: output.mimeType, storageKey: duplicateKey });
    expect(await repository.settleOutput({ binding: secondBinding, output, storageKey: duplicateKey, token: second.token })).toEqual(published);
    expect(await repository.prepareOutput({ ...firstLease, storageKey: abandonedKey })).toBe(false);
    await expect(repository.settleOutput({ binding: firstBinding, output: { ...output, relativePath: "abandoned.txt" }, storageKey: abandonedKey, token: first.token }))
      .rejects.toMatchObject({ code: "workspace_operation_stale" });
    const retention = createPrismaRetentionRepository(prisma);
    expect(await retention.claimAttachmentDeletionJobs({ claimableBefore: new Date(Date.now() - 15 * 60_000), limit: 20, now: new Date() })).toEqual([]);
    const future = new Date(Date.now() + 16 * 60_000);
    const claims = await retention.claimAttachmentDeletionJobs({ claimableBefore: new Date(future.getTime() - 15 * 60_000), limit: 20, now: future });
    expect(claims.map(({ storageKey }) => storageKey).sort()).toEqual([abandonedKey, duplicateKey].sort());
    for (const claim of claims) {
      await storage.deleteObject(claim.storageKey);
      expect(await retention.completeAttachmentDeletionJob(claim)).toBe(true);
    }
    expect([...storage.objects.keys()]).toEqual([publishedKey]);
    expect((await storage.getObject(publishedKey)).body.equals(bytes)).toBe(true);
    expect((await repository.generatedFiles(fixture))[0]?.attachmentId).toBe(published.attachmentId);
  });

  it("settles one output row per path when two workers race on the same file", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExportForRecovery({ ...fixture, leaseMs: 60_000 });
    if (claim.status !== "claimed") throw new Error("fixture_export_claim_failed");
    const binding = await repository.binding({ runId: fixture.runId, userId: fixture.userId });
    expect(binding).not.toBeNull();
    const output = {
      byteSize: 12,
      checksum: "c".repeat(64),
      mimeType: "text/plain",
      relativePath: "nested/report.txt"
    };
    const storageKey = `${fixture.userId}/workspace-outputs/${fixture.runId}/race`;
    const lease = { ...fixture, operation: claim.operation, token: claim.token };
    await captureOutputs(lease, [output]);
    await expect(repository.prepareOutput({ ...lease, storageKey })).resolves.toBe(true);
    const settled = await Promise.all([1, 2, 3].map(() => repository.settleOutput({
      binding: binding!, token: claim.token,
      output,
      storageKey
    })));
    expect(new Set(settled.map((file) => file.attachmentId)).size).toBe(1);
    await expect(prisma.workspaceRunOutput.count({
      where: { workspaceRunBindingId: fixture.runId }
    })).resolves.toBe(1);
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(0);
    await expect(prisma.attachment.count({
      where: { origin: "WORKSPACE_OUTPUT", producerModelRunId: fixture.runId }
    })).resolves.toBe(1);
    // The same path with different bytes is a changed output and fails closed.
    await expect(repository.settleOutput({
      binding: binding!, token: claim.token,
      output: { ...output, checksum: "d".repeat(64) },
      storageKey: `${fixture.userId}/workspace-outputs/${fixture.runId}/changed`
    })).rejects.toThrow("workspace_output_export_failed");
  });

  it("fences background export recovery against an active run on the same chat", async () => {
    const fixture = await createFixture();
    const userMessage = await prisma.message.create({
      data: {
        chatId: fixture.chatId,
        content: textMessageContent("Another turn"),
        modelId: "fake-qsa",
        provider: "fake",
        role: "user",
        status: "complete"
      }
    });
    const assistantMessage = await prisma.message.create({
      data: {
        chatId: fixture.chatId,
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
        chatId: fixture.chatId,
        modelId: "fake-qsa",
        normalizedRequest: {},
        provider: "fake",
        status: "streaming",
        userId: fixture.userId,
        userMessageId: userMessage.id
      }
    });
    await expect(repository.claimExportForRecovery({ ...fixture,
      leaseMs: 60_000,
      runId: fixture.runId,
      sessionId: fixture.sessionId
    })).resolves.toEqual({ status: "busy" });
    await expect(bindingState(fixture.runId)).resolves.toMatchObject({ exportState: "PENDING" });

    // The one-active-run invariant lives in the database, not in memory.
    await expect(prisma.modelRun.create({
      data: {
        assistantMessageId: assistantMessage.id,
        chatId: fixture.chatId,
        modelId: "fake-qsa",
        normalizedRequest: {},
        provider: "fake",
        status: "streaming",
        userId: fixture.userId,
        userMessageId: userMessage.id
      }
    })).rejects.toThrow();

    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: activeRun.id } });
    await expect(repository.claimExportForRecovery({ ...fixture,
      leaseMs: 60_000,
      runId: fixture.runId,
      sessionId: fixture.sessionId
    })).resolves.toMatchObject({ status: "claimed" });
    await expect(repository.exportRecoveryCandidates({
      limit: 10,
      staleBefore: new Date(Date.now() + 1_000)
    })).resolves.not.toContainEqual(expect.objectContaining({ runId: fixture.runId, userId: fixture.userId }));
  });
});
