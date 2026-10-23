import type { AssistantRunMaterialization, AssistantRunResolver } from "../assistants/runMaterialization";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { SkillCatalogAuthorityChangedError } from "./catalogRelevanceService";
import type { SkillRunCatalogEntry, SkillRunResolver } from "./runMaterialization";

function identity(entries: readonly SkillRunCatalogEntry[]): string {
  return hashCanonicalMcpValue(entries.map(({ skillId, revisionId, name, description, fileCount, hasExecutables }) => ({
    skillId, revisionId, name, description: description ?? null,
    fileCount: fileCount ?? null, hasExecutables: hasExecutables ?? null
  })).sort((left, right) => left.skillId.localeCompare(right.skillId)));
}

/**
 * An Auto run offers its runner's enabled Skills as the catalog unless an
 * Assistant links Skills of its own: an Assistant that links none behaves like
 * an ordinary chat (`AssistantSkillsValue`), one with any link offers only its
 * links. The catalog is always the runner's, never the Assistant owner's.
 */
export function usesPersonalSkillCatalog(assistant: Pick<AssistantRunMaterialization, "skillIds"> | null): boolean {
  return !assistant || assistant.skillIds.length === 0;
}

/** Relevance can reduce an authorized catalog, never hide an unavailable
 * required binding or disclose metadata after its current authority changed. */
export function skillCatalogAuthorization(input: Readonly<{
  userId: string;
  assistant: AssistantRunMaterialization | null;
  assistants?: AssistantRunResolver;
  skills: SkillRunResolver;
  pinned: readonly SkillRunCatalogEntry[];
  available: readonly SkillRunCatalogEntry[];
  authorizeScope(): Promise<void>;
}>): () => Promise<void> {
  const expected = identity([...input.pinned, ...input.available]);
  const expectedAssistant = input.assistant ? hashCanonicalMcpValue(input.assistant) : null;
  const pinnedIds = new Set(input.pinned.map(skill => skill.skillId));
  const personalCatalog = usesPersonalSkillCatalog(input.assistant);
  const requiredIds = personalCatalog
    ? [...pinnedIds]
    : [...input.pinned, ...input.available].map(skill => skill.skillId);
  return async () => {
    await input.authorizeScope();
    if (input.assistant) {
      const resolution = await input.assistants?.resolveForRun(input.userId, input.assistant.assistantId);
      if (!resolution?.ok || hashCanonicalMcpValue(resolution.assistant) !== expectedAssistant) {
        throw new SkillCatalogAuthorityChangedError();
      }
    }
    const required = requiredIds.length === 0 ? { ok: true as const, skills: [] }
      : await input.skills.resolveForRun(input.userId, requiredIds);
    if (!required?.ok) throw new SkillCatalogAuthorityChangedError();
    const available = !personalCatalog ? []
      : (await input.skills.listEnabledForRun?.(input.userId) ?? []).filter(skill => !pinnedIds.has(skill.skillId));
    if (identity([...required.skills, ...available]) !== expected) throw new SkillCatalogAuthorityChangedError();
    await input.authorizeScope();
  };
}
