import { ASSISTANT_ROW_KEYS, type AssistantRowKey } from "../../contracts/assistants";
import {
  decodeStoredChatAssistantOverrides,
  type ChatAssistantOverrides,
  type ChatAssistantOverridesPatch
} from "../../contracts/chats";
import { decodeMcpRunSelection } from "../../contracts/mcp";
import { invalidRunParamsError } from "../../domain/runParams";
import { decodeSearchPlan, type SearchPlan } from "../../domain/search";
import {
  storedOverridesInEffect,
  type AssistantRowContext,
  type AssistantRowResourceIds
} from "../assistants/rowContext";
import {
  resolveAssistantRows,
  type AssistantRowResolution,
  type AssistantRowResolutionFailure,
  type ResolvedAssistantRowValues
} from "../assistants/rowResolution";
import { runControlsFromSavedValues } from "../assistants/runControlMaterialization";
import type {
  AssistantRunMaterialization,
  AssistantRunResolution,
  AssistantRunResolver
} from "../assistants/runMaterialization";
import type { AcceptedChatAssistant } from "./runRepositoryContract";

/*
 * Assistant admission. The chat's binding names the Assistant; a request may
 * name it only to bind a chat that has none (the first message, or a composer
 * that selected an Assistant mid-chat) or when it repeats the binding. Every
 * row resolves through the priority chain against the runner's own catalog
 * and Chat defaults. Request values change adjustable rows for the chat and
 * are stored by the admission transaction.
 */

export type AssistantAdmissionFailure = Readonly<{
  code: string;
  ok: false;
  status: 400 | 403 | 404 | 409 | 503;
}>;

function rejected(code: string, status: AssistantAdmissionFailure["status"]): AssistantAdmissionFailure {
  return { code, ok: false, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ChatAssistantSource = Readonly<{
  /** Null for an ordinary chat. */
  assistantId: string | null;
  /** The chat has no binding yet; admission binds it to `assistantId`. */
  bind: boolean;
  ok: true;
}>;

/**
 * The Assistant a chat runs with. A chat whose Assistant was deleted answers
 * the neutral unavailability instead of silently running without it; the
 * user continues by clearing the binding. `assistantId` null names none, as
 * in the chat update contract.
 */
export function chatAssistantSource(
  body: Readonly<Record<string, unknown>> | null,
  chat: Readonly<{ assistantId?: string | null; assistantOverrides?: unknown }>
): ChatAssistantSource | AssistantAdmissionFailure {
  const deleted = decodeStoredChatAssistantOverrides(chat.assistantOverrides)?.kind === "deleted";
  const bound = chat.assistantId ?? null;
  const requested = body?.assistantId;
  if (requested === undefined || requested === null) {
    if (deleted) return rejected("assistant_not_available", 409);
    return { assistantId: bound, bind: false, ok: true };
  }
  if (typeof requested !== "string" || !requested.trim() || requested.length > 64) {
    return rejected("assistant_not_available", 404);
  }
  const assistantId = requested.trim();
  if (deleted) return rejected("assistant_not_available", 409);
  if (bound === null) return { assistantId, bind: true, ok: true };
  if (bound !== assistantId) return rejected("assistant_binding_conflict", 409);
  return { assistantId, bind: false, ok: true };
}

/** Request keys that never change an Assistant row: the prompt and the Search preference. */
const assistantRejectedBodyKeys = ["prompt", "searchPreferencePlan", "searchPreferenceSource"] as const;

export type AssistantRowRequest = Readonly<{
  /** The first malformed row value in canonical row order; reported unless the row is fixed. */
  invalid: AssistantAdmissionFailure | null;
  /** The connection sent with `modelId`, checked against the model's own. */
  provider?: string;
  /** Request values in override vocabulary; a malformed value holds a placeholder so policy is checked first. */
  requested: ChatAssistantOverrides;
  /** `tools: "none"` is the per-request "no client tools" switch of the Tools row, never stored. */
  toolsKey: boolean;
}>;

/**
 * Decodes the ordinary row keys of a request into chat override vocabulary,
 * with the codes an ordinary chat returns for the same malformed values.
 * Controls travel as `controlDefaults` (provider-neutral saved-value format);
 * `params` counts as the controls key but is never read, because the server
 * materializes params from the resolved controls.
 */
export function decodeAssistantRowRequest(
  body: Readonly<Record<string, unknown>> | null
): (AssistantRowRequest & { ok: true }) | AssistantAdmissionFailure {
  const value = body ?? {};
  const has = (key: string) => Object.hasOwn(value, key);
  if (assistantRejectedBodyKeys.some(has)) return rejected("assistant_overrides_not_allowed", 400);
  const requested: ChatAssistantOverrides = {};
  const invalid: Partial<Record<AssistantRowKey, AssistantAdmissionFailure>> = {};
  let provider: string | undefined;
  if (has("modelId") || has("provider")) {
    const valid = typeof value.modelId === "string" && value.modelId !== "" &&
      (!has("provider") || typeof value.provider === "string");
    if (!valid) invalid.model = rejected("assistant_overrides_invalid", 400);
    requested.model = { mode: "model", modelId: valid ? value.modelId as string : "" };
    if (typeof value.provider === "string") provider = value.provider;
  }
  if (has("controlDefaults") || has("params")) {
    const controls = isRecord(value.controlDefaults) ? runControlsFromSavedValues(value.controlDefaults) : null;
    if (!controls) invalid.controls = rejected(invalidRunParamsError, 400);
    requested.controls = controls ?? {};
  }
  if (has("searchPlan")) {
    const decoded = decodeSearchPlan(value.searchPlan);
    if (!decoded.ok) invalid.search = rejected(decoded.code, 400);
    requested.search = decoded.ok && decoded.plan.optionIds.length > 0
      ? { mode: decoded.plan.mode, optionIds: [...decoded.plan.optionIds] }
      : { mode: "off" };
  }
  if (has("mcp")) {
    const decoded = decodeMcpRunSelection(value.mcp);
    if (!decoded) invalid.tools = rejected("mcp_selection_invalid", 400);
    requested.tools = decoded ?? { mode: "off" };
  }
  if (has("skills")) {
    const skills = value.skills;
    const valid = isRecord(skills) && Object.keys(skills).every((key) => key === "mode") &&
      (skills.mode === "auto" || skills.mode === "off");
    if (!valid) invalid.skills = rejected("skills_mode_invalid", 400);
    requested.skills = { mode: valid && skills.mode === "off" ? "off" : "auto" };
  }
  const firstInvalid = ASSISTANT_ROW_KEYS.map((key) => invalid[key]).find(Boolean) ?? null;
  return {
    invalid: firstInvalid,
    ok: true,
    ...(provider !== undefined ? { provider } : {}),
    requested,
    toolsKey: has("tools")
  };
}

/** The Skill ids the chain needs checked for this run. */
function rowResourceIds(assistant: AssistantRunMaterialization): AssistantRowResourceIds {
  return { skillIds: assistant.rows.skills.value.links.map((link) => link.skillId) };
}

type UnavailableCodes = Readonly<Partial<Record<AssistantRowKey, [string, AssistantAdmissionFailure["status"]]>>>;

/** The codes an ordinary chat returns for a request value outside its catalog. */
const ordinaryUnavailableCodes: UnavailableCodes = {
  controls: [invalidRunParamsError, 400],
  model: ["model_not_available", 403],
  search: ["search_strategy_not_available", 403]
};

/**
 * Maps a chain failure to the response. An unavailable fixed resource or
 * Skill link is the neutral conflict whoever runs the Assistant.
 */
export function assistantRowFailure(failure: AssistantRowResolutionFailure): AssistantAdmissionFailure {
  if (failure.code === "assistant_overrides_not_allowed") return rejected(failure.code, 400);
  if (failure.code === "request_value_not_available") {
    const [code, status] = ordinaryUnavailableCodes[failure.row] ?? ["assistant_overrides_invalid", 400];
    return rejected(code, status);
  }
  return rejected(failure.code, 409);
}

export type ChatAssistantAdmission = Readonly<{
  assistant: AssistantRunMaterialization;
  chatAssistant: AcceptedChatAssistant;
  context: AssistantRowContext;
  /** The connection of the effective model; empty when the context has no usable default. */
  modelProvider: string;
  resolution: AssistantRowResolution;
}>;

export type ChatAssistantAdmissionDeps = Readonly<{
  assistants?: AssistantRunResolver;
  repository: Readonly<{
    loadAssistantRowContext?(input: Readonly<{ ids: AssistantRowResourceIds; userId: string }>): Promise<AssistantRowContext | null>;
  }>;
}>;

/**
 * Resolves the chat's Assistant and every row. Controls are materialized
 * later, once the effective model's parameter controls are known.
 */
export async function admitChatAssistant(
  deps: ChatAssistantAdmissionDeps,
  input: Readonly<{
    body: Readonly<Record<string, unknown>> | null;
    source: ChatAssistantSource & { assistantId: string };
    storedOverrides: unknown;
    userId: string;
  }>
): Promise<({ ok: true } & ChatAssistantAdmission) | AssistantAdmissionFailure> {
  const request = decodeAssistantRowRequest(input.body);
  if (!request.ok) return request;
  const resolved: AssistantRunResolution = deps.assistants
    ? await deps.assistants.resolveForRun(input.userId, input.source.assistantId)
    : { code: "assistant_not_available", ok: false, status: 404 };
  if (!resolved.ok) return rejected(resolved.code, resolved.status);
  const assistant = resolved.assistant;
  if (request.toolsKey && assistant.rows.tools.policy === "fixed") {
    return rejected("assistant_overrides_not_allowed", 400);
  }
  // A chat being bound now has no overrides of its own; an undecodable value
  // counts as none and is replaced by the next write.
  const decoded = input.source.bind ? null : decodeStoredChatAssistantOverrides(input.storedOverrides);
  const storedOverrides = decoded?.kind === "overrides" ? decoded.overrides : {};
  if (!deps.repository.loadAssistantRowContext) return rejected("assistant_not_available", 503);
  const context = await deps.repository.loadAssistantRowContext({
    ids: rowResourceIds(assistant),
    userId: input.userId
  });
  if (!context) return rejected("assistant_not_available", 404);
  // The run uses stored controls only with the model they were set for.
  const stored = storedOverridesInEffect({
    assistant: assistant.rows,
    available: context.available,
    requested: request.requested,
    stored: storedOverrides
  });
  const resolution = resolveAssistantRows({
    assistant: assistant.rows,
    available: context.available,
    defaults: context.defaults,
    requested: request.requested,
    stored
  });
  // A value for a fixed row is refused before its shape is judged.
  if (!resolution.ok && resolution.code === "assistant_overrides_not_allowed") return assistantRowFailure(resolution);
  if (request.invalid) return request.invalid;
  if (!resolution.ok) return assistantRowFailure(resolution);
  const modelId = resolution.rows.model.value.modelId;
  const modelProvider = context.modelConnections.get(modelId) ?? "";
  if (request.provider !== undefined && request.provider !== modelProvider) {
    const [code, status] = ordinaryUnavailableCodes.model!;
    return rejected(code, status);
  }
  return {
    assistant,
    chatAssistant: {
      assistantId: input.source.assistantId,
      bind: input.source.bind,
      overridesPatch: resolution.overridesPatch
    },
    context,
    modelProvider,
    ok: true,
    resolution
  };
}

/** The Search plan a resolved Search row admits; Off is a plan without sources. */
export function searchPlanFromRow(value: ResolvedAssistantRowValues["search"]): SearchPlan {
  return "optionIds" in value
    ? { mode: value.mode, optionIds: [...value.optionIds] }
    : { mode: "all_selected", optionIds: [] };
}

/** The final override change once controls were materialized. */
export function chatAssistantWithPatch(
  chatAssistant: AcceptedChatAssistant,
  overridesPatch: ChatAssistantOverridesPatch
): AcceptedChatAssistant {
  return { ...chatAssistant, overridesPatch };
}
