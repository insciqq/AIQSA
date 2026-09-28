import type {
  AssistantAvailability,
  AssistantAvailabilityReason,
  AssistantRowAvailability,
  AssistantRowDeviation,
  AssistantRowDeviationKey,
  AssistantRowKey,
  AssistantRows
} from "../../contracts/assistants";
import { visibleAssistantRows } from "../assistants/rowRedaction";
import {
  resolveAssistantRows,
  type AssistantRowAvailableResources,
  type AssistantRowContextDefaults
} from "../assistants/rowResolution";
import { legacyValuesFromAssistantRows, type AssistantLegacyRowValues } from "../assistants/storedContent";

/*
 * Assistants in a Project (P-06): only the resources of fixed rows and every
 * Skill link are dependencies the Project must provide. An adjustable row
 * whose resource the Project lacks runs with the Project's default instead,
 * so it neither blocks binding nor makes the Assistant unavailable.
 */

/** The resources a Project must provide for an Assistant. */
export type ProjectAssistantDependencies = {
  knowledgeBaseIds: string[];
  knowledgeSourceIds: string[];
  mcpServerIds: string[];
  /** Null when the Model row is adjustable (or inherits): the Project default serves it. */
  modelId: string | null;
  searchOptionIds: string[];
  skillIds: string[];
};

export function projectAssistantDependencies(rows: AssistantRows): ProjectAssistantDependencies {
  const model = rows.model.value;
  const search = rows.search.value;
  const tools = rows.tools.value;
  const knowledge = rows.knowledge.value;
  const explicitKnowledge = rows.knowledge.policy === "fixed" && knowledge.mode === "explicit" ? knowledge : null;
  return {
    knowledgeBaseIds: [...new Set(explicitKnowledge?.baseIds ?? [])],
    knowledgeSourceIds: [...new Set(explicitKnowledge?.sourceIds ?? [])],
    mcpServerIds: rows.tools.policy === "fixed" && tools.mode === "exact" ? [...new Set(tools.serverIds)] : [],
    modelId: rows.model.policy === "fixed" && model.mode === "model" ? model.modelId : null,
    searchOptionIds: rows.search.policy === "fixed" && "optionIds" in search ? [...new Set(search.optionIds)] : [],
    skillIds: [...new Set(rows.skills.value.links.map((link) => link.skillId))]
  };
}

/** Availability does not depend on what inherit means, so any defaults decide it. */
const availabilityDefaults: AssistantRowContextDefaults = {
  controlsForModel: () => ({}),
  knowledge: { mode: "none" },
  modelId: "",
  search: { mode: "off" },
  tools: { mode: "off" }
};

const unavailableReasons: Readonly<Record<AssistantRowKey, AssistantAvailabilityReason>> = {
  controls: "model_access",
  knowledge: "knowledge_access",
  model: "model_access",
  search: "search_access",
  skills: "skills_access",
  tools: "tools_access"
};

const deviationReasons: Readonly<Record<AssistantRowDeviationKey, AssistantRowDeviation["reason"]>> = {
  knowledge: "knowledge_access",
  model: "model_access",
  search: "search_access",
  tools: "tools_access"
};

/**
 * Whether the Assistant can run in the Project, decided by the same row chain
 * as admission, and which adjustable rows fall back to the Project's default.
 * Project members see the Assistant as consumers: reasons stay neutral and no
 * resource is named.
 */
export function projectAssistantAvailability(
  rows: AssistantRows,
  available: AssistantRowAvailableResources
): Readonly<{ availability: AssistantAvailability; rowAvailability: AssistantRowAvailability }> {
  const resolution = resolveAssistantRows({
    assistant: rows,
    available,
    defaults: availabilityDefaults,
    requested: {},
    stored: {}
  });
  if (!resolution.ok) {
    return { availability: { ok: false, reason: unavailableReasons[resolution.row] }, rowAvailability: {} };
  }
  const rowAvailability: AssistantRowAvailability = {};
  for (const key of Object.keys(deviationReasons) as AssistantRowDeviationKey[]) {
    if (!resolution.rows[key].assistantValueAvailable) rowAvailability[key] = { reason: deviationReasons[key] };
  }
  return { availability: { ok: true }, rowAvailability };
}

/**
 * The rows and flat fields of a Project composer entry. Every member receives
 * them, so a resource the Project does not provide (such as the owner's
 * personal model, MCP server or Knowledge in an adjustable row) is never
 * identified, only counted, and a model outside the Project reads as none.
 */
export function projectAssistantEntryRows(
  rows: AssistantRows,
  available: AssistantRowAvailableResources
): Readonly<{ flat: AssistantLegacyRowValues; rows: AssistantRows }> {
  const visible = visibleAssistantRows(rows, available);
  return { flat: legacyValuesFromAssistantRows(visible), rows: visible };
}
