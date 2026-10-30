import { SUBAGENT_BUILT_IN_TYPE, SUBAGENT_DEFINITION_LIMITS } from "@/lib/contracts/subagents";
import type { SubagentDefinitionDraft } from "@/lib/contracts/subagentDefinitions";
import type {
  SubagentDefaultRef,
  SubagentDefinitionRecord,
  SubagentDefinitionStore,
  SubagentStoreRefusal,
  SubagentStoreWrite
} from "@/lib/server/subagents/definitionStore";

/**
 * An in-memory double of the custom sub-agent store
 * (`lib/server/subagents/definitionStore.ts`) with the same owner scoping,
 * version guard, per-user limit, name uniqueness, reserved name, append-only
 * revisions and default pointer, which deleting its definition clears.
 * The Prisma store has its own stateful test (`definitionStore.prisma.test.ts`).
 */

type Revision = Readonly<{ id: string; number: number; draft: SubagentDefinitionDraft }>;
type Row = { id: string; ownerUserId: string; version: number; current: string; revisions: Revision[]; updatedAt: Date };

export class MemorySubagentDefinitionStore {
  readonly rows = new Map<string, Row>();
  /** Each user's default definition, as `UserSettings.defaultSubagentDefinitionId`. */
  readonly defaults = new Map<string, string>();
  threads = new Map<string, number>();
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  private record(row: Row): SubagentDefinitionRecord {
    const current = row.revisions.find((revision) => revision.id === row.current)!;
    const previous = row.revisions.find((revision) => revision.number === current.number - 1) ?? null;
    return {
      description: current.draft.description, id: row.id, instructions: current.draft.instructions, name: current.draft.name,
      previousRevisionId: previous?.id ?? null, providerModelId: current.draft.modelId, reasoningEffort: current.draft.effort,
      revisionId: current.id, revisionNumber: current.number, toolGroups: current.draft.tools, updatedAt: row.updatedAt, version: row.version
    };
  }

  private owned(userId: string): Row[] {
    return [...this.rows.values()].filter((row) => row.ownerUserId === userId);
  }

  private find(userId: string, lookup: Readonly<{ id: string }> | Readonly<{ name: string }>): Row | null {
    return this.owned(userId).find((row) => "id" in lookup ? row.id === lookup.id : this.record(row).name === lookup.name) ?? null;
  }

  private append(userId: string, id: string, expectedVersion: number, draft: SubagentDefinitionDraft): SubagentStoreWrite {
    const row = this.find(userId, { id });
    if (!row) return refused("subagent_not_found");
    const current = this.record(row);
    if (row.version !== expectedVersion) return refused("subagent_definition_conflict", current);
    if (current.name === draft.name && current.description === draft.description && current.instructions === draft.instructions &&
      current.providerModelId === draft.modelId && current.reasoningEffort === draft.effort &&
      JSON.stringify(current.toolGroups) === JSON.stringify(draft.tools)) return { kind: "unchanged", record: current };
    if (draft.name !== current.name && draft.name === SUBAGENT_BUILT_IN_TYPE) return refused("subagent_name_invalid");
    if (draft.name !== current.name && this.find(userId, { name: draft.name })) return refused("subagent_definition_exists", current);
    const revision = { draft: { ...draft }, id: this.nextId("rev"), number: current.revisionNumber + 1 };
    row.revisions.push(revision);
    row.current = revision.id;
    row.version += 1;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1_000);
    return { kind: "written", previous: current, record: this.record(row) };
  }

  private currentDefault(userId: string): SubagentDefaultRef | null {
    const id = this.defaults.get(userId);
    const row = id ? this.find(userId, { id }) : null;
    return row ? { definitionId: row.id, name: this.record(row).name } : null;
  }

  private writeDefault(userId: string, target: string | null): void {
    if (target === null) this.defaults.delete(userId);
    else this.defaults.set(userId, target);
  }

  private removeRow(id: string): void {
    this.rows.delete(id);
    for (const [userId, target] of this.defaults) if (target === id) this.defaults.delete(userId);
  }

  /** The store seam the service and resolver take. */
  readonly store: SubagentDefinitionStore = {
    list: async (_db, userId) => this.owned(userId).map((row) => this.record(row)).sort((a, b) => a.name.localeCompare(b.name)),
    find: async (_db, userId, lookup) => {
      const row = this.find(userId, lookup);
      return row ? this.record(row) : null;
    },
    create: async (_tx, userId, draft) => {
      if (draft.name === SUBAGENT_BUILT_IN_TYPE) return refused("subagent_name_invalid");
      if (this.owned(userId).length >= SUBAGENT_DEFINITION_LIMITS.perUser) return refused("subagent_definition_limit");
      if (this.find(userId, { name: draft.name })) return refused("subagent_definition_exists");
      const revision = { draft: { ...draft }, id: this.nextId("rev"), number: 1 };
      const row: Row = { current: revision.id, id: this.nextId("def"), ownerUserId: userId, revisions: [revision],
        updatedAt: new Date("2026-10-30T10:00:00Z"), version: 1 };
      this.rows.set(row.id, row);
      return { kind: "written", previous: null, record: this.record(row) };
    },
    revise: async (_tx, userId, id, expectedVersion, draft) => this.append(userId, id, expectedVersion, draft),
    restore: async (_tx, userId, id, expectedVersion, revisionId) => {
      const row = this.find(userId, { id });
      if (!row) return refused("subagent_not_found");
      const revision = row.revisions.find((entry) => entry.id === revisionId);
      return revision ? this.append(userId, id, expectedVersion, revision.draft) : refused("subagent_revision_unknown");
    },
    remove: async (_tx, userId, id, expectedVersion) => {
      const row = this.find(userId, { id });
      if (!row) return refused("subagent_not_found");
      if (row.version !== expectedVersion) return refused("subagent_definition_conflict", this.record(row));
      const record = this.record(row);
      this.removeRow(id);
      return { kind: "deleted", record };
    },
    threadCount: async (_db, userId, id) => this.find(userId, { id }) ? this.threads.get(id) ?? 0 : 0,
    readDefault: async (_db, userId) => this.currentDefault(userId),
    setDefault: async (_tx, userId, input) => {
      const current = this.currentDefault(userId);
      const currentId = current?.definitionId ?? null;
      if (input.expected !== undefined && input.expected !== currentId) return refused("subagent_default_conflict");
      if (input.target !== null && !this.find(userId, { id: input.target })) return refused("subagent_not_found");
      if (input.target === currentId) return { kind: "unchanged" };
      this.writeDefault(userId, input.target);
      return { kind: "moved", previous: current };
    },
    undoDefaultChange: async (tx, userId, input) => {
      const left = this.currentDefault(userId)?.definitionId ?? null;
      if (input.definition) {
        const { expectedVersion, id, revisionId } = input.definition;
        const write = revisionId === null ? await this.store.remove(tx, userId, id, expectedVersion)
          : await this.store.restore(tx, userId, id, expectedVersion, revisionId);
        if (write.kind === "refused") return write;
      }
      if (left !== input.restore.expected) return { kind: "undone", outcome: "changed" };
      const { target } = input.restore;
      const gone = target !== null && !this.find(userId, { id: target });
      this.writeDefault(userId, gone ? null : target);
      return { kind: "undone", outcome: gone ? "target_gone" : "restored" };
    }
  };
}

function refused(code: SubagentStoreRefusal["code"], current?: SubagentDefinitionRecord): SubagentStoreRefusal {
  return { code, kind: "refused", ...(current ? { current } : {}) };
}

/** A database double whose transaction runs the work at once, for services built over the memory store. */
export function immediateTransactionDb<T>(): T {
  const tx = {};
  return { $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as unknown as T;
}
