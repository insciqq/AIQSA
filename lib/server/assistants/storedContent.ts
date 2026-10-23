import {
  assistantSkillDelivery,
  assistantSkillModeForDelivery,
  decodeAssistantRows,
  type AssistantRowPolicy,
  type AssistantRows,
  type AssistantRunControls
} from "../../contracts/assistants";
import {
  decodeSearchPlan,
  type SearchPlan,
  type SearchPlanMode
} from "../../contracts/search";
import type { AssistantSkillMode, SkillsMode } from "../../contracts/skills";

/**
 * Storage mapping for Assistant definition values that the database keeps
 * distinct from the current wire shapes. Rows are authoritative; the flat
 * fields of the current editor and run materialization derive from them.
 */

export type StoredAssistantSearchPlan =
  | { mode: "inherit" }
  | { mode: "off" }
  | { mode: SearchPlanMode; optionIds: string[] };

export type StoredAssistantMcpMode = "exact" | "inherit" | "off";

/**
 * The definition columns behind the five rows, as the database stores them.
 * The retired Knowledge columns stay in the table until a later migration
 * drops them; Assistant code neither reads nor writes them.
 */
export type StoredAssistantRowColumns = {
  controlsPolicy: AssistantRowPolicy;
  mcpMode: StoredAssistantMcpMode;
  mcpServerIds: readonly string[];
  modelPolicy: AssistantRowPolicy;
  /** Null is an inherited model. */
  providerModelId: string | null;
  runControls: unknown;
  /** `{"mode":"inherit"}`, `{"mode":"off"}` or a plan with Search sources. */
  searchPlan: unknown;
  searchPolicy: AssistantRowPolicy;
  /** Links in their stored ordinal order. */
  skillLinks: readonly { mode: AssistantSkillMode; skillId: string }[];
  skillsMode: SkillsMode;
  skillsPolicy: AssistantRowPolicy;
  toolsPolicy: AssistantRowPolicy;
};

export type StoredAssistantRowWrite = Omit<StoredAssistantRowColumns, "searchPlan" | "skillLinks"> & {
  mcpServerIds: string[];
  searchPlan: StoredAssistantSearchPlan;
  skillLinks: { mode: AssistantSkillMode; skillId: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInherit(value: unknown): boolean {
  return isRecord(value) && value.mode === "inherit" && Object.keys(value).length === 1;
}

/** A plan without Search sources is stored as explicit Off. */
export function storedAssistantSearchPlan(plan: SearchPlan): StoredAssistantSearchPlan {
  return plan.optionIds.length === 0
    ? { mode: "off" }
    : { mode: plan.mode, optionIds: [...plan.optionIds] };
}

/** The MCP mode follows the concrete server list; Inherit has no writer yet. */
export function storedAssistantMcpMode(mcpServerIds: readonly string[]): "exact" | "off" {
  return mcpServerIds.length > 0 ? "exact" : "off";
}

/** An empty control set cannot be fixed; a concrete one keeps today's lock. */
export function storedAssistantControlsPolicy(runControls: unknown): "adjustable" | "fixed" {
  return isRecord(runControls) && Object.keys(runControls).length > 0 ? "fixed" : "adjustable";
}

/**
 * Reads the five rows from stored columns. Returns null for a combination the
 * database or the row rules do not allow, which callers treat as an integrity
 * failure.
 */
export function assistantRowsFromStoredColumns(columns: StoredAssistantRowColumns): AssistantRows | null {
  const search = isInherit(columns.searchPlan) ||
    (isRecord(columns.searchPlan) && columns.searchPlan.mode === "off")
    ? columns.searchPlan
    : (() => {
        // A plan without Search sources, written before explicit Off existed
        // or by a previous-release writer, reads as Off like it runs.
        const decoded = decodeSearchPlan(columns.searchPlan);
        if (!decoded.ok) return null;
        return decoded.plan.optionIds.length > 0 ? decoded.plan : { mode: "off" };
      })();
  const tools = columns.mcpMode === "exact"
    ? { mode: "exact", serverIds: columns.mcpServerIds }
    : columns.mcpServerIds.length === 0 ? { mode: columns.mcpMode } : null;
  if (!search || !tools) return null;
  const decoded = decodeAssistantRows({
    // Readers have always treated a missing control set as empty.
    controls: { policy: columns.controlsPolicy, value: columns.runControls ?? {} },
    model: {
      policy: columns.modelPolicy,
      value: columns.providerModelId === null
        ? { mode: "inherit" }
        : { mode: "model", modelId: columns.providerModelId }
    },
    search: { policy: columns.searchPolicy, value: search },
    skills: {
      policy: columns.skillsPolicy,
      value: {
        links: columns.skillLinks.map((link) => ({
          delivery: assistantSkillDelivery(link.mode),
          skillId: link.skillId
        })),
        mode: columns.skillsMode
      }
    },
    tools: { policy: columns.toolsPolicy, value: tools }
  }, "draft");
  return decoded.ok ? decoded.rows : null;
}

/** The flat row fields the current editor and run materialization read. */
export type AssistantLegacyRowValues = {
  mcpServerIds: string[];
  providerModelId: string | null;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
};

/**
 * Flat fields cannot express inherit: an inherited model reads as null and
 * every other inherit value reads like Off. Run resolution refuses inherit
 * values before it reads these fields.
 */
export function legacyValuesFromAssistantRows(rows: AssistantRows): AssistantLegacyRowValues {
  const model = rows.model.value;
  const search = rows.search.value;
  const tools = rows.tools.value;
  return {
    mcpServerIds: tools.mode === "exact" ? [...tools.serverIds] : [],
    providerModelId: model.mode === "model" ? model.modelId : null,
    runControls: { ...rows.controls.value },
    searchPlan: search.mode === "inherit" || search.mode === "off"
      ? { mode: "all_selected", optionIds: [] }
      : { mode: search.mode, optionIds: [...search.optionIds] }
  };
}

/**
 * Writes draft rows to stored columns. Projection values that redact
 * resources are never storable.
 */
export function storedColumnsFromAssistantRows(rows: AssistantRows): StoredAssistantRowWrite {
  const model = rows.model.value;
  const search = rows.search.value;
  const tools = rows.tools.value;
  const skills = rows.skills.value;
  if (
    (model.mode === "model" && model.modelId === null) ||
    "hiddenCount" in search || "hiddenCount" in tools || "hiddenCount" in skills
  ) {
    throw new Error("assistant_rows_redacted");
  }
  return {
    controlsPolicy: rows.controls.policy,
    mcpMode: tools.mode,
    mcpServerIds: tools.mode === "exact" ? [...tools.serverIds] : [],
    modelPolicy: rows.model.policy,
    providerModelId: model.mode === "model" ? model.modelId : null,
    runControls: { ...rows.controls.value },
    searchPlan: search.mode === "inherit" || search.mode === "off"
      ? { mode: search.mode }
      : { mode: search.mode, optionIds: [...search.optionIds] },
    searchPolicy: rows.search.policy,
    skillLinks: skills.links.map((link) => ({
      mode: assistantSkillModeForDelivery(link.delivery),
      skillId: link.skillId
    })),
    skillsMode: skills.mode,
    skillsPolicy: rows.skills.policy,
    toolsPolicy: rows.tools.policy
  };
}
