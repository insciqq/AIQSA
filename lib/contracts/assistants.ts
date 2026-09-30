import {
  decodeSearchPlan,
  MAX_SEARCH_PLAN_OPTIONS,
  type SearchPlan,
  type SearchPlanMode
} from "./search";
import {
  decodeKnowledgePlan,
  decodeKnowledgeSelection,
  KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES,
  KNOWLEDGE_SELECTION_VERSION,
  type KnowledgeSelection
} from "./knowledge";
import { ANSWER_RULES_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH } from "./instructionPresets";
import { decodeAssistantListingStatus, type AssistantListingStatus } from "./assistantListing";
import { decodeSkillsSelection, SKILL_MAX_PINNED, SKILL_ASSISTANT_MAX_AVAILABLE, type AssistantSkillMode, type SkillsMode, type SkillsSelection } from "./skills";

export const ASSISTANT_NAME_MAX_LENGTH = 80;
export const ASSISTANT_DESCRIPTION_MAX_LENGTH = 400;
export const ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH = 48_000;
/** Limit for starters in new writes. */
export const ASSISTANT_STARTER_PROMPT_MAX_LENGTH = 200;
/** Starters saved under the former limit stay readable until their next edit. */
export const ASSISTANT_STORED_STARTER_PROMPT_MAX_LENGTH = 400;
export const ASSISTANT_MAX_STARTER_PROMPTS = 6;
export const ASSISTANT_MAX_MCP_SERVERS = 16;
export const ASSISTANT_MAX_OUTPUT_TOKENS_CEILING = 1_000_000;
const ASSISTANT_AVAILABILITY_DEPENDENCY_NAME_MAX_LENGTH = 160;

export const ASSISTANT_CATEGORIES = [
  "coding",
  "writing",
  "research",
  "analysis",
  "support",
  "productivity",
  "learning",
  "other"
] as const;

export type AssistantCategory = (typeof ASSISTANT_CATEGORIES)[number];

export const ASSISTANT_CATEGORY_LABELS: Readonly<Record<AssistantCategory, string>> = {
  analysis: "Analysis",
  coding: "Coding",
  learning: "Learning",
  other: "Other",
  productivity: "Productivity",
  research: "Research",
  support: "Support",
  writing: "Writing"
};

export const ASSISTANT_AVATAR_PALETTES = [
  "ember",
  "ocean",
  "meadow",
  "plum",
  "sand",
  "slate",
  "coral",
  "pine"
] as const;

export type AssistantAvatarPalette = (typeof ASSISTANT_AVATAR_PALETTES)[number];

export const ASSISTANT_AVATAR_SHAPES = [
  "circle",
  "square",
  "diamond",
  "hexagon",
  "triangle",
  "ring"
] as const;

export type AssistantAvatarShape = (typeof ASSISTANT_AVATAR_SHAPES)[number];

export type AssistantAvatarRotation = 0 | 1 | 2 | 3;

export const ASSISTANT_AVATAR_MAX_ACCENTS = 4;
export const ASSISTANT_AVATAR_ACCENT_SLOTS = 8;
export const ASSISTANT_AVATAR_RECIPE_MIN_BYTES = 6 + ASSISTANT_AVATAR_MAX_ACCENTS;

export type AssistantAvatarRecipe = {
  accents: number[];
  backgroundShape: AssistantAvatarShape;
  foregroundShape: AssistantAvatarShape;
  kind: "generated";
  paletteId: AssistantAvatarPalette;
  recipeVersion: 1;
  rotations: [AssistantAvatarRotation, AssistantAvatarRotation];
};

const avatarRecipeKeys = new Set([
  "accents",
  "backgroundShape",
  "foregroundShape",
  "kind",
  "paletteId",
  "recipeVersion",
  "rotations"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRotation(value: unknown): value is AssistantAvatarRotation {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * Strict, fail-closed decoder for the browser-generated avatar recipe. Unknown
 * versions, keys, enum members, oversized arrays, and non-integer accents all
 * return null because client-generated data remains untrusted.
 */
export function decodeAssistantAvatarRecipe(value: unknown): AssistantAvatarRecipe | null {
  if (!isRecord(value)) {
    return null;
  }

  const keys = Object.keys(value);
  if (keys.length !== avatarRecipeKeys.size || keys.some((key) => !avatarRecipeKeys.has(key))) {
    return null;
  }

  if (value.kind !== "generated" || value.recipeVersion !== 1) {
    return null;
  }

  if (
    !ASSISTANT_AVATAR_PALETTES.includes(value.paletteId as AssistantAvatarPalette) ||
    !ASSISTANT_AVATAR_SHAPES.includes(value.backgroundShape as AssistantAvatarShape) ||
    !ASSISTANT_AVATAR_SHAPES.includes(value.foregroundShape as AssistantAvatarShape)
  ) {
    return null;
  }

  const rotations = value.rotations;
  if (!Array.isArray(rotations) || rotations.length !== 2 || !rotations.every(isRotation)) {
    return null;
  }

  const accents = value.accents;
  if (
    !Array.isArray(accents) ||
    accents.length > ASSISTANT_AVATAR_MAX_ACCENTS ||
    accents.some(
      (accent) =>
        typeof accent !== "number" ||
        !Number.isInteger(accent) ||
        accent < 0 ||
        accent >= ASSISTANT_AVATAR_ACCENT_SLOTS
    ) ||
    new Set(accents).size !== accents.length
  ) {
    return null;
  }

  return {
    accents: accents.map((accent) => accent as number),
    backgroundShape: value.backgroundShape as AssistantAvatarShape,
    foregroundShape: value.foregroundShape as AssistantAvatarShape,
    kind: "generated",
    paletteId: value.paletteId as AssistantAvatarPalette,
    recipeVersion: 1,
    rotations: [rotations[0] as AssistantAvatarRotation, rotations[1] as AssistantAvatarRotation]
  };
}

/**
 * One clockwise quarter turn of the whole composition: both shape rotations
 * step by 90° and every accent moves two of the eight slots the same way, so
 * the turn stays visible when the foreground shape is 90°-symmetric. A uniform
 * shift keeps the accent slots unique, so the result still decodes.
 */
export function rotateAssistantAvatarRecipe(recipe: AssistantAvatarRecipe): AssistantAvatarRecipe {
  const accentStep = ASSISTANT_AVATAR_ACCENT_SLOTS / 4;
  return {
    ...recipe,
    accents: recipe.accents.map((slot) => (slot + accentStep) % ASSISTANT_AVATAR_ACCENT_SLOTS),
    rotations: [
      ((recipe.rotations[0] + 1) % 4) as AssistantAvatarRotation,
      ((recipe.rotations[1] + 1) % 4) as AssistantAvatarRotation
    ]
  };
}

/** Bounded display-only identity captured once with an accepted run. */
export type AssistantIdentity = { avatar: AssistantAvatarRecipe; name: string };

export function decodeAssistantIdentity(value: unknown): AssistantIdentity | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
    typeof value.name !== "string" || !value.name.trim() ||
    value.name.length > ASSISTANT_NAME_MAX_LENGTH) return null;
  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  return avatar ? { avatar, name: value.name } : null;
}

/**
 * Pure bounded generator: maps random bytes (Web Crypto in the browser, fixed
 * vectors in tests) to one exact recipe. The same bytes always produce the same
 * recipe; no clock, locale, or environment input participates.
 */
export function assistantAvatarRecipeFromBytes(bytes: Uint8Array): AssistantAvatarRecipe {
  if (bytes.length < ASSISTANT_AVATAR_RECIPE_MIN_BYTES) {
    throw new RangeError("assistant_avatar_recipe_requires_more_bytes");
  }

  const accentCount = bytes[5]! % (ASSISTANT_AVATAR_MAX_ACCENTS + 1);
  const accents: number[] = [];
  for (let index = 0; index < accentCount; index += 1) {
    let slot = bytes[6 + index]! % ASSISTANT_AVATAR_ACCENT_SLOTS;
    while (accents.includes(slot)) {
      slot = (slot + 1) % ASSISTANT_AVATAR_ACCENT_SLOTS;
    }
    accents.push(slot);
  }

  return {
    accents,
    backgroundShape: ASSISTANT_AVATAR_SHAPES[bytes[1]! % ASSISTANT_AVATAR_SHAPES.length]!,
    foregroundShape: ASSISTANT_AVATAR_SHAPES[bytes[2]! % ASSISTANT_AVATAR_SHAPES.length]!,
    kind: "generated",
    paletteId: ASSISTANT_AVATAR_PALETTES[bytes[0]! % ASSISTANT_AVATAR_PALETTES.length]!,
    recipeVersion: 1,
    rotations: [
      (bytes[3]! % 4) as AssistantAvatarRotation,
      (bytes[4]! % 4) as AssistantAvatarRotation
    ]
  };
}

export type AssistantRunControls = {
  backgroundMode?: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  reasoningMode?: string;
  streamMode?: boolean;
  temperature?: number;
};

export const ASSISTANT_RUN_CONTROL_FIELDS = [
  "backgroundMode",
  "maxOutputTokens",
  "reasoningEffort",
  "reasoningMode",
  "streamMode",
  "temperature"
] as const;

export type AssistantRunControlField = typeof ASSISTANT_RUN_CONTROL_FIELDS[number];

const runControlKeys = new Set([
  "backgroundMode",
  "maxOutputTokens",
  "reasoningEffort",
  "reasoningMode",
  "streamMode",
  "temperature"
]);

function boundedControlToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 64;
}

export function decodeAssistantRunControls(value: unknown): AssistantRunControls | null {
  if (!isRecord(value)) {
    return null;
  }

  if (Object.keys(value).some((key) => !runControlKeys.has(key))) {
    return null;
  }

  const controls: AssistantRunControls = {};

  if ("backgroundMode" in value) {
    if (typeof value.backgroundMode !== "boolean") return null;
    controls.backgroundMode = value.backgroundMode;
  }
  if ("maxOutputTokens" in value) {
    if (
      typeof value.maxOutputTokens !== "number" ||
      !Number.isInteger(value.maxOutputTokens) ||
      value.maxOutputTokens < 1 ||
      value.maxOutputTokens > ASSISTANT_MAX_OUTPUT_TOKENS_CEILING
    ) {
      return null;
    }
    controls.maxOutputTokens = value.maxOutputTokens;
  }
  if ("reasoningEffort" in value) {
    if (!boundedControlToken(value.reasoningEffort)) return null;
    controls.reasoningEffort = value.reasoningEffort;
  }
  if ("reasoningMode" in value) {
    if (!boundedControlToken(value.reasoningMode)) return null;
    controls.reasoningMode = value.reasoningMode;
  }
  if ("streamMode" in value) {
    if (typeof value.streamMode !== "boolean") return null;
    controls.streamMode = value.streamMode;
  }
  if ("temperature" in value) {
    if (
      typeof value.temperature !== "number" ||
      !Number.isFinite(value.temperature) ||
      value.temperature < -10 ||
      value.temperature > 10
    ) {
      return null;
    }
    controls.temperature = value.temperature;
  }

  return controls;
}

function invalidAssistantRunControlField(
  value: unknown
): AssistantRunControlField | undefined {
  if (!isRecord(value)) return undefined;
  if ("backgroundMode" in value && typeof value.backgroundMode !== "boolean") {
    return "backgroundMode";
  }
  if (
    "maxOutputTokens" in value &&
    (typeof value.maxOutputTokens !== "number" ||
      !Number.isInteger(value.maxOutputTokens) ||
      value.maxOutputTokens < 1 ||
      value.maxOutputTokens > ASSISTANT_MAX_OUTPUT_TOKENS_CEILING)
  ) {
    return "maxOutputTokens";
  }
  if ("reasoningEffort" in value && !boundedControlToken(value.reasoningEffort)) {
    return "reasoningEffort";
  }
  if ("reasoningMode" in value && !boundedControlToken(value.reasoningMode)) {
    return "reasoningMode";
  }
  if ("streamMode" in value && typeof value.streamMode !== "boolean") {
    return "streamMode";
  }
  if (
    "temperature" in value &&
    (typeof value.temperature !== "number" ||
      !Number.isFinite(value.temperature) ||
      value.temperature < -10 ||
      value.temperature > 10)
  ) {
    return "temperature";
  }
  return undefined;
}

export const ASSISTANT_ROW_KEYS = ["model", "controls", "search", "tools", "knowledge", "skills"] as const;

export type AssistantRowKey = (typeof ASSISTANT_ROW_KEYS)[number];

export const ASSISTANT_ROW_POLICIES = ["fixed", "adjustable"] as const;

/** `fixed` applies in every chat; `adjustable` starts a chat and may be changed for it. */
export type AssistantRowPolicy = (typeof ASSISTANT_ROW_POLICIES)[number];

export const ASSISTANT_ROW_PROVENANCES = ["assistant", "chat", "default", "fallback"] as const;

/**
 * Origin of an effective row value: the Assistant, a change made for this
 * chat, the user's Chat defaults through inherit, or the user's default in
 * place of an adjustable Assistant value the user cannot use.
 */
export type AssistantRowProvenance = (typeof ASSISTANT_ROW_PROVENANCES)[number];

export function decodeAssistantRowKey(value: unknown): AssistantRowKey | null {
  return ASSISTANT_ROW_KEYS.includes(value as AssistantRowKey) ? value as AssistantRowKey : null;
}

export function decodeAssistantRowPolicy(value: unknown): AssistantRowPolicy | null {
  return ASSISTANT_ROW_POLICIES.includes(value as AssistantRowPolicy) ? value as AssistantRowPolicy : null;
}

export function decodeAssistantRowProvenance(value: unknown): AssistantRowProvenance | null {
  return ASSISTANT_ROW_PROVENANCES.includes(value as AssistantRowProvenance)
    ? value as AssistantRowProvenance
    : null;
}

/*
 * Row values keep inherit, explicit off/none and concrete choices distinct.
 * `hiddenCount` appears only in projections: resources the viewer cannot
 * access are counted there, never identified.
 */
export type AssistantModelValue =
  | { mode: "inherit" }
  /** A null id appears only in projections, for a model outside the viewer's catalog. */
  | { mode: "model"; modelId: string | null };

export type AssistantSearchValue =
  | { mode: "inherit" }
  | { mode: "off" }
  | { hiddenCount?: number; mode: SearchPlanMode; optionIds: string[] };

export type AssistantToolsValue =
  | { mode: "inherit" }
  | { mode: "off" }
  | { hiddenCount?: number; mode: "exact"; serverIds: string[] };

export type AssistantKnowledgeValue =
  | { mode: "inherit" }
  | { mode: "none" }
  | { baseIds: string[]; hiddenCount?: number; mode: "explicit"; sourceIds: string[] };

/** Wire names of the stored link modes: `pinned` is `always`, `available` is `on_demand`. */
export type AssistantSkillDelivery = "always" | "on_demand";

export type AssistantSkillLink = { delivery: AssistantSkillDelivery; skillId: string };

/** Skills have no inherit: `auto` without links already behaves like an ordinary chat. */
export type AssistantSkillsValue = {
  hiddenCount?: number;
  links: AssistantSkillLink[];
  mode: SkillsMode;
};

export type AssistantRowValues = {
  /** A partial set; an unset field uses the user's saved value for the model. */
  controls: AssistantRunControls;
  knowledge: AssistantKnowledgeValue;
  model: AssistantModelValue;
  search: AssistantSearchValue;
  skills: AssistantSkillsValue;
  tools: AssistantToolsValue;
};

export type AssistantRow<Key extends AssistantRowKey> = {
  policy: AssistantRowPolicy;
  value: AssistantRowValues[Key];
};

export type AssistantRows = { [Key in AssistantRowKey]: AssistantRow<Key> };

export type AssistantDecodeError = {
  actual?: number;
  code: string;
  field?: AssistantRunControlField | "pinned" | "available";
  limit?: number;
  ok: false;
  row?: AssistantRowKey;
};

/** Drafts carry what an owner may write; projections may also redact. */
export type AssistantRowDecodeMode = "draft" | "projection";

type ValueResult<T> = { ok: true; value: T } | AssistantDecodeError;

export function assistantSkillDelivery(mode: AssistantSkillMode): AssistantSkillDelivery {
  return mode === "available" ? "on_demand" : "always";
}

export function assistantSkillModeForDelivery(delivery: AssistantSkillDelivery): AssistantSkillMode {
  return delivery === "on_demand" ? "available" : "pinned";
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 64;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function onlyMode(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 1;
}

/** Zero when absent; a positive count is accepted only in projections. */
function decodeHiddenCount(value: Record<string, unknown>, mode: AssistantRowDecodeMode): number | null {
  if (!("hiddenCount" in value)) return 0;
  return mode === "projection" && typeof value.hiddenCount === "number" &&
    Number.isSafeInteger(value.hiddenCount) && value.hiddenCount > 0
    ? value.hiddenCount
    : null;
}

function withHiddenCount<T extends object>(value: T, hiddenCount: number): T & { hiddenCount?: number } {
  return hiddenCount > 0 ? { ...value, hiddenCount } : value;
}

function distinctBoundedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(boundedId)) return null;
  const ids = value.map((id) => (id as string).trim());
  return new Set(ids).size === ids.length ? ids : null;
}

export function decodeAssistantModelValue(
  value: unknown,
  mode: AssistantRowDecodeMode = "draft"
): AssistantModelValue | null {
  if (!isRecord(value)) return null;
  if (value.mode === "inherit") return onlyMode(value) ? { mode: "inherit" } : null;
  if (value.mode !== "model" || Object.keys(value).length !== 2 || !("modelId" in value)) return null;
  if (value.modelId === null) return mode === "projection" ? { mode: "model", modelId: null } : null;
  return boundedId(value.modelId) ? { mode: "model", modelId: value.modelId.trim() } : null;
}

export function decodeAssistantSearchValue(
  value: unknown,
  mode: AssistantRowDecodeMode = "draft"
): AssistantSearchValue | null {
  if (!isRecord(value)) return null;
  if (value.mode === "inherit" || value.mode === "off") return onlyMode(value) ? { mode: value.mode } : null;
  if (!hasOnlyKeys(value, ["hiddenCount", "mode", "optionIds"])) return null;
  const hiddenCount = decodeHiddenCount(value, mode);
  const plan = decodeSearchPlan({ mode: value.mode, optionIds: value.optionIds });
  if (hiddenCount === null || !plan.ok) return null;
  const total = plan.plan.optionIds.length + hiddenCount;
  return total >= 1 && total <= MAX_SEARCH_PLAN_OPTIONS
    ? withHiddenCount({ mode: plan.plan.mode, optionIds: [...plan.plan.optionIds] }, hiddenCount)
    : null;
}

export function decodeAssistantToolsValue(
  value: unknown,
  mode: AssistantRowDecodeMode = "draft"
): AssistantToolsValue | null {
  if (!isRecord(value)) return null;
  if (value.mode === "inherit" || value.mode === "off") return onlyMode(value) ? { mode: value.mode } : null;
  if (value.mode !== "exact" || !hasOnlyKeys(value, ["hiddenCount", "mode", "serverIds"])) return null;
  const hiddenCount = decodeHiddenCount(value, mode);
  const serverIds = distinctBoundedIds(value.serverIds);
  if (hiddenCount === null || !serverIds) return null;
  const total = serverIds.length + hiddenCount;
  return total >= 1 && total <= ASSISTANT_MAX_MCP_SERVERS
    ? withHiddenCount({ mode: "exact" as const, serverIds }, hiddenCount)
    : null;
}

export function decodeAssistantKnowledgeValue(
  value: unknown,
  mode: AssistantRowDecodeMode = "draft"
): AssistantKnowledgeValue | null {
  if (!isRecord(value)) return null;
  if (value.mode === "inherit" || value.mode === "none") return onlyMode(value) ? { mode: value.mode } : null;
  if (
    value.mode !== "explicit" ||
    !hasOnlyKeys(value, ["baseIds", "hiddenCount", "mode", "sourceIds"]) ||
    !Array.isArray(value.baseIds) ||
    !Array.isArray(value.sourceIds)
  ) {
    return null;
  }
  const hiddenCount = decodeHiddenCount(value, mode);
  if (hiddenCount === null) return null;
  let baseIds: string[] = [];
  let sourceIds: string[] = [];
  if (value.baseIds.length + value.sourceIds.length > 0) {
    const decoded = decodeKnowledgeSelection({
      baseIds: value.baseIds,
      mode: "explicit",
      sourceIds: value.sourceIds,
      version: KNOWLEDGE_SELECTION_VERSION
    });
    if (!decoded.ok) return null;
    baseIds = [...decoded.plan.baseIds];
    sourceIds = [...decoded.plan.sourceIds];
  }
  const total = baseIds.length + sourceIds.length + hiddenCount;
  return total >= 1 && total <= KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES
    ? withHiddenCount({ baseIds, mode: "explicit" as const, sourceIds }, hiddenCount)
    : null;
}

function skillsValueResult(value: unknown, mode: AssistantRowDecodeMode): ValueResult<AssistantSkillsValue> {
  const invalid = { code: "assistant_skills_invalid", ok: false as const, row: "skills" as const };
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["hiddenCount", "links", "mode"]) ||
    (value.mode !== "auto" && value.mode !== "off") ||
    !Array.isArray(value.links)
  ) {
    return invalid;
  }
  const hiddenCount = decodeHiddenCount(value, mode);
  if (hiddenCount === null) return invalid;
  const links: AssistantSkillLink[] = [];
  for (const link of value.links) {
    if (
      !isRecord(link) ||
      Object.keys(link).length !== 2 ||
      !boundedId(link.skillId) ||
      (link.delivery !== "always" && link.delivery !== "on_demand")
    ) {
      return invalid;
    }
    links.push({ delivery: link.delivery, skillId: link.skillId.trim() });
  }
  if (new Set(links.map((link) => link.skillId)).size !== links.length) return invalid;
  for (const [field, delivery, limit] of [
    ["pinned", "always", SKILL_MAX_PINNED],
    ["available", "on_demand", SKILL_ASSISTANT_MAX_AVAILABLE]
  ] as const) {
    const actual = links.filter((link) => link.delivery === delivery).length;
    if (actual > limit) return { actual, code: "skills_count_exceeded", field, limit, ok: false, row: "skills" };
  }
  if (links.length + hiddenCount > SKILL_MAX_PINNED + SKILL_ASSISTANT_MAX_AVAILABLE) return invalid;
  return { ok: true, value: withHiddenCount({ links, mode: value.mode }, hiddenCount) };
}

export function decodeAssistantSkillsValue(
  value: unknown,
  mode: AssistantRowDecodeMode = "draft"
): AssistantSkillsValue | null {
  const decoded = skillsValueResult(value, mode);
  return decoded.ok ? decoded.value : null;
}

const assistantRowValueCodes: Readonly<Record<AssistantRowKey, string>> = {
  controls: "assistant_run_controls_invalid",
  knowledge: "assistant_knowledge_bases_invalid",
  model: "assistant_model_invalid",
  search: "assistant_search_plan_invalid",
  skills: "assistant_skills_invalid",
  tools: "assistant_mcp_servers_invalid"
};

function rowValueResult(
  key: AssistantRowKey,
  value: unknown,
  mode: AssistantRowDecodeMode
): ValueResult<AssistantRowValues[AssistantRowKey]> {
  if (key === "skills") return skillsValueResult(value, mode);
  if (key === "controls") {
    const controls = decodeAssistantRunControls(value);
    if (controls) return { ok: true, value: controls };
    const field = invalidAssistantRunControlField(value);
    return { code: assistantRowValueCodes.controls, ...(field ? { field } : {}), ok: false, row: key };
  }
  const decoded = key === "model" ? decodeAssistantModelValue(value, mode)
    : key === "search" ? decodeAssistantSearchValue(value, mode)
      : key === "tools" ? decodeAssistantToolsValue(value, mode)
        : decodeAssistantKnowledgeValue(value, mode);
  return decoded ? { ok: true, value: decoded } : { code: assistantRowValueCodes[key], ok: false, row: key };
}

/**
 * PRD 5.3: a fixed row needs a concrete value (off and none are concrete);
 * fixed controls need at least one field and a fixed model, because
 * parameters of a model the user may replace cannot be fixed.
 */
export function assistantRowPolicyViolation(rows: AssistantRows): AssistantDecodeError | null {
  for (const key of ["model", "search", "tools", "knowledge"] as const) {
    if (rows[key].policy === "fixed" && rows[key].value.mode === "inherit") {
      return { code: "assistant_row_fixed_requires_value", ok: false, row: key };
    }
  }
  if (rows.controls.policy === "fixed") {
    if (Object.keys(rows.controls.value).length === 0) {
      return { code: "assistant_row_fixed_requires_value", ok: false, row: "controls" };
    }
    if (rows.model.policy !== "fixed") {
      return { code: "assistant_row_controls_require_fixed_model", ok: false, row: "controls" };
    }
  }
  return null;
}

/** Strict decoder for all six rows, including the policy rules. */
export function decodeAssistantRows(
  value: unknown,
  mode: AssistantRowDecodeMode = "draft"
): { ok: true; rows: AssistantRows } | AssistantDecodeError {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== ASSISTANT_ROW_KEYS.length ||
    !hasOnlyKeys(value, ASSISTANT_ROW_KEYS)
  ) {
    return { code: "assistant_rows_invalid", ok: false };
  }
  const rows: Partial<Record<AssistantRowKey, { policy: AssistantRowPolicy; value: unknown }>> = {};
  for (const key of ASSISTANT_ROW_KEYS) {
    const row = value[key];
    const policy = isRecord(row) && Object.keys(row).length === 2 && "value" in row
      ? decodeAssistantRowPolicy(row.policy)
      : null;
    if (!isRecord(row) || !policy) return { code: "assistant_rows_invalid", ok: false, row: key };
    const decoded = rowValueResult(key, row.value, mode);
    if (!decoded.ok) return decoded;
    rows[key] = { policy, value: decoded.value };
  }
  const complete = rows as AssistantRows;
  return assistantRowPolicyViolation(complete) ?? { ok: true, rows: complete };
}

/**
 * The flat row fields of the first Assistant release. Create and revise
 * accept only `rows`; server, run and Skills tests still use the flat fields
 * as a compact way to write fixed rows through `assistantRowsFromLegacyFields`.
 */
export type AssistantLegacyRowFields = {
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  providerModelId: string;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
  skillIds: string[];
  skillModes?: Record<string, AssistantSkillMode>;
  skills?: SkillsSelection;
};

/**
 * Legacy values keep today's behaviour: every row is fixed, except empty
 * controls, which can never be fixed. A plan without Search sources and an
 * empty MCP list are explicit Off.
 */
export function assistantRowsFromLegacyFields(fields: AssistantLegacyRowFields): AssistantRows {
  const knowledge = fields.knowledgeSelection;
  if (knowledge.mode === "all_my_knowledge" || knowledge.mode === "inherited") {
    throw new Error("assistant_legacy_knowledge_invalid");
  }
  return {
    controls: {
      policy: Object.keys(fields.runControls).length > 0 ? "fixed" : "adjustable",
      value: { ...fields.runControls }
    },
    knowledge: {
      policy: "fixed",
      value: knowledge.mode === "explicit"
        ? { baseIds: [...knowledge.baseIds], mode: "explicit", sourceIds: [...knowledge.sourceIds] }
        : { mode: "none" }
    },
    model: { policy: "fixed", value: { mode: "model", modelId: fields.providerModelId } },
    search: {
      policy: "fixed",
      value: fields.searchPlan.optionIds.length > 0
        ? { mode: fields.searchPlan.mode, optionIds: [...fields.searchPlan.optionIds] }
        : { mode: "off" }
    },
    skills: {
      policy: "fixed",
      value: {
        links: fields.skillIds.map((skillId) => ({
          delivery: assistantSkillDelivery(fields.skillModes?.[skillId] ?? "pinned"),
          skillId
        })),
        mode: fields.skills?.mode ?? "auto"
      }
    },
    tools: {
      policy: "fixed",
      value: fields.mcpServerIds.length > 0
        ? { mode: "exact", serverIds: [...fields.mcpServerIds] }
        : { mode: "off" }
    }
  };
}

export type AssistantDraft = {
  /** Null keeps the platform answer rules; text replaces them for this Assistant. */
  answerRules: string | null;
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  name: string;
  responseReminder: string;
  rows: AssistantRows;
  starterPrompts: string[];
  systemPrompt: string;
};

export type AssistantDraftDecodeResult =
  | AssistantDecodeError
  | { draft: AssistantDraft; ok: true };

/** Every link remains a dependency. Modes control delivery, never authority. */
export function decodeAssistantSkillModes(skillIds: readonly string[], value: unknown):
  | { ok: true; modes: Record<string, AssistantSkillMode> }
  | { ok: false; code: string; field?: "pinned" | "available"; actual?: number; limit?: number } {
  if (value !== undefined && (!isRecord(value) || Object.keys(value).some((id) => !skillIds.includes(id)) ||
    Object.values(value).some((mode) => mode !== "pinned" && mode !== "available"))) return { ok: false, code: "assistant_skills_invalid" };
  const modes = Object.fromEntries(skillIds.map((id) => [id, isRecord(value) && value[id] === "available" ? "available" : "pinned"])) as Record<string, AssistantSkillMode>;
  for (const [field, limit] of [["pinned", SKILL_MAX_PINNED], ["available", SKILL_ASSISTANT_MAX_AVAILABLE]] as const) {
    const actual = Object.values(modes).filter((mode) => mode === field).length;
    if (actual > limit) return { ok: false, code: "skills_count_exceeded", field, actual, limit };
  }
  return { ok: true, modes };
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && !value.includes("\0");
}

/**
 * Strict decoder for create/revise payloads with all six `rows`. Every bound
 * fails closed with a stable field-scoped code so the editor can attach
 * errors to their section; row errors also name the row. Unknown keys, such
 * as the retired developer prompt or the flat row fields of the first
 * release, are ignored, so a payload without `rows` fails as invalid rows.
 */
export function decodeAssistantDraft(value: unknown): AssistantDraftDecodeResult {
  if (!isRecord(value)) {
    return { code: "assistant_draft_invalid", ok: false };
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > ASSISTANT_NAME_MAX_LENGTH) {
    return { code: "assistant_name_invalid", ok: false };
  }

  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > ASSISTANT_DESCRIPTION_MAX_LENGTH) {
    return { code: "assistant_description_invalid", ok: false };
  }

  const category = value.category ?? null;
  if (category !== null && !ASSISTANT_CATEGORIES.includes(category as AssistantCategory)) {
    return { code: "assistant_category_invalid", ok: false };
  }

  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  if (!avatar) {
    return { code: "assistant_avatar_invalid", ok: false };
  }

  const decodedRows = decodeAssistantRows(value.rows, "draft");
  if (!decodedRows.ok) return decodedRows;
  const rows = decodedRows.rows;

  const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : null;
  if (systemPrompt === null || systemPrompt.length > ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH) {
    return { code: "assistant_system_prompt_invalid", ok: false };
  }

  const responseReminder = value.responseReminder === undefined ? "" : value.responseReminder;
  if (!boundedText(responseReminder, RESPONSE_REMINDER_MAX_LENGTH)) {
    return { code: "assistant_response_reminder_invalid", ok: false };
  }

  const answerRules = value.answerRules ?? null;
  if (answerRules !== null && !boundedText(answerRules, ANSWER_RULES_MAX_LENGTH)) {
    return { code: "assistant_answer_rules_invalid", ok: false };
  }

  const starterPromptsInput = value.starterPrompts ?? [];
  if (
    !Array.isArray(starterPromptsInput) ||
    starterPromptsInput.length > ASSISTANT_MAX_STARTER_PROMPTS ||
    !starterPromptsInput.every(
      (starter) => typeof starter === "string" && starter.trim().length > 0 &&
        starter.length <= ASSISTANT_STARTER_PROMPT_MAX_LENGTH
    )
  ) {
    return { code: "assistant_starter_prompts_invalid", ok: false };
  }

  return {
    draft: {
      answerRules,
      avatar,
      category: (category as AssistantCategory | null) ?? null,
      description,
      name,
      responseReminder,
      rows,
      starterPrompts: starterPromptsInput.map((starter) => (starter as string).trim()),
      systemPrompt
    },
    ok: true
  };
}

export type AssistantAvailabilityReason =
  | "archived"
  | "model_access"
  | "search_access"
  | "tools_access"
  | "skills_access"
  | "knowledge_access"
  | "knowledge_not_ready"
  | "knowledge_unavailable";

const ASSISTANT_AVAILABILITY_REASONS: readonly AssistantAvailabilityReason[] = [
  "archived",
  "model_access",
  "search_access",
  "tools_access",
  "skills_access",
  "knowledge_access",
  "knowledge_not_ready",
  "knowledge_unavailable"
];

export type AssistantAvailabilityDependency = {
  kind: "mcp" | "model" | "search";
  name: string;
};

export type AssistantAvailability =
  | { ok: true }
  | {
      /** Present only on owner projections; shared consumers receive a neutral reason. */
      dependencies?: AssistantAvailabilityDependency[];
      ok: false;
      reason: AssistantAvailabilityReason;
    };

/** Rows whose adjustable resource can be unavailable without making the Assistant unavailable. */
export type AssistantRowDeviationKey = "knowledge" | "model" | "search" | "tools";

/**
 * The Assistant's adjustable value is unavailable to the viewer, who gets
 * their own default instead. Owners also receive the missing resource names.
 */
export type AssistantRowDeviation = {
  dependencies?: AssistantAvailabilityDependency[];
  reason: Exclude<AssistantAvailabilityReason, "archived" | "skills_access">;
};

/** Deviations only; a row absent from the map is available as configured. */
export type AssistantRowAvailability = Partial<Record<AssistantRowDeviationKey, AssistantRowDeviation>>;

export type AssistantAccessScope =
  | { groupNames: string[]; kind: "group" }
  | { kind: "installation" }
  | { kind: "owner" }
  | { kind: "project"; projectName: string };

/**
 * Owner only: who the owner shared the Assistant with. A pending request to
 * list it for everyone is not an audience.
 */
export type AssistantOwnerAudience = {
  /** Listed for everyone in this installation. */
  everyone: boolean;
  /** The non-archived groups it is published to, by name. */
  groupNames: string[];
};

export type AssistantCapabilityFingerprint = {
  /** Privacy-safe capability copy; dependency ids and names stay server-side. */
  knowledgeLabel: string | null;
  knowledgeResourceCount: number;
  mcpServerCount: number;
  modelLabel: string | null;
  reasoningEffort: string | null;
  searchOptionCount: number;
};

export type AssistantSummary = {
  archived: boolean;
  /** Null exactly when the viewer does not own it: a consumer never learns the other audiences. */
  audience: AssistantOwnerAudience | null;
  availability: AssistantAvailability;
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  /** Listed for everyone and chosen by an administrator for the Featured group. */
  featured: boolean;
  /** Position in the Featured group (0 first); null exactly when not featured. */
  featuredOrder: number | null;
  fingerprint: AssistantCapabilityFingerprint;
  id: string;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  pinned: boolean;
  published: boolean;
  rowAvailability: AssistantRowAvailability;
  /** How the Assistant reaches this viewer; always `owner` for the owner. */
  scope: AssistantAccessScope;
  /** Skill links of the definition for every viewer; a count, never which Skills. */
  skillLinkCount: number;
  starterPrompts: string[];
  updatedAt: string;
};

export type AssistantContent = {
  /** Null keeps the platform answer rules. */
  answerRules: string | null;
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  responseReminder?: string;
  /*
   * The flat row fields below are a lossy projection of `rows` (inherit reads
   * as unset, Off or None). The editor and the composer read `rows`.
   */
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  name: string;
  providerModelId: string | null;
  rows: AssistantRows;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
  skillIds: string[];
  skillModes?: Record<string, AssistantSkillMode>;
  skills?: SkillsSelection;
  starterPrompts: string[];
  systemPrompt: string;
};

export type AssistantPublicationView = {
  groupId: string | null;
  groupName: string | null;
  id: string;
  scope: "group" | "installation" | "project";
  updatedAt: string;
};

/** Projects the owner can open are named; the rest are only counted. */
export type AssistantProjectUsage = {
  otherProjectCount: number;
  projects: { id: string; name: string }[];
};

export type AssistantDetail = {
  archived: boolean;
  /** As in the summary: null exactly when the viewer does not own it. */
  audience: AssistantOwnerAudience | null;
  availability: AssistantAvailability;
  featured: boolean;
  /** Owner only: position among Featured Assistants, null when not featured. */
  featuredOrder?: number | null;
  id: string;
  /** Owner only: listing for everyone, with the latest request to list it. */
  listingRequest?: AssistantListingStatus | null;
  owned: boolean;
  ownerDisplayName: string;
  pinned: boolean;
  /** Owner only. */
  projects?: AssistantProjectUsage;
  publications?: AssistantPublicationView[];
  /** Owner only: distinct chats with a run of this Assistant in the last 30 days. */
  recentChatCount?: number;
  rowAvailability: AssistantRowAvailability;
  /** As in the summary; a Project member reads it through the Project. */
  scope: AssistantAccessScope;
  content: AssistantContent;
  skills?: { id: string; name: string; available?: boolean; mode?: AssistantSkillMode; instructionApproxTokens?: number }[];
  updatedAt: string;
  version?: number;
};

/** `memberCount` counts the group's active users. */
export type AssistantPublishableGroup = { id: string; memberCount: number; name: string };

export const ASSISTANT_MAX_RECENT = 5;

export type AssistantListResponse = {
  assistants: AssistantSummary[];
  /** The caller's active group memberships, usable as publication targets. */
  publishableGroups: AssistantPublishableGroup[];
  /** Assistants of the viewer's latest personal chats, newest first; always listed above. */
  recentAssistantIds: string[];
  viewer: {
    canPublishInstallation: boolean;
    /** The saved personal default while it is listed above; otherwise null. */
    defaultAssistantId: string | null;
  };
};
export type AssistantDetailResponse = { assistant: AssistantDetail };

/** Rows reset to inherit (none for Knowledge) because the copier cannot use their resources. */
export type AssistantDuplicateReport = {
  downgradedRows: AssistantRowKey[];
  droppedSkillCount: number;
};
export type AssistantDuplicateResponse = AssistantDetailResponse & { report: AssistantDuplicateReport };
export type AssistantPublicationResponse = { publication: AssistantPublicationView };

/** Frozen with an accepted run: where each effective row value came from. */
export type AssistantRunRowProvenance = Readonly<Record<AssistantRowKey, AssistantRowProvenance>>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeAvailabilityDependencies(value: unknown): AssistantAvailabilityDependency[] | null {
  if (!Array.isArray(value) || value.length > 18) return null;
  const dependencies: AssistantAvailabilityDependency[] = [];
  for (const dependency of value) {
    if (
      !isRecord(dependency) ||
      (dependency.kind !== "mcp" &&
        dependency.kind !== "model" &&
        dependency.kind !== "search") ||
      typeof dependency.name !== "string" ||
      !dependency.name.trim() ||
      dependency.name.length > ASSISTANT_AVAILABILITY_DEPENDENCY_NAME_MAX_LENGTH
    ) {
      return null;
    }
    dependencies.push({ kind: dependency.kind, name: dependency.name });
  }
  return dependencies;
}

export function decodeAssistantAvailability(value: unknown): AssistantAvailability | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) return { ok: true };
  if (
    value.ok === false &&
    ASSISTANT_AVAILABILITY_REASONS.includes(value.reason as AssistantAvailabilityReason)
  ) {
    let dependencies: AssistantAvailabilityDependency[] | undefined;
    if (value.dependencies !== undefined) {
      const decoded = decodeAvailabilityDependencies(value.dependencies);
      if (!decoded) return null;
      dependencies = decoded;
    }
    return {
      ...(dependencies ? { dependencies } : {}),
      ok: false,
      reason: value.reason as AssistantAvailabilityReason
    };
  }
  return null;
}

const rowDeviationReasons: Readonly<Record<AssistantRowDeviationKey, readonly AssistantRowDeviation["reason"][]>> = {
  knowledge: ["knowledge_access", "knowledge_not_ready", "knowledge_unavailable"],
  model: ["model_access"],
  search: ["search_access"],
  tools: ["tools_access"]
};

/** Dependency names are accepted only for the owner, as for availability. */
export function decodeAssistantRowDeviation(
  key: AssistantRowKey,
  value: unknown,
  owned: boolean
): AssistantRowDeviation | null {
  const reasons = Object.hasOwn(rowDeviationReasons, key)
    ? rowDeviationReasons[key as AssistantRowDeviationKey]
    : undefined;
  if (
    !reasons ||
    !isRecord(value) ||
    !hasOnlyKeys(value, ["dependencies", "reason"]) ||
    !reasons.includes(value.reason as AssistantRowDeviation["reason"])
  ) {
    return null;
  }
  if (value.dependencies === undefined) return { reason: value.reason as AssistantRowDeviation["reason"] };
  const dependencies = owned ? decodeAvailabilityDependencies(value.dependencies) : null;
  return dependencies ? { dependencies, reason: value.reason as AssistantRowDeviation["reason"] } : null;
}

export function decodeAssistantRowAvailability(value: unknown, owned: boolean): AssistantRowAvailability | null {
  if (!isRecord(value)) return null;
  const availability: AssistantRowAvailability = {};
  for (const [key, entry] of Object.entries(value)) {
    const row = decodeAssistantRowKey(key);
    const deviation = row ? decodeAssistantRowDeviation(row, entry, owned) : null;
    if (!deviation) return null;
    availability[row as AssistantRowDeviationKey] = deviation;
  }
  return availability;
}

function decodeScope(value: unknown): AssistantAccessScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === "owner") return { kind: "owner" };
  if (value.kind === "installation") return { kind: "installation" };
  if (
    value.kind === "group" &&
    Array.isArray(value.groupNames) &&
    value.groupNames.every((name) => typeof name === "string")
  ) {
    return { groupNames: value.groupNames as string[], kind: "group" };
  }
  if (value.kind === "project" && nonEmptyString(value.projectName)) {
    return { kind: "project", projectName: value.projectName };
  }
  return null;
}

/** Present exactly for the owner; undefined rejects the payload. */
function decodeOwnerAudience(value: unknown, owned: unknown): AssistantOwnerAudience | null | undefined {
  if (owned !== true) return value === null ? null : undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["everyone", "groupNames"]) ||
    typeof value.everyone !== "boolean" ||
    !Array.isArray(value.groupNames) ||
    !value.groupNames.every(nonEmptyString)
  ) {
    return undefined;
  }
  return { everyone: value.everyone, groupNames: [...value.groupNames] };
}

function decodeFingerprint(value: unknown): AssistantCapabilityFingerprint | null {
  if (
    !isRecord(value) ||
    !stringOrNull(value.knowledgeLabel) ||
    typeof value.knowledgeResourceCount !== "number" ||
    !Number.isSafeInteger(value.knowledgeResourceCount) ||
    value.knowledgeResourceCount < 0 ||
    typeof value.mcpServerCount !== "number" ||
    !stringOrNull(value.modelLabel) ||
    !stringOrNull(value.reasoningEffort) ||
    typeof value.searchOptionCount !== "number"
  ) {
    return null;
  }
  return {
    knowledgeLabel: value.knowledgeLabel,
    knowledgeResourceCount: value.knowledgeResourceCount,
    mcpServerCount: value.mcpServerCount,
    modelLabel: value.modelLabel,
    reasoningEffort: value.reasoningEffort,
    searchOptionCount: value.searchOptionCount
  };
}

function decodeCategory(value: unknown): AssistantCategory | null | undefined {
  if (value === null) return null;
  if (ASSISTANT_CATEGORIES.includes(value as AssistantCategory)) {
    return value as AssistantCategory;
  }
  return undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Stored starters may predate the 200-character limit for new writes. */
function storedStarterPrompts(value: unknown): value is string[] {
  return stringArray(value) &&
    value.length <= ASSISTANT_MAX_STARTER_PROMPTS &&
    value.every((starter) => starter.length <= ASSISTANT_STORED_STARTER_PROMPT_MAX_LENGTH);
}

export function decodeAssistantSummary(value: unknown): AssistantSummary | null {
  if (!isRecord(value)) return null;
  const audience = decodeOwnerAudience(value.audience, value.owned);
  const availability = decodeAssistantAvailability(value.availability);
  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  const category = decodeCategory(value.category);
  const fingerprint = decodeFingerprint(value.fingerprint);
  const scope = decodeScope(value.scope);
  const rowAvailability = typeof value.owned === "boolean"
    ? decodeAssistantRowAvailability(value.rowAvailability, value.owned)
    : null;
  if (
    typeof value.archived !== "boolean" ||
    audience === undefined ||
    !availability ||
    !avatar ||
    category === undefined ||
    typeof value.description !== "string" ||
    typeof value.featured !== "boolean" ||
    !(value.featuredOrder === null || nonNegativeInteger(value.featuredOrder)) ||
    (value.featuredOrder !== null) !== value.featured ||
    !fingerprint ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.name) ||
    typeof value.owned !== "boolean" ||
    (value.owned === false && !availability.ok && availability.dependencies !== undefined) ||
    typeof value.ownerDisplayName !== "string" ||
    typeof value.pinned !== "boolean" ||
    typeof value.published !== "boolean" ||
    !rowAvailability ||
    !scope ||
    !nonNegativeInteger(value.skillLinkCount) ||
    !storedStarterPrompts(value.starterPrompts) ||
    !nonEmptyString(value.updatedAt)
  ) {
    return null;
  }

  return {
    archived: value.archived,
    audience,
    availability,
    avatar,
    category,
    description: value.description,
    featured: value.featured,
    featuredOrder: value.featuredOrder,
    fingerprint,
    id: value.id,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    pinned: value.pinned,
    published: value.published,
    rowAvailability,
    scope,
    skillLinkCount: value.skillLinkCount,
    starterPrompts: value.starterPrompts,
    updatedAt: value.updatedAt
  };
}

export function decodeAssistantContent(value: unknown): AssistantContent | null {
  if (!isRecord(value)) return null;
  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  const category = decodeCategory(value.category);
  const runControls = decodeAssistantRunControls(value.runControls);
  const searchPlan = decodeSearchPlan(value.searchPlan);
  const knowledge = decodeKnowledgePlan(value.knowledgeSelection ?? {
    baseIds: value.knowledgeBaseIds
  });
  const rows = decodeAssistantRows(value.rows, "projection");
  const skillIds = value.skillIds;
  if (
    !(value.answerRules === null || boundedText(value.answerRules, ANSWER_RULES_MAX_LENGTH)) ||
    !avatar ||
    category === undefined ||
    typeof value.description !== "string" ||
    (value.responseReminder !== undefined && !boundedText(value.responseReminder, RESPONSE_REMINDER_MAX_LENGTH)) ||
    !knowledge.ok ||
    knowledge.plan.mode === "all_my_knowledge" ||
    knowledge.plan.mode === "inherited" && knowledge.plan.inheritedFrom !== "assistant" ||
    !stringArray(value.mcpServerIds) ||
    !nonEmptyString(value.name) ||
    !stringOrNull(value.providerModelId) ||
    !rows.ok ||
    !runControls ||
    !searchPlan.ok ||
    !stringArray(skillIds) ||
    !skillIds.every(boundedId) ||
    skillIds.some((id) => id !== id.trim()) ||
    new Set(skillIds).size !== skillIds.length ||
    !storedStarterPrompts(value.starterPrompts) ||
    typeof value.systemPrompt !== "string" ||
    value.systemPrompt.length > ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH
  ) {
    return null;
  }
  const decodedSkillModes = decodeAssistantSkillModes(skillIds, value.skillModes);
  const skills = decodeSkillsSelection(value.skills);
  if (!decodedSkillModes.ok || !skills) return null;

  return {
    answerRules: value.answerRules as string | null,
    avatar,
    category,
    description: value.description,
    responseReminder: typeof value.responseReminder === "string" ? value.responseReminder : "",
    knowledgeSelection: knowledge.plan,
    mcpServerIds: value.mcpServerIds,
    name: value.name,
    providerModelId: value.providerModelId,
    rows: rows.rows,
    runControls,
    searchPlan: searchPlan.plan,
    skillIds,
    skillModes: decodedSkillModes.modes,
    skills,
    starterPrompts: value.starterPrompts,
    systemPrompt: value.systemPrompt
  };
}

function decodePublicationView(value: unknown): AssistantPublicationView | null {
  if (
    !isRecord(value) ||
    !stringOrNull(value.groupId) ||
    !stringOrNull(value.groupName) ||
    !nonEmptyString(value.id) ||
    (value.scope !== "group" && value.scope !== "installation" && value.scope !== "project") ||
    !nonEmptyString(value.updatedAt)
  ) {
    return null;
  }
  if (value.scope === "group" && (!nonEmptyString(value.groupId) || !nonEmptyString(value.groupName))) {
    return null;
  }
  if ((value.scope === "installation" || value.scope === "project") &&
    (value.groupId !== null || value.groupName !== null)) return null;
  return {
    groupId: value.groupId,
    groupName: value.groupName,
    id: value.id,
    scope: value.scope,
    updatedAt: value.updatedAt
  };
}

function decodeProjectUsage(value: unknown): AssistantProjectUsage | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !nonNegativeInteger(value.otherProjectCount) ||
    !Array.isArray(value.projects)
  ) {
    return null;
  }
  const projects: AssistantProjectUsage["projects"] = [];
  for (const project of value.projects) {
    if (!isRecord(project) || Object.keys(project).length !== 2 ||
      !nonEmptyString(project.id) || !nonEmptyString(project.name)) return null;
    projects.push({ id: project.id, name: project.name });
  }
  return new Set(projects.map((project) => project.id)).size === projects.length
    ? { otherProjectCount: value.otherProjectCount, projects }
    : null;
}

const ownerOnlyDetailFields = ["featuredOrder", "listingRequest", "projects", "recentChatCount"] as const;

export function decodeAssistantDetail(value: unknown): AssistantDetail | null {
  if (!isRecord(value)) return null;
  const audience = decodeOwnerAudience(value.audience, value.owned);
  const availability = decodeAssistantAvailability(value.availability);
  const content = decodeAssistantContent(value.content);
  const scope = decodeScope(value.scope);
  const rowAvailability = typeof value.owned === "boolean"
    ? decodeAssistantRowAvailability(value.rowAvailability, value.owned)
    : null;
  if (
    typeof value.archived !== "boolean" ||
    audience === undefined ||
    !availability ||
    typeof value.featured !== "boolean" ||
    !nonEmptyString(value.id) ||
    typeof value.owned !== "boolean" ||
    (value.owned === false && !availability.ok && availability.dependencies !== undefined) ||
    (value.owned === false && ownerOnlyDetailFields.some((field) => value[field] !== undefined)) ||
    typeof value.ownerDisplayName !== "string" ||
    typeof value.pinned !== "boolean" ||
    !rowAvailability ||
    !scope ||
    !nonEmptyString(value.updatedAt) ||
    !content
  ) {
    return null;
  }

  let publications: AssistantPublicationView[] | undefined;
  if (value.publications !== undefined) {
    if (!Array.isArray(value.publications)) return null;
    const decoded = value.publications.map(decodePublicationView);
    if (decoded.some((entry) => entry === null)) return null;
    publications = decoded as AssistantPublicationView[];
  }

  if (value.version !== undefined && typeof value.version !== "number") return null;
  if (value.featuredOrder !== undefined && value.featuredOrder !== null &&
    !nonNegativeInteger(value.featuredOrder)) return null;
  if (value.featuredOrder !== undefined && (value.featuredOrder !== null) !== value.featured) return null;
  const listingRequest = value.listingRequest === undefined || value.listingRequest === null
    ? value.listingRequest
    : decodeAssistantListingStatus(value.listingRequest);
  if (value.listingRequest !== undefined && value.listingRequest !== null && !listingRequest) return null;
  const projects = value.projects === undefined ? undefined : decodeProjectUsage(value.projects);
  if (projects === null) return null;
  if (value.recentChatCount !== undefined && !nonNegativeInteger(value.recentChatCount)) return null;
  let skills: AssistantDetail["skills"];
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills)) return null;
    skills = [];
    for (const skill of value.skills) {
      if (!isRecord(skill) || !boundedId(skill.id) || !nonEmptyString(skill.name)) return null;
      if (skill.available !== undefined && typeof skill.available !== "boolean") return null;
      if (skill.mode !== undefined && skill.mode !== "pinned" && skill.mode !== "available") return null;
      if (skill.instructionApproxTokens !== undefined && (!Number.isSafeInteger(skill.instructionApproxTokens) || Number(skill.instructionApproxTokens) < 0)) return null;
      skills.push({ id: skill.id, name: skill.name, ...(skill.available === undefined ? {} : { available: skill.available }),
        ...(skill.mode === undefined ? {} : { mode: skill.mode }),
        ...(skill.instructionApproxTokens === undefined ? {} : { instructionApproxTokens: Number(skill.instructionApproxTokens) }) });
    }
    if (
      skills.length !== content.skillIds.length ||
      skills.some((skill, index) => skill.id !== content.skillIds[index])
    ) {
      return null;
    }
  }

  return {
    archived: value.archived,
    audience,
    availability,
    featured: value.featured,
    ...(value.featuredOrder !== undefined ? { featuredOrder: value.featuredOrder as number | null } : {}),
    id: value.id,
    ...(listingRequest !== undefined ? { listingRequest } : {}),
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    pinned: value.pinned,
    ...(projects ? { projects } : {}),
    ...(publications ? { publications } : {}),
    ...(value.recentChatCount !== undefined ? { recentChatCount: value.recentChatCount as number } : {}),
    rowAvailability,
    scope,
    content,
    ...(skills ? { skills } : {}),
    updatedAt: value.updatedAt,
    ...(value.version !== undefined ? { version: value.version } : {})
  };
}

export function decodeAssistantListResponse(value: unknown): AssistantListResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.assistants) ||
    !Array.isArray(value.publishableGroups) ||
    !Array.isArray(value.recentAssistantIds) ||
    value.recentAssistantIds.length > ASSISTANT_MAX_RECENT ||
    !isRecord(value.viewer) ||
    typeof value.viewer.canPublishInstallation !== "boolean" ||
    !(value.viewer.defaultAssistantId === null || nonEmptyString(value.viewer.defaultAssistantId))
  ) {
    return null;
  }
  const assistants = value.assistants.map(decodeAssistantSummary);
  if (assistants.some((assistant) => assistant === null)) return null;
  const listedIds = new Set((assistants as AssistantSummary[]).map((assistant) => assistant.id));
  const recentAssistantIds = value.recentAssistantIds;
  // Both references point into the list, so they never name an Assistant the
  // viewer cannot see.
  if (
    !recentAssistantIds.every((id) => typeof id === "string" && listedIds.has(id)) ||
    new Set(recentAssistantIds).size !== recentAssistantIds.length ||
    (value.viewer.defaultAssistantId !== null && !listedIds.has(value.viewer.defaultAssistantId))
  ) {
    return null;
  }
  const publishableGroups: AssistantPublishableGroup[] = [];
  for (const group of value.publishableGroups) {
    if (!isRecord(group) || !nonEmptyString(group.id) || !nonNegativeInteger(group.memberCount) ||
      !nonEmptyString(group.name)) {
      return null;
    }
    publishableGroups.push({ id: group.id, memberCount: group.memberCount, name: group.name });
  }
  return {
    assistants: assistants as AssistantSummary[],
    publishableGroups,
    recentAssistantIds: recentAssistantIds as string[],
    viewer: {
      canPublishInstallation: value.viewer.canPublishInstallation,
      defaultAssistantId: value.viewer.defaultAssistantId
    }
  };
}

export function decodeAssistantDetailResponse(value: unknown): AssistantDetailResponse | null {
  if (!isRecord(value)) return null;
  const assistant = decodeAssistantDetail(value.assistant);
  return assistant ? { assistant } : null;
}

export function decodeAssistantDuplicateResponse(value: unknown): AssistantDuplicateResponse | null {
  const detail = decodeAssistantDetailResponse(value);
  if (!detail || !isRecord(value) || !isRecord(value.report)) return null;
  const report = value.report;
  if (
    Object.keys(report).length !== 2 ||
    !Array.isArray(report.downgradedRows) ||
    !report.downgradedRows.every((row) => decodeAssistantRowKey(row) !== null) ||
    new Set(report.downgradedRows).size !== report.downgradedRows.length ||
    !nonNegativeInteger(report.droppedSkillCount)
  ) {
    return null;
  }
  return {
    ...detail,
    report: {
      downgradedRows: report.downgradedRows as AssistantRowKey[],
      droppedSkillCount: report.droppedSkillCount
    }
  };
}

export function decodeAssistantRunRowProvenance(value: unknown): AssistantRunRowProvenance | null {
  if (!isRecord(value) || Object.keys(value).length !== ASSISTANT_ROW_KEYS.length) return null;
  const provenance: Partial<Record<AssistantRowKey, AssistantRowProvenance>> = {};
  for (const key of ASSISTANT_ROW_KEYS) {
    const decoded = decodeAssistantRowProvenance(value[key]);
    if (!decoded) return null;
    provenance[key] = decoded;
  }
  return provenance as AssistantRunRowProvenance;
}
