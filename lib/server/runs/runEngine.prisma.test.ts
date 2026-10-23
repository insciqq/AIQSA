import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createChatPdfRepository } from "../uploads/chatPdfPersistence";
import { activeRunControllerRegistry } from "./activeRunControllerRegistry";
import { createPrismaRunRepository } from "./prismaRepository";
import { ActiveRunConflictError, type RunRepository } from "./runRepositoryContract";
import { reconcileStaleRuns } from "./runRecovery";
import { createWorkspaceFollowupRepository } from "./workspaceFollowupPersistence";

// Long before any other fixture, so installation-wide recovery bounded by the
// next day sees only the runs this file backdates.
const BACKDATED = new Date("2001-02-03T04:05:06.000Z");
const BOUNDARY = new Date("2001-02-04T04:05:06.000Z");

type Engine = "native" | "v1";
type Turn = Readonly<{ answerId: string; questionId: string }>;
type AcceptedRun = Readonly<{ assistantMessageId: string; chatId: string; runId: string; userMessageId: string }>;

const owners: string[] = [];
const repository = createPrismaRunRepository(prisma);

async function owner(): Promise<string> {
  const userId = `run-engine-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: {
    displayName: "Run engine test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } }
  } });
  return userId;
}

function chat(userId: string, title: string) {
  return prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title, userId } });
}

function sendInput(chatId: string, userId: string, expectedActiveLeafId: string | null = null): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Synthetic question");
  return {
    chatId, content, expectedActiveLeafId, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId,
    defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId },
    normalizedRequest: {
      attachmentIds: [], chatId, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
    }
  };
}

/** A run the old core accepts today: its admission names no engine. */
async function oldCoreRun(userId: string): Promise<AcceptedRun> {
  const { id: chatId } = await chat(userId, "Old-core chat");
  const created = await repository.createRun(sendInput(chatId, userId));
  return { assistantMessageId: created.assistantMessageId, chatId, runId: created.runId, userMessageId: created.userMessageId };
}

/** The native engine writes its marker at admission; nothing else differs here. */
async function nativeRun(userId: string): Promise<AcceptedRun> {
  const run = await oldCoreRun(userId);
  await prisma.modelRun.update({ data: { engine: "native" }, where: { id: run.runId } });
  return run;
}

async function turn(chatId: string, answerStatus: "complete" | "streaming" = "streaming", parentMessageId: string | null = null): Promise<Turn> {
  const question = await prisma.message.create({ data: {
    chatId, content: textMessageContent("Synthetic question"), parentMessageId, role: "user", status: "complete"
  } });
  const answer = await prisma.message.create({ data: {
    chatId, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: answerStatus
  } });
  return { answerId: answer.id, questionId: question.id };
}

type OutsideWriter = Readonly<{ chatId: string; engine?: "native"; turn: Turn; userId: string }>;

/** The INSERT of an active run written outside this release: a previous
 * release names no engine column at all, a native writer names its own. */
function activeRunInsert(id: string, input: OutsideWriter): Prisma.Sql {
  const engineColumn = input.engine ? Prisma.sql`, "engine"` : Prisma.empty;
  const engineValue = input.engine ? Prisma.sql`, ${input.engine}::"ModelRunEngine"` : Prisma.empty;
  return Prisma.sql`
    INSERT INTO "ModelRun" ("id", "userId", "chatId", "userMessageId", "assistantMessageId", "provider", "modelId",
      "status", "normalizedRequest", "updatedAt"${engineColumn})
    VALUES (${id}, ${input.userId}, ${input.chatId}, ${input.turn.questionId}, ${input.turn.answerId}, 'fake', 'fake-qsa',
      'streaming', '{}'::jsonb, CURRENT_TIMESTAMP${engineValue})`;
}

async function insertActiveRun(input: OutsideWriter): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRaw(activeRunInsert(id, input));
  return id;
}

/** Whether ModelRun_one_active_per_chat_idx refuses the writer's run. The
 * conflict target and predicate infer that index as the only arbiter, so a
 * refusal skips the row; a conflict with any other constraint still raises,
 * and an insert that nothing refuses lands and returns its id. */
async function activeRunIndexRefuses(input: OutsideWriter): Promise<boolean> {
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`${activeRunInsert(randomUUID(), input)}
    ON CONFLICT ("chatId") WHERE NOT "workspaceWaitPending" AND "status" IN ('preparing', 'queued', 'streaming', 'in_progress')
    DO NOTHING
    RETURNING "id"`);
  return inserted.length === 0;
}

/** An answer the previous release started: it reaches this release as an active row without the column. */
async function previousReleaseRun(userId: string): Promise<AcceptedRun> {
  const { id: chatId } = await chat(userId, "Previous-release chat");
  const answer = await turn(chatId);
  await prisma.chat.update({ data: { activeLeafMessageId: answer.answerId }, where: { id: chatId } });
  const runId = await insertActiveRun({ chatId, turn: answer, userId });
  return { assistantMessageId: answer.answerId, chatId, runId, userMessageId: answer.questionId };
}

async function backdate(runIds: readonly string[]): Promise<void> {
  await prisma.modelRun.updateMany({ data: { createdAt: BACKDATED, updatedAt: BACKDATED }, where: { id: { in: [...runIds] } } });
}

function errorCode(payload: Prisma.JsonValue | null): Prisma.JsonValue | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload.code ?? null : null;
}

async function runStates(runIds: readonly string[]) {
  const rows = await prisma.modelRun.findMany({
    select: { engine: true, errorPayload: true, id: true, status: true }, where: { id: { in: [...runIds] } }
  });
  return Object.fromEntries(rows.map((row) => [row.id, { code: errorCode(row.errorPayload), engine: row.engine, status: row.status }]));
}

async function messageStatus(id: string) {
  return (await prisma.message.findUniqueOrThrow({ select: { status: true }, where: { id } })).status;
}

/** A successor whose Workspace follow-up a crashed worker left mid-activation: claimable again. */
async function interruptedFollowup(userId: string, engine: Engine): Promise<string> {
  const { id: chatId } = await chat(userId, "Workspace follow-up chat");
  const first = await turn(chatId, "complete");
  const second = await turn(chatId, "streaming", first.answerId);
  return prisma.$transaction(async (tx) => {
    // Only a preparing run lacks its normalized request (ModelRun_memory_request_shape_check).
    const predecessor = await tx.modelRun.create({ data: {
      assistantMessageId: first.answerId, chatId, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
      status: "complete", userId, userMessageId: first.questionId
    } });
    const successor = await tx.modelRun.create({ data: {
      assistantMessageId: second.answerId, chatId, engine, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
      status: "streaming", userId, userMessageId: second.questionId
    } });
    await tx.workspaceFollowup.create({ data: {
      admissionKey: successor.id.replaceAll("-", "").repeat(2), admissionResult: {}, chatId, claimToken: randomUUID(),
      deadlineAt: new Date(Date.now() + 120_000), leaseExpiresAt: new Date(Date.now() - 86_400_000),
      modelRunId: successor.id, predecessorRunId: predecessor.id, snapshot: {}, state: "preparing"
    } });
    return successor.id;
  });
}

/** A run waiting for its PDF to be read before the answer, as the chat PDF worker finds it. */
async function pendingPdfPreparation(userId: string, engine: Engine): Promise<string> {
  const attachmentId = randomUUID();
  const sourceChecksum = createHash("sha256").update(`synthetic pdf ${attachmentId}`).digest("hex");
  return prisma.$transaction(async (tx) => {
    const { id: chatId } = await tx.chat.create({ data: { title: "PDF chat", userId } });
    const question = await tx.message.create({ data: { chatId, role: "user",
      content: { blocks: [{ type: "file", attachmentId }] } } });
    const answer = await tx.message.create({ data: { chatId, role: "assistant",
      parentMessageId: question.id, status: "queued", content: { blocks: [] } } });
    await tx.attachment.create({ data: { id: attachmentId, userId, chatId, messageId: question.id,
      kind: "pdf", mimeType: "application/pdf", fileName: "synthetic.pdf", storageKey: `test/${attachmentId}`,
      checksum: sourceChecksum, byteSize: 10, metadata: {} } });
    const run = await tx.modelRun.create({ data: { userId, chatId, userMessageId: question.id,
      assistantMessageId: answer.id, engine, modelId: "fixture", provider: "openai_compatible", status: "preparing" } });
    await tx.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: answer.id } });
    await tx.chatPdfRunPreparation.create({ data: { modelRunId: run.id,
      admissionKey: run.id.replaceAll("-", "").repeat(2), snapshot: { version: 1 } } });
    await tx.chatPdfAttachmentPreparation.create({ data: { modelRunId: run.id, attachmentId, route: "local_text",
      sourceChecksum, sourceByteSize: 10, pageCount: 2, compatibilityKey: "c".repeat(64) } });
    return run.id;
  });
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    await tx.user.deleteMany({ where: { id } });
  });
});
afterAll(() => prisma.$disconnect());

describe("the old run core beside the native engine on one database", () => {
  it("gives a previous release's run the old core's engine and settles only old-core runs at boot", async () => {
    const userId = await owner();
    const oldCore = await oldCoreRun(userId);
    const native = await nativeRun(userId);
    const previous = await previousReleaseRun(userId);
    const runIds = [oldCore.runId, native.runId, previous.runId];
    await backdate(runIds);
    const nativeAnswer = await messageStatus(native.assistantMessageId);

    await expect(repository.sweepBootOrphanedRuns({ createdBefore: BOUNDARY, liveRunIds: [] })).resolves.toBe(2);

    await expect(runStates(runIds)).resolves.toEqual({
      [oldCore.runId]: { code: "run_orphaned_on_boot", engine: "v1", status: "error" },
      [native.runId]: { code: null, engine: "native", status: "streaming" },
      [previous.runId]: { code: "run_orphaned_on_boot", engine: "v1", status: "error" }
    });
    await expect(messageStatus(native.assistantMessageId)).resolves.toBe(nativeAnswer);
    await expect(messageStatus(previous.assistantMessageId)).resolves.toBe("error");
  });

  it("finds and settles only old-core runs in stale and installation recovery", async () => {
    const userId = await owner();
    const oldCore = await oldCoreRun(userId);
    const native = await nativeRun(userId);
    const previous = await previousReleaseRun(userId);
    const runIds = [oldCore.runId, native.runId, previous.runId];
    await backdate(runIds);

    const stale = await repository.findStaleActiveRunsForUser({ staleBefore: BOUNDARY, userId });
    expect(stale.map(({ id }) => id).sort()).toEqual([oldCore.runId, previous.runId].sort());
    const installation = (await repository.findInstallationRecoverableRuns!({
      bootedBefore: BOUNDARY, limit: 100, staleBefore: BOUNDARY
    })).map(({ id }) => id);
    expect(installation).toEqual(expect.arrayContaining([oldCore.runId, previous.runId]));
    expect(installation).not.toContain(native.runId);

    await reconcileStaleRuns({ providers: {}, registry: activeRunControllerRegistry, repository }, { userId });

    await expect(runStates(runIds)).resolves.toEqual({
      [oldCore.runId]: { code: "run_orphaned", engine: "v1", status: "error" },
      [native.runId]: { code: null, engine: "native", status: "streaming" },
      [previous.runId]: { code: "run_orphaned", engine: "v1", status: "error" }
    });
  });

  it("keeps one active run per chat across engines and writers", async () => {
    const userId = await owner();
    const { id: chatId } = await chat(userId, "Shared guard chat");
    const root = await prisma.message.create({ data: {
      chatId, content: textMessageContent("Synthetic root"), role: "user", status: "complete"
    } });
    await prisma.chat.update({ data: { activeLeafMessageId: root.id }, where: { id: chatId } });
    const native = await repository.createRun(sendInput(chatId, userId, root.id));
    await prisma.modelRun.update({ data: { engine: "native" }, where: { id: native.runId } });

    // The send pre-check and the admission transaction both see the native run.
    await expect(repository.findRecentActiveRunForChat({ chatId, since: new Date(0), userId }))
      .resolves.toMatchObject({ id: native.runId });
    await expect(repository.createRun(sendInput(chatId, userId, native.assistantMessageId)))
      .rejects.toBeInstanceOf(ActiveRunConflictError);
    // A previous release's writer meets the same engine-agnostic index.
    await expect(activeRunIndexRefuses({
      chatId, turn: { answerId: native.assistantMessageId, questionId: native.userMessageId }, userId
    })).resolves.toBe(true);
    await expect(prisma.modelRun.count({ where: { chatId } })).resolves.toBe(1);

    // And a native run cannot start beside an old-core one.
    const oldCore = await oldCoreRun(userId);
    await expect(activeRunIndexRefuses({
      chatId: oldCore.chatId, engine: "native",
      turn: { answerId: oldCore.assistantMessageId, questionId: oldCore.userMessageId }, userId
    })).resolves.toBe(true);
    await expect(prisma.modelRun.count({ where: { chatId: oldCore.chatId } })).resolves.toBe(1);
  });

  it("hands the Workspace follow-up worker successors of either engine, which it starts on their own engine", async () => {
    const userId = await owner();
    const followups = createWorkspaceFollowupRepository(prisma);
    const native = await interruptedFollowup(userId, "native");
    await expect(followups.hasPending()).resolves.toBe(true);
    await expect(followups.claim(new Date(), [])).resolves.toMatchObject({ runId: native, userId });

    const oldCore = await interruptedFollowup(userId, "v1");
    await expect(followups.claim(new Date(), [])).resolves.toMatchObject({ runId: oldCore, userId });
  });

  it("hands the old core's chat PDF worker only old-core runs", async () => {
    const userId = await owner();
    const pdf = createChatPdfRepository(prisma);
    await pendingPdfPreparation(userId, "native");
    const oldCore = await pendingPdfPreparation(userId, "v1");

    await expect(pdf.claim()).resolves.toMatchObject({ runId: oldCore, userId });
    await expect(pdf.claim()).resolves.toBeNull();
  });
});
