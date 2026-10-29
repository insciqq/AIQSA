// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { workspaceRunOutputDirectory, workspaceSandboxName } from "@/lib/domain/workspace";
import { prisma } from "@/lib/server/prisma";
import { WORKSPACE_SUBAGENTS_RUNNING_CODE } from "@/lib/contracts/subagents";
import type { WorkspaceDetachInput, WorkspaceDetachResult } from "@/lib/server/subagents/ports";
import {
  closeWorkspaceRunOperation,
  createPrismaWorkspaceAttachments,
  currentWorkspaceAttachments,
  joinWorkspaceRunOperation,
  workspaceRunHoldsOperation
} from "./attachments";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { removeWorkspaceForDeletion } from "./removal";
import { lockWorkspaceSession } from "./sessionOperation";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const prefix = "workspace-attachment-test-";
/** The coordinator's retirement is covered by its own tests; these cover the attachment rows and their races. */
const retireNothing = async (_input: WorkspaceDetachInput): Promise<WorkspaceDetachResult> =>
  ({ interruptedRunIds: [], kind: "detached", remainingRuns: 0 });
const attachments = createPrismaWorkspaceAttachments({ prisma, retire: retireNothing, waitMs: 8_000 });

/** A chat with an active main-agent run and `subagents` active background sub-agent runs, all bound to one idle session. */
async function chatFixture(subagents: number) {
  const userId = prefix + randomUUID();
  await prisma.user.create({ data: { displayName: "Workspace Attachment Test", id: userId, status: "active" } });
  const chat = await prisma.chat.create({ data: { title: "Shared Workspace", userId, workspaceEnabled: true } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic question"), role: "user" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id,
    role: "assistant", status: "streaming" } });
  const sessionId = `ws_${randomBytes(20).toString("hex")}`;
  const session = await prisma.workspaceSession.create({ data: {
    chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000), id: sessionId, imageRef: config.imageRef, internetEnabled: false,
    policyRevision: 1, sandboxName: workspaceSandboxName(sessionId), state: "READY"
  } });
  const run = (data: Readonly<{ assistantMessageId?: string; subagentThreadId?: string; subagentTurnId?: string }>) => prisma.modelRun.create({ data: {
    chatId: chat.id, id: randomUUID(), modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "streaming", userId,
    userMessageId: question.id, ...data
  } });
  const bind = (modelRunId: string) => prisma.workspaceRunBinding.create({ data: {
    guestUsedAt: null, imageRef: config.imageRef, internetEnabled: false, mcpVersion: "0.6.16", modelRunId,
    outputDirectory: workspaceRunOutputDirectory(modelRunId), policyRevision: 1, runtimeVersion: "0.6.16",
    toolCatalogHash: "a".repeat(64), toolDefinitions: [], workspaceSessionId: sessionId
  } });
  const main = await run({ assistantMessageId: answer.id });
  await bind(main.id);
  const background: Array<Readonly<{ name: string; runId: string; threadId: string }>> = [];
  for (let index = 0; index < subagents; index += 1) {
    const call = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: main.id, ordinal: index,
      providerCallId: `call-${index}`, roundIndex: 0, toolName: "call_subagent" } });
    const name = `researcher-${index}`;
    const thread = await prisma.subagentThread.create({ data: { anchorRunId: main.id, chatId: chat.id, name, userId } });
    const turn = await prisma.subagentTurn.create({ data: { chatId: chat.id, mode: "background", modelId: "fake-qsa",
      parentRunId: main.id, parentToolCallId: call.id, provider: "fake", threadId: thread.id, userId } });
    const subagent = await run({ subagentThreadId: thread.id, subagentTurnId: turn.id });
    await bind(subagent.id);
    background.push({ name, runId: subagent.id, threadId: thread.id });
  }
  const subagentAttachment = (index: number) => ({ agent: { kind: "subagent" as const, name: background[index]!.name,
    threadId: background[index]!.threadId }, chatId: chat.id, modelRunId: background[index]!.runId, userId });
  return { background, chatId: chat.id, main, session, sessionId, subagentAttachment, userId };
}

async function sessionRow(sessionId: string) {
  return prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId } });
}

describe("Workspace attachments on PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("lets two background runs that attach at once share one operation, and the main run join it", async () => {
    const f = await chatFixture(2);
    const results = await Promise.all([attachments.attach(f.subagentAttachment(0)), attachments.attach(f.subagentAttachment(1))]);
    expect(results.map((result) => result.kind)).toEqual(["attached", "attached"]);
    const session = await sessionRow(f.sessionId);
    // One claim only: the second run joined the first's generation instead of draining it with a new one.
    expect(session.version).toBe(f.session.version + 1);
    expect(session.operationOwner).toMatch(/^run:/u);
    const rows = await prisma.workspaceRunAttachment.findMany({ where: { chatId: f.chatId } });
    expect(rows.map((row) => row.operationGeneration)).toEqual([session.version, session.version]);
    // The main agent's next message attaches to the same VM, as run admission does.
    expect(await prisma.$transaction(async (tx) => {
      const locked = await lockWorkspaceSession(tx, f.sessionId);
      return joinWorkspaceRunOperation(tx, locked!, f.main.id);
    })).toBe(true);
    const attached = await attachments.attached({ chatId: f.chatId, userId: f.userId });
    expect(attached.map((entry) => entry.agent.kind).sort()).toEqual(["main", "subagent", "subagent"]);
    expect((await sessionRow(f.sessionId)).version).toBe(session.version);
    // Another user sees nothing, and an attach naming the wrong agent for the run is refused.
    expect(await attachments.attached({ chatId: f.chatId, userId: "someone-else" })).toEqual([]);
    expect(await attachments.attach({ ...f.subagentAttachment(0), agent: { kind: "main" } }))
      .toEqual({ code: "workspace_unavailable", kind: "refused" });
    // Reset and continuation seeds wait for the sub-agents; other exclusive steps run one at a time.
    await expect(attachments.exclusive({ chatId: f.chatId, operation: "reset", userId: f.userId }, async () => "reset"))
      .resolves.toEqual({ code: WORKSPACE_SUBAGENTS_RUNNING_CODE, kind: "refused" });
    await expect(attachments.exclusive({ chatId: f.chatId, operation: "vm_start", userId: f.userId }, async () => "started"))
      .resolves.toEqual({ kind: "done", value: "started" });
  });

  it("never leaves a run attached to an operation a settling last run stops", async () => {
    // A background run attaches while the chat's last attached run settles; whichever wins, the invariant holds.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const f = await chatFixture(1);
      expect(await attachments.attach({ agent: { kind: "main" }, chatId: f.chatId, modelRunId: f.main.id, userId: f.userId }))
        .toMatchObject({ attachedRuns: 1, kind: "attached" });
      const held = await sessionRow(f.sessionId);
      const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
      const binding = (await repository.binding({ runId: f.main.id, userId: f.userId }))!;
      expect(binding.operationAttached).toBe(true);
      const settle = async () => {
        // The coordinator's last-run path: close the operation, then settle the session once the VM stopped.
        if (!await prisma.$transaction((tx) => closeWorkspaceRunOperation(tx, { force: false, generation: held.version,
          owner: held.operationOwner!, runId: f.main.id, sessionId: f.sessionId }))) return false;
        await prisma.modelRun.update({ data: { status: "complete" }, where: { id: f.main.id } });
        return repository.settleSession({ operation: { generation: held.version, owner: held.operationOwner! }, outcome: "stopped",
          runtimeSandboxId: null, sessionId: f.sessionId });
      };
      const attach = () => attachments.attach(f.subagentAttachment(0));
      const [settled, attached] = attempt % 2 === 0 ? await Promise.all([settle(), attach()])
        : await Promise.all([attach(), settle()]).then(([joined, closed]) => [closed, joined] as const);
      expect(attached).toMatchObject({ kind: "attached" });
      const session = await sessionRow(f.sessionId);
      // The sub-agent holds the session's current operation either way: a fresh one after the settle, or the main
      // run's, which then was never closed under it.
      expect(await workspaceRunHoldsOperation(prisma, session, f.background[0]!.runId)).toBe(true);
      if (settled) {
        expect(session.version).toBe(held.version + 1);
        expect(session.operationOwner).toBe(`run:${f.background[0]!.runId}`);
      } else {
        expect(session.version).toBe(held.version);
        expect(session.operationExpiresAt).toBeNull();
        expect((await currentWorkspaceAttachments(prisma, session)).map((run) => run.modelRunId).sort())
          .toEqual([f.main.id, f.background[0]!.runId].sort());
      }
    }
  });

  it("refuses Workspace removal while an attached run is active, and takes over the operation once it stopped", async () => {
    const f = await chatFixture(1);
    expect(await attachments.attach(f.subagentAttachment(0))).toMatchObject({ kind: "attached" });
    const runtime = fenceDeterministicWorkspaceRuntime(new DeterministicWorkspaceRuntime(config));
    await expect(removeWorkspaceForDeletion({ now: new Date(), prisma, runtime, sessionId: f.sessionId }))
      .rejects.toMatchObject({ code: "workspace_operation_stale" });
    expect(await prisma.workspaceRunAttachment.count({ where: { chatId: f.chatId } })).toBe(1);
    // The deletion path stops every run of the chat first (here: they ended without detaching, as after a crash).
    await prisma.modelRun.updateMany({ data: { status: "cancelled" }, where: { chatId: f.chatId } });
    await removeWorkspaceForDeletion({ now: new Date(), prisma, runtime, sessionId: f.sessionId });
    const session = await sessionRow(f.sessionId);
    expect(session).toMatchObject({ operationOwner: null, state: "DELETING" });
    expect(await prisma.workspaceRunAttachment.count({ where: { chatId: f.chatId } })).toBe(0);
    // Nothing attaches to a Workspace being deleted.
    await prisma.modelRun.update({ data: { status: "streaming" }, where: { id: f.background[0]!.runId } });
    expect(await attachments.attach(f.subagentAttachment(0))).toEqual({ code: "workspace_unavailable", kind: "refused" });
  });
});
