// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { prisma } from "@/lib/server/prisma";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";
import { createPrismaWorkspaceExecutionRegistry } from "./executionRegistry";

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
    where: { userId: { in: userIds } }
  });
  const chatIds = chats.map(({ id }) => id);
  await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.chat.updateMany({
    data: { activeLeafMessageId: null },
    where: { id: { in: chatIds } }
  });
  await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

type Fixture = Readonly<{
  runId: string;
  sessionId: string;
  toolCallId: string;
}>;

async function createFixture(input: Readonly<{
  exportState?: "EXPORTING" | "FAILED" | "PENDING";
  lastExportErrorCode?: string;
}> = {}): Promise<Fixture> {
  const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
  const user = await prisma.user.create({
    data: { displayName: "Workspace Export Lease Test", id: userId }
  });
  const chat = await prisma.chat.create({
    data: { title: "Export lease", userId: user.id, workspaceEnabled: true }
  });
  const userMessage = await prisma.message.create({
    data: {
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
      toolCatalogHash: "a".repeat(64),
      toolDefinitions: [{ name: "fixture" }],
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
  return { runId: run.id, sessionId: session.id, toolCallId: toolCall.id };
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

describe("Prisma Workspace export lease", () => {
  const repository = createPrismaWorkspaceCoordinatorRepository(prisma);

  beforeAll(cleanupFixtures);

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  });

  it("grants one owner per binding across simultaneous claims", async () => {
    const fixture = await createFixture();
    const claims = await Promise.all(Array.from({ length: 4 }, () => repository.claimExport({
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
    const first = await repository.claimExport({
      leaseMs: 1,
      runId: stale.runId,
      sessionId: stale.sessionId
    });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await repository.claimExport({
      leaseMs: 60_000,
      runId: stale.runId,
      sessionId: stale.sessionId
    });
    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") return;
    expect(second.token).not.toBe(first.token);

    const lease = { leaseMs: 60_000, runId: stale.runId, sessionId: stale.sessionId };
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
    await expect(repository.renewExportLease({ ...lease, token: second.token })).resolves.toBe(true);
    await expect(repository.markExportComplete({ ...lease, token: second.token })).resolves.toBe(true);
  });

  it("never downgrades COMPLETE and reports permanent failures without reclaiming them", async () => {
    const fixture = await createFixture();
    const claim = await repository.claimExport({
      leaseMs: 60_000,
      runId: fixture.runId,
      sessionId: fixture.sessionId
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    const lease = { runId: fixture.runId, sessionId: fixture.sessionId, token: claim.token };
    await expect(repository.markExportComplete(lease)).resolves.toBe(true);
    await expect(repository.markExportFailed({ ...lease, code: "workspace_output_export_failed" }))
      .resolves.toBe(false);
    await expect(repository.claimExport({
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
    await expect(repository.claimExport({
      leaseMs: 60_000,
      runId: retryable.runId,
      sessionId: retryable.sessionId
    })).resolves.toMatchObject({ status: "claimed" });

    const permanent = await createFixture({
      exportState: "FAILED",
      lastExportErrorCode: "workspace_output_limit_exceeded"
    });
    await expect(repository.claimExport({
      leaseMs: 60_000,
      runId: permanent.runId,
      sessionId: permanent.sessionId
    })).resolves.toEqual({ code: "workspace_output_limit_exceeded", status: "failed" });

    await expect(repository.claimExport({
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
