import type { Prisma, PrismaClient } from "@prisma/client";
import { SUBAGENT_DEFINITION_LIMITS } from "../../contracts/subagents";
import {
  SUBAGENT_DEFINITION_CODES,
  decodeSubagentDefinitionDraft,
  type SubagentDefinitionDraft,
  type SubagentDefinitionField,
  type SubagentDefinitionListResponse,
  type SubagentDefinitionSummary,
  type SubagentDefinitionView,
  type SubagentModelOption
} from "../../contracts/subagentDefinitions";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceCommitOutcome
} from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import { subagentModelRefusal, type SubagentModelSource } from "./definitionModels";
import {
  prismaSubagentDefinitionStore,
  type SubagentDefinitionLookup,
  type SubagentDefinitionStore,
  type SubagentDefinitionRecord,
  type SubagentStoreRefusal,
  type SubagentStoreWrite
} from "./definitionStore";

/**
 * The one service behind custom sub-agents: Studio's routes and the agent's
 * `create_subagent`, `edit_subagent` and `delete_subagent` validate a draft
 * the same way (contract bounds, then the user's current tool-calling models
 * and efforts) and write through the same store. A Studio write commits in
 * its own transaction; an agent write commits with its tool call and card
 * (`commitSelfServiceChange`). Deleting from the agent only proposes: the
 * user confirms in the card through the Studio route.
 */

export type SubagentDefinitionDb = Pick<PrismaClient, "$transaction" | "subagentDefinition" | "subagentDefinitionRevision" | "subagentThread">;

export type SubagentDefinitionRefusal = Readonly<{
  code: string;
  /** The definition as it is now, for a conflict. */
  current?: SubagentDefinitionRecord;
  field?: SubagentDefinitionField;
}>;

export type SubagentDefinitionOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; refusal: SubagentDefinitionRefusal }>;

const refuse = (refusal: SubagentDefinitionRefusal): Readonly<{ ok: false; refusal: SubagentDefinitionRefusal }> => ({ ok: false, refusal });

/** A record as the owner's Studio reads it, with its model's current name and availability. */
export function subagentDefinitionSummary(record: SubagentDefinitionRecord, models: readonly SubagentModelOption[] | null): SubagentDefinitionSummary {
  const model = record.providerModelId === null ? null : models?.find((option) => option.modelId === record.providerModelId) ?? null;
  return {
    description: record.description, effort: record.reasoningEffort, id: record.id,
    // An unreadable catalog is not proof the model is gone.
    modelAvailable: record.providerModelId === null || models === null || model !== null,
    modelDisplayName: model?.displayName ?? null, modelId: record.providerModelId, name: record.name, revisionNumber: record.revisionNumber,
    tools: record.toolGroups, updatedAt: record.updatedAt.toISOString(), version: record.version
  };
}

export function subagentDefinitionView(record: SubagentDefinitionRecord, models: readonly SubagentModelOption[] | null): SubagentDefinitionView {
  return { ...subagentDefinitionSummary(record, models), instructions: record.instructions, previousRevisionId: record.previousRevisionId,
    revisionId: record.revisionId };
}

/** Checks a decoded draft against the user's current models. */
async function checkModel(models: SubagentModelSource, userId: string, draft: SubagentDefinitionDraft): Promise<SubagentDefinitionRefusal | null> {
  if (draft.modelId === null && draft.effort === null) return null;
  const options = await models(userId);
  if (!options) return { code: SUBAGENT_DEFINITION_CODES.catalogUnavailable };
  return subagentModelRefusal(draft, options);
}

function storeRefusal(refusal: SubagentStoreRefusal): SubagentDefinitionRefusal {
  return { code: refusal.code, ...(refusal.current ? { current: refusal.current } : {}) };
}

/** A store write as an outcome; an unchanged draft is a success that wrote nothing. */
function written(write: SubagentStoreWrite): SubagentDefinitionOutcome<SubagentDefinitionRecord> {
  return write.kind === "refused" ? refuse(storeRefusal(write)) : { ok: true, value: write.record };
}

/** The Studio routes' service: one owner per call, each write in its own transaction. */
export type SubagentDefinitionService = Readonly<{
  list(userId: string): Promise<SubagentDefinitionListResponse>;
  get(userId: string, id: string): Promise<SubagentDefinitionView | null>;
  create(userId: string, draft: unknown): Promise<SubagentDefinitionOutcome<SubagentDefinitionView>>;
  update(userId: string, id: string, expectedVersion: number, draft: unknown): Promise<SubagentDefinitionOutcome<SubagentDefinitionView>>;
  restore(userId: string, id: string, expectedVersion: number, revisionId: string): Promise<SubagentDefinitionOutcome<SubagentDefinitionView>>;
  remove(userId: string, id: string, expectedVersion: number): Promise<SubagentDefinitionOutcome<null>>;
}>;

export function createSubagentDefinitionService(input: Readonly<{
  db: SubagentDefinitionDb;
  models: SubagentModelSource;
  /** Test seam; defaults to the Prisma store. */
  store?: SubagentDefinitionStore;
}>): SubagentDefinitionService {
  const { db, models } = input;
  const store = input.store ?? prismaSubagentDefinitionStore;

  async function decode(userId: string, raw: unknown): Promise<SubagentDefinitionOutcome<SubagentDefinitionDraft>> {
    const decoded = decodeSubagentDefinitionDraft(raw);
    if (!decoded.ok) return refuse({ code: decoded.code, field: decoded.field });
    const refusal = await checkModel(models, userId, decoded.draft);
    return refusal ? refuse(refusal) : { ok: true, value: decoded.draft };
  }

  async function view(userId: string, outcome: SubagentDefinitionOutcome<SubagentDefinitionRecord>):
    Promise<SubagentDefinitionOutcome<SubagentDefinitionView>> {
    if (!outcome.ok) return outcome;
    return { ok: true, value: subagentDefinitionView(outcome.value, await models(userId).catch(() => null)) };
  }

  return {
    async list(userId) {
      const [records, options] = await Promise.all([store.list(db, userId), models(userId).catch(() => null)]);
      return { definitions: records.map((record) => subagentDefinitionSummary(record, options)), limit: SUBAGENT_DEFINITION_LIMITS.perUser,
        models: options ?? [] };
    },

    async get(userId, id) {
      const record = await store.find(db, userId, { id });
      return record ? subagentDefinitionView(record, await models(userId).catch(() => null)) : null;
    },

    async create(userId, raw) {
      const draft = await decode(userId, raw);
      if (!draft.ok) return draft;
      return view(userId, written(await db.$transaction((tx) => store.create(tx, userId, draft.value))));
    },

    async update(userId, id, expectedVersion, raw) {
      const draft = await decode(userId, raw);
      if (!draft.ok) return draft;
      return view(userId, written(await db.$transaction((tx) => store.revise(tx, userId, id, expectedVersion, draft.value))));
    },

    async restore(userId, id, expectedVersion, revisionId) {
      // Undo restores what the user had; a model that is no longer theirs is kept as it was and refused when a turn uses it.
      return view(userId, written(await db.$transaction((tx) => store.restore(tx, userId, id, expectedVersion, revisionId))));
    },

    async remove(userId, id, expectedVersion) {
      const deleted = await db.$transaction((tx) => store.remove(tx, userId, id, expectedVersion));
      return deleted.kind === "deleted" ? { ok: true, value: null } : refuse(storeRefusal(deleted));
    }
  };
}

/** What an agent write did, for its card and result. */
export type AgentSubagentWritten = Readonly<{ previous: SubagentDefinitionRecord | null; record: SubagentDefinitionRecord }>;

export type AgentSubagentRefusal = SubagentDefinitionRefusal & Readonly<{ unchanged?: SubagentDefinitionRecord }>;

export type AgentSubagentCommit = SelfServiceCommitOutcome<AgentSubagentWritten, AgentSubagentRefusal>;

/**
 * The agent's access to its user's custom sub-agents, for one tool call:
 * reads of the user's own definitions, and writes that commit with the
 * call's settlement and card in one transaction.
 */
export type AgentSubagentService = Readonly<{
  models(): Promise<readonly SubagentModelOption[] | null>;
  find(lookup: SubagentDefinitionLookup): Promise<SubagentDefinitionRecord | null>;
  /** Threads in the user's chats started as this definition. */
  threadCount(id: string): Promise<number>;
  create(draft: SubagentDefinitionDraft, result: (written: AgentSubagentWritten) => ToolExecutionResult): Promise<AgentSubagentCommit>;
  revise(id: string, expectedVersion: number, draft: SubagentDefinitionDraft, result: (written: AgentSubagentWritten) => ToolExecutionResult):
    Promise<AgentSubagentCommit>;
}>;

export function createAgentSubagentService(input: Readonly<{
  db: SubagentDefinitionDb;
  models: SubagentModelSource;
  store: SelfServiceCallStore;
  userId: string;
  /** Test seam; defaults to the Prisma store. */
  definitions?: SubagentDefinitionStore;
}>): AgentSubagentService {
  const { db, userId } = input;
  const store = input.definitions ?? prismaSubagentDefinitionStore;

  async function write(draft: SubagentDefinitionDraft,
    apply: (tx: Prisma.TransactionClient, draft: SubagentDefinitionDraft) => Promise<SubagentStoreWrite>,
    result: (written: AgentSubagentWritten) => ToolExecutionResult): Promise<AgentSubagentCommit> {
    const decoded = decodeSubagentDefinitionDraft(draft);
    if (!decoded.ok) return { kind: "refused", value: { code: decoded.code, field: decoded.field } };
    const refusal = await checkModel(input.models, userId, decoded.draft);
    if (refusal) return { kind: "refused", value: refusal };
    return commitSelfServiceChange<AgentSubagentWritten, AgentSubagentRefusal>(db, input.store, async (tx) => {
      const outcome = await apply(tx, decoded.draft);
      if (outcome.kind === "refused") return { kind: "refused", value: storeRefusal(outcome) };
      if (outcome.kind === "unchanged") return { kind: "refused", value: { code: "subagent_definition_unchanged", unchanged: outcome.record } };
      const done = { previous: outcome.previous, record: outcome.record };
      return { kind: "changed", result: result(done), value: done };
    });
  }

  return {
    models: () => input.models(userId),
    find: (lookup) => store.find(db, userId, lookup),
    threadCount: (id) => store.threadCount(db, userId, id),
    create: (draft, result) => write(draft, (tx, decoded) => store.create(tx, userId, decoded), result),
    revise: (id, expectedVersion, draft, result) =>
      write(draft, (tx, decoded) => store.revise(tx, userId, id, expectedVersion, decoded), result)
  };
}
