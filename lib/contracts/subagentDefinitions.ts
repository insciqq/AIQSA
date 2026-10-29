import {
  SUBAGENT_DEFINITION_LIMITS,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_LIMITS,
  decodeSubagentToolGroups,
  normalizeSubagentName,
  type SubagentToolGroup
} from "./subagents";

/**
 * Client-safe wire shapes of the user's custom sub-agents in Studio
 * (`features/library-v2/subagents/`) and the owner-only routes under
 * `/api/me/subagents` (`lib/server/subagents/definitionHandlers.ts`). A
 * definition is personal: only its owner lists, reads or changes it, and a
 * definition the caller cannot see answers like one that does not exist
 * (`subagent_not_found`, 404). Every edit is a new immutable revision; Undo
 * restores an earlier revision as a new one.
 */

export const SUBAGENT_DEFINITIONS_PATH = "/api/me/subagents";
export const SUBAGENTS_LIBRARY_PATH = "/?library=subagents";

export function subagentDefinitionPath(definitionId: string): string {
  return `${SUBAGENT_DEFINITIONS_PATH}/${encodeURIComponent(definitionId)}`;
}

/** Makes an earlier revision current again as a new revision (Undo of an edit). */
export function subagentDefinitionRestorePath(definitionId: string): string {
  return `${subagentDefinitionPath(definitionId)}/restore`;
}

/** Stable codes of the definition routes and tools; the bounds are `SUBAGENT_DEFINITION_LIMITS`. */
export const SUBAGENT_DEFINITION_CODES = Object.freeze({
  ...SUBAGENT_ERROR_CODES,
  /** A text field is empty, too long or not text (`field` names it). */
  definitionInvalid: "subagent_definition_invalid",
  /** The user's models could not be read now; nothing was saved. */
  catalogUnavailable: "subagent_catalog_unavailable",
  /** The revision to restore is not one of this definition's. */
  revisionUnknown: "subagent_revision_unknown"
} as const);

export type SubagentDefinitionField = "name" | "description" | "instructions" | "model" | "effort" | "tools";

/** What a user or the agent writes; null model runs on the caller's model, null effort is the model's default, null tools every sub-agent tool. */
export type SubagentDefinitionDraft = Readonly<{
  description: string;
  effort: string | null;
  instructions: string;
  /** A catalog model id (`CatalogWireModel.modelId`) of one of the user's tool-calling chat models. */
  modelId: string | null;
  name: string;
  tools: readonly SubagentToolGroup[] | null;
}>;

/** One of the user's tool-calling chat models a sub-agent may run on, with the efforts it takes. */
export type SubagentModelOption = Readonly<{
  defaultEffort: string | null;
  displayName: string;
  efforts: readonly string[];
  modelId: string;
}>;

export type SubagentDefinitionSummary = Readonly<{
  description: string;
  effort: string | null;
  id: string;
  /** Null when the model is not set (the caller's) or no longer among the user's models. */
  modelDisplayName: string | null;
  modelId: string | null;
  /** False when a set model is no longer among the user's tool-calling models: calls with this type are refused. */
  modelAvailable: boolean;
  name: string;
  revisionNumber: number;
  tools: readonly SubagentToolGroup[] | null;
  updatedAt: string;
  version: number;
}>;

export type SubagentDefinitionView = SubagentDefinitionSummary & Readonly<{
  instructions: string;
  /** The revision current before this one, which Undo of the latest edit restores; null for the first. */
  previousRevisionId: string | null;
  revisionId: string;
}>;

export type SubagentDefinitionListResponse = Readonly<{
  definitions: readonly SubagentDefinitionSummary[];
  limit: number;
  models: readonly SubagentModelOption[];
}>;

export type SubagentDefinitionResponse = Readonly<{ definition: SubagentDefinitionView }>;

export type SubagentDefinitionUpdateRequest = Readonly<{ draft: SubagentDefinitionDraft; expectedVersion: number }>;
export type SubagentDefinitionDeleteRequest = Readonly<{ expectedVersion: number }>;
export type SubagentDefinitionRestoreRequest = Readonly<{ expectedVersion: number; revisionId: string }>;

/** A refused route call: the stable code, and the field for an invalid draft. */
export type SubagentDefinitionErrorBody = Readonly<{ error: string; field?: SubagentDefinitionField }>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
const nullableText = (value: unknown, max: number): value is string | null =>
  value === null || (boundedText(value, max) && value.trim().length > 0);
const textList = (value: unknown, max: number, items: number): value is string[] =>
  Array.isArray(value) && value.length <= items && value.every((item) => boundedText(item, max) && item.length > 0);

export type SubagentDraftDecode =
  | Readonly<{ draft: SubagentDefinitionDraft; ok: true }>
  | Readonly<{ code: string; field: SubagentDefinitionField; ok: false }>;

const invalid = (field: SubagentDefinitionField, code: string = SUBAGENT_DEFINITION_CODES.definitionInvalid): SubagentDraftDecode =>
  ({ code, field, ok: false });

/**
 * A draft as Studio or the agent sends it: the name normalized (trimmed,
 * lowercased), texts trimmed and bounded, tool groups distinct and known.
 * Whether the model and effort are the user's is the server's check.
 */
export function decodeSubagentDefinitionDraft(value: unknown): SubagentDraftDecode {
  if (!record(value) || !exact(value, ["description", "effort", "instructions", "modelId", "name", "tools"])) return invalid("name");
  const name = normalizeSubagentName(value.name);
  if (!name) return invalid("name", SUBAGENT_DEFINITION_CODES.nameInvalid);
  const limits = SUBAGENT_DEFINITION_LIMITS;
  if (!boundedText(value.description, limits.descriptionCharacters * 2) || !value.description.trim() ||
    value.description.trim().length > limits.descriptionCharacters) return invalid("description");
  if (!boundedText(value.instructions, limits.instructionsCharacters * 2) || !value.instructions.trim() ||
    value.instructions.trim().length > limits.instructionsCharacters) return invalid("instructions");
  if (!nullableText(value.modelId, SUBAGENT_LIMITS.modelCharacters)) return invalid("model", SUBAGENT_DEFINITION_CODES.modelUnavailable);
  if (!nullableText(value.effort, SUBAGENT_LIMITS.effortCharacters)) return invalid("effort", SUBAGENT_DEFINITION_CODES.effortUnsupported);
  let tools: SubagentToolGroup[] | null = null;
  if (value.tools !== null) {
    tools = decodeSubagentToolGroups(value.tools);
    if (!tools) return invalid("tools");
  }
  return { draft: {
    description: value.description.trim(), effort: value.effort === null ? null : (value.effort as string).trim(),
    instructions: value.instructions.trim(), modelId: value.modelId === null ? null : (value.modelId as string).trim(), name, tools
  }, ok: true };
}

export function decodeSubagentDefinitionUpdateRequest(value: unknown): Readonly<{ draft: unknown; expectedVersion: number }> | null {
  return record(value) && exact(value, ["draft", "expectedVersion"]) && positive(value.expectedVersion)
    ? { draft: value.draft, expectedVersion: value.expectedVersion } : null;
}

export function decodeSubagentDefinitionDeleteRequest(value: unknown): SubagentDefinitionDeleteRequest | null {
  return record(value) && exact(value, ["expectedVersion"]) && positive(value.expectedVersion) ? { expectedVersion: value.expectedVersion } : null;
}

export function decodeSubagentDefinitionRestoreRequest(value: unknown): SubagentDefinitionRestoreRequest | null {
  return record(value) && exact(value, ["expectedVersion", "revisionId"]) && positive(value.expectedVersion) && id(value.revisionId)
    ? { expectedVersion: value.expectedVersion, revisionId: value.revisionId } : null;
}

function decodeTools(value: unknown): readonly SubagentToolGroup[] | null | undefined {
  if (value === null) return null;
  return decodeSubagentToolGroups(value) ?? undefined;
}

const SUMMARY_KEYS = ["description", "effort", "id", "modelAvailable", "modelDisplayName", "modelId", "name", "revisionNumber", "tools",
  "updatedAt", "version"];

function decodeSummaryFields(value: Record<string, unknown>): SubagentDefinitionSummary | null {
  const name = normalizeSubagentName(value.name);
  const tools = decodeTools(value.tools);
  if (!id(value.id) || !name || name !== value.name || !boundedText(value.description, SUBAGENT_DEFINITION_LIMITS.descriptionCharacters) ||
    !nullableText(value.effort, SUBAGENT_LIMITS.effortCharacters) || !nullableText(value.modelId, SUBAGENT_LIMITS.modelCharacters) ||
    !nullableText(value.modelDisplayName, 256) || typeof value.modelAvailable !== "boolean" || !positive(value.revisionNumber) ||
    !positive(value.version) || tools === undefined || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    return null;
  }
  return { description: value.description, effort: value.effort, id: value.id, modelAvailable: value.modelAvailable,
    modelDisplayName: value.modelDisplayName, modelId: value.modelId, name, revisionNumber: value.revisionNumber, tools,
    updatedAt: value.updatedAt, version: value.version };
}

export function decodeSubagentDefinitionSummary(value: unknown): SubagentDefinitionSummary | null {
  return record(value) && exact(value, SUMMARY_KEYS) ? decodeSummaryFields(value) : null;
}

export function decodeSubagentDefinitionView(value: unknown): SubagentDefinitionView | null {
  if (!record(value) || !exact(value, [...SUMMARY_KEYS, "instructions", "previousRevisionId", "revisionId"])) return null;
  const summary = decodeSummaryFields(value);
  if (!summary || !boundedText(value.instructions, SUBAGENT_DEFINITION_LIMITS.instructionsCharacters) || !id(value.revisionId) ||
    !(value.previousRevisionId === null || id(value.previousRevisionId))) return null;
  return { ...summary, instructions: value.instructions, previousRevisionId: value.previousRevisionId, revisionId: value.revisionId };
}

function decodeModelOption(value: unknown): SubagentModelOption | null {
  if (!record(value) || !exact(value, ["defaultEffort", "displayName", "efforts", "modelId"]) ||
    !boundedText(value.modelId, SUBAGENT_LIMITS.modelCharacters) || !value.modelId ||
    !boundedText(value.displayName, 256) || !textList(value.efforts, SUBAGENT_LIMITS.effortCharacters, 32) ||
    !nullableText(value.defaultEffort, SUBAGENT_LIMITS.effortCharacters)) return null;
  return { defaultEffort: value.defaultEffort, displayName: value.displayName, efforts: [...value.efforts], modelId: value.modelId };
}

export function decodeSubagentDefinitionListResponse(value: unknown): SubagentDefinitionListResponse | null {
  if (!record(value) || !exact(value, ["definitions", "limit", "models"]) || !positive(value.limit) ||
    !Array.isArray(value.definitions) || value.definitions.length > SUBAGENT_DEFINITION_LIMITS.perUser ||
    !Array.isArray(value.models) || value.models.length > 500) return null;
  const definitions = value.definitions.map(decodeSubagentDefinitionSummary);
  const models = value.models.map(decodeModelOption);
  if (definitions.some((entry) => entry === null) || models.some((entry) => entry === null)) return null;
  return { definitions: definitions as SubagentDefinitionSummary[], limit: value.limit, models: models as SubagentModelOption[] };
}

export function decodeSubagentDefinitionResponse(value: unknown): SubagentDefinitionResponse | null {
  if (!record(value) || !exact(value, ["definition"])) return null;
  const definition = decodeSubagentDefinitionView(value.definition);
  return definition ? { definition } : null;
}

/** The user's plain-language name of each tool group, for Studio and the change cards. */
export const SUBAGENT_TOOL_GROUP_LABELS: Readonly<Record<SubagentToolGroup, string>> = Object.freeze({
  images: "Image generation",
  mcp: "MCP tools",
  memory: "Memory search",
  secrets: "Saved secrets",
  skills: "Skills",
  vision: "Image analysis",
  web_fetch: "Reading web pages",
  web_search: "Web search",
  workspace: "Workspace and browser"
});
