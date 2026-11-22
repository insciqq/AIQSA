/**
 * How long a Temporary chat lives: it is deleted a day after its last answer settled (or after a continuation made
 * it). The deadline on the chat row is the deletion obligation; the background worker deletes the chat once it has
 * passed (`lib/server/chats/temporaryDeletion.ts`).
 */
export const TEMPORARY_CHAT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function temporaryChatRetentionDeadline(now: Date): Date {
  const deadline = new Date(now.getTime() + TEMPORARY_CHAT_RETENTION_MS);
  if (!Number.isFinite(deadline.getTime())) throw new Error("temporary_chat_retention_clock_invalid");
  return deadline;
}
