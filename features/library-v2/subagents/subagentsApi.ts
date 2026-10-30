import {
  SUBAGENT_DEFAULT_PATH,
  SUBAGENT_DEFAULT_UNDO_PATH,
  SUBAGENT_DEFINITIONS_PATH,
  decodeSubagentDefaultResponse,
  decodeSubagentDefaultUndoResponse,
  decodeSubagentDefinitionListResponse,
  decodeSubagentDefinitionResponse,
  subagentDefinitionPath,
  subagentDefinitionRestorePath,
  type SubagentDefaultUndoOutcome,
  type SubagentDefaultUndoRequest,
  type SubagentDefinitionDraft,
  type SubagentDefinitionField,
  type SubagentDefinitionListResponse,
  type SubagentDefinitionView
} from "@/lib/contracts/subagentDefinitions";

/**
 * The browser's calls to the owner-only custom sub-agent routes, used by
 * Studio > Sub-agents and the answer's change cards. A response that does
 * not decode fails like a server error, never as guessed state.
 */

export class SubagentApiError extends Error {
  constructor(readonly code: string | null, readonly status: number, readonly field: SubagentDefinitionField | null = null) {
    super(code ?? `subagent_http_${status}`);
    this.name = "SubagentApiError";
  }
}

const FIELDS: readonly string[] = ["name", "description", "instructions", "model", "effort", "tools"];
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function send(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : undefined });
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const field = record(body) && typeof body.field === "string" && FIELDS.includes(body.field) ? body.field as SubagentDefinitionField : null;
    throw new SubagentApiError(record(body) && typeof body.error === "string" ? body.error : null, response.status, field);
  }
  return body;
}

function definition(body: unknown): SubagentDefinitionView {
  const decoded = decodeSubagentDefinitionResponse(body);
  if (!decoded) throw new SubagentApiError(null, 200);
  return decoded.definition;
}

export async function listSubagentDefinitions(signal?: AbortSignal): Promise<SubagentDefinitionListResponse> {
  const decoded = decodeSubagentDefinitionListResponse(await send(SUBAGENT_DEFINITIONS_PATH, { signal }));
  if (!decoded) throw new SubagentApiError(null, 200);
  return decoded;
}

export async function getSubagentDefinition(id: string, signal?: AbortSignal): Promise<SubagentDefinitionView> {
  return definition(await send(subagentDefinitionPath(id), { signal }));
}

export async function createSubagentDefinition(draft: SubagentDefinitionDraft): Promise<SubagentDefinitionView> {
  return definition(await send(SUBAGENT_DEFINITIONS_PATH, { body: JSON.stringify(draft), method: "POST" }));
}

export async function updateSubagentDefinition(id: string, expectedVersion: number, draft: SubagentDefinitionDraft): Promise<SubagentDefinitionView> {
  return definition(await send(subagentDefinitionPath(id), { body: JSON.stringify({ draft, expectedVersion }), method: "PATCH" }));
}

/** Deletes it only while it is still at `expectedVersion`; otherwise `subagent_definition_conflict`. */
export async function deleteSubagentDefinition(id: string, expectedVersion: number): Promise<void> {
  await send(subagentDefinitionPath(id), { body: JSON.stringify({ expectedVersion }), method: "DELETE" });
}

/** Makes `revisionId` current again as a new revision, while it is still at `expectedVersion` (Undo of an edit). */
export async function restoreSubagentRevision(id: string, expectedVersion: number, revisionId: string): Promise<SubagentDefinitionView> {
  return definition(await send(subagentDefinitionRestorePath(id), { body: JSON.stringify({ expectedVersion, revisionId }), method: "POST" }));
}

function defaultOf(body: unknown): string | null {
  const decoded = decodeSubagentDefaultResponse(body);
  if (!decoded) throw new SubagentApiError(null, 200);
  return decoded.defaultDefinitionId;
}

/** The user's default sub-agent's id; null is the built-in one. */
export async function readSubagentDefault(signal?: AbortSignal): Promise<string | null> {
  return defaultOf(await send(SUBAGENT_DEFAULT_PATH, { signal }));
}

/** Moves the default, a null `definitionId` to the built-in sub-agent, while it is still `expected`; otherwise `subagent_default_conflict`. */
export async function setSubagentDefault(definitionId: string | null, expected: string | null): Promise<string | null> {
  return defaultOf(await send(SUBAGENT_DEFAULT_PATH, { body: JSON.stringify({ definitionId, expected }), method: "PUT" }));
}

/** Undo of a card's change that moved the default, its definition change included, as one. */
export async function undoSubagentDefaultChange(undo: SubagentDefaultUndoRequest): Promise<SubagentDefaultUndoOutcome> {
  const decoded = decodeSubagentDefaultUndoResponse(await send(SUBAGENT_DEFAULT_UNDO_PATH, { body: JSON.stringify(undo), method: "POST" }));
  if (!decoded) throw new SubagentApiError(null, 200);
  return decoded.outcome;
}

/** The user's words for a route's refusal. */
export function subagentErrorMessage(failure: unknown): string {
  const code = failure instanceof SubagentApiError ? failure.code : null;
  switch (code) {
    case "subagent_definition_exists": return "You already have a sub-agent with this name. Choose another name.";
    case "subagent_definition_conflict": return "This sub-agent changed in another tab or chat. Reload it, then make your change again.";
    case "subagent_default_conflict": return "Your default sub-agent changed in another tab or chat. Check the list below, then try again.";
    case "subagent_definition_limit": return "You have reached the limit of custom sub-agents. Delete one first.";
    case "subagent_not_found": return "This sub-agent no longer exists.";
    case "subagent_name_invalid": return "Use lowercase letters a–z, digits, hyphens and underscores for the name, starting and ending with a letter or digit. “main” and “built-in” are reserved.";
    case "subagent_model_unavailable": return "That model is not available to you. Choose another model.";
    case "subagent_effort_unsupported": return "That model does not support this reasoning effort.";
    case "subagent_definition_invalid": return "Fill in the description and instructions.";
    case "subagent_catalog_unavailable": return "Your models could not be loaded right now. Try again.";
    default: return "The sub-agent could not be saved. Try again.";
  }
}
