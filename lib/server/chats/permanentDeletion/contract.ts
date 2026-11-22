/**
 * The outbox target of a permanent chat deletion the previous release admitted through the Memory coordinator.
 * New deletions write no outbox row (the fence on the chat is the obligation); the Memory coordinator completes
 * such a row as a no-op (`lib/server/memory/deletionComposition.ts`) until the old tables are dropped.
 */
export const PERMANENT_CHAT_DELETION_MANIFEST_VERSION =
  "memory-chat-delete-v1" as const;
export const PERMANENT_CHAT_DELETION_TARGET_TYPE =
  `CHAT@${PERMANENT_CHAT_DELETION_MANIFEST_VERSION}` as const;
