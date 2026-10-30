import type { Prisma, PrismaClient } from "@prisma/client";
import { SUBAGENT_DEFINITION_LIMITS } from "../../contracts/subagents";
import {
  SUBAGENT_DEFINITION_CODES,
  decodeSubagentDefinitionDraft,
  type SubagentDefaultUndoOutcome,
  type SubagentDefaultUndoRequest,
  type SubagentDefinitionDraft,
  type SubagentDefinitionField,
  type SubagentDefinitionListResponse,
  type SubagentDefinitionSummary,
  type SubagentDefinitionView,
  subagentModelLabel,
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
  type SubagentDefaultRef,
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
 * user confirms in the card through the Studio route. Moving the user's default
 * sub-agent follows the same paths, and an Undo of a change that moved it reverses
 * both in one transaction.
 */

export type SubagentDefinitionDb = Pick<PrismaClient, "$transaction" | "subagentDefinition" | "subagentDefinitionRevision" | "subagentThread" | "userSettings">;

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
    // Named with its connection, like the picker lists it: two connections may serve models of the same name.
    modelDisplayName: model ? Array.from(subagentModelLabel(model)).slice(0, 256).join("") : null,
    modelId: record.providerModelId, name: record.name, revisionNumber: record.revisionNumber,
    tools: record.toolGroups, updatedAt: record.updatedAt.toISOString(), version: record.version
  };
}

export function subagentDefinitionView(record: SubagentDefinitionRecord, models: readonly SubagentModelOption[] | null): SubagentDefinitionView {
  return { ...subagentDefinitionSummary(record, models), instructions: record.instructions, previousRevisionId: record.previousRevisionId,
    revisionId: record.revisionId };
}

/** Checks a decoded draft's model and effort against the user's current models. */
async function checkModel(models: SubagentModelSource, userId: string, draft: Pick<SubagentDefinitionDraft, "effort" | "modelId">):
  Promise<SubagentDefinitionRefusal | null> {
  if (draft.modelId === null && draft.effort === null) return null;
  const options = await models(userId);
  if (!options) return { code: SUBAGENT_DEFINITION_CODES.catalogUnavailable };
  return subagentModelRefusal(draft, options);
}

function storeRefusal(refusal: SubagentStoreRefusal): SubagentDefinitionRefusal {
  return { code: refusal.code, ...(refusal.current ? { current: refusal.current } : {}),
    ...(refusal.code === SUBAGENT_DEFINITION_CODES.nameInvalid ? { field: "name" as const } : {}) };
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
  /** The user's default sub-agent's id; null is the built-in one. */
  readDefault(userId: string): Promise<string | null>;
  /** Moves the default while it is still `expected`; returns where it is now. A model the user no longer has is refused. */
  setDefault(userId: string, definitionId: string | null, expected: string | null): Promise<SubagentDefinitionOutcome<string | null>>;
  /** Undo of a change that moved the default (`SubagentDefaultUndoRequest`). */
  undoDefaultChange(userId: string, undo: SubagentDefaultUndoRequest): Promise<SubagentDefinitionOutcome<SubagentDefaultUndoOutcome>>;
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
      const [records, options, pointer] = await Promise.all([store.list(db, userId), models(userId).catch(() => null),
        store.readDefault(db, userId)]);
      return { defaultDefinitionId: records.find((record) => record.id === pointer?.definitionId)?.id ?? null,
        definitions: records.map((record) => subagentDefinitionSummary(record, options)), limit: SUBAGENT_DEFINITION_LIMITS.perUser,
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
    },

    async readDefault(userId) {
      return (await store.readDefault(db, userId))?.definitionId ?? null;
    },

    async setDefault(userId, definitionId, expected) {
      if (definitionId !== null) {
        const record = await store.find(db, userId, { id: definitionId });
        if (!record) return refuse({ code: SUBAGENT_DEFINITION_CODES.notFound });
        // As saving it would: the user's current models decide. Only an Undo puts back a model they no longer have.
        const refusal = await checkModel(models, userId, { effort: record.reasoningEffort, modelId: record.providerModelId });
        if (refusal) return refuse(refusal);
      }
      const write = await db.$transaction((tx) => store.setDefault(tx, userId, { expected, target: definitionId }));
      return write.kind === "refused" ? refuse(storeRefusal(write)) : { ok: true, value: definitionId };
    },

    async undoDefaultChange(userId, undo) {
      const write = await db.$transaction((tx) => store.undoDefaultChange(tx, userId, undo));
      return write.kind === "refused" ? refuse(storeRefusal(write)) : { ok: true, value: write.outcome };
    }
  };
}

/** How an agent write touches the user's default sub-agent. */
export type SubagentDefaultIntent = "clear" | "keep" | "set";

/** The default moved with an agent write: to this definition or away from it, and what it was. */
export type SubagentDefaultMove = Readonly<{ isDefault: boolean; previous: SubagentDefaultRef | null }>;

/** What an agent write did, for its card and result. `previous`: the definition before a new revision, null when none was written. */
export type AgentSubagentWritten = Readonly<{
  defaultMove: SubagentDefaultMove | null;
  /** Whether it is the user's default now. */
  isDefault: boolean;
  previous: SubagentDefinitionRecord | null;
  record: SubagentDefinitionRecord;
}>;

export type AgentSubagentRefusal = SubagentDefinitionRefusal & Readonly<{ isDefault?: boolean; unchanged?: SubagentDefinitionRecord }>;

export type AgentSubagentCommit = SelfServiceCommitOutcome<AgentSubagentWritten, AgentSubagentRefusal>;

/**
 * The agent's access to its user's custom sub-agents, for one tool call:
 * reads of the user's own definitions, and writes that commit with the
 * call's settlement and card in one transaction.
 */
export type AgentSubagentService = Readonly<{
  models(): Promise<readonly SubagentModelOption[] | null>;
  find(lookup: SubagentDefinitionLookup): Promise<SubagentDefinitionRecord | null>;
  /** The user's default sub-agent; null is the built-in one. */
  currentDefault(): Promise<SubagentDefaultRef | null>;
  /** Threads in the user's chats started as this definition. */
  threadCount(id: string): Promise<number>;
  create(draft: SubagentDefinitionDraft, intent: Exclude<SubagentDefaultIntent, "clear">, result: (written: AgentSubagentWritten) => ToolExecutionResult):
    Promise<AgentSubagentCommit>;
  /**
   * A new revision of `current`, under its version. A draft equal to it that still moves the default writes no
   * revision: `previous` is null.
   */
  revise(current: SubagentDefinitionRecord, draft: SubagentDefinitionDraft, intent: SubagentDefaultIntent,
    result: (written: AgentSubagentWritten) => ToolExecutionResult): Promise<AgentSubagentCommit>;
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

  /**
   * Moves the default as the write asks, under the owner's lock the write took. Setting the default it already is, or
   * clearing it from a definition that is not the default (another one's stays), moves nothing.
   */
  async function moveDefault(tx: Prisma.TransactionClient, id: string, intent: SubagentDefaultIntent):
    Promise<Pick<AgentSubagentWritten, "defaultMove" | "isDefault">> {
    const previous = await store.readDefault(tx, userId);
    const wasDefault = previous?.definitionId === id;
    if (intent === "keep" || wasDefault === (intent === "set")) return { defaultMove: null, isDefault: wasDefault };
    const moved = await store.setDefault(tx, userId, { target: intent === "set" ? id : null });
    if (moved.kind !== "moved") throw new Error("subagent_default_write_lost");
    return { defaultMove: { isDefault: intent === "set", previous }, isDefault: intent === "set" };
  }

  async function write(draft: SubagentDefinitionDraft, intent: SubagentDefaultIntent, checksModel: boolean,
    apply: (tx: Prisma.TransactionClient, draft: SubagentDefinitionDraft) => Promise<SubagentStoreWrite>,
    result: (written: AgentSubagentWritten) => ToolExecutionResult): Promise<AgentSubagentCommit> {
    const decoded = decodeSubagentDefinitionDraft(draft);
    if (!decoded.ok) return { kind: "refused", value: { code: decoded.code, field: decoded.field } };
    const refusal = checksModel ? await checkModel(input.models, userId, decoded.draft) : null;
    if (refusal) return { kind: "refused", value: refusal };
    return commitSelfServiceChange<AgentSubagentWritten, AgentSubagentRefusal>(db, input.store, async (tx) => {
      const outcome = await apply(tx, decoded.draft);
      if (outcome.kind === "refused") return { kind: "refused", value: storeRefusal(outcome) };
      const pointer = await moveDefault(tx, outcome.record.id, intent);
      if (outcome.kind === "unchanged" && !pointer.defaultMove) {
        return { kind: "refused", value: { code: "subagent_definition_unchanged", isDefault: pointer.isDefault, unchanged: outcome.record } };
      }
      const done = { ...pointer, previous: outcome.kind === "written" ? outcome.previous : null, record: outcome.record };
      return { kind: "changed", result: result(done), value: done };
    });
  }

  return {
    models: () => input.models(userId),
    find: (lookup) => store.find(db, userId, lookup),
    currentDefault: () => store.readDefault(db, userId),
    threadCount: (id) => store.threadCount(db, userId, id),
    create: (draft, intent, result) => write(draft, intent, true, (tx, decoded) => store.create(tx, userId, decoded), result),
    // Only a new model or effort, or becoming the default, needs the user's current models: a sub-agent whose model is
    // gone can still be renamed or stop being the default.
    revise: (current, draft, intent, result) => write(draft, intent,
      intent === "set" || draft.modelId !== current.providerModelId || draft.effort !== current.reasoningEffort,
      (tx, decoded) => store.revise(tx, userId, current.id, current.version, decoded), result)
  };
}
