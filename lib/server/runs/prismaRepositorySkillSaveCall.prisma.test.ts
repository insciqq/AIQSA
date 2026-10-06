// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createSkillBundle, parseSkillMarkdown, type SkillBundle } from "../skills/bundle";
import { createSkillSaveUndoService, SKILL_SAVE_CLIENT_ID, type SkillSaveTarget } from "../skills/skillSave";
import { SAVE_SKILL_TOOL_NAME, skillSavedResult } from "../tools/skillSave";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { saveSkillForToolCall } from "./prismaRepositorySkillSaveCall";
import { projectRunOutputArtifactEvent } from "./runOutputEvents";

const users: string[] = [];
const markdown = (body: string) => Buffer.from(`---\nname: digest\ndescription: Synthetic digest\n---\n${body}\n`);
const bundle = (body: string, files: Record<string, string> = {}): SkillBundle => createSkillBundle(parseSkillMarkdown(markdown(body), "digest"),
  Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })));

async function owner() {
  const userId = `skill-save-test-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic Skill saver", id: userId, status: "active" } });
  return userId;
}

/** A personal chat turn whose open run holds `calls` running save calls. */
async function answer(userId: string, input: Readonly<{ calls?: number; scheduledTaskId?: string }> = {}) {
  const chatId = randomUUID(), questionId = randomUUID(), answerId = randomUUID(), runId = randomUUID();
  await prisma.chat.create({ data: { id: chatId, title: "Synthetic chat", userId } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("Save this as a Skill"), id: questionId, role: "user",
    status: "complete" } });
  await prisma.message.create({ data: { chatId, content: textMessageContent(""), id: answerId, parentMessageId: questionId,
    role: "assistant", status: "streaming" } });
  await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: runId, modelId: "fake-qsa", normalizedRequest: {},
    provider: "fake", status: "streaming", userId, userMessageId: questionId,
    ...(input.scheduledTaskId ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: input.scheduledTaskId } : {}) } });
  const callIds: string[] = [];
  for (let ordinal = 0; ordinal < (input.calls ?? 1); ordinal += 1) {
    callIds.push((await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: runId, ordinal,
      providerCallId: `provider-call-${ordinal}`, roundIndex: 1, startedAt: new Date(), state: "running", toolName: SAVE_SKILL_TOOL_NAME } })).id);
  }
  const save = (callId: string, target: SkillSaveTarget, content: SkillBundle, ordinal = 0) => saveSkillForToolCall(prisma, {
    callId, runId, userId, target, bundle: content, changeNote: "Synthetic note",
    result: (card, version) => skillSavedResult({ id: `provider-call-${ordinal}`, name: SAVE_SKILL_TOOL_NAME }, card, version)
  });
  return { callIds, runId, save };
}

const cardEvents = (runId: string) => prisma.modelRunEvent.findMany({ where: { eventType: "artifact", modelRunId: runId,
  payload: { path: ["artifactType"], equals: "skill_save" } } });
const saved = (outcome: Awaited<ReturnType<typeof saveSkillForToolCall>>) => {
  if (outcome.kind !== "saved") throw new Error(`expected a save, received ${outcome.kind}`);
  const card = outcome.result.artifacts?.[0];
  if (card?.type !== "artifact" || card.data.artifactType !== "skill_save") throw new Error("expected a save card");
  return card.data.payload as import("../../contracts/skillSaves").SkillSaveCard;
};

afterEach(async () => {
  const ids = users.splice(0);
  const definitions = await prisma.skillDefinition.findMany({ where: { ownerUserId: { in: ids } }, select: { id: true } });
  const skillIds = definitions.map((entry) => entry.id);
  await prisma.skillStoreOperation.deleteMany({ where: { ownerUserId: { in: ids } } });
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.skillDefinition.updateMany({ where: { id: { in: skillIds } }, data: { currentRevisionId: null, sharedRevisionId: null } });
  await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.userSkillPreference.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("a chat answer's Skill save", () => {
  it("creates v1 with executables, settles the call and its card once, and saves once per answer under concurrency", async () => {
    const userId = await owner();
    const turn = await answer(userId, { calls: 2 });
    const content = bundle("Run run.sh.", { "run.sh": "#!/bin/sh\necho ok\n" });
    const outcomes = await Promise.all(turn.callIds.map((callId, ordinal) => turn.save(callId, { kind: "new" }, content, ordinal)));
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["not_saved", "saved"]);
    expect(outcomes.find((outcome) => outcome.kind === "not_saved")).toMatchObject({ outcome: { code: "skill_save_answer_limit" } });
    const card = saved(outcomes.find((outcome) => outcome.kind === "saved")!);
    expect(card).toMatchObject({ outcome: "created", fromRevision: null, toRevision: 1, changeNote: "Synthetic note" });
    const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: card.skillId }, include: { currentRevision: true } });
    expect(definition).toMatchObject({ ownerUserId: userId, version: 1, currentRevision: { hasExecutables: true, bundleReady: true } });
    expect(await prisma.skillStoreOperation.count({ where: { ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID } })).toBe(1);
    expect(await cardEvents(turn.runId)).toHaveLength(1);
    // A replayed settled call publishes its card again; the answer keeps it once.
    const event = projectRunOutputArtifactEvent((outcomes.find((outcome) => outcome.kind === "saved") as unknown as { result: { artifacts: never[] } }).result.artifacts[0])!;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${turn.runId} FOR UPDATE`;
      await appendRunOutputEvents(tx, turn.runId, [event]);
    });
    expect(await cardEvents(turn.runId)).toHaveLength(1);
    // The settled call replays its result and never saves twice.
    const settledId = (await prisma.modelRunToolCall.findFirstOrThrow({ where: { modelRunId: turn.runId, state: "complete" } })).id;
    expect(await turn.save(settledId, { kind: "new" }, content)).toMatchObject({ kind: "settled", result: { status: "complete" } });
    expect(await prisma.skillDefinition.count({ where: { ownerUserId: userId } })).toBe(1);
  });

  it("saves a guarded new version of the owner's published Skill, keeps the published revision and refuses stale bases", async () => {
    const userId = await owner();
    const first = await answer(userId);
    const created = saved(await first.save(first.callIds[0]!, { kind: "new" }, bundle("One.", { "notes.txt": "a\n" })));
    await prisma.skillDefinition.update({ where: { id: created.skillId }, data: { sharedRevisionId: created.revisionId } });
    const second = await answer(userId);
    const updated = saved(await second.save(second.callIds[0]!, { kind: "frozen", skillId: created.skillId, revisionId: created.revisionId },
      bundle("Two.", { "notes.txt": "b\n" })));
    expect(updated).toMatchObject({ outcome: "updated", fromRevision: 1, toRevision: 2, published: true, skillId: created.skillId });
    expect(updated.files).toEqual(expect.arrayContaining([{ path: "notes.txt", change: "changed", executable: false }]));
    expect(await prisma.skillDefinition.findUniqueOrThrow({ where: { id: created.skillId } }))
      .toMatchObject({ version: 2, currentRevisionId: updated.revisionId, sharedRevisionId: created.revisionId });
    // A save built on revision 1 conflicts now: nothing is written and the current files come back.
    const third = await answer(userId);
    const stale = await third.save(third.callIds[0]!, { kind: "frozen", skillId: created.skillId, revisionId: created.revisionId },
      bundle("Three.", { "notes.txt": "c\n" }));
    expect(stale).toMatchObject({ kind: "not_saved", outcome: { code: "skill_version_conflict", conflict: { currentVersion: 2,
      differingFiles: expect.arrayContaining([{ path: "notes.txt", content: "b\n" }]) } } });
    const byVersion = await third.save(third.callIds[0]!, { kind: "version", skillId: created.skillId, expectedVersion: 2 },
      bundle("Three.", { "notes.txt": "c\n" }));
    expect(byVersion.kind).toBe("saved");
    expect(await prisma.skillRevision.count({ where: { skillId: created.skillId } })).toBe(3);
  });

  it("copies another user's published Skill with provenance and leaves the original unchanged", async () => {
    const author = await owner();
    const reader = await owner();
    const authorTurn = await answer(author);
    const original = saved(await authorTurn.save(authorTurn.callIds[0]!, { kind: "new" }, bundle("Shared.")));
    await prisma.skillDefinition.update({ where: { id: original.skillId }, data: { sharedRevisionId: original.revisionId } });
    await prisma.skillPublication.create({ data: { skillId: original.skillId, scope: "installation", publishedByUserId: author } });
    const turn = await answer(reader);
    const copy = saved(await turn.save(turn.callIds[0]!, { kind: "frozen", skillId: original.skillId, revisionId: original.revisionId },
      bundle("My copy.")));
    expect(copy).toMatchObject({ outcome: "created", copiedFrom: "digest" });
    expect(copy.skillId).not.toBe(original.skillId);
    expect(await prisma.skillDefinition.findUniqueOrThrow({ where: { id: copy.skillId } })).toMatchObject({ ownerUserId: reader,
      importSourceJson: { kind: "skill_copy", skillId: original.skillId, revisionId: original.revisionId } });
    expect(await prisma.skillRevision.count({ where: { skillId: original.skillId } })).toBe(1);
    // An unpublished Skill of someone else is not visible.
    await prisma.skillPublication.deleteMany({ where: { skillId: original.skillId } });
    const hidden = await answer(reader);
    expect(await hidden.save(hidden.callIds[0]!, { kind: "version", skillId: original.skillId, expectedVersion: 1 }, bundle("x")))
      .toMatchObject({ kind: "not_saved", outcome: { code: "skill_not_available" } });
  });

  it("refuses scheduled runs and the hourly limit, and warns about active tasks that pin or used the Skill", async () => {
    const userId = await owner();
    const task = await prisma.scheduledTask.create({ data: { userId, title: "Morning digest", prompt: "Synthetic", scheduleKind: "DAILY",
      timeOfDayMinutes: 540, timeZone: "UTC", modelId: "fake-qsa", provider: "fake", toolsEnabled: true } });
    const scheduled = await answer(userId, { scheduledTaskId: task.id });
    expect(await scheduled.save(scheduled.callIds[0]!, { kind: "new" }, bundle("x"))).toEqual({ kind: "unavailable" });
    const turn = await answer(userId);
    const created = saved(await turn.save(turn.callIds[0]!, { kind: "new" }, bundle("One.")));
    await prisma.modelRunSkillBinding.create({ data: { modelRunId: scheduled.runId, skillId: created.skillId, revisionId: created.revisionId,
      alias: "digest" } });
    const pinned = await prisma.scheduledTask.create({ data: { userId, title: "Pinned digest", prompt: "Synthetic", scheduleKind: "DAILY",
      timeOfDayMinutes: 600, timeZone: "UTC", modelId: "fake-qsa", provider: "fake", toolsEnabled: true, pinnedSkillIds: [created.skillId] } });
    const next = await answer(userId);
    const updated = saved(await next.save(next.callIds[0]!, { kind: "version", skillId: created.skillId, expectedVersion: 1 }, bundle("Two.")));
    expect(updated.scheduledTasks).toEqual([{ taskId: task.id, title: "Morning digest" }, { taskId: pinned.id, title: "Pinned digest" }]);
    await prisma.skillStoreOperation.createMany({ data: Array.from({ length: 18 }, () => ({ ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID,
      operationKey: randomUUID(), requestDigest: "0".repeat(64), action: "create", status: "COMPLETED", revisionId: created.revisionId })) });
    const limited = await answer(userId);
    expect(await limited.save(limited.callIds[0]!, { kind: "new" }, bundle("Three."))).toMatchObject({ kind: "not_saved",
      outcome: { code: "skill_save_rate_limited" } });
  });

  it("undoes a new Skill by archiving it and a new version by restoring the previous content, never over a later change", async () => {
    const userId = await owner();
    const undo = createSkillSaveUndoService(prisma);
    const first = await answer(userId);
    const created = saved(await first.save(first.callIds[0]!, { kind: "new" }, bundle("One.", { "notes.txt": "a\n" })));
    const second = await answer(userId);
    const updated = saved(await second.save(second.callIds[0]!, { kind: "version", skillId: created.skillId, expectedVersion: 1 },
      bundle("Two.", { "notes.txt": "b\n" })));
    // The creation's Undo would overwrite the later version: a conflict.
    expect(await undo.state({ userId, skillId: created.skillId, saveId: created.saveId })).toEqual({ state: "conflict" });
    expect(await undo.state({ userId, skillId: updated.skillId, saveId: updated.saveId })).toEqual({ state: "available" });
    const restored = await undo.undo({ userId, skillId: updated.skillId, saveId: updated.saveId });
    expect(restored).toEqual({ state: "undone", outcome: "restored", revision: 3 });
    const current = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: created.skillId },
      include: { currentRevision: { include: { files: true } } } });
    expect(current.version).toBe(3);
    expect(current.currentRevision).toMatchObject({ instructions: expect.stringContaining("One."), files: [expect.objectContaining({ textContent: "a\n" })] });
    expect(await undo.undo({ userId, skillId: updated.skillId, saveId: updated.saveId })).toEqual(restored);
    // Another user cannot read or use the save.
    const stranger = await owner();
    expect(await undo.undo({ userId: stranger, skillId: updated.skillId, saveId: updated.saveId })).toEqual({ state: "unavailable" });
    // A fresh Skill's Undo archives it.
    const third = await answer(userId);
    const fresh = saved(await third.save(third.callIds[0]!, { kind: "new" }, bundle("Fresh.")));
    expect(await undo.undo({ userId, skillId: fresh.skillId, saveId: fresh.saveId })).toEqual({ state: "undone", outcome: "archived", revision: null });
    expect((await prisma.skillDefinition.findUniqueOrThrow({ where: { id: fresh.skillId } })).archivedAt).not.toBeNull();
    expect(await undo.revisionFile({ userId, skillId: updated.skillId, revisionId: updated.revisionId, path: "notes.txt" }))
      .toEqual({ path: "notes.txt", content: "b\n" });
    expect(await undo.revisionFile({ userId: stranger, skillId: updated.skillId, revisionId: updated.revisionId, path: "notes.txt" })).toBeNull();
  });
});
