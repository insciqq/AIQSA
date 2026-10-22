/**
 * Areas the operator disabled on 2026-10-22 ahead of removing their code:
 * Projects, Knowledge and the native Anthropic provider. No surface offers
 * them and the server refuses to create, change or use them with the stable
 * codes below. Their data stays where it is: Project chats stay readable and
 * nothing is deleted or migrated. These are constants, not configuration (no
 * environment variable or setting turns an area back on), so removing an area
 * means deleting every reference to its switch.
 */

/** No Project is created or changed and no Project chat admits a message; existing Project chats stay readable. */
export const PROJECTS_ENABLED: boolean = false;

/** No Knowledge base or document is created, changed or uploaded, and no run or Assistant selects Knowledge. */
export const KNOWLEDGE_ENABLED: boolean = false;

/** No native Anthropic connection or model is set up or enabled and none runs; Claude models through OpenRouter stay. */
export const NATIVE_ANTHROPIC_ENABLED: boolean = false;

export const PROJECTS_DISABLED_CODE = "projects_disabled";
export const KNOWLEDGE_DISABLED_CODE = "knowledge_disabled";
export const NATIVE_ANTHROPIC_DISABLED_CODE = "native_anthropic_disabled";

/** The provider families setup still offers, in their order: native Anthropic is left out while disabled. */
export function offeredProviderFamilies<Family extends string>(families: readonly Family[]): Family[] {
  return families.filter((family) => NATIVE_ANTHROPIC_ENABLED || family !== "anthropic");
}
