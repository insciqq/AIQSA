import {
  decodeSearchPlan,
  MAX_SEARCH_PLAN_OPTIONS,
  type SearchPlan
} from "./search";
import {
  decodeKnowledgePlan,
  decodeKnowledgeSelection,
  type KnowledgeSelection
} from "./knowledge";
import { SKILL_MAX_SELECTED } from "./skills";

export const ASSISTANT_NAME_MAX_LENGTH = 80;
export const ASSISTANT_DESCRIPTION_MAX_LENGTH = 400;
export const ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH = 32_000;
export const ASSISTANT_DEVELOPER_PROMPT_MAX_LENGTH = 16_000;
export const ASSISTANT_STARTER_PROMPT_MAX_LENGTH = 400;
export const ASSISTANT_MAX_STARTER_PROMPTS = 4;
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

export type AssistantDraft = {
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  developerPrompt: string | null;
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  name: string;
  providerModelId: string;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
  skillIds: string[];
  starterPrompts: string[];
  systemPrompt: string;
};

export type AssistantDraftDecodeResult =
  | { code: string; field?: AssistantRunControlField; ok: false }
  | { draft: AssistantDraft; ok: true };

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 64;
}

/**
 * Strict decoder for create/revise payloads. Every bound fails closed with a
 * stable field-scoped code so the editor can attach errors to their section.
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

  if (!boundedId(value.providerModelId)) {
    return { code: "assistant_model_invalid", ok: false };
  }

  const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : null;
  if (systemPrompt === null || systemPrompt.length > ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH) {
    return { code: "assistant_system_prompt_invalid", ok: false };
  }

  const developerPrompt = value.developerPrompt ?? null;
  if (
    developerPrompt !== null &&
    (typeof developerPrompt !== "string" ||
      developerPrompt.length > ASSISTANT_DEVELOPER_PROMPT_MAX_LENGTH)
  ) {
    return { code: "assistant_developer_prompt_invalid", ok: false };
  }

  const runControls = decodeAssistantRunControls(value.runControls ?? {});
  if (!runControls) {
    const field = invalidAssistantRunControlField(value.runControls ?? {});
    return {
      code: "assistant_run_controls_invalid",
      ...(field ? { field } : {}),
      ok: false
    };
  }

  const decodedPlan = decodeSearchPlan(value.searchPlan);
  if (!decodedPlan.ok || decodedPlan.plan.optionIds.length > MAX_SEARCH_PLAN_OPTIONS) {
    return { code: "assistant_search_plan_invalid", ok: false };
  }

  const mcpServerIds = value.mcpServerIds ?? [];
  if (
    !Array.isArray(mcpServerIds) ||
    mcpServerIds.length > ASSISTANT_MAX_MCP_SERVERS ||
    !mcpServerIds.every(boundedId) ||
    new Set(mcpServerIds).size !== mcpServerIds.length
  ) {
    return { code: "assistant_mcp_servers_invalid", ok: false };
  }

  const knowledge = decodeKnowledgeSelection(value.knowledgeSelection);
  if (!knowledge.ok ||
    knowledge.plan.mode === "all_my_knowledge" || knowledge.plan.mode === "inherited") {
    return { code: "assistant_knowledge_bases_invalid", ok: false };
  }

  const skillIds = value.skillIds ?? [];
  const normalizedSkillIds = Array.isArray(skillIds)
    ? skillIds.map((id) => typeof id === "string" ? id.trim() : id)
    : skillIds;
  if (
    !Array.isArray(normalizedSkillIds) ||
    normalizedSkillIds.length > SKILL_MAX_SELECTED ||
    !normalizedSkillIds.every(boundedId) ||
    new Set(normalizedSkillIds).size !== normalizedSkillIds.length
  ) {
    return { code: "assistant_skills_invalid", ok: false };
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
      avatar,
      category: (category as AssistantCategory | null) ?? null,
      description,
      developerPrompt: typeof developerPrompt === "string" ? developerPrompt : null,
      knowledgeSelection: knowledge.plan,
      mcpServerIds: mcpServerIds.map((id) => (id as string).trim()),
      name,
      providerModelId: (value.providerModelId as string).trim(),
      runControls,
      searchPlan: decodedPlan.plan,
      skillIds: normalizedSkillIds as string[],
      starterPrompts: starterPromptsInput.map((starter) => (starter as string).trim()),
      systemPrompt
    },
    ok: true
  };
}

export type AssistantAvailabilityReason = "model_access" | "search_access" | "tools_access";

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

export type AssistantAccessScope =
  | { groupNames: string[]; kind: "group" }
  | { kind: "installation" }
  | { kind: "owner" };

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
  availability: AssistantAvailability;
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  fingerprint: AssistantCapabilityFingerprint;
  id: string;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  pinned: boolean;
  published: boolean;
  scope: AssistantAccessScope;
  starterPrompts: string[];
  updatedAt: string;
};

export type AssistantContent = {
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  developerPrompt: string | null;
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  name: string;
  providerModelId: string | null;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
  skillIds: string[];
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

export type AssistantDetail = {
  archived: boolean;
  availability: AssistantAvailability;
  id: string;
  owned: boolean;
  ownerDisplayName: string;
  pinned: boolean;
  publications?: AssistantPublicationView[];
  content: AssistantContent;
  skills?: { id: string; name: string }[];
  version?: number;
};

export type AssistantPublishableGroup = { id: string; name: string };

export type AssistantListResponse = {
  assistants: AssistantSummary[];
  /** The caller's active group memberships, usable as publication targets. */
  publishableGroups: AssistantPublishableGroup[];
  viewer: { canPublishInstallation: boolean };
};
export type AssistantDetailResponse = { assistant: AssistantDetail };
export type AssistantPublicationResponse = { publication: AssistantPublicationView };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function decodeAvailability(value: unknown): AssistantAvailability | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) return { ok: true };
  if (
    value.ok === false &&
    (value.reason === "model_access" || value.reason === "search_access" || value.reason === "tools_access")
  ) {
    let dependencies: AssistantAvailabilityDependency[] | undefined;
    if (value.dependencies !== undefined) {
      if (!Array.isArray(value.dependencies) || value.dependencies.length > 18) return null;
      dependencies = [];
      for (const dependency of value.dependencies) {
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
    }
    return {
      ...(dependencies ? { dependencies } : {}),
      ok: false,
      reason: value.reason
    };
  }
  return null;
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
  return null;
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

export function decodeAssistantSummary(value: unknown): AssistantSummary | null {
  if (!isRecord(value)) return null;
  const availability = decodeAvailability(value.availability);
  const avatar = decodeAssistantAvatarRecipe(value.avatar);
  const category = decodeCategory(value.category);
  const fingerprint = decodeFingerprint(value.fingerprint);
  const scope = decodeScope(value.scope);
  if (
    typeof value.archived !== "boolean" ||
    !availability ||
    !avatar ||
    category === undefined ||
    typeof value.description !== "string" ||
    !fingerprint ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.name) ||
    typeof value.owned !== "boolean" ||
    (value.owned === false && !availability.ok && availability.dependencies !== undefined) ||
    typeof value.ownerDisplayName !== "string" ||
    typeof value.pinned !== "boolean" ||
    typeof value.published !== "boolean" ||
    !scope ||
    !stringArray(value.starterPrompts) ||
    !nonEmptyString(value.updatedAt)
  ) {
    return null;
  }

  return {
    archived: value.archived,
    availability,
    avatar,
    category,
    description: value.description,
    fingerprint,
    id: value.id,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    pinned: value.pinned,
    published: value.published,
    scope,
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
  const skillIds = value.skillIds;
  if (
    !avatar ||
    category === undefined ||
    typeof value.description !== "string" ||
    !stringOrNull(value.developerPrompt) ||
    !knowledge.ok ||
    knowledge.plan.mode === "all_my_knowledge" ||
    knowledge.plan.mode === "inherited" && knowledge.plan.inheritedFrom !== "assistant" ||
    !stringArray(value.mcpServerIds) ||
    !nonEmptyString(value.name) ||
    !stringOrNull(value.providerModelId) ||
    !runControls ||
    !searchPlan.ok ||
    !stringArray(skillIds) ||
    !skillIds.every(boundedId) ||
    skillIds.some((id) => id !== id.trim()) ||
    skillIds.length > SKILL_MAX_SELECTED ||
    new Set(skillIds).size !== skillIds.length ||
    !stringArray(value.starterPrompts) ||
    typeof value.systemPrompt !== "string"
  ) {
    return null;
  }

  return {
    avatar,
    category,
    description: value.description,
    developerPrompt: value.developerPrompt,
    knowledgeSelection: knowledge.plan,
    mcpServerIds: value.mcpServerIds,
    name: value.name,
    providerModelId: value.providerModelId,
    runControls,
    searchPlan: searchPlan.plan,
    skillIds,
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

export function decodeAssistantDetail(value: unknown): AssistantDetail | null {
  if (!isRecord(value)) return null;
  const availability = decodeAvailability(value.availability);
  const content = decodeAssistantContent(value.content);
  if (
    typeof value.archived !== "boolean" ||
    !availability ||
    !nonEmptyString(value.id) ||
    typeof value.owned !== "boolean" ||
    (value.owned === false && !availability.ok && availability.dependencies !== undefined) ||
    typeof value.ownerDisplayName !== "string" ||
    typeof value.pinned !== "boolean" ||
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
  let skills: { id: string; name: string }[] | undefined;
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills)) return null;
    skills = [];
    for (const skill of value.skills) {
      if (!isRecord(skill) || !boundedId(skill.id) || !nonEmptyString(skill.name)) return null;
      skills.push({ id: skill.id, name: skill.name });
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
    availability,
    id: value.id,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    pinned: value.pinned,
    ...(publications ? { publications } : {}),
    content,
    ...(skills ? { skills } : {}),
    ...(value.version !== undefined ? { version: value.version } : {})
  };
}

export function decodeAssistantListResponse(value: unknown): AssistantListResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.assistants) ||
    !Array.isArray(value.publishableGroups) ||
    !isRecord(value.viewer) ||
    typeof value.viewer.canPublishInstallation !== "boolean"
  ) {
    return null;
  }
  const assistants = value.assistants.map(decodeAssistantSummary);
  if (assistants.some((assistant) => assistant === null)) return null;
  const publishableGroups: AssistantPublishableGroup[] = [];
  for (const group of value.publishableGroups) {
    if (!isRecord(group) || !nonEmptyString(group.id) || !nonEmptyString(group.name)) {
      return null;
    }
    publishableGroups.push({ id: group.id, name: group.name });
  }
  return {
    assistants: assistants as AssistantSummary[],
    publishableGroups,
    viewer: { canPublishInstallation: value.viewer.canPublishInstallation }
  };
}

export function decodeAssistantDetailResponse(value: unknown): AssistantDetailResponse | null {
  if (!isRecord(value)) return null;
  const assistant = decodeAssistantDetail(value.assistant);
  return assistant ? { assistant } : null;
}
