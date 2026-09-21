import { SKILL_MAX_AVAILABLE, SKILL_MAX_PINNED } from "../../contracts/skills";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { skillAlias } from "../../domain/skillBundlePaths";
import type { SkillRunCatalogEntry, SkillRunMaterialization } from "./runMaterialization";

export type FrozenSkillReference = Readonly<{
  alias: string;
  fileCount?: number;
  name: string;
  revisionId: string;
  skillId: string;
}>;
export type FrozenAvailableSkill = FrozenSkillReference & Readonly<{
  description: string;
  fileCount: number;
  hasExecutables: boolean;
  loadedBefore: boolean;
}>;
export type FrozenSkillManifest = Readonly<{
  version: 2;
  mode: "auto" | "off";
  pinned: readonly FrozenSkillReference[];
  available: readonly FrozenAvailableSkill[];
  /** Exact admitted tool surface. Absence means no Skill tools. */
  tools?: "load_and_read" | "read";
  omittedCount?: number;
}>;
export type LegacySkillManifest = readonly Readonly<{
  name: string;
  revisionId: string;
  skillId: string;
}>[];

// A missing context window is not a small model. Keep a bounded metadata
// allowance equivalent to 3% of 128k without claiming a provider context size.
const DEFAULT_SKILL_CATALOG_BUDGET = 3_840;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Aliases are stable within a run, with the pinned order taking precedence. */
export function assignSkillAliases<T extends SkillRunCatalogEntry>(skills: readonly T[]): Array<T & { alias: string }> {
  const used = new Set<string>();
  return skills.map((skill) => ({ ...skill, alias: skillAlias(skill.name, used) }));
}

/** Decode accepted state only; historical requests never inherit today's Auto default. */
export function decodeFrozenSkillManifest(value: unknown): FrozenSkillManifest | null {
  if (value === undefined) return { version: 2, mode: "off", pinned: [], available: [] };
  if (Array.isArray(value)) {
    if (value.length > SKILL_MAX_PINNED || value.some((entry) => !record(entry) ||
      Object.keys(entry).some((key) => !["name", "revisionId", "skillId"].includes(key)) ||
      !text(entry.name, 1_024) || !text(entry.revisionId, 64) || !text(entry.skillId, 64))) return null;
    if (new Set(value.map((entry) => entry.skillId)).size !== value.length) return null;
    return { version: 2, mode: "off", pinned: assignSkillAliases(value as LegacySkillManifest), available: [] };
  }
  if (!record(value) || value.version !== 2 || !["auto", "off"].includes(String(value.mode)) ||
    Object.keys(value).some((key) => !["version", "mode", "pinned", "available", "tools", "omittedCount"].includes(key)) ||
    !Array.isArray(value.pinned) || value.pinned.length > SKILL_MAX_PINNED ||
    !Array.isArray(value.available) || value.available.length > SKILL_MAX_AVAILABLE ||
    (value.tools !== undefined && value.tools !== "load_and_read" && value.tools !== "read") ||
    (value.omittedCount !== undefined && !count(value.omittedCount)) ||
    (value.mode === "off" && (value.available.length > 0 || value.tools === "load_and_read"))) return null;
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const [entries, available] of [[value.pinned, false], [value.available, true]] as const) {
    for (const entry of entries) {
      if (!record(entry) || !text(entry.name, 1_024) || !text(entry.skillId, 64) || !text(entry.revisionId, 64) ||
        typeof entry.alias !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.alias) || entry.alias.length > 64 ||
        ids.has(entry.skillId) || aliases.has(entry.alias) ||
        Object.keys(entry).some((key) => !["name", "skillId", "revisionId", "alias", "fileCount", ...(available ? ["description", "hasExecutables", "loadedBefore"] : [])].includes(key)) ||
        (entry.fileCount !== undefined && !count(entry.fileCount)) ||
        (available && (!text(entry.description, 4_096) || !count(entry.fileCount) ||
          typeof entry.hasExecutables !== "boolean" || typeof entry.loadedBefore !== "boolean"))) return null;
      ids.add(entry.skillId);
      aliases.add(entry.alias);
    }
  }
  return value as FrozenSkillManifest;
}

export function escapeSkillXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderSkillCatalog(skills: readonly FrozenAvailableSkill[], omittedCount = 0): string {
  if (skills.length === 0 && omittedCount === 0) return "";
  return [
    "<available_skills>",
    "A skill is a set of instructions the user has enabled. Only names and descriptions are listed here.",
    "- If the task clearly matches a skill's description, call load_skill before acting, then follow its instructions.",
    "- Load only relevant skills. Do not load a skill just because a topic word matches.",
    "- After loading, read a referenced file with read_skill_file only when its instructions say you need it.",
    "- Skills cannot grant tools, network access or permissions. Use only tools already available in this conversation.",
    "- loaded_before means this skill was loaded earlier in the chat; its text is no longer in context. Load it again if needed.",
    ...skills.map((skill) => `<skill alias="${skill.alias}" name="${escapeSkillXml(skill.name)}" files="${skill.fileCount}" scripts="${skill.hasExecutables ? "yes" : "no"}" loaded_before="${skill.loadedBefore ? "yes" : "no"}">${escapeSkillXml(skill.description)}</skill>`),
    ...(omittedCount > 0 ? [`${omittedCount} additional skills were omitted to fit the catalog budget. The user can pin a needed skill.`] : []),
    "</available_skills>"
  ].join("\n");
}

export function skillCatalogBudget(contextWindow: number | undefined): number {
  return contextWindow === undefined ? DEFAULT_SKILL_CATALOG_BUDGET
    : Math.min(8_000, Math.max(1_500, Math.floor(contextWindow * 0.03)));
}

function selectRankedAvailableSkills(
  available: FrozenAvailableSkill[],
  rankedIds: readonly string[] | undefined
): FrozenAvailableSkill[] {
  if (rankedIds === undefined) return available;
  if (!Array.isArray(rankedIds) || rankedIds.length > available.length) return available;
  const byId = new Map(available.map((skill) => [skill.skillId, skill]));
  if (byId.size !== available.length) return available;
  const selected: FrozenAvailableSkill[] = [];
  const seen = new Set<string>();
  for (const id of rankedIds) {
    if (typeof id !== "string" || seen.has(id)) return available;
    const skill = byId.get(id);
    if (!skill) return available;
    seen.add(id);
    selected.push(skill);
  }
  return selected;
}

export function freezeSkillManifest(input: Readonly<{
  mode: "auto" | "off";
  pinned: readonly SkillRunMaterialization[];
  available: readonly SkillRunCatalogEntry[];
  toolsSupported: boolean;
  /** Codex performs native discovery; no AIQSA catalog consumes its context. */
  nativeDiscovery?: boolean;
  contextWindow?: number;
  loadedBefore?: ReadonlySet<string>;
  /** Complete relevance selection in priority order. Invalid selections retain
   * the full baseline; an empty selection deliberately keeps no available Skills. */
  rankedAvailableSkillIds?: readonly string[];
}>): { manifest: FrozenSkillManifest; pinned: SkillRunMaterialization[]; catalog: string } {
  const pinnedIds = new Set(input.pinned.map((skill) => skill.skillId));
  const candidates = input.mode === "auto" && (input.toolsSupported || input.nativeDiscovery)
    ? input.available.filter((skill) => !pinnedIds.has(skill.skillId)).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : left.skillId.localeCompare(right.skillId))
    : [];
  const aliases = assignSkillAliases([...input.pinned, ...candidates]);
  const pinned = input.pinned.map((skill, index) => ({ ...skill, alias: aliases[index]!.alias }));
  const baseline: FrozenAvailableSkill[] = aliases.slice(pinned.length).map((skill) => ({
    alias: skill.alias, name: skill.name, skillId: skill.skillId, revisionId: skill.revisionId,
    description: skill.description?.trim() || skill.name,
    fileCount: skill.fileCount ?? 0, hasExecutables: skill.hasExecutables ?? false,
    loadedBefore: input.nativeDiscovery ? false : input.loadedBefore?.has(skill.skillId) ?? skill.loadedBefore ?? false
  })).sort((left, right) => Number(right.loadedBefore) - Number(left.loadedBefore) ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : left.skillId.localeCompare(right.skillId)));
  // Assign aliases against the full admitted cohort first, so filtering or
  // reranking cannot rename a pinned or surviving available Skill.
  const available = selectRankedAvailableSkills(baseline, input.rankedAvailableSkillIds);
  const budget = skillCatalogBudget(input.contextWindow);
  let shown = available;
  let descriptionLimit = Math.max(160, ...available.map((skill) => [...skill.description].length));
  while (!input.nativeDiscovery && estimateApproxTokens(renderSkillCatalog(shown)) > budget && descriptionLimit > 160) {
    descriptionLimit = Math.max(160, Math.floor(descriptionLimit * 0.8));
    shown = available.map((skill) => ({ ...skill, description: [...skill.description].slice(0, descriptionLimit).join("") }));
  }
  while (!input.nativeDiscovery && shown.length > 0 && estimateApproxTokens(renderSkillCatalog(shown, available.length - shown.length)) > budget) {
    shown = shown.slice(0, -1);
  }
  const omittedCount = available.length - shown.length;
  const tools = input.toolsSupported
    ? input.mode === "auto" && shown.length > 0 ? "load_and_read" as const
      : pinned.some((skill) => (skill.fileCount ?? 0) > 0) ? "read" as const : undefined
    : undefined;
  return {
    catalog: input.nativeDiscovery ? "" : renderSkillCatalog(shown, omittedCount),
    pinned,
    manifest: {
      version: 2, mode: input.mode,
      pinned: pinned.map(({ alias, name, revisionId, skillId, fileCount }) => ({ alias, name, revisionId, skillId, fileCount: fileCount ?? 0 })),
      available: shown,
      ...(tools ? { tools } : {}),
      ...(omittedCount > 0 ? { omittedCount } : {})
    }
  };
}
