import {
  ASSISTANT_ROW_KEYS,
  type AssistantRowKey,
  AssistantRowProvenance,
  AssistantRows,
  AssistantRunControlField,
  AssistantRunControls,
  AssistantRunRowProvenance,
  AssistantSkillLink
} from "../../contracts/assistants";
import type {
  ChatAssistantOverrides,
  ChatAssistantOverridesPatch,
  ChatAssistantOverrideValues
} from "../../contracts/chats";
import type { McpRunSelection } from "../../contracts/mcp";
import type { SearchPlan } from "../../contracts/search";
import type { SkillsMode } from "../../contracts/skills";
import {
  assistantRunControlIssue,
  materializeAssistantRunParams
} from "./runControlMaterialization";

/*
 * The priority chain of Assistant rows (PRD 5.4), as one pure decision shared
 * by run admission, the chat projection and "save chat setup". Per row, the
 * first match wins: the chat's value when the row is adjustable, the
 * Assistant's value when it is concrete and usable, the context's default for
 * inherit (`default`) or for an adjustable value the runner cannot use
 * (`fallback`), and the model's built-ins for controls only. The caller loads
 * everything; nothing here reads a database, a clock or the request.
 */

/**
 * Effective values in the vocabulary admission executes. Tools: `exact` is the
 * exact server allowlist with Load all semantics, `auto` and `load_all` are an
 * ordinary chat over the runner's own servers, `off` exposes no MCP. Search:
 * `off` resolves no source; a plan always names at least one source.
 * Knowledge: `all_my_knowledge`, `none` or an explicit selection. Skills: the
 * Assistant's links are always included; the caller adds manual pins on top.
 * Controls: a partial set over the model's built-ins. Every value is also a
 * valid `ChatAssistantRowValues` effective value of the chat projection.
 */
export type ResolvedAssistantRowValues = {
  controls: AssistantRunControls;
  knowledge: ChatAssistantOverrideValues["knowledge"];
  model: ChatAssistantOverrideValues["model"];
  search: ChatAssistantOverrideValues["search"];
  skills: { links: AssistantSkillLink[]; mode: SkillsMode };
  tools: McpRunSelection | { mode: "exact"; serverIds: string[] };
};

/**
 * What inherit means in the chat's context: the user's Chat defaults for a
 * personal chat, the Project's defaults for a Project chat. Skills have no
 * inherit, so no Skills default is needed.
 */
export type AssistantRowContextDefaults = {
  /** The context's saved control values for a model; `{}` when none are saved. */
  controlsForModel: (modelId: string) => AssistantRunControls;
  knowledge: ChatAssistantOverrideValues["knowledge"];
  /** The model a chat without a choice uses; the caller resolves it as an ordinary chat does. */
  modelId: string;
  /** A plan without sources reads as Off. */
  search: { mode: "off" } | SearchPlan;
  tools: McpRunSelection;
};

/**
 * Resources the runner may use in the chat's context. Each set needs to cover
 * only the ids the rows, overrides and request values name.
 */
export type AssistantRowAvailableResources = {
  /** False where "All my knowledge" cannot run, such as a Project chat. */
  allMyKnowledge: boolean;
  knowledgeBaseIds: ReadonlySet<string>;
  knowledgeSourceIds: ReadonlySet<string>;
  mcpServerIds: ReadonlySet<string>;
  modelIds: ReadonlySet<string>;
  searchOptionIds: ReadonlySet<string>;
  skillIds: ReadonlySet<string>;
};

export type AssistantRowResolutionInput = {
  /** The complete, unredacted definition rows; a redacted resource counts as unavailable. */
  assistant: AssistantRows;
  available: AssistantRowAvailableResources;
  defaults: AssistantRowContextDefaults;
  /** Values sent with this request, decoded into override vocabulary; a present key was sent. */
  requested: ChatAssistantOverrides;
  /** The chat's stored overrides (`Chat.assistantOverrides`); a present key means "changed for this chat". */
  stored: ChatAssistantOverrides;
};

export type ResolvedAssistantRow<Key extends AssistantRowKey> = {
  /** False when the Assistant's own concrete value names a resource the runner cannot use. */
  assistantValueAvailable: boolean;
  /** Ids of the Assistant's resources the runner cannot use; for internal use and owner projections only. */
  missingResourceIds: string[];
  provenance: AssistantRowProvenance;
  value: ResolvedAssistantRowValues[Key];
};

/** The partial control sets the controls value was layered from, lowest first. */
export type AssistantControlLayers = {
  /** The context's saved values for the effective model. */
  saved: AssistantRunControls;
  /** The Assistant's controls; null when the effective model is not the Assistant's model. */
  assistant: AssistantRunControls | null;
  /** The chat's controls; null when absent or when fixed controls ignore them. */
  chat: { origin: "request" | "stored"; value: AssistantRunControls } | null;
};

export type ResolvedAssistantRows = { [Key in Exclude<AssistantRowKey, "controls">]: ResolvedAssistantRow<Key> } & {
  controls: ResolvedAssistantRow<"controls"> & { layers: AssistantControlLayers };
};

export type AssistantRowResolution = {
  ok: true;
  /**
   * The change to apply to the stored overrides with
   * `applyChatAssistantOverridesPatch`: accepted request values to persist,
   * and null for stored overrides to clear because their row is fixed or
   * their value is no longer usable.
   */
  overridesPatch: ChatAssistantOverridesPatch;
  rows: ResolvedAssistantRows;
};

/**
 * `assistant_overrides_not_allowed`: the request carries a value for a fixed
 * row. `assistant_not_available`: a resource of a fixed row or a Skill link is
 * unavailable; `row` is for internal use, the caller decides what the viewer
 * may see. `request_value_not_available`: a request value names a resource
 * outside the available set; the caller reports it as an ordinary chat would
 * for that row. `assistant_configuration_unavailable`: a control the Assistant
 * applies is incompatible with the effective model.
 */
export type AssistantRowResolutionFailure = {
  code:
    | "assistant_configuration_unavailable"
    | "assistant_not_available"
    | "assistant_overrides_not_allowed"
    | "request_value_not_available";
  field?: AssistantRunControlField;
  ok: false;
  row: AssistantRowKey;
};

type ResourceRowKey = "knowledge" | "model" | "search" | "tools";

type Availability = { available: boolean; missing: string[] };

function missingOf(ids: readonly string[], available: ReadonlySet<string>, hiddenCount = 0): Availability {
  const missing = ids.filter((id) => !available.has(id));
  return { available: missing.length === 0 && hiddenCount === 0, missing };
}

function usable(): Availability {
  return { available: true, missing: [] };
}

/** A row with several resources is unavailable as a whole when any of them is. */
export function assistantValueAvailability(
  key: ResourceRowKey,
  rows: AssistantRows,
  available: AssistantRowAvailableResources
): Availability {
  if (key === "model") {
    const value = rows.model.value;
    if (value.mode === "inherit") return usable();
    return value.modelId === null ? { available: false, missing: [] } : missingOf([value.modelId], available.modelIds);
  }
  if (key === "search") {
    const value = rows.search.value;
    return "optionIds" in value ? missingOf(value.optionIds, available.searchOptionIds, value.hiddenCount) : usable();
  }
  if (key === "tools") {
    const value = rows.tools.value;
    return value.mode === "exact" ? missingOf(value.serverIds, available.mcpServerIds, value.hiddenCount) : usable();
  }
  const value = rows.knowledge.value;
  if (value.mode !== "explicit") return usable();
  const bases = missingOf(value.baseIds, available.knowledgeBaseIds);
  const sources = missingOf(value.sourceIds, available.knowledgeSourceIds, value.hiddenCount);
  return { available: bases.available && sources.available, missing: [...bases.missing, ...sources.missing] };
}

function overrideAvailable(
  key: ResourceRowKey,
  overrides: ChatAssistantOverrides,
  available: AssistantRowAvailableResources
): boolean {
  if (key === "model") return available.modelIds.has(overrides.model!.modelId);
  if (key === "search") {
    const value = overrides.search!;
    return !("optionIds" in value) || value.optionIds.every((id) => available.searchOptionIds.has(id));
  }
  // Chat tools use the ordinary modes over the runner's own servers.
  if (key === "tools") return true;
  const value = overrides.knowledge!;
  if (value.mode === "all_my_knowledge") return available.allMyKnowledge;
  return value.mode === "none" ||
    (value.baseIds.every((id) => available.knowledgeBaseIds.has(id)) &&
      value.sourceIds.every((id) => available.knowledgeSourceIds.has(id)));
}

function searchValue(value: AssistantRowContextDefaults["search"]): ResolvedAssistantRowValues["search"] {
  if (!("optionIds" in value) || value.optionIds.length === 0) return { mode: "off" };
  return { mode: value.mode, optionIds: [...value.optionIds] };
}

function copyOverride<Key extends ResourceRowKey>(key: Key, value: ChatAssistantOverrideValues[Key]):
  ResolvedAssistantRowValues[Key] {
  if (key === "search") return searchValue(value as ChatAssistantOverrideValues["search"]) as ResolvedAssistantRowValues[Key];
  if (key === "knowledge" && value.mode === "explicit") {
    const knowledge = value as Extract<ChatAssistantOverrideValues["knowledge"], { mode: "explicit" }>;
    return { baseIds: [...knowledge.baseIds], mode: "explicit", sourceIds: [...knowledge.sourceIds] } as
      ResolvedAssistantRowValues[Key];
  }
  return { ...value } as ResolvedAssistantRowValues[Key];
}

function defaultValue<Key extends ResourceRowKey>(key: Key, defaults: AssistantRowContextDefaults):
  ResolvedAssistantRowValues[Key] {
  const value: ResolvedAssistantRowValues[ResourceRowKey] =
    key === "model" ? { mode: "model", modelId: defaults.modelId }
      : key === "search" ? searchValue(defaults.search)
        : key === "tools" ? { mode: defaults.tools.mode }
          : copyOverride("knowledge", defaults.knowledge);
  return value as ResolvedAssistantRowValues[Key];
}

/** The Assistant's concrete value in effective vocabulary; only called when it is usable. */
function assistantValue<Key extends ResourceRowKey>(key: Key, rows: AssistantRows): ResolvedAssistantRowValues[Key] {
  let value: ResolvedAssistantRowValues[ResourceRowKey];
  if (key === "model") {
    value = { mode: "model", modelId: (rows.model.value as { modelId: string }).modelId };
  } else if (key === "search") {
    value = searchValue(rows.search.value as ChatAssistantOverrideValues["search"]);
  } else if (key === "tools") {
    const tools = rows.tools.value;
    value = tools.mode === "exact" ? { mode: "exact", serverIds: [...tools.serverIds] } : { mode: "off" };
  } else {
    const knowledge = rows.knowledge.value;
    value = knowledge.mode === "explicit"
      ? { baseIds: [...knowledge.baseIds], mode: "explicit", sourceIds: [...knowledge.sourceIds] }
      : { mode: "none" };
  }
  return value as ResolvedAssistantRowValues[Key];
}

type RowOutcome<Key extends AssistantRowKey> =
  | { ok: true; row: ResolvedAssistantRow<Key> }
  | AssistantRowResolutionFailure;

function resolveResourceRow<Key extends ResourceRowKey>(
  key: Key,
  input: AssistantRowResolutionInput,
  patch: ChatAssistantOverridesPatch
): RowOutcome<Key> {
  const { assistant, available, defaults, requested, stored } = input;
  const row = assistant[key];
  const own = assistantValueAvailability(key, assistant, available);
  const resolved = (provenance: AssistantRowProvenance, value: ResolvedAssistantRowValues[Key]): RowOutcome<Key> => ({
    ok: true,
    row: { assistantValueAvailable: own.available, missingResourceIds: own.missing, provenance, value }
  });

  if (row.policy === "fixed") {
    if (requested[key] !== undefined) return { code: "assistant_overrides_not_allowed", ok: false, row: key };
    // The author may have fixed the row after the chat changed it.
    if (stored[key] !== undefined) patch[key] = null;
  } else if (requested[key] !== undefined) {
    if (!overrideAvailable(key, requested, available)) {
      return { code: "request_value_not_available", ok: false, row: key };
    }
    (patch as Record<string, unknown>)[key] = requested[key];
    return resolved("chat", copyOverride(key, requested[key] as ChatAssistantOverrideValues[Key]));
  } else if (stored[key] !== undefined) {
    if (overrideAvailable(key, stored, available)) {
      return resolved("chat", copyOverride(key, stored[key] as ChatAssistantOverrideValues[Key]));
    }
    patch[key] = null;
  }

  if (row.value.mode === "inherit") return resolved("default", defaultValue(key, defaults));
  if (own.available) return resolved("assistant", assistantValue(key, assistant));
  if (row.policy === "fixed") return { code: "assistant_not_available", ok: false, row: key };
  return resolved("fallback", defaultValue(key, defaults));
}

function resolveSkillsRow(
  input: AssistantRowResolutionInput,
  patch: ChatAssistantOverridesPatch
): RowOutcome<"skills"> {
  const { assistant, available, requested, stored } = input;
  const row = assistant.skills;
  const own = missingOf(row.value.links.map((link) => link.skillId), available.skillIds, row.value.hiddenCount);
  let mode = row.value.mode;
  let provenance: AssistantRowProvenance = "assistant";
  if (row.policy === "fixed") {
    if (requested.skills !== undefined) return { code: "assistant_overrides_not_allowed", ok: false, row: "skills" };
    if (stored.skills !== undefined) patch.skills = null;
  } else if (requested.skills !== undefined) {
    patch.skills = requested.skills;
    mode = requested.skills.mode;
    provenance = "chat";
  } else if (stored.skills !== undefined) {
    mode = stored.skills.mode;
    provenance = "chat";
  }
  // Every link is required whatever the policy (Skills v2 5.2).
  if (!own.available) return { code: "assistant_not_available", ok: false, row: "skills" };
  return {
    ok: true,
    row: {
      assistantValueAvailable: true,
      missingResourceIds: [],
      provenance,
      value: { links: row.value.links.map((link) => ({ ...link })), mode }
    }
  };
}

function layeredControls(layers: AssistantControlLayers): AssistantRunControls {
  return { ...layers.saved, ...layers.assistant, ...layers.chat?.value };
}

/** Empty Assistant controls ask the next level, like inherit does for the other rows. */
function controlsProvenance(layers: AssistantControlLayers): AssistantRowProvenance {
  if (layers.chat) return "chat";
  return layers.assistant && Object.keys(layers.assistant).length > 0 ? "assistant" : "default";
}

function controlsRow(layers: AssistantControlLayers): ResolvedAssistantRows["controls"] {
  return {
    assistantValueAvailable: true,
    layers,
    missingResourceIds: [],
    provenance: controlsProvenance(layers),
    value: layeredControls(layers)
  };
}

/**
 * The Assistant's controls belong to the Assistant's model: its concrete
 * model, or the context's default model when the model row inherits. When the
 * user runs another model they do not apply and the row is editable whatever
 * its policy; fixed controls that apply ignore chat values.
 */
function resolveControlsRow(
  input: AssistantRowResolutionInput,
  model: ResolvedAssistantRow<"model">,
  patch: ChatAssistantOverridesPatch
): RowOutcome<"controls"> {
  const { assistant, defaults, requested, stored } = input;
  const assistantModelId = assistant.model.value.mode === "model" ? assistant.model.value.modelId : defaults.modelId;
  const applies = model.provenance !== "fallback" && model.value.modelId === assistantModelId;
  const editable = !applies || assistant.controls.policy === "adjustable";
  let chat: AssistantControlLayers["chat"] = null;
  if (!editable) {
    if (requested.controls !== undefined) {
      return { code: "assistant_overrides_not_allowed", ok: false, row: "controls" };
    }
    if (stored.controls !== undefined) patch.controls = null;
  } else if (requested.controls !== undefined) {
    patch.controls = requested.controls;
    chat = { origin: "request", value: { ...requested.controls } };
  } else if (stored.controls !== undefined) {
    chat = { origin: "stored", value: { ...stored.controls } };
  }
  return {
    ok: true,
    row: controlsRow({
      assistant: applies ? { ...assistant.controls.value } : null,
      chat,
      saved: { ...defaults.controlsForModel(model.value.modelId) }
    })
  };
}

const failurePriority: readonly AssistantRowResolutionFailure["code"][] = [
  "assistant_overrides_not_allowed",
  "assistant_not_available",
  "request_value_not_available"
];

/**
 * Resolves every row of a bound chat's Assistant. A request value for a fixed
 * row is reported first, then an unavailable fixed resource or Skill link,
 * then a request value outside the available set; within one kind, rows keep
 * their canonical order. Controls are materialized afterwards against the
 * effective model with `materializeAssistantRowControls`.
 */
export function resolveAssistantRows(
  input: AssistantRowResolutionInput
): AssistantRowResolution | AssistantRowResolutionFailure {
  const patch: ChatAssistantOverridesPatch = {};
  const model = resolveResourceRow("model", input, patch);
  // Fixed controls require a fixed model, so they would apply whatever made the model fail.
  const controlsWithoutModel: AssistantRowResolutionFailure | null =
    input.assistant.controls.policy === "fixed" && input.requested.controls !== undefined
      ? { code: "assistant_overrides_not_allowed", ok: false, row: "controls" }
      : null;
  const outcomes = {
    controls: model.ok ? resolveControlsRow(input, model.row, patch) : controlsWithoutModel,
    knowledge: resolveResourceRow("knowledge", input, patch),
    model,
    search: resolveResourceRow("search", input, patch),
    skills: resolveSkillsRow(input, patch),
    tools: resolveResourceRow("tools", input, patch)
  };
  const failures = Object.values(outcomes).filter(
    (outcome): outcome is AssistantRowResolutionFailure => outcome !== null && !outcome.ok
  );
  for (const code of failurePriority) {
    const failure = failures
      .filter((candidate) => candidate.code === code)
      .sort((left, right) => ASSISTANT_ROW_KEYS.indexOf(left.row) - ASSISTANT_ROW_KEYS.indexOf(right.row))[0];
    if (failure) return failure;
  }
  const rows = Object.fromEntries(
    Object.entries(outcomes).map(([key, outcome]) => [key, (outcome as { row: unknown }).row])
  ) as ResolvedAssistantRows;
  return { ok: true, overridesPatch: patch, rows };
}

/** The per-row provenance frozen with an accepted run. */
export function assistantRunRowProvenance(resolution: AssistantRowResolution): AssistantRunRowProvenance {
  const { rows } = resolution;
  return {
    controls: rows.controls.provenance,
    knowledge: rows.knowledge.provenance,
    model: rows.model.provenance,
    search: rows.search.provenance,
    skills: rows.skills.provenance,
    tools: rows.tools.provenance
  };
}

/** Removes the user's own saved fields the model no longer supports, one at a time. */
function supportedSavedControls(
  saved: AssistantRunControls,
  controls: Parameters<typeof assistantRunControlIssue>[1]
): AssistantRunControls {
  const next: AssistantRunControls = { ...saved };
  for (let issue = assistantRunControlIssue(next, controls); issue; issue = assistantRunControlIssue(next, controls)) {
    delete next[issue.control];
  }
  return next;
}

export type AssistantRowControlsMaterialization =
  | { ok: true; params: Record<string, unknown>; resolution: AssistantRowResolution }
  | AssistantRowResolutionFailure;

/**
 * Layers the resolved controls over the effective model's built-ins through
 * `materializeAssistantRunParams`: the chat's values over the Assistant's
 * over the context's saved values. A request value the model does not
 * support is rejected; a stored chat value the model does not support is
 * dropped and cleared; an Assistant control the run uses and the model does
 * not support fails closed; the user's own saved values keep only supported
 * fields. The returned resolution carries the final controls row and patch.
 */
export function materializeAssistantRowControls(
  resolution: AssistantRowResolution,
  model: Omit<Parameters<typeof materializeAssistantRunParams>[0], "runControls">
): AssistantRowControlsMaterialization {
  const { layers } = resolution.rows.controls;
  let chat = layers.chat;
  const overridesPatch = { ...resolution.overridesPatch };
  const chatIssue = chat ? assistantRunControlIssue(chat.value, model.controls) : null;
  if (chat && chatIssue) {
    if (chat.origin === "request") {
      return { code: "request_value_not_available", field: chatIssue.control, ok: false, row: "controls" };
    }
    chat = null;
    overridesPatch.controls = null;
  }
  // Only the Assistant's fields the chat does not replace reach the run.
  const assistantUsed: AssistantRunControls = { ...layers.assistant };
  for (const field of Object.keys(chat?.value ?? {}) as AssistantRunControlField[]) delete assistantUsed[field];
  const assistantIssue = assistantRunControlIssue(assistantUsed, model.controls);
  if (assistantIssue) {
    return { code: "assistant_configuration_unavailable", field: assistantIssue.control, ok: false, row: "controls" };
  }
  const finalLayers: AssistantControlLayers = {
    assistant: layers.assistant,
    chat,
    saved: supportedSavedControls(layers.saved, model.controls)
  };
  const materialized = materializeAssistantRunParams({ ...model, runControls: layeredControls(finalLayers) });
  if (!materialized.ok) return { code: "assistant_configuration_unavailable", ok: false, row: "controls" };
  return {
    ok: true,
    params: materialized.params,
    resolution: {
      ok: true,
      overridesPatch,
      rows: { ...resolution.rows, controls: controlsRow(finalLayers) }
    }
  };
}
