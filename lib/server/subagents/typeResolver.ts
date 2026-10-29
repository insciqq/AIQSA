import type { Prisma } from "@prisma/client";
import { normalizeSubagentName } from "../../contracts/subagents";
import { prismaSubagentDefinitionStore, type SubagentDefinitionRecord, type SubagentDefinitionStore } from "./definitionStore";
import type { SubagentTypeEntry, SubagentTypeLookup, SubagentTypeResolution, SubagentTypeResolver, SubagentTypeSnapshot } from "./ports";

/**
 * The production `SubagentTypeResolver` (`ports.ts`) over the user's own
 * definitions. It returns a definition's current revision as a snapshot and
 * builds no model binding: the engine resolves `providerModelId` and the
 * effort against the run's frozen sub-agent model catalog (call, then type,
 * then parent) and refuses an unavailable type model with
 * `subagent_type_unavailable`, never substituting another. A deleted
 * definition, a thread whose link was cleared, another user's definition and
 * a malformed lookup all resolve to `unavailable`.
 */

type Db = Pick<Prisma.TransactionClient, "subagentDefinition" | "subagentDefinitionRevision">;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function subagentTypeSnapshot(record: SubagentDefinitionRecord): SubagentTypeSnapshot {
  return {
    definitionId: record.id, description: record.description, instructions: record.instructions, name: record.name,
    providerModelId: record.providerModelId, reasoningEffort: record.reasoningEffort, revisionId: record.revisionId,
    toolGroups: record.toolGroups === null ? null : [...record.toolGroups]
  };
}

export function createSubagentTypeResolver(db: Db, store: SubagentDefinitionStore = prismaSubagentDefinitionStore): SubagentTypeResolver {
  return {
    async catalog({ userId }): Promise<readonly SubagentTypeEntry[]> {
      return (await store.list(db, userId)).map((record) => ({ description: record.description, name: record.name }));
    },

    async resolve(input: SubagentTypeLookup): Promise<SubagentTypeResolution> {
      let record: SubagentDefinitionRecord | null = null;
      if ("definitionId" in input) {
        if (typeof input.definitionId === "string" && ID_PATTERN.test(input.definitionId)) {
          record = await store.find(db, input.userId, { id: input.definitionId });
        }
      } else {
        const name = normalizeSubagentName(input.name);
        if (name) record = await store.find(db, input.userId, { name });
      }
      return record ? { kind: "found", type: subagentTypeSnapshot(record) } : { kind: "unavailable" };
    }
  };
}
