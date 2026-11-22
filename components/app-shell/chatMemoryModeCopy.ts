/**
 * The words of a chat's Memory mode: Archive and Restore, Exclude from Memory
 * and its Resume, imported chats and Temporary chats. English only
 * (`agent_docs/FRONTEND.md`). Memory is the note and past-chat search: an
 * Excluded or Temporary chat neither reads nor changes Memory, and past-chat
 * search never finds it (`agent_docs/MEMORY.md`).
 */
const CHAT_MEMORY_MODE_COPY = Object.freeze({
  "archive.action": "Archive",
  "archive.explanation": "Moves this chat out of the active list. Past-chat search can still find it.",
  "exclude.action": "Exclude from Memory",
  "exclude.explanation": "Keeps the chat, but past-chat search no longer finds it, and it neither reads nor changes your Memory note. Archive status does not change.",
  "imported.unavailable": "Imported chats don't use Memory",
  "restore.action": "Restore",
  "resume.action": "Resume Memory for this chat",
  "resume.explanation": "Past-chat search can find this chat again, its earlier messages included.",
  "temporary.explanation": "Temporary Chat neither reads nor changes your Memory, is never found by past-chat search, cannot be converted to a retained chat, and cannot be shared.",
  "temporary.externalRetention": "External providers and tools may retain data under their disclosed policies; operator backups are a separate domain.",
  "temporary.label": "Temporary Chat",
  "temporary.retention": "The complete chat aggregate is scheduled for durable deletion 24 hours after the last terminal run, or after creation or last local activity if no run settles."
});

export type ChatMemoryModeCopyKey = keyof typeof CHAT_MEMORY_MODE_COPY;

export function chatMemoryModeCopy(key: ChatMemoryModeCopyKey): string {
  return CHAT_MEMORY_MODE_COPY[key];
}
