-- Personal Memory is replaced by the note and past-chat search (operator decision 2026-11-22). From this release on
-- nothing keeps the old Memory history in step with chats and messages: chat and message writers mark the past-chat
-- index instead, the old coordinator no longer runs, and the drop migration of this release removes the old tables.
--
-- Two kinds of old guard would now refuse ordinary writes on chats that still hold old Memory rows:
--
-- * The deferred source guards compare old history rows with their chat: a READY checkpoint whose leaf is no longer
--   the chat's, an ACTIVE chunk or round of a message no longer on the active branch, or any of them on a chat that
--   became Excluded. The old source hooks kept those rows in step on every send, settlement, branch switch, edit,
--   deletion and mode change; without them the next such write of the chat failed at commit.
-- * Restrictive keys from old Memory rows refused deleting a message, a folder or an Assistant those rows still name
--   (a checkpoint's leaf, a chunk's source or folder, a fact's evidence, a fact scope), which the same hooks used to
--   move, orphan or clear first.
--
-- Both go here. The rows stay, unread, for the data migration and the drop; the guard functions stay for the drop to
-- remove with the rest. Every statement tolerates a repeated deploy.

DROP TRIGGER IF EXISTS "Chat_memory_history_source_guard" ON "Chat";
DROP TRIGGER IF EXISTS "Chat_recall_round_source_guard" ON "Chat";
DROP TRIGGER IF EXISTS "ChatMemoryCheckpoint_source_guard" ON "ChatMemoryCheckpoint";
DROP TRIGGER IF EXISTS "ChatMemoryCheckpoint_recall_round_source_guard" ON "ChatMemoryCheckpoint";
DROP TRIGGER IF EXISTS "ChatMemoryCheckpointMessage_recall_round_source_guard" ON "ChatMemoryCheckpointMessage";
DROP TRIGGER IF EXISTS "MemoryRecallChunk_source_guard" ON "MemoryRecallChunk";
DROP TRIGGER IF EXISTS "MemoryRecallChunk_round_source_guard" ON "MemoryRecallChunk";
DROP TRIGGER IF EXISTS "MemoryRecallChunkMessage_source_guard" ON "MemoryRecallChunkMessage";
DROP TRIGGER IF EXISTS "MemoryRecallRound_source_guard" ON "MemoryRecallRound";
DROP TRIGGER IF EXISTS "MemoryRecallRoundMessage_source_guard" ON "MemoryRecallRoundMessage";
DROP TRIGGER IF EXISTS "MemoryToolEvent_source_guard" ON "MemoryToolEvent";

ALTER TABLE "ChatMemoryCheckpoint"
  DROP CONSTRAINT IF EXISTS "ChatMemoryCheckpoint_active_leaf_fkey",
  DROP CONSTRAINT IF EXISTS "ChatMemoryCheckpoint_last_indexed_message_fkey";
ALTER TABLE "ChatMemoryCheckpointMessage" DROP CONSTRAINT IF EXISTS "ChatMemoryCheckpointMessage_message_fkey";
ALTER TABLE "MemoryCandidateMessage" DROP CONSTRAINT IF EXISTS "MemoryCandidateMessage_message_fkey";
ALTER TABLE "MemoryEvidence" DROP CONSTRAINT IF EXISTS "MemoryEvidence_message_fkey";
ALTER TABLE "MemoryJob" DROP CONSTRAINT IF EXISTS "MemoryJob_leaf_fkey";
ALTER TABLE "MemoryMutationAuthorization" DROP CONSTRAINT IF EXISTS "MemoryMutationAuthorization_message_fkey";
ALTER TABLE "MemoryRecallChunk" DROP CONSTRAINT IF EXISTS "MemoryRecallChunk_folder_fkey";
ALTER TABLE "MemoryRecallChunkMessage" DROP CONSTRAINT IF EXISTS "MemoryRecallChunkMessage_message_fkey";
ALTER TABLE "MemoryRecallRound" DROP CONSTRAINT IF EXISTS "MemoryRecallRound_folder_fkey";
ALTER TABLE "MemoryRecallRoundMessage" DROP CONSTRAINT IF EXISTS "MemoryRecallRoundMessage_message_fkey";
ALTER TABLE "MemoryRetrievalAttempt"
  DROP CONSTRAINT IF EXISTS "MemoryRetrievalAttempt_assistant_message_fkey",
  DROP CONSTRAINT IF EXISTS "MemoryRetrievalAttempt_pre_leaf_fkey",
  DROP CONSTRAINT IF EXISTS "MemoryRetrievalAttempt_user_message_fkey";
ALTER TABLE "MemoryScope"
  DROP CONSTRAINT IF EXISTS "MemoryScope_assistant_fkey",
  DROP CONSTRAINT IF EXISTS "MemoryScope_folder_fkey";
ALTER TABLE "MemorySuppression" DROP CONSTRAINT IF EXISTS "MemorySuppression_message_fkey";
