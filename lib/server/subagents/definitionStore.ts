import { Prisma } from "@prisma/client";
import { SUBAGENT_DEFINITION_LIMITS, decodeSubagentToolGroups, type SubagentToolGroup } from "../../contracts/subagents";
import { SUBAGENT_DEFINITION_CODES, type SubagentDefinitionDraft } from "../../contracts/subagentDefinitions";

/**
 * The custom sub-agent rows (`SubagentDefinition`, append-only
 * `SubagentDefinitionRevision`). Every read and write names the owner, so a
 * definition of another user reads as missing. Writes run inside the
 * caller's transaction (a Studio route's, or a tool call's together with its
 * settlement, `lib/server/tools/selfServiceCall.ts`) and first take the
 * owner's definition lock, so the per-user limit, name uniqueness and the
 * version guard hold without relying on a constraint error, which would
 * abort the transaction the tool call settles in. A refusal writes nothing.
 */

type Reader = Pick<Prisma.TransactionClient, "subagentDefinition" | "subagentDefinitionRevision">;
type Writer = Reader & Pick<Prisma.TransactionClient, "$queryRaw">;

/** One definition at its current revision. */
export type SubagentDefinitionRecord = Readonly<{
  description: string;
  id: string;
  instructions: string;
  name: string;
  /** The revision current before this one (the latest edit's Undo target); null for the first. */
  previousRevisionId: string | null;
  providerModelId: string | null;
  reasoningEffort: string | null;
  revisionId: string;
  revisionNumber: number;
  toolGroups: readonly SubagentToolGroup[] | null;
  updatedAt: Date;
  version: number;
}>;

export type SubagentDefinitionLookup = Readonly<{ id: string }> | Readonly<{ name: string }>;

export type SubagentStoreRefusalCode =
  | typeof SUBAGENT_DEFINITION_CODES.notFound
  | typeof SUBAGENT_DEFINITION_CODES.definitionExists
  | typeof SUBAGENT_DEFINITION_CODES.definitionConflict
  | typeof SUBAGENT_DEFINITION_CODES.definitionLimit
  | typeof SUBAGENT_DEFINITION_CODES.revisionUnknown;

export type SubagentStoreRefusal = Readonly<{ code: SubagentStoreRefusalCode; current?: SubagentDefinitionRecord; kind: "refused" }>;

export type SubagentStoreWrite =
  /** `previous`: the definition as it was before (null for a creation). */
  | Readonly<{ kind: "written"; previous: SubagentDefinitionRecord | null; record: SubagentDefinitionRecord }>
  /** The draft equals the current revision: nothing was written. */
  | Readonly<{ kind: "unchanged"; record: SubagentDefinitionRecord }>
  | SubagentStoreRefusal;

export type SubagentStoreDelete = Readonly<{ kind: "deleted"; record: SubagentDefinitionRecord }> | SubagentStoreRefusal;

const refused = (code: SubagentStoreRefusalCode, current?: SubagentDefinitionRecord): SubagentStoreRefusal =>
  ({ code, kind: "refused", ...(current ? { current } : {}) });

const revisionSelect = {
  description: true, id: true, instructions: true, name: true, providerModelId: true, reasoningEffort: true, revisionNumber: true,
  toolGroups: true
} as const;

const definitionSelect = {
  currentRevision: { select: revisionSelect }, id: true, name: true, updatedAt: true, version: true
} as const;

type DefinitionRow = Prisma.SubagentDefinitionGetPayload<{ select: typeof definitionSelect }>;

/** Stored tool groups: a list the contract decodes, or null; anything else reads as no tools beyond the always-present ones. */
export function storedToolGroups(value: Prisma.JsonValue | null): readonly SubagentToolGroup[] | null {
  if (value === null) return null;
  return decodeSubagentToolGroups(value) ?? [];
}

function toRecord(row: DefinitionRow, previousRevisionId: string | null): SubagentDefinitionRecord | null {
  const revision = row.currentRevision;
  if (!revision) return null;
  return {
    description: revision.description, id: row.id, instructions: revision.instructions, name: row.name, previousRevisionId,
    providerModelId: revision.providerModelId, reasoningEffort: revision.reasoningEffort, revisionId: revision.id,
    revisionNumber: revision.revisionNumber, toolGroups: storedToolGroups(revision.toolGroups), updatedAt: row.updatedAt, version: row.version
  };
}

async function previousRevisionIds(db: Reader, rows: readonly DefinitionRow[]): Promise<Map<string, string>> {
  const wanted = rows.flatMap((row) => row.currentRevision && row.currentRevision.revisionNumber > 1
    ? [{ definitionId: row.id, revisionNumber: row.currentRevision.revisionNumber - 1 }] : []);
  if (wanted.length === 0) return new Map();
  const previous = await db.subagentDefinitionRevision.findMany({ select: { definitionId: true, id: true }, where: { OR: wanted } });
  return new Map(previous.map((revision) => [revision.definitionId, revision.id]));
}

/** The owner's definitions, by name. */
export async function listSubagentDefinitions(db: Reader, userId: string): Promise<SubagentDefinitionRecord[]> {
  const rows = await db.subagentDefinition.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }], select: definitionSelect, take: SUBAGENT_DEFINITION_LIMITS.perUser * 2,
    where: { currentRevisionId: { not: null }, ownerUserId: userId }
  });
  const previous = await previousRevisionIds(db, rows);
  return rows.flatMap((row) => {
    const record = toRecord(row, previous.get(row.id) ?? null);
    return record ? [record] : [];
  });
}

/** One of the owner's definitions by id or name; null when it is missing or another user's. */
export async function findSubagentDefinition(db: Reader, userId: string, lookup: SubagentDefinitionLookup): Promise<SubagentDefinitionRecord | null> {
  const row = await db.subagentDefinition.findFirst({
    select: definitionSelect,
    where: { ownerUserId: userId, ...("id" in lookup ? { id: lookup.id } : { name: lookup.name }) }
  });
  if (!row) return null;
  return toRecord(row, (await previousRevisionIds(db, [row])).get(row.id) ?? null);
}

/** Serializes the owner's definition writes for the rest of the transaction. */
async function lockOwner(tx: Writer, userId: string): Promise<void> {
  const key = `aiqsa:subagent-definitions:${userId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lock"`;
}

const toolGroupsValue = (tools: readonly SubagentToolGroup[] | null) => tools === null ? Prisma.DbNull : [...tools];

function sameContent(record: SubagentDefinitionRecord, draft: SubagentDefinitionDraft): boolean {
  const tools = record.toolGroups;
  return record.name === draft.name && record.description === draft.description && record.instructions === draft.instructions &&
    record.providerModelId === draft.modelId && record.reasoningEffort === draft.effort &&
    JSON.stringify(tools) === JSON.stringify(draft.tools);
}

async function nameTaken(tx: Writer, userId: string, name: string, exceptId?: string): Promise<boolean> {
  const row = await tx.subagentDefinition.findFirst({
    select: { id: true }, where: { name, ownerUserId: userId, ...(exceptId ? { id: { not: exceptId } } : {}) }
  });
  return row !== null;
}

/** Creates a definition at version 1 with its first revision. */
export async function createSubagentDefinitionInTransaction(tx: Writer, userId: string, draft: SubagentDefinitionDraft): Promise<SubagentStoreWrite> {
  await lockOwner(tx, userId);
  if (await tx.subagentDefinition.count({ where: { ownerUserId: userId } }) >= SUBAGENT_DEFINITION_LIMITS.perUser) {
    return refused(SUBAGENT_DEFINITION_CODES.definitionLimit);
  }
  if (await nameTaken(tx, userId, draft.name)) return refused(SUBAGENT_DEFINITION_CODES.definitionExists);
  const definition = await tx.subagentDefinition.create({ data: { name: draft.name, ownerUserId: userId }, select: { id: true } });
  const revision = await tx.subagentDefinitionRevision.create({ data: {
    definitionId: definition.id, description: draft.description, instructions: draft.instructions, name: draft.name,
    providerModelId: draft.modelId, reasoningEffort: draft.effort, revisionNumber: 1, toolGroups: toolGroupsValue(draft.tools)
  }, select: { id: true } });
  await tx.subagentDefinition.update({ data: { currentRevisionId: revision.id }, where: { id: definition.id } });
  const record = await findSubagentDefinition(tx, userId, { id: definition.id });
  if (!record) throw new Error("subagent_definition_write_lost");
  return { kind: "written", previous: null, record };
}

/** Appends `draft` as the definition's next revision under the version guard. */
async function appendRevision(tx: Writer, userId: string, id: string, expectedVersion: number, draft: SubagentDefinitionDraft):
  Promise<SubagentStoreWrite> {
  const current = await findSubagentDefinition(tx, userId, { id });
  if (!current) return refused(SUBAGENT_DEFINITION_CODES.notFound);
  if (current.version !== expectedVersion) return refused(SUBAGENT_DEFINITION_CODES.definitionConflict, current);
  if (sameContent(current, draft)) return { kind: "unchanged", record: current };
  if (draft.name !== current.name && await nameTaken(tx, userId, draft.name, id)) return refused(SUBAGENT_DEFINITION_CODES.definitionExists, current);
  const revision = await tx.subagentDefinitionRevision.create({ data: {
    definitionId: id, description: draft.description, instructions: draft.instructions, name: draft.name, providerModelId: draft.modelId,
    reasoningEffort: draft.effort, revisionNumber: current.revisionNumber + 1, toolGroups: toolGroupsValue(draft.tools)
  }, select: { id: true } });
  const updated = await tx.subagentDefinition.updateMany({
    data: { currentRevisionId: revision.id, name: draft.name, version: { increment: 1 } },
    where: { id, ownerUserId: userId, version: expectedVersion }
  });
  if (updated.count !== 1) throw new Error("subagent_definition_write_lost");
  const record = await findSubagentDefinition(tx, userId, { id });
  if (!record) throw new Error("subagent_definition_write_lost");
  return { kind: "written", previous: current, record };
}

/** Replaces the definition's content with `draft` as a new revision. */
export async function reviseSubagentDefinitionInTransaction(tx: Writer, userId: string, id: string, expectedVersion: number,
  draft: SubagentDefinitionDraft): Promise<SubagentStoreWrite> {
  await lockOwner(tx, userId);
  return appendRevision(tx, userId, id, expectedVersion, draft);
}

/** The content of one of the definition's revisions, as a draft. */
export async function loadSubagentRevisionDraft(db: Reader, userId: string, id: string, revisionId: string): Promise<SubagentDefinitionDraft | null> {
  const revision = await db.subagentDefinitionRevision.findFirst({
    select: revisionSelect, where: { definition: { ownerUserId: userId }, definitionId: id, id: revisionId }
  });
  return revision ? {
    description: revision.description, effort: revision.reasoningEffort, instructions: revision.instructions, modelId: revision.providerModelId,
    name: revision.name, tools: storedToolGroups(revision.toolGroups)
  } : null;
}

/** Makes an earlier revision's content current again as a new revision (Undo of an edit). */
export async function restoreSubagentRevisionInTransaction(tx: Writer, userId: string, id: string, expectedVersion: number,
  revisionId: string): Promise<SubagentStoreWrite> {
  await lockOwner(tx, userId);
  const draft = await loadSubagentRevisionDraft(tx, userId, id, revisionId);
  if (!draft) {
    return await findSubagentDefinition(tx, userId, { id }) ? refused(SUBAGENT_DEFINITION_CODES.revisionUnknown)
      : refused(SUBAGENT_DEFINITION_CODES.notFound);
  }
  return appendRevision(tx, userId, id, expectedVersion, draft);
}

/**
 * Deletes the definition with its revisions while it is still at
 * `expectedVersion`. Threads started as it keep their work and name, and
 * lose the link (`SubagentThread.definitionId` is set null), so continuing
 * one is refused visibly.
 */
export async function deleteSubagentDefinitionInTransaction(tx: Writer, userId: string, id: string, expectedVersion: number):
  Promise<SubagentStoreDelete> {
  await lockOwner(tx, userId);
  const current = await findSubagentDefinition(tx, userId, { id });
  if (!current) return refused(SUBAGENT_DEFINITION_CODES.notFound);
  if (current.version !== expectedVersion) return refused(SUBAGENT_DEFINITION_CODES.definitionConflict, current);
  const deleted = await tx.subagentDefinition.deleteMany({ where: { id, ownerUserId: userId, version: expectedVersion } });
  if (deleted.count !== 1) throw new Error("subagent_definition_write_lost");
  return { kind: "deleted", record: current };
}

/** Sub-agent threads in the owner's chats started as this definition: what deleting it cuts off. */
export async function countSubagentDefinitionThreads(db: Pick<Prisma.TransactionClient, "subagentThread">, userId: string, id: string): Promise<number> {
  return db.subagentThread.count({ where: { definitionId: id, userId } });
}

/** The store's operations as one seam, so the service can be tested over an in-memory double. */
export type SubagentDefinitionStore = Readonly<{
  list: typeof listSubagentDefinitions;
  find: typeof findSubagentDefinition;
  create: typeof createSubagentDefinitionInTransaction;
  revise: typeof reviseSubagentDefinitionInTransaction;
  restore: typeof restoreSubagentRevisionInTransaction;
  remove: typeof deleteSubagentDefinitionInTransaction;
  threadCount: typeof countSubagentDefinitionThreads;
}>;

export const prismaSubagentDefinitionStore: SubagentDefinitionStore = Object.freeze({
  create: createSubagentDefinitionInTransaction,
  find: findSubagentDefinition,
  list: listSubagentDefinitions,
  remove: deleteSubagentDefinitionInTransaction,
  restore: restoreSubagentRevisionInTransaction,
  revise: reviseSubagentDefinitionInTransaction,
  threadCount: countSubagentDefinitionThreads
});
