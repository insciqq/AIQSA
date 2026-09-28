import {
  ASSISTANT_MAX_MCP_SERVERS,
  ASSISTANT_MAX_STARTER_PROMPTS,
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_ROW_KEYS,
  ASSISTANT_STARTER_PROMPT_MAX_LENGTH,
  type AssistantAccessScope,
  type AssistantAvailability,
  type AssistantAvatarRecipe,
  type AssistantCategory,
  type AssistantContent,
  type AssistantDetail,
  type AssistantDraft,
  type AssistantOwnerAudience,
  type AssistantPublishableGroup,
  type AssistantRowAvailability,
  type AssistantRowKey,
  type AssistantRowPolicy,
  type AssistantRows,
  type AssistantRowValues,
  type AssistantRunControlField,
  type AssistantRunControls,
  type AssistantSkillLink,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import type { AssistantListingStatus } from "@/lib/contracts/assistantListing";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import { KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES } from "@/lib/contracts/knowledge";
import type { McpReadiness } from "@/lib/contracts/mcp";
import { SKILL_ASSISTANT_MAX_AVAILABLE, SKILL_MAX_PINNED } from "@/lib/contracts/skills";
import { MAX_SEARCH_PLAN_OPTIONS, type SearchPlanMode } from "@/lib/domain/search";

export type LibraryNotice = {
  kind: "error" | "success";
  text: string;
};

/*
 * Rows draft. Every row has a value and a policy, and inherit stays
 * expressible. Run controls are kept exactly as edited (numbers as strings,
 * null or "" for the model default); save converts them to the bounded wire
 * values.
 */
export type AssistantControlsDraft = {
  backgroundMode: boolean | null;
  maxOutputTokens: string;
  reasoningEffort: string;
  reasoningMode: string;
  streamMode: boolean | null;
  temperature: string;
};

export type AssistantDraftRowValues = Omit<AssistantRowValues, "controls"> & {
  controls: AssistantControlsDraft;
};

export type AssistantDraftRow<Key extends AssistantRowKey> = {
  policy: AssistantRowPolicy;
  value: AssistantDraftRowValues[Key];
};

export type AssistantDraftRows = { [Key in AssistantRowKey]: AssistantDraftRow<Key> };

export type AssistantEditorDraft = {
  /** Null keeps the platform answer rules. */
  answerRules: string | null;
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  name: string;
  responseReminder: string;
  rows: AssistantDraftRows;
  starterPrompts: string[];
  systemPrompt: string;
};

/** Identity and instruction fields; rows change through `onRowChange`. */
export type AssistantEditorDraftUpdate = Partial<Omit<AssistantEditorDraft, "rows">>;

/** What a template may prefill: identity, instructions and starters only. */
export type AssistantTemplatePrefill = Partial<Pick<
  AssistantEditorDraft,
  "answerRules" | "category" | "description" | "name" | "responseReminder" | "starterPrompts" | "systemPrompt"
>>;

export type AssistantEditorPrefill = AssistantEditorDraftUpdate & {
  rows?: Partial<AssistantDraftRows>;
};

export const EMPTY_ASSISTANT_CONTROLS_DRAFT: Readonly<AssistantControlsDraft> = Object.freeze({
  backgroundMode: null,
  maxOutputTokens: "",
  reasoningEffort: "",
  reasoningMode: "",
  streamMode: null,
  temperature: ""
});

/**
 * PRD 5.3 defaults of a new Assistant: a persona over the user's own setup.
 * Every row is adjustable; Knowledge starts as None and Skills as Auto
 * without links.
 */
export function defaultAssistantDraftRows(): AssistantDraftRows {
  return {
    controls: { policy: "adjustable", value: { ...EMPTY_ASSISTANT_CONTROLS_DRAFT } },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  };
}

export function controlsDraftFromRunControls(controls: AssistantRunControls): AssistantControlsDraft {
  return {
    backgroundMode: controls.backgroundMode ?? null,
    maxOutputTokens: controls.maxOutputTokens !== undefined ? String(controls.maxOutputTokens) : "",
    reasoningEffort: controls.reasoningEffort ?? "",
    reasoningMode: controls.reasoningMode ?? "",
    streamMode: controls.streamMode ?? null,
    temperature: controls.temperature !== undefined ? String(controls.temperature) : ""
  };
}

export function controlsDraftIsEmpty(controls: AssistantControlsDraft): boolean {
  return controls.backgroundMode === null && controls.streamMode === null &&
    !controls.maxOutputTokens.trim() && !controls.temperature.trim() &&
    !controls.reasoningEffort && !controls.reasoningMode;
}

/** Drops projection-only `hiddenCount`; an owner draft never carries it. */
function draftRowValue<Key extends AssistantRowKey>(
  key: Key,
  value: AssistantRowValues[Key]
): AssistantDraftRowValues[Key] {
  if (key === "controls") {
    return controlsDraftFromRunControls(value as AssistantRunControls) as AssistantDraftRowValues[Key];
  }
  const copy = structuredClone(value) as Record<string, unknown>;
  delete copy.hiddenCount;
  return copy as AssistantDraftRowValues[Key];
}

export function draftRowsFromRows(rows: AssistantRows): AssistantDraftRows {
  return Object.fromEntries(ASSISTANT_ROW_KEYS.map((key) => [
    key,
    { policy: rows[key].policy, value: draftRowValue(key, rows[key].value) }
  ])) as AssistantDraftRows;
}

export function editorDraftFromContent(content: AssistantContent): AssistantEditorDraft {
  return {
    answerRules: content.answerRules,
    avatar: content.avatar,
    category: content.category,
    description: content.description,
    name: content.name,
    responseReminder: content.responseReminder ?? "",
    rows: draftRowsFromRows(content.rows),
    starterPrompts: [...content.starterPrompts],
    systemPrompt: content.systemPrompt
  };
}

/** The concrete model of a row, or null for inherit or a model outside the catalog. */
export function draftModelId(rows: Pick<AssistantDraftRows, "model">): string | null {
  const value = rows.model.value;
  return value.mode === "model" ? value.modelId : null;
}

export type AssistantControlsReconciliation = {
  controls: AssistantControlsDraft;
  resetFields: AssistantRunControlField[];
};

/**
 * Drops overrides the newly selected model cannot execute. Values are never
 * clamped or replaced with a different explicit value; callers must present
 * `resetFields` so the reset is visible to the user. Without a model (inherit)
 * no parameter can be kept.
 */
export function reconcileControlsForModel(
  current: AssistantControlsDraft,
  controls: ModelParameterControls | null
): AssistantControlsReconciliation {
  const draft = { ...current };
  const resetFields: AssistantRunControlField[] = [];
  const reset = <Field extends AssistantRunControlField>(
    field: Field,
    value: AssistantControlsDraft[Field]
  ) => {
    if (draft[field] === value) return;
    (draft[field] as AssistantControlsDraft[Field]) = value;
    resetFields.push(field);
  };

  if (draft.backgroundMode !== null && (!controls || !controls.background.supported)) {
    reset("backgroundMode", null);
  }
  if (draft.streamMode !== null && (!controls || !controls.stream.supported)) {
    reset("streamMode", null);
  }
  if (
    draft.maxOutputTokens.trim() &&
    (!controls ||
      !Number.isInteger(Number(draft.maxOutputTokens)) ||
      Number(draft.maxOutputTokens) < 1 ||
      Number(draft.maxOutputTokens) > (controls.maxOutputTokens.maxValue ?? Number.MAX_SAFE_INTEGER))
  ) {
    reset("maxOutputTokens", "");
  }
  if (
    draft.temperature.trim() &&
    (!controls ||
      !controls.temperature.supported ||
      !Number.isFinite(Number(draft.temperature)) ||
      Number(draft.temperature) < controls.temperature.minValue ||
      Number(draft.temperature) > controls.temperature.maxValue)
  ) {
    reset("temperature", "");
  }
  if (
    draft.reasoningEffort &&
    (!controls ||
      !controls.reasoningEffort.supported ||
      !controls.reasoningEffort.options.includes(draft.reasoningEffort))
  ) {
    reset("reasoningEffort", "");
  }
  if (
    draft.reasoningMode &&
    (!controls?.reasoningMode?.supported ||
      !controls.reasoningMode.options.includes(draft.reasoningMode))
  ) {
    reset("reasoningMode", "");
  }

  return { controls: draft, resetFields };
}

/** Field errors of identity inputs and run-control fields. */
export type AssistantEditorField = AssistantRunControlField | "name" | "starterPrompts";

export type AssistantEditorErrors = {
  fields: Partial<Record<AssistantEditorField, string>>;
  /** One message per row; a run-control field error also names the controls row. */
  rows: Partial<Record<AssistantRowKey, string>>;
};

export function assistantEditorErrorsEmpty(errors: AssistantEditorErrors | null): boolean {
  return !errors || (Object.keys(errors.fields).length === 0 && Object.keys(errors.rows).length === 0);
}

/**
 * Mirrors `assistantRowPolicyViolation` of the contract: a fixed row needs a
 * concrete value (off and none are concrete); fixed controls need at least
 * one field and a fixed model.
 */
export function assistantDraftPolicyErrors(
  rows: AssistantDraftRows
): Partial<Record<AssistantRowKey, string>> {
  const errors: Partial<Record<AssistantRowKey, string>> = {};
  for (const key of ["model", "search", "tools", "knowledge"] as const) {
    if (rows[key].policy === "fixed" && rows[key].value.mode === "inherit") {
      errors[key] = "Choose a value to fix, or make this row Adjustable.";
    }
  }
  if (rows.controls.policy === "fixed") {
    if (controlsDraftIsEmpty(rows.controls.value)) {
      errors.controls = "Set at least one parameter to fix, or make this row Adjustable.";
    } else if (rows.model.policy !== "fixed") {
      errors.controls = "Fix the model before fixing its parameters.";
    }
  }
  return errors;
}

function invalidRunControlMessage(
  field: AssistantRunControlField,
  controls: ModelParameterControls
): string {
  switch (field) {
    case "backgroundMode":
      return "This model does not support Background mode.";
    case "maxOutputTokens":
      return controls.maxOutputTokens.maxValue === undefined ? "Enter a positive whole number." : `Enter a whole number from 1 to ${controls.maxOutputTokens.maxValue}.`;
    case "reasoningEffort":
      return "Choose a reasoning effort offered by this model.";
    case "reasoningMode":
      return "Choose a reasoning mode offered by this model.";
    case "streamMode":
      return "This model does not support Stream mode.";
    case "temperature":
      return controls.temperature.supported
        ? `Enter a temperature from ${controls.temperature.minValue} to ${controls.temperature.maxValue}.`
        : "This model does not support Temperature.";
  }
}

/** Converts edited parameters to wire values against the Assistant's model. */
export function runControlsFromDraft(
  state: AssistantControlsDraft,
  modelControls: ModelParameterControls
): { controls: AssistantRunControls } | { fieldErrors: Partial<Record<AssistantRunControlField, string>> } {
  const fieldErrors: Partial<Record<AssistantRunControlField, string>> = {};
  const runControls: AssistantRunControls = {};

  if (state.backgroundMode !== null) {
    if (modelControls.background.supported) runControls.backgroundMode = state.backgroundMode;
    else fieldErrors.backgroundMode = invalidRunControlMessage("backgroundMode", modelControls);
  }
  if (state.streamMode !== null) {
    if (modelControls.stream.supported) runControls.streamMode = state.streamMode;
    else fieldErrors.streamMode = invalidRunControlMessage("streamMode", modelControls);
  }
  if (state.reasoningEffort) {
    if (
      modelControls.reasoningEffort.supported &&
      modelControls.reasoningEffort.options.includes(state.reasoningEffort)
    ) {
      runControls.reasoningEffort = state.reasoningEffort;
    } else {
      fieldErrors.reasoningEffort = invalidRunControlMessage("reasoningEffort", modelControls);
    }
  }
  if (state.reasoningMode) {
    if (
      modelControls.reasoningMode?.supported === true &&
      modelControls.reasoningMode.options.includes(state.reasoningMode)
    ) {
      runControls.reasoningMode = state.reasoningMode;
    } else {
      fieldErrors.reasoningMode = invalidRunControlMessage("reasoningMode", modelControls);
    }
  }
  if (state.maxOutputTokens.trim()) {
    const maxOutputTokens = Number(state.maxOutputTokens);
    if (
      Number.isInteger(maxOutputTokens) &&
      maxOutputTokens >= 1 &&
      maxOutputTokens <= (modelControls.maxOutputTokens.maxValue ?? Number.MAX_SAFE_INTEGER)
    ) {
      runControls.maxOutputTokens = maxOutputTokens;
    } else {
      fieldErrors.maxOutputTokens = invalidRunControlMessage("maxOutputTokens", modelControls);
    }
  }
  if (state.temperature.trim()) {
    const temperature = Number(state.temperature);
    if (
      modelControls.temperature.supported &&
      Number.isFinite(temperature) &&
      temperature >= modelControls.temperature.minValue &&
      temperature <= modelControls.temperature.maxValue
    ) {
      runControls.temperature = temperature;
    } else {
      fieldErrors.temperature = invalidRunControlMessage("temperature", modelControls);
    }
  }
  return Object.keys(fieldErrors).length > 0 ? { fieldErrors } : { controls: runControls };
}

/** What the owner's catalog says about the draft's concrete values. */
export type AssistantDraftValidationContext = {
  /** The model's controls and tool support, or null when it is not in the catalog. */
  model: { controls: ModelParameterControls; toolCalling: boolean } | null;
  /** The owner's MCP servers; a disabled or missing server cannot be saved. */
  mcpServers: readonly { enabled: boolean; id: string }[];
};

export type AssistantDraftResult =
  | { draft: AssistantDraft }
  | { errors: AssistantEditorErrors };

export const ASSISTANT_SKILL_LIMIT_MESSAGE =
  `Choose up to ${SKILL_MAX_PINNED} Always and ${SKILL_ASSISTANT_MAX_AVAILABLE} On demand Skills. Change delivery or remove a Skill before saving.`;

/**
 * The name field's error for a name the server rejects: blank, or longer
 * than the limit once trimmed. The editor shows it for the client check and
 * for the server's answer alike.
 */
export function assistantNameErrorText(name: string): string {
  return name.trim() ? `Use up to ${ASSISTANT_NAME_MAX_LENGTH} characters.` : "Enter a name.";
}

/**
 * Client validation of a rows draft before create or update. Errors are keyed
 * by field and by row. A not-ready MCP server does not block saving (D-11);
 * a disabled or unavailable one does, as on the server.
 */
export function assistantDraftFromEditor(
  state: AssistantEditorDraft,
  context: AssistantDraftValidationContext
): AssistantDraftResult {
  const errors: AssistantEditorErrors = { fields: {}, rows: assistantDraftPolicyErrors(state.rows) };
  const name = state.name.trim();
  if (!name || name.length > ASSISTANT_NAME_MAX_LENGTH) errors.fields.name = assistantNameErrorText(name);
  const starterPrompts = state.starterPrompts
    .map((starter) => starter.trim())
    .filter((starter) => starter.length > 0);
  if (
    starterPrompts.length > ASSISTANT_MAX_STARTER_PROMPTS ||
    starterPrompts.some((starter) => starter.length > ASSISTANT_STARTER_PROMPT_MAX_LENGTH)
  ) {
    errors.fields.starterPrompts =
      `Keep up to ${ASSISTANT_MAX_STARTER_PROMPTS} starters of up to ${ASSISTANT_STARTER_PROMPT_MAX_LENGTH} characters.`;
  }

  const rows = state.rows;
  const model = rows.model.value;
  if (model.mode === "model" && (model.modelId === null || !context.model)) {
    errors.rows.model ??= "Choose a model from your catalog.";
  }

  let controls: AssistantRunControls = {};
  if (!controlsDraftIsEmpty(rows.controls.value)) {
    if (model.mode === "inherit") {
      errors.rows.controls ??= "Choose a model to set its parameters.";
    } else if (context.model) {
      const converted = runControlsFromDraft(rows.controls.value, context.model.controls);
      if ("fieldErrors" in converted) {
        Object.assign(errors.fields, converted.fieldErrors);
        errors.rows.controls ??= Object.values(converted.fieldErrors)[0];
      } else {
        controls = converted.controls;
      }
    }
  }

  const search = rows.search.value;
  if (search.mode !== "inherit" && search.mode !== "off") {
    if (search.optionIds.length === 0) {
      errors.rows.search ??= "Choose at least one Search source, or turn Web search off.";
    } else if (search.optionIds.length > MAX_SEARCH_PLAN_OPTIONS) {
      errors.rows.search ??= `Choose up to ${MAX_SEARCH_PLAN_OPTIONS} Search sources.`;
    }
  }

  const tools = rows.tools.value;
  if (tools.mode === "exact") {
    const servers = new Map(context.mcpServers.map((server) => [server.id, server]));
    if (tools.serverIds.length === 0) {
      errors.rows.tools ??= "Choose at least one MCP server, or turn Tools off.";
    } else if (tools.serverIds.length > ASSISTANT_MAX_MCP_SERVERS) {
      errors.rows.tools ??= `Choose up to ${ASSISTANT_MAX_MCP_SERVERS} MCP servers.`;
    } else if (model.mode === "model" && context.model && !context.model.toolCalling) {
      errors.rows.tools ??= "Choose a model that can call tools, or remove the MCP tools.";
    } else if (tools.serverIds.some((id) => !servers.get(id)?.enabled)) {
      errors.rows.tools ??= "Remove MCP servers that are disabled or unavailable before saving.";
    }
  }

  const knowledge = rows.knowledge.value;
  if (knowledge.mode === "explicit") {
    const count = knowledge.baseIds.length + knowledge.sourceIds.length;
    if (count === 0) {
      errors.rows.knowledge ??= "Choose at least one base or document, or choose None.";
    } else if (count > KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES) {
      errors.rows.knowledge ??= `Choose up to ${KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES} bases and documents.`;
    }
  }

  const links = rows.skills.value.links;
  if (
    links.filter((link) => link.delivery === "always").length > SKILL_MAX_PINNED ||
    links.filter((link) => link.delivery === "on_demand").length > SKILL_ASSISTANT_MAX_AVAILABLE
  ) {
    errors.rows.skills ??= ASSISTANT_SKILL_LIMIT_MESSAGE;
  }

  if (!assistantEditorErrorsEmpty(errors)) return { errors };

  return {
    draft: {
      answerRules: state.answerRules,
      avatar: state.avatar,
      category: state.category,
      description: state.description.trim(),
      name,
      responseReminder: state.responseReminder,
      rows: {
        controls: { policy: rows.controls.policy, value: controls },
        knowledge: { policy: rows.knowledge.policy, value: structuredClone(knowledge) },
        model: { policy: rows.model.policy, value: structuredClone(model) },
        search: { policy: rows.search.policy, value: structuredClone(search) },
        skills: {
          policy: rows.skills.policy,
          value: { links: links.map((link) => ({ ...link })), mode: rows.skills.value.mode }
        },
        tools: { policy: rows.tools.policy, value: structuredClone(tools) }
      },
      starterPrompts,
      systemPrompt: state.systemPrompt
    }
  };
}

/** Composer values "From current chat" carries, in composer vocabulary. */
export type AssistantChatSetup = {
  backgroundMode: boolean;
  knowledge:
    | { baseIds: readonly string[]; mode: "explicit"; sourceIds: readonly string[] }
    | { mode: "all" | "inherit" | "none" };
  maxOutputTokens: string;
  mcp:
    | { mode: "auto" | "off" }
    | { mode: "exact"; serverIds: readonly string[] }
    | { mode: "load_all"; enabledServerIds: readonly string[] | null };
  modelId: string | null;
  reasoningEffort: string;
  reasoningMode: string;
  search: { mode: SearchPlanMode; optionIds: readonly string[] };
  skills: { links: readonly AssistantSkillLink[]; mode: "auto" | "off" };
  streamMode: boolean;
  temperature: string;
};

/**
 * "From current chat" carries the chat's model, parameters, search,
 * Tools, Knowledge (bases and documents) and Skills as adjustable rows.
 * Values rows cannot express become inherit: MCP Auto, all Knowledge, and
 * Load all when the user's servers are not known or exceed the row limit.
 */
export function draftRowsFromChatSetup(setup: AssistantChatSetup): AssistantDraftRows {
  const rows = defaultAssistantDraftRows();
  if (setup.modelId) rows.model.value = { mode: "model", modelId: setup.modelId };
  rows.controls.value = {
    backgroundMode: setup.backgroundMode,
    maxOutputTokens: setup.maxOutputTokens,
    reasoningEffort: setup.reasoningEffort,
    reasoningMode: setup.reasoningMode,
    streamMode: setup.streamMode,
    temperature: setup.temperature
  };
  const searchIds = setup.search.optionIds.slice(0, MAX_SEARCH_PLAN_OPTIONS);
  rows.search.value = searchIds.length > 0
    ? { mode: setup.search.mode, optionIds: [...searchIds] }
    : { mode: "off" };
  const mcp = setup.mcp;
  const serverIds = mcp.mode === "exact" ? mcp.serverIds : mcp.mode === "load_all" ? mcp.enabledServerIds : null;
  rows.tools.value = mcp.mode === "off"
    ? { mode: "off" }
    : serverIds && serverIds.length > 0 && serverIds.length <= ASSISTANT_MAX_MCP_SERVERS
      ? { mode: "exact", serverIds: [...serverIds] }
      : { mode: "inherit" };
  const knowledge = setup.knowledge;
  rows.knowledge.value = knowledge.mode === "explicit" &&
    knowledge.baseIds.length + knowledge.sourceIds.length > 0 &&
    knowledge.baseIds.length + knowledge.sourceIds.length <= KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES
    ? { baseIds: [...knowledge.baseIds], mode: "explicit", sourceIds: [...knowledge.sourceIds] }
    : knowledge.mode === "none" ? { mode: "none" } : { mode: "inherit" };
  rows.skills.value = { links: setup.skills.links.map((link) => ({ ...link })), mode: setup.skills.mode };
  return rows;
}

export type AssistantEditorModelOption = {
  capabilities: {
    documentInputMode: "native_pdf" | "none" | "pdf_text_extraction";
    imageInput: boolean;
    reasoning: boolean;
    toolCalling: boolean;
  };
  controls: ModelParameterControls;
  id: string;
  label: string;
  providerFamily?: string;
  providerLabel: string;
  supportsTools: boolean;
};

export type AssistantEditorOptions = {
  knowledgeBases: { available: boolean; id: string; name: string }[];
  knowledgeSources: { available: boolean; id: string; name: string }[];
  knowledgeDataError: string | null;
  knowledgeDataState: "error" | "loading" | "ready";
  mcpServers: { enabled: boolean; id: string; name: string; readiness: McpReadiness }[];
  models: AssistantEditorModelOption[];
  onRetryKnowledge(): void;
  searchOptions: { id: string; label: string }[];
  /** Names of the linked Skills, in link order, including off-page and unavailable ones. */
  selectedSkills: { id: string; name: string; available?: boolean }[];
};

/** A version conflict keeps the draft; the latest saved version is shown beside it. */
export type AssistantEditorConflict = {
  /** Null while the latest version loads or when it could not be read. */
  latest: { draft: AssistantEditorDraft; version: number } | null;
  loading: boolean;
};

export type AssistantEditorView = {
  assistantId: string | null;
  archived: boolean;
  /** The owner's audience from the list, so the Sharing card reads as the gallery card. */
  audience: AssistantOwnerAudience | null;
  availability: AssistantAvailability | null;
  conflict: AssistantEditorConflict | null;
  dirty: boolean;
  draft: AssistantEditorDraft;
  /** Stable error code and copy of the failed save, if any. */
  error: { code: string; text: string } | null;
  errors: AssistantEditorErrors | null;
  /** A row the editor opens expanded, such as Knowledge for a template that needs it. */
  initialExpandedRow: AssistantRowKey | null;
  /** True only immediately after an atomic create, for the created banner. */
  justCreated: boolean;
  mode: "create" | "edit";
  onCancel(): void;
  onChange(update: AssistantEditorDraftUpdate): void;
  onGenerateAvatar(): void;
  /** Keeps the draft and saves it over the latest version on the next save. */
  onKeepDraftOverLatest(): void;
  onOpenMcpSettings(): void;
  /** Null while creating: the Sharing card reads "Save first". */
  onOpenSharing: (() => void) | null;
  onReloadLatest(): void;
  onReplaceDraftWithLatest(): void;
  onRowChange<Key extends AssistantRowKey>(key: Key, update: Partial<AssistantDraftRow<Key>>): void;
  /** Resolves to the saved Assistant id, or null when nothing was saved. */
  onSave(): Promise<string | null>;
  /** Saves unsaved changes, then opens a Temporary chat with the Assistant (an ordinary one where those are off). */
  onSaveAndTry(): Promise<boolean>;
  onUseInChat: (() => void) | null;
  options: AssistantEditorOptions;
  rowAvailability: AssistantRowAvailability;
  /** The last saved name; null while creating. */
  savedName: string | null;
  saving: boolean;
  scope: AssistantAccessScope | null;
};

export type AssistantCardState =
  | { kind: "archived" }
  /** Owner: the dependencies that make it unavailable, by name when known. */
  | { count: number; kind: "attention"; names: string[] }
  | { kind: "ready" }
  /** Consumer: neutral, without dependency names. */
  | { kind: "unavailable" };

/** Counts for the capability line. */
export type AssistantCardCapabilities = {
  knowledge: number;
  search: number;
  skills: number;
  tools: number;
};

export type AssistantCardView = {
  assistant: AssistantSummary;
  capabilities: AssistantCardCapabilities;
  state: AssistantCardState;
};

export function assistantCardState(
  assistant: Pick<AssistantSummary, "archived" | "availability" | "owned">
): AssistantCardState {
  if (assistant.archived) return { kind: "archived" };
  if (assistant.availability.ok) return { kind: "ready" };
  if (!assistant.owned) return { kind: "unavailable" };
  const names = [...new Set(assistant.availability.dependencies?.map((dependency) => dependency.name) ?? [])];
  return { count: Math.max(names.length, 1), kind: "attention", names };
}

export function assistantCardView(assistant: AssistantSummary): AssistantCardView {
  return {
    assistant,
    capabilities: {
      knowledge: assistant.fingerprint.knowledgeResourceCount,
      search: assistant.fingerprint.searchOptionCount,
      skills: assistant.skillLinkCount,
      tools: assistant.fingerprint.mcpServerCount
    },
    state: assistantCardState(assistant)
  };
}

export const ASSISTANT_GALLERY_FILTERS = ["all", "pinned", "yours", "shared", "featured", "archived"] as const;
export type AssistantGalleryFilter = (typeof ASSISTANT_GALLERY_FILTERS)[number];

export type AssistantGalleryQuery = {
  category: AssistantCategory | null;
  filter: AssistantGalleryFilter;
  search: string;
};

export type AssistantGalleryGroup = {
  cards: AssistantCardView[];
  kind: "featured" | "pinned" | "rest";
};

export type AssistantGalleryResult = {
  counts: Record<AssistantGalleryFilter, number>;
  /** Grouped under All without search; one flat group otherwise. */
  groups: AssistantGalleryGroup[];
};

function matchesFilter(assistant: AssistantSummary, filter: AssistantGalleryFilter): boolean {
  if (filter === "archived") return assistant.archived;
  if (assistant.archived) return false;
  if (filter === "pinned") return assistant.pinned;
  if (filter === "yours") return assistant.owned;
  if (filter === "shared") return !assistant.owned;
  if (filter === "featured") return assistant.featured;
  return true;
}

function matchesSearch(assistant: AssistantSummary, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [assistant.name, assistant.description, assistant.ownerDisplayName]
    .some((text) => text.toLocaleLowerCase().includes(needle));
}

/**
 * Filter chips, category and client search over name, description and author.
 * All excludes archived, and every count is the length of the list its chip
 * shows under the current category and search.
 */
export function filterAssistantGallery(
  assistants: readonly AssistantSummary[],
  query: AssistantGalleryQuery
): AssistantGalleryResult {
  const visible = assistants.filter((assistant) =>
    (query.category === null || assistant.category === query.category) &&
    matchesSearch(assistant, query.search)
  );
  const counts = Object.fromEntries(ASSISTANT_GALLERY_FILTERS.map((filter) => [
    filter,
    visible.filter((assistant) => matchesFilter(assistant, filter)).length
  ])) as Record<AssistantGalleryFilter, number>;
  const listed = visible
    .filter((assistant) => matchesFilter(assistant, query.filter))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(assistantCardView);
  // Featured Assistants keep the administrator's order, wherever they are listed together.
  const byFeaturedOrder = (cards: AssistantCardView[]) =>
    cards.sort((left, right) => (left.assistant.featuredOrder ?? 0) - (right.assistant.featuredOrder ?? 0));
  if (query.filter !== "all" || query.search.trim()) {
    const cards = query.filter === "featured" ? byFeaturedOrder(listed) : listed;
    return { counts, groups: cards.length > 0 ? [{ cards, kind: "rest" }] : [] };
  }
  const featured = byFeaturedOrder(listed.filter((card) => card.assistant.featured));
  const pinned = listed.filter((card) => !card.assistant.featured && card.assistant.pinned);
  const rest = listed.filter((card) => !card.assistant.featured && !card.assistant.pinned);
  return {
    counts,
    groups: ([
      { cards: featured, kind: "featured" },
      { cards: pinned, kind: "pinned" },
      { cards: rest, kind: "rest" }
    ] as AssistantGalleryGroup[]).filter((group) => group.cards.length > 0)
  };
}

export type AssistantGalleryView = {
  assistants: AssistantSummary[];
  onArchiveToggle(assistantId: string, archived: boolean): void;
  /** Copies the Assistant's entry link; false when the clipboard refused it. */
  onCopyLink(assistantId: string): Promise<boolean>;
  /** Opens the delete dialog with the server's consequences. */
  onDelete(assistantId: string): void;
  onDuplicate(assistantId: string): void;
  onEdit(assistantId: string): void;
  onOpenDetail(assistantId: string): void;
  onPinToggle(assistantId: string, pinned: boolean): void;
  /** Opens the Sharing sheet (owner). */
  onShare(assistantId: string): void;
  /** Chooses the Assistant for a new chat and leaves Studio; false when refused. */
  onStartChat(assistantId: string): Promise<boolean>;
  recentAssistantIds: string[];
  viewer: { canPublishInstallation: boolean; defaultAssistantId: string | null };
};

/**
 * Names from the viewer's own catalogs for the Setup rows of the detail
 * sheet. Rows carry only ids the viewer can use; an id missing here is
 * counted, never named.
 */
export type AssistantResourceNames = {
  knowledgeBases: readonly { id: string; name: string }[];
  knowledgeSources: readonly { id: string; name: string }[];
  mcpServers: readonly { id: string; name: string }[];
  models: readonly { id: string; label: string }[];
  searchOptions: readonly { id: string; label: string }[];
};

export type AssistantDetailSheetView = {
  assistantId: string;
  detail: AssistantDetail | null;
  error: string | null;
  names: AssistantResourceNames;
  onClose(): void;
  onRetry(): void;
  /** `unavailable` is privacy-neutral: missing and invisible look the same. */
  state: "error" | "loading" | "ready" | "unavailable";
  /** The list entry, when listed, for an immediate header while the detail loads. */
  summary: AssistantSummary | null;
};

export type AssistantDeleteDialogView = {
  assistantId: string;
  consequences: AssistantDeletionConsequences | null;
  error: string | null;
  name: string;
  onCancel(): void;
  onConfirm(): void;
  onRetry(): void;
  state: "deleting" | "error" | "loading" | "ready";
};

export type AssistantNewAssistantView = {
  onBlank(): void;
  onClose(): void;
  onFromCurrentChat(): void;
  onOpen(): void;
  onTemplate(prefill: AssistantTemplatePrefill, options?: { expandedRow?: AssistantRowKey }): void;
  open: boolean;
};

export type AssistantSharingAudience = "everyone" | "groups" | "owner";

export type AssistantSharingDraft = {
  audience: AssistantSharingAudience;
  /** Administrators only, with Everyone. */
  featured: boolean;
  /** Position among Featured Assistants, 0 first. */
  featuredOrder: number;
  groupIds: string[];
};

export type AssistantSharingFailureTarget =
  | { groupId: string; kind: "group" }
  | { kind: "everyone" }
  | { kind: "featured" };

export type AssistantSharingFailure = {
  code: string;
  /** Names of the Skills that block this audience. */
  skills: string[];
  target: AssistantSharingFailureTarget;
  text: string;
};

export type AssistantSharingSheetView = {
  assistantId: string;
  /** Owner detail: publications, listing request, Featured position, Projects, rows. */
  detail: AssistantDetail | null;
  dirty: boolean;
  draft: AssistantSharingDraft;
  error: string | null;
  /** What the last save could not apply; applied changes stay applied. */
  failures: AssistantSharingFailure[];
  /** Featured Assistants other than this one, for the position control. */
  featuredCount: number;
  /** The owner's active groups, the publication targets. */
  groups: AssistantPublishableGroup[];
  isAdministrator: boolean;
  listing: AssistantListingStatus | null;
  /** From the detail, or the list entry while it loads; null when neither is known. */
  name: string | null;
  /** The owner's own catalogs, to name the resources people need access to. */
  names: AssistantResourceNames;
  /**
   * Choosing Everyone keeps the saved group publications, Only me clears the
   * groups; a change clears the failures of the last save.
   */
  onChange(update: Partial<AssistantSharingDraft>): void;
  /** Discards the draft. */
  onClose(): void;
  /** Copies the Assistant's entry link; false when the clipboard refused it. */
  onCopyLink(): Promise<boolean>;
  onRetry(): void;
  /** Applies every change as one user action; false when anything failed. */
  onSave(): Promise<boolean>;
  onWithdrawRequest(): void;
  saving: boolean;
  state: "error" | "loading" | "ready";
  withdrawing: boolean;
};

export type AssistantLibraryView = {
  busy: boolean;
  catalogError: string | null;
  catalogState: "error" | "loading" | "ready";
  deletion: AssistantDeleteDialogView | null;
  detail: AssistantDetailSheetView | null;
  /** Unsaved editor or Sharing changes; every exit from Studio asks first. */
  dirty: boolean;
  editor: AssistantEditorView | null;
  gallery: AssistantGalleryView;
  newAssistant: AssistantNewAssistantView;
  notice: LibraryNotice | null;
  onBackToChat(): void;
  /** Discards the unsaved editor and Sharing drafts. */
  onDiscardDrafts(): void;
  onDismissNotice(): void;
  onOpenMcpSettings(): void;
  onRetryCatalog(): void;
  sharing: AssistantSharingSheetView | null;
  /** Which Studio subview is visible; editor is non-null when active. */
  task: "editor" | "list";
};
