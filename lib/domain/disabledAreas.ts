/**
 * Areas the operator disabled on 2026-10-22 ahead of removing their code:
 * Projects and Knowledge. No surface offers them and the server refuses to
 * create, change or use them with the stable codes below. Their data stays
 * where it is: Project chats stay readable and nothing is deleted or
 * migrated. These are constants, not configuration (no environment variable
 * or setting turns an area back on), so removing an area means deleting
 * every reference to its switch. Native Anthropic, disabled with them, stays
 * (operator decision 2026-10-23) and has no switch.
 */

/** No Project is created or changed and no Project chat admits a message; existing Project chats stay readable. */
export const PROJECTS_ENABLED: boolean = false;

/** No Knowledge base or document is created, changed or uploaded, and no run or Assistant selects Knowledge. */
export const KNOWLEDGE_ENABLED: boolean = false;

export const PROJECTS_DISABLED_CODE = "projects_disabled";
export const KNOWLEDGE_DISABLED_CODE = "knowledge_disabled";
