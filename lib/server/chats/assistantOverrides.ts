import type { Prisma } from "@prisma/client";
import type { AssistantRowKey, AssistantRows } from "../../contracts/assistants";
import type { CatalogWireModel } from "../../contracts/catalog";
import {
  applyChatAssistantOverridesPatch,
  type ChatAssistantOverrides,
  type ChatAssistantOverridesPatch
} from "../../contracts/chats";
import type { SearchStrategyCatalogEntry } from "../../domain/catalog";
import { isSearchCombinationCompatible } from "../../domain/catalogMatrix";
import type { AssistantRowAvailableResources } from "../assistants/rowResolution";
import { assistantRunControlIssue } from "../assistants/runControlMaterialization";
import { assistantRowsFromStoredColumns } from "../assistants/storedContent";
import {
  resolveCurrentUserCatalogSelection,
  type CatalogData
} from "../catalog/currentUserCatalog";
import { installationOrGroupPublication } from "../knowledge/retainedEvidenceAccess";
import type { ChatAssistantUpdateErrorCode } from "./assistantUpdateError";

/** The part of the chat's catalog that overrides are checked against: the requester's, or the Project's. */
export type ChatAssistantOverrideCatalog = Readonly<{
  defaultModelId: string | null;
  models: readonly CatalogWireModel[];
  searchStrategies: readonly SearchStrategyCatalogEntry[];
}>;

export function chatAssistantOverrideCatalog(data: CatalogData): ChatAssistantOverrideCatalog {
  const selection = resolveCurrentUserCatalogSelection(data);
  return {
    defaultModelId: selection.defaultModel?.modelId ?? null,
    models: selection.models,
    searchStrategies: selection.entitledStrategies
  };
}

/**
 * Applies a patch to the stored overrides. Stored controls are not keyed by
 * model, so they belong to the model they were set for: a patch that sets,
 * changes or clears the model drops them unless it carries new controls.
 */
export function nextChatAssistantOverrides(
  current: ChatAssistantOverrides,
  patch: ChatAssistantOverridesPatch
): ChatAssistantOverrides {
  const next = applyChatAssistantOverridesPatch(current, patch);
  if (patch.model !== undefined && patch.controls == null) {
    const { controls: _controls, ...withoutControls } = next;
    return withoutControls;
  }
  return next;
}

/** Rows whose override the catalog decides; the other rows are plain modes. */
export function overridesNeedCatalog(patch: ChatAssistantOverridesPatch): boolean {
  return (["controls", "model", "search"] as const).some((key) => patch[key] != null);
}

/** Whether a patch names resources a Project chat checks against the Project: a catalog value or Knowledge. */
export function projectOverridesNeedAuthority(patch: ChatAssistantOverridesPatch): boolean {
  return overridesNeedCatalog(patch) || patch.knowledge != null;
}

const definitionRowSelect = {
  controlsPolicy: true,
  knowledgePolicy: true,
  knowledgeSelection: true,
  mcpMode: true,
  mcpServerIds: true,
  modelPolicy: true,
  providerModelId: true,
  runControls: true,
  searchPlan: true,
  searchPolicy: true,
  skillLinks: { orderBy: { ordinal: "asc" }, select: { mode: true, skillId: true } },
  skillsMode: true,
  skillsPolicy: true,
  toolsPolicy: true
} satisfies Prisma.AssistantDefinitionSelect;

/** The six rows of a definition the caller already found available. */
export async function loadAssistantRows(
  tx: Pick<Prisma.TransactionClient, "assistantDefinition">,
  assistantId: string
): Promise<AssistantRows> {
  const definition = await tx.assistantDefinition.findUnique({
    select: definitionRowSelect,
    where: { id: assistantId }
  });
  const rows = definition ? assistantRowsFromStoredColumns(definition) : null;
  if (!rows) throw new Error("assistant_definition_integrity_invalid");
  return rows;
}

/**
 * Checks a patch against the Assistant's row policies and the requester's
 * catalog, the way an ordinary chat checks the same kind of value. Clearing a
 * row (null) is always allowed: it only removes a stale value. Knowledge
 * resources are checked separately because they need the database.
 */
export function chatAssistantOverridesIssue(input: Readonly<{
  catalog: ChatAssistantOverrideCatalog | null;
  next: ChatAssistantOverrides;
  patch: ChatAssistantOverridesPatch;
  rows: AssistantRows;
}>): ChatAssistantUpdateErrorCode | null {
  const changed = (Object.keys(input.patch) as AssistantRowKey[])
    .filter((key) => input.patch[key] != null);
  if (changed.some((key) => input.rows[key].policy === "fixed")) {
    return "assistant_overrides_not_allowed";
  }
  if (!overridesNeedCatalog(input.patch)) return null;
  const catalog = input.catalog;
  if (!catalog) return "assistant_overrides_invalid";
  const modelById = new Map(catalog.models.map((model) => [model.modelId, model]));

  const model = input.patch.model;
  if (model && !modelById.has(model.modelId)) return "assistant_overrides_invalid";

  const search = input.patch.search;
  if (search && search.mode !== "off" && (
    search.optionIds.some((optionId) =>
      !catalog.searchStrategies.some((strategy) => strategy.strategyId === optionId)) ||
    !isSearchCombinationCompatible(search.optionIds, catalog.searchStrategies, search.mode)
  )) {
    return "assistant_overrides_invalid";
  }

  const controls = input.patch.controls;
  if (controls) {
    // Parameters belong to the model the next message uses: the chat's model,
    // else the Assistant's model while the requester can use it, else theirs.
    const assistantModel = input.rows.model.value;
    const assistantModelId = assistantModel.mode === "model" && assistantModel.modelId &&
      modelById.has(assistantModel.modelId)
      ? assistantModel.modelId
      : null;
    const effectiveModelId = input.next.model?.modelId ?? assistantModelId ?? catalog.defaultModelId;
    const effectiveModel = effectiveModelId ? modelById.get(effectiveModelId) : undefined;
    if (!effectiveModel || assistantRunControlIssue(controls, effectiveModel.parameterControls)) {
      return "assistant_overrides_invalid";
    }
  }
  return null;
}

/** Whether every Knowledge base and source of an explicit override is usable by the requester. */
export async function knowledgeOverrideAvailable(
  tx: Pick<Prisma.TransactionClient, "knowledgeBase" | "knowledgeSource" | "userGroup">,
  userId: string,
  value: NonNullable<ChatAssistantOverridesPatch["knowledge"]>
): Promise<boolean> {
  if (value.mode !== "explicit") return true;
  const baseIds = [...new Set(value.baseIds)];
  const sourceIds = [...new Set(value.sourceIds)];
  if (baseIds.length === 0 && sourceIds.length === 0) return true;
  const memberships = await tx.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId }
  });
  const accessible = await tx.knowledgeBase.findMany({
    select: { id: true },
    where: {
      deletionRequestedAt: null,
      OR: [
        { archivedAt: null, ownerUserId: userId, trashedAt: null },
        installationOrGroupPublication(memberships.map(({ groupId }) => groupId))
      ]
    }
  });
  const accessibleIds = new Set(accessible.map(({ id }) => id));
  if (baseIds.some((id) => !accessibleIds.has(id))) return false;
  if (sourceIds.length === 0) return true;
  const sources = await tx.knowledgeSource.count({
    where: {
      deletionRequestedAt: null,
      id: { in: sourceIds },
      OR: [
        { ownerUserId: userId },
        { baseMemberships: { some: { knowledgeBaseId: { in: [...accessibleIds] }, removedAt: null } } }
      ],
      trashedAt: null
    }
  });
  return sources === sourceIds.length;
}

/**
 * Whether a Knowledge override is usable in a Project chat: None, or only
 * Knowledge bases and ready documents the Project provides. "All my
 * knowledge" and a member's personal Knowledge never run in a Project.
 */
export function projectKnowledgeOverrideAvailable(
  available: Pick<AssistantRowAvailableResources, "knowledgeBaseIds" | "knowledgeSourceIds">,
  value: NonNullable<ChatAssistantOverridesPatch["knowledge"]>
): boolean {
  if (value.mode === "all_my_knowledge") return false;
  return value.mode === "none" || (
    value.baseIds.every((id) => available.knowledgeBaseIds.has(id)) &&
    value.sourceIds.every((id) => available.knowledgeSourceIds.has(id))
  );
}
