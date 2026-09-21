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

/** Relevance can reduce an authorized catalog, never hide an unavailable
 * required binding or disclose metadata after its current authority changed. */
export function skillCatalogAuthorization(input: Readonly<{
  userId: string;
  projectId?: string;
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
  const requiredIds = input.assistant || input.projectId
    ? [...input.pinned, ...input.available].map(skill => skill.skillId)
    : [...pinnedIds];
  return async () => {
    await input.authorizeScope();
    if (input.assistant) {
      const resolution = input.projectId
        ? await input.assistants?.resolveForProject?.(input.projectId, input.assistant.assistantId)
        : await input.assistants?.resolveForRun(input.userId, input.assistant.assistantId);
      if (!resolution?.ok || hashCanonicalMcpValue(resolution.assistant) !== expectedAssistant) {
        throw new SkillCatalogAuthorityChangedError();
      }
    }
    const required = requiredIds.length === 0 ? { ok: true as const, skills: [] }
      : input.projectId
        ? await input.skills.resolveForProject?.(input.projectId, requiredIds)
        : await input.skills.resolveForRun(input.userId, requiredIds);
    if (!required?.ok) throw new SkillCatalogAuthorityChangedError();
    const available = input.assistant || input.projectId ? []
      : (await input.skills.listEnabledForRun?.(input.userId) ?? []).filter(skill => !pinnedIds.has(skill.skillId));
    if (identity([...required.skills, ...available]) !== expected) throw new SkillCatalogAuthorityChangedError();
    await input.authorizeScope();
  };
}
