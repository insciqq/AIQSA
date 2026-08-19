export const DEFAULT_KNOWLEDGE_TRASH_RETENTION_DAYS = 30;

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export function knowledgeTrashPurgeScheduledAt(trashedAt: Date | null): Date | null {
  return trashedAt
    ? new Date(trashedAt.getTime() + DEFAULT_KNOWLEDGE_TRASH_RETENTION_DAYS * DAY_MILLISECONDS)
    : null;
}
