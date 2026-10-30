// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SUBAGENT_DEFINITION_LIMITS } from "../../contracts/subagents";
import type { SubagentDefinitionDraft } from "../../contracts/subagentDefinitions";
import { textMessageContent } from "../../domain/content";
import { personalChatExportEntries } from "../chats/exportAll";
import { prisma } from "../prisma";
import {
  countSubagentDefinitionThreads,
  createSubagentDefinitionInTransaction,
  deleteSubagentDefinitionInTransaction,
  findSubagentDefinition,
  listSubagentDefinitions,
  readSubagentDefault,
  restoreSubagentRevisionInTransaction,
  reviseSubagentDefinitionInTransaction,
  setSubagentDefaultInTransaction,
  undoSubagentDefaultChangeInTransaction
} from "./definitionStore";
import { createSubagentTypeResolver } from "./typeResolver";

// Every row belongs to this file's own synthetic users; deleting them removes the rest.
const users: string[] = [];
const MARKER = `subagent-definition-marker-${randomUUID()}`;

async function owner(): Promise<string> {
  const id = `subagent-definitions-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic sub-agent owner", id, status: "active" } });
  users.push(id);
  return id;
}

const draft = (patch: Partial<SubagentDefinitionDraft> = {}): SubagentDefinitionDraft => ({
  description: "Synthetic long browsing.", effort: "low", instructions: `Synthetic instructions ${MARKER}`, modelId: "synthetic-model",
  name: "browser", tools: ["workspace", "web_search"], ...patch
});

async function created(userId: string, patch: Partial<SubagentDefinitionDraft> = {}) {
  const write = await prisma.$transaction((tx) => createSubagentDefinitionInTransaction(tx, userId, draft(patch)));
  if (write.kind !== "written") throw new Error(`create refused: ${write.kind === "refused" ? write.code : write.kind}`);
  return write.record;
}

/** A chat with an answered run and a sub-agent thread started as the definition. */
async function threadOf(userId: string, definitionId: string, typeName: string) {
  const chat = await prisma.chat.create({ data: { title: "Synthetic sub-agent chat", userId } });
  const message = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic question"), role: "user",
    status: "complete" } });
  const run = await prisma.modelRun.create({ data: { chatId: chat.id, modelId: "synthetic-model", normalizedRequest: {}, provider: "fake",
    status: "complete", userId, userMessageId: message.id } });
  return prisma.subagentThread.create({ data: { anchorRunId: run.id, chatId: chat.id, definitionId, name: "shopper", typeName, userId } });
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.modelRun.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("custom sub-agent definitions on PostgreSQL", () => {
  it("appends a revision per edit and restores an earlier one as a new revision", async () => {
    const userId = await owner();
    const first = await created(userId);
    expect(first).toMatchObject({ name: "browser", previousRevisionId: null, revisionNumber: 1, toolGroups: ["workspace", "web_search"], version: 1 });
    const edit = await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, first.id, 1,
      draft({ effort: null, modelId: null, name: "web", tools: null })));
    expect(edit).toMatchObject({ kind: "written", previous: { name: "browser", version: 1 },
      record: { name: "web", previousRevisionId: first.revisionId, providerModelId: null, revisionNumber: 2, toolGroups: null, version: 2 } });
    const stale = await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, first.id, 1, draft({ name: "stale" })));
    expect(stale).toMatchObject({ code: "subagent_definition_conflict", current: { name: "web", version: 2 }, kind: "refused" });
    const same = await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, first.id, 2,
      draft({ effort: null, modelId: null, name: "web", tools: null })));
    expect(same.kind).toBe("unchanged");
    const undo = await prisma.$transaction((tx) => restoreSubagentRevisionInTransaction(tx, userId, first.id, 2, first.revisionId));
    expect(undo).toMatchObject({ kind: "written", record: { name: "browser", providerModelId: "synthetic-model", revisionNumber: 3,
      toolGroups: ["workspace", "web_search"], version: 3 } });
    const revisions = await prisma.subagentDefinitionRevision.findMany({ orderBy: { revisionNumber: "asc" }, where: { definitionId: first.id } });
    expect(revisions.map((revision) => [revision.revisionNumber, revision.name])).toEqual([[1, "browser"], [2, "web"], [3, "browser"]]);
    // The first revision is untouched by the restore: revisions are append-only.
    expect(revisions[0]!.id).toBe(first.revisionId);
    expect(revisions[1]!.toolGroups).toBeNull();
  });

  it("keeps names unique per owner, isolates owners and holds the limit under concurrent creates", async () => {
    const a = await owner();
    const b = await owner();
    const mine = await created(a);
    expect(await prisma.$transaction((tx) => createSubagentDefinitionInTransaction(tx, a, draft()))).toMatchObject({ code: "subagent_definition_exists" });
    await created(b);
    expect(await findSubagentDefinition(prisma, b, { id: mine.id })).toBeNull();
    expect(await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, b, mine.id, 1, draft({ name: "taken" }))))
      .toMatchObject({ code: "subagent_not_found" });
    expect(await prisma.$transaction((tx) => deleteSubagentDefinitionInTransaction(tx, b, mine.id, 1))).toMatchObject({ code: "subagent_not_found" });
    for (let index = 2; index < SUBAGENT_DEFINITION_LIMITS.perUser; index += 1) await created(a, { name: `agent-${index}` });
    const racing = await Promise.all(["race-one", "race-two", "race-three"].map((name) =>
      prisma.$transaction((tx) => createSubagentDefinitionInTransaction(tx, a, draft({ name })))));
    expect(racing.filter((write) => write.kind === "written")).toHaveLength(1);
    expect(racing.filter((write) => write.kind === "refused" && write.code === "subagent_definition_limit")).toHaveLength(2);
    expect(await listSubagentDefinitions(prisma, a)).toHaveLength(SUBAGENT_DEFINITION_LIMITS.perUser);
  });

  it("deletes a definition with its revisions; its threads keep their work and name but lose the link", async () => {
    const userId = await owner();
    const definition = await created(userId);
    const thread = await threadOf(userId, definition.id, definition.name);
    expect(await countSubagentDefinitionThreads(prisma, userId, definition.id)).toBe(1);
    const resolver = createSubagentTypeResolver(prisma);
    expect(await resolver.resolve({ definitionId: definition.id, userId })).toMatchObject({ kind: "found", type: { revisionId: definition.revisionId } });
    expect(await prisma.$transaction((tx) => deleteSubagentDefinitionInTransaction(tx, userId, definition.id, 1))).toMatchObject({ kind: "deleted" });
    expect(await prisma.subagentDefinitionRevision.count({ where: { definitionId: definition.id } })).toBe(0);
    expect(await prisma.subagentThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({ definitionId: null, typeName: "browser" });
    expect(await resolver.resolve({ definitionId: definition.id, userId })).toEqual({ kind: "unavailable" });
  });

  it("leaves definitions out of the personal chat export and removes them with the account", async () => {
    const userId = await owner();
    const definition = await created(userId);
    await threadOf(userId, definition.id, definition.name);
    let exported = "";
    for await (const entry of personalChatExportEntries(prisma, userId)) {
      exported += typeof entry.content === "string" ? entry.content : new TextDecoder().decode(entry.content);
    }
    expect(exported.length).toBeGreaterThan(0);
    expect(exported).not.toContain(MARKER);
    // An administrator deletes an account only once it owns nothing (custom sub-agents count, like Skills and Assistants);
    // the database removes definitions and revisions with the user in any case.
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.subagentDefinition.count({ where: { id: definition.id } })).toBe(0);
    expect(await prisma.subagentDefinitionRevision.count({ where: { definitionId: definition.id } })).toBe(0);
  });

  it("keeps the reserved type out of new names, and a row that already holds it through its edits", async () => {
    const userId = await owner();
    expect(await prisma.$transaction((tx) => createSubagentDefinitionInTransaction(tx, userId, draft({ name: "built-in" }))))
      .toEqual({ code: "subagent_name_invalid", kind: "refused" });
    const definition = await created(userId);
    expect(await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, definition.id, 1, draft({ name: "built-in" }))))
      .toEqual({ code: "subagent_name_invalid", kind: "refused" });
    // A row an earlier release saved under the name stays readable, editable and renamable; it never takes the name back.
    const legacy = await prisma.subagentDefinitionRevision.create({ data: { definitionId: definition.id, description: "d", instructions: "i", name: "built-in",
      revisionNumber: 2 }, select: { id: true } });
    await prisma.subagentDefinition.update({ data: { currentRevisionId: legacy.id, name: "built-in", version: 2 }, where: { id: definition.id } });
    expect(await findSubagentDefinition(prisma, userId, { name: "built-in" })).toMatchObject({ id: definition.id });
    expect(await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, definition.id, 2, draft({ description: "Edited.", name: "built-in" }))))
      .toMatchObject({ kind: "written", record: { name: "built-in", version: 3 } });
    expect(await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, definition.id, 3, draft({ name: "renamed" }))))
      .toMatchObject({ kind: "written", record: { name: "renamed", version: 4 } });
    expect(await prisma.$transaction((tx) => restoreSubagentRevisionInTransaction(tx, userId, definition.id, 4, legacy.id)))
      .toEqual({ code: "subagent_name_invalid", kind: "refused" });
  });
});

describe("the default custom sub-agent on PostgreSQL", () => {
  const stored = async (userId: string) => (await prisma.userSettings.findUnique({ select: { defaultSubagentDefinitionId: true }, where: { userId } }))
    ?.defaultSubagentDefinitionId ?? null;
  const move = (userId: string, target: string | null, expected?: string | null) => prisma.$transaction((tx) =>
    setSubagentDefaultInTransaction(tx, userId, { target, ...(expected !== undefined ? { expected } : {}) }));

  it("moves among the owner's definitions under what the caller read, for a user with no settings row yet too", async () => {
    const userId = await owner();
    const first = await created(userId);
    const second = await created(userId, { name: "other" });
    expect(await readSubagentDefault(prisma, userId)).toBeNull();
    expect(await move(userId, first.id, null)).toEqual({ kind: "moved", previous: null });
    expect(await readSubagentDefault(prisma, userId)).toEqual({ definitionId: first.id, name: "browser" });
    expect(await move(userId, first.id, first.id)).toEqual({ kind: "unchanged" });
    expect(await move(userId, second.id, null)).toEqual({ code: "subagent_default_conflict", kind: "refused" });
    expect(await move(userId, second.id, first.id)).toEqual({ kind: "moved", previous: { definitionId: first.id, name: "browser" } });
    expect(await move(userId, null, second.id)).toEqual({ kind: "moved", previous: { definitionId: second.id, name: "other" } });
    expect(await stored(userId)).toBeNull();
    // An edit is no move, and the read follows a rename.
    await move(userId, first.id);
    await prisma.$transaction((tx) => reviseSubagentDefinitionInTransaction(tx, userId, first.id, 1, draft({ name: "renamed" })));
    expect(await readSubagentDefault(prisma, userId)).toEqual({ definitionId: first.id, name: "renamed" });
  });

  it("lets one of two racing moves from one reading through", async () => {
    const userId = await owner();
    const first = await created(userId);
    const second = await created(userId, { name: "other" });
    const racing = await Promise.all([move(userId, first.id, null), move(userId, second.id, null)]);
    expect(racing.filter((write) => write.kind === "moved")).toHaveLength(1);
    expect(racing.filter((write) => write.kind === "refused" && write.code === "subagent_default_conflict")).toHaveLength(1);
    expect([first.id, second.id]).toContain(await stored(userId));
  });

  it("clears only its own column when the definition is deleted, leaving the rest of the settings", async () => {
    const userId = await owner();
    await prisma.userSettings.create({ data: { defaultMcpMode: "off", userId } });
    const definition = await created(userId);
    await move(userId, definition.id);
    expect(await prisma.$transaction((tx) => deleteSubagentDefinitionInTransaction(tx, userId, definition.id, 1))).toMatchObject({ kind: "deleted" });
    expect(await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).toMatchObject({ defaultMcpMode: "off", defaultSubagentDefinitionId: null, userId });
    expect(await readSubagentDefault(prisma, userId)).toBeNull();
  });

  it("keeps a default among the owner's definitions in the store and in the database's own key", async () => {
    const a = await owner();
    const b = await owner();
    const theirs = await created(b);
    expect(await move(a, theirs.id)).toEqual({ code: "subagent_not_found", kind: "refused" });
    expect(await move(a, "missing-definition")).toEqual({ code: "subagent_not_found", kind: "refused" });
    await prisma.userSettings.create({ data: { userId: a } });
    // Raw SQL and destructive handlers go past the store; the composite key refuses them too.
    await expect(prisma.userSettings.update({ data: { defaultSubagentDefinitionId: theirs.id }, where: { userId: a } })).rejects.toThrow();
    expect(await stored(a)).toBeNull();
  });

  it("undoes a created default whole, its deletion clearing the pointer before the earlier one comes back", async () => {
    const userId = await owner();
    const earlier = await created(userId);
    const later = await created(userId, { name: "later" });
    await move(userId, earlier.id);
    await move(userId, later.id);
    const undo = (input: Parameters<typeof undoSubagentDefaultChangeInTransaction>[2]) =>
      prisma.$transaction((tx) => undoSubagentDefaultChangeInTransaction(tx, userId, input));
    expect(await undo({ definition: { expectedVersion: 9, id: later.id, revisionId: null }, restore: { expected: later.id, target: earlier.id } }))
      .toMatchObject({ code: "subagent_definition_conflict", kind: "refused" });
    expect(await stored(userId)).toBe(later.id);
    expect(await undo({ definition: { expectedVersion: 1, id: later.id, revisionId: null }, restore: { expected: later.id, target: earlier.id } }))
      .toEqual({ kind: "undone", outcome: "restored" });
    expect(await findSubagentDefinition(prisma, userId, { id: later.id })).toBeNull();
    expect(await stored(userId)).toBe(earlier.id);
    expect(await undo({ restore: { expected: null, target: earlier.id } })).toEqual({ kind: "undone", outcome: "changed" });
    expect(await undo({ restore: { expected: earlier.id, target: "gone-definition" } })).toEqual({ kind: "undone", outcome: "target_gone" });
    expect(await stored(userId)).toBeNull();
  });

  it("stays out of the personal chat export, and the settings and definitions go with the account", async () => {
    const userId = await owner();
    const definition = await created(userId);
    await move(userId, definition.id);
    await threadOf(userId, definition.id, definition.name);
    let exported = "";
    for await (const entry of personalChatExportEntries(prisma, userId)) {
      exported += typeof entry.content === "string" ? entry.content : new TextDecoder().decode(entry.content);
    }
    expect(exported).not.toContain(definition.id);
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.userSettings.count({ where: { userId } })).toBe(0);
    expect(await prisma.subagentDefinition.count({ where: { id: definition.id } })).toBe(0);
  });
});
