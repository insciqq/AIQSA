// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { SkillSaveCard } from "../../contracts/skillSaves";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { saveSkillForToolCall } from "../runs/prismaRepositorySkillSaveCall";
import { SAVE_SKILL_TOOL_NAME, skillSavedResult } from "../tools/skillSave";
import { createSkillVersionService, SKILL_LIBRARY_RESTORE_CLIENT_ID } from "./revisionRestore";
import { createSkillSaveUndoService, SKILL_SAVE_CLIENT_ID, type SkillSaveTarget } from "./skillSave";

const users: string[] = [];

async function owner() {
  const userId = `skill-restore-test-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic restorer", id: userId, status: "active" } });
  return userId;
}

/**
 * A Skill with ready revisions v1..vN: each holds a text note and the same
 * settled binary object, so restores can be checked for object reuse.
 */
async function skill(userId: string, notes: readonly string[], input: Readonly<{ published?: boolean; archived?: boolean }> = {}) {
  const definition = await prisma.skillDefinition.create({ data: { ownerUserId: userId } });
  const storageKey = `skills/${definition.id}/synthetic/${randomUUID()}`;
  const revisions: string[] = [];
  for (const [index, note] of notes.entries()) {
    const revision = await prisma.skillRevision.create({ data: { skillId: definition.id, revisionNumber: index + 1, schemaVersion: 2,
      name: "digest", description: "Synthetic digest", instructions: `Version ${index + 1}.`, bundleDigest: `digest-${note}`,
      fileCount: 2, bundleByteSize: 100 + index, hasExecutables: index % 2 === 0, authorUserId: userId, bundleReady: true } });
    await prisma.skillRevisionFile.createMany({ data: [
      { revisionId: revision.id, skillId: definition.id, path: "notes.txt", byteSize: note.length, checksum: `sum-${note}`, kind: "text",
        executable: false, textContent: note },
      { revisionId: revision.id, skillId: definition.id, path: "model.bin", byteSize: 4, checksum: "sum-bin", kind: "binary",
        executable: false, textContent: null, storageKey }
    ] });
    revisions.push(revision.id);
  }
  // A staged revision that never settled is not a version.
  await prisma.skillRevision.create({ data: { skillId: definition.id, revisionNumber: notes.length + 1, schemaVersion: 2, name: "digest",
    instructions: "Staged.", bundleReady: false, authorUserId: userId } });
  await prisma.skillDefinition.update({ where: { id: definition.id }, data: { currentRevisionId: revisions.at(-1)!,
    version: notes.length, ...(input.published ? { sharedRevisionId: revisions[0] } : {}),
    ...(input.archived ? { archivedAt: new Date() } : {}) } });
  return { skillId: definition.id, revisions, storageKey };
}

async function answer(userId: string) {
  const chatId = randomUUID(), questionId = randomUUID(), answerId = randomUUID(), runId = randomUUID();
  await prisma.chat.create({ data: { id: chatId, title: "Synthetic chat", userId } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("Restore the previous version"), id: questionId, role: "user",
    status: "complete" } });
  await prisma.message.create({ data: { chatId, content: textMessageContent(""), id: answerId, parentMessageId: questionId,
    role: "assistant", status: "streaming" } });
  await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: runId, modelId: "fake-qsa", normalizedRequest: {},
    provider: "fake", status: "streaming", userId, userMessageId: questionId } });
  const call = async () => (await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: runId,
    ordinal: await prisma.modelRunToolCall.count({ where: { modelRunId: runId } }), providerCallId: `provider-${randomUUID()}`, roundIndex: 1,
    startedAt: new Date(), state: "running", toolName: SAVE_SKILL_TOOL_NAME } })).id;
  const restore = async (target: SkillSaveTarget) => saveSkillForToolCall(prisma, { callId: await call(), runId, userId, target, bundle: null,
    changeNote: "Put the old digest back", result: (card, version) => skillSavedResult({ id: "provider-call", name: SAVE_SKILL_TOOL_NAME }, card, version) });
  return { restore };
}

const savedCard = (outcome: Awaited<ReturnType<typeof saveSkillForToolCall>>): SkillSaveCard => {
  if (outcome.kind !== "saved") throw new Error(`expected a save, received ${JSON.stringify(outcome)}`);
  const artifact = outcome.result.artifacts?.[0];
  if (artifact?.type !== "artifact" || artifact.data.artifactType !== "skill_save") throw new Error("expected a card");
  return artifact.data.payload as SkillSaveCard;
};

afterEach(async () => {
  const ids = users.splice(0);
  const skillIds = (await prisma.skillDefinition.findMany({ where: { ownerUserId: { in: ids } }, select: { id: true } })).map((entry) => entry.id);
  await prisma.skillStoreOperation.deleteMany({ where: { ownerUserId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.skillDefinition.updateMany({ where: { id: { in: skillIds } }, data: { currentRevisionId: null, sharedRevisionId: null } });
  await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
  await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("Skill versions in the library", () => {
  it("lists ready versions newest first and pages older ones; others' Skills look missing", async () => {
    const userId = await owner();
    const { skillId, revisions } = await skill(userId, ["a", "b", "c"], { published: true });
    const service = createSkillVersionService(prisma);
    const page = await service.list({ userId, skillId });
    expect(page).toMatchObject({ skillId, version: 3, archived: false, nextBefore: null });
    expect(page!.versions.map((version) => [version.revisionNumber, version.current, version.shared])).toEqual([
      [3, true, false], [2, false, false], [1, false, true]]);
    expect(page!.versions[0]).toMatchObject({ revisionId: revisions[2], authorDisplayName: "Synthetic restorer", fileCount: 2,
      byteSize: 102, hasExecutables: true, changeNote: null, restoredFrom: null });
    expect((await service.list({ userId, skillId, before: 3 }))!.versions.map((version) => version.revisionNumber)).toEqual([2, 1]);
    const stranger = await owner();
    expect(await service.list({ userId: stranger, skillId })).toBeNull();
  });

  it("restores a version as a new current one with the same digest and objects, keeping history and the published version", async () => {
    const userId = await owner();
    const { skillId, revisions, storageKey } = await skill(userId, ["a", "b", "c"], { published: true });
    const service = createSkillVersionService(prisma);
    const result = await service.restore({ userId, skillId, revisionId: revisions[0]!, expectedVersion: 3 });
    // Revision 4 is the staged one that never settled, so the restore is v5.
    expect(result).toEqual({ kind: "ok", response: { outcome: "restored", version: 4, revisionNumber: 5, restoredFrom: 1 } });
    const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId },
      include: { currentRevision: { include: { files: { orderBy: { path: "asc" } } } } } });
    expect(definition).toMatchObject({ version: 4, sharedRevisionId: revisions[0] });
    expect(definition.currentRevision).toMatchObject({ revisionNumber: 5, bundleDigest: "digest-a", bundleReady: true, instructions: "Version 1.",
      hasExecutables: true });
    expect(definition.currentRevision!.files).toEqual([
      expect.objectContaining({ path: "model.bin", storageKey, textContent: null }),
      expect.objectContaining({ path: "notes.txt", textContent: "a", storageKey: null })
    ]);
    // No object was uploaded or scheduled for deletion; every earlier version is still there.
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { startsWith: `skills/${skillId}/` } } })).toBe(0);
    expect(await prisma.skillRevision.count({ where: { skillId, bundleReady: true } })).toBe(4);
    const page = await service.list({ userId, skillId });
    expect(page!.versions[0]).toMatchObject({ revisionNumber: 5, current: true, restoredFrom: 1 });
    expect(await prisma.skillStoreOperation.count({ where: { ownerUserId: userId, clientId: SKILL_LIBRARY_RESTORE_CLIENT_ID } })).toBe(1);
    // The current content again is unchanged and writes nothing.
    expect(await service.restore({ userId, skillId, revisionId: revisions[0]!, expectedVersion: 4 }))
      .toEqual({ kind: "ok", response: { outcome: "unchanged", version: 4 } });
  });

  it("reports a stale version as a conflict and refuses archived, foreign and unknown targets without writing", async () => {
    const userId = await owner();
    const { skillId, revisions } = await skill(userId, ["a", "b"]);
    const service = createSkillVersionService(prisma);
    const before = await prisma.skillRevision.count({ where: { skillId } });
    expect(await service.restore({ userId, skillId, revisionId: revisions[0]!, expectedVersion: 1 })).toEqual({ kind: "conflict" });
    expect(await service.restore({ userId, skillId, revisionId: "missing-revision", expectedVersion: 2 })).toEqual({ kind: "not_found" });
    const stranger = await owner();
    expect(await service.restore({ userId: stranger, skillId, revisionId: revisions[0]!, expectedVersion: 2 })).toEqual({ kind: "not_found" });
    const archived = await skill(userId, ["x", "y"], { archived: true });
    expect(await service.restore({ userId, skillId: archived.skillId, revisionId: archived.revisions[0]!, expectedVersion: 2 }))
      .toEqual({ kind: "archived" });
    expect(await prisma.skillRevision.count({ where: { skillId } })).toBe(before);
    expect(await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).toMatchObject({ version: 2, currentRevisionId: revisions[1] });
  });
});

describe("a chat answer's Skill restore", () => {
  it("restores by alias guard with a v2 → v4 (= v1) card and Undo, under the one-save-per-answer limit", async () => {
    const userId = await owner();
    const { skillId, revisions } = await skill(userId, ["a", "b"], { published: true });
    const turn = await answer(userId);
    const card = savedCard(await turn.restore({ kind: "restore", skillId, guard: { revisionId: revisions[1]! }, revision: 1 }));
    expect(card).toMatchObject({ outcome: "restored", fromRevision: 2, toRevision: 4, restoredRevision: 1, published: true,
      changeNote: "Put the old digest back", copiedFrom: null });
    expect(card.files).toEqual(expect.arrayContaining([{ path: "notes.txt", change: "changed", executable: false },
      { path: "model.bin", change: "unchanged", executable: false, binary: true }]));
    expect(card.diffs.map((diff) => diff.path)).toEqual(expect.arrayContaining(["SKILL.md", "notes.txt"]));
    expect(await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } }))
      .toMatchObject({ version: 3, currentRevisionId: card.revisionId, sharedRevisionId: revisions[0] });
    expect(await prisma.skillStoreOperation.findFirstOrThrow({ where: { ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID } }))
      .toMatchObject({ action: "update", revisionId: card.revisionId, expectedCurrentRevisionId: revisions[1],
        resultJson: expect.objectContaining({ restoredRevision: 1, changeNote: "Put the old digest back" }) });
    // A second save in the same answer is refused.
    expect(await turn.restore({ kind: "restore", skillId, guard: { expectedVersion: 3 }, revision: 2 }))
      .toMatchObject({ kind: "not_saved", outcome: { code: "skill_save_answer_limit" } });
    // Undo makes v2's content current again as a new version.
    const undo = createSkillSaveUndoService(prisma);
    expect(await undo.undo({ userId, skillId, saveId: card.saveId })).toEqual({ state: "undone", outcome: "restored", revision: 5 });
    const current = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId }, include: { currentRevision: true } });
    expect(current.currentRevision).toMatchObject({ instructions: "Version 2.", bundleDigest: "digest-b" });
    const versions = await createSkillVersionService(prisma).list({ userId, skillId });
    expect(versions!.versions.slice(0, 2).map((version) => [version.revisionNumber, version.restoredFrom, version.changeNote]))
      .toEqual([[5, 2, null], [4, 1, "Put the old digest back"]]);
  });

  it("lists versions, refuses stale guards, unknown versions and another user's Skill, and skips current content", async () => {
    const userId = await owner();
    const { skillId, revisions } = await skill(userId, ["a", "b", "c"]);
    const turn = await answer(userId);
    expect(await turn.restore({ kind: "restore", skillId, guard: { revisionId: revisions[2]! }, revision: 0 })).toMatchObject({
      kind: "not_saved", outcome: { kind: "versions", list: { skillId, name: "digest", currentVersion: 3, more: false,
        versions: [expect.objectContaining({ revision: 3, current: true }), expect.objectContaining({ revision: 2 }),
          expect.objectContaining({ revision: 1 })] } } });
    expect(await turn.restore({ kind: "restore", skillId, guard: { revisionId: revisions[0]! }, revision: 2 })).toMatchObject({
      kind: "not_saved", outcome: { code: "skill_restore_conflict", versions: { currentVersion: 3 } } });
    expect(await turn.restore({ kind: "restore", skillId, guard: { expectedVersion: 3 }, revision: 4 })).toMatchObject({
      kind: "not_saved", outcome: { code: "skill_restore_revision_unknown", versions: { skillId } } });
    expect(await turn.restore({ kind: "restore", skillId, guard: { expectedVersion: 3 }, revision: 3 })).toMatchObject({
      kind: "not_saved", outcome: { kind: "unchanged", version: 3 } });
    const stranger = await owner();
    const strangerTurn = await answer(stranger);
    expect(await strangerTurn.restore({ kind: "restore", skillId, guard: { expectedVersion: 3 }, revision: 1 })).toMatchObject({
      kind: "not_saved", outcome: { code: "skill_not_available" } });
    await prisma.skillPublication.create({ data: { skillId, scope: "installation", publishedByUserId: userId } });
    await prisma.skillDefinition.update({ where: { id: skillId }, data: { sharedRevisionId: revisions[2] } });
    expect(await strangerTurn.restore({ kind: "restore", skillId, guard: { expectedVersion: 3 }, revision: 1 })).toMatchObject({
      kind: "not_saved", outcome: { code: "skill_restore_not_own" } });
    expect(await prisma.skillRevision.count({ where: { skillId, bundleReady: true } })).toBe(3);
    expect(await prisma.skillStoreOperation.count({ where: { ownerUserId: { in: [userId, stranger] } } })).toBe(0);
  });

  it("counts restores toward the hourly limit", async () => {
    const userId = await owner();
    const { skillId, revisions } = await skill(userId, ["a", "b"]);
    await prisma.skillStoreOperation.createMany({ data: Array.from({ length: 20 }, () => ({ ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID,
      operationKey: randomUUID(), requestDigest: "0".repeat(64), action: "update", status: "COMPLETED", revisionId: revisions[1] })) });
    const turn = await answer(userId);
    expect(await turn.restore({ kind: "restore", skillId, guard: { expectedVersion: 2 }, revision: 1 })).toMatchObject({
      kind: "not_saved", outcome: { code: "skill_save_rate_limited" } });
  });
});
