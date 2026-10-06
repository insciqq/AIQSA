import { digestRows } from "./retire-memory-digests-adoption";

/** Synthetic v0.3.6 state; migration-contract owns the disposable database. */
export const DROP_RETIRED_MEMORY_DIGEST_SYNTHESIS_STORAGE_MIGRATION =
  "20261006150000_memory_drop_retired_digest_synthesis_storage";

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const retiredTables = quoted(["ChatMemoryDigest", "ChatMemoryDigestChunk", "ChatMemoryDigestMessage",
  "MemoryHistoryExecution", "MemorySynthesisExecution"]);
const retiredFunctions = quoted(["aiqsa_memory_digest_row_source_trigger()",
  "aiqsa_memory_digest_map_source_trigger()", "aiqsa_memory_assert_digest_sources_once(text)",
  "aiqsa_memory_assert_digest_sources(text)", "aiqsa_memory_history_execution_guard()",
  "aiqsa_memory_synthesis_execution_guard()"]);
const sharedFunctions = quoted(["aiqsa_memory_history_source_trigger()",
  "aiqsa_permanent_chat_child_write_guard()", "aiqsa_memory_source_guard_forget()",
  "aiqsa_memory_source_guard_passed(text)", "aiqsa_memory_source_guard_remember(text)"]);
// Every table the remaining history and recall-round source asserts read.
const sourceGuardTables = quoted(["Chat", "Message", "MemoryPauseInterval", "MemoryRecallChunk",
  "MemoryRecallChunkMessage", "MemoryRecallRound", "MemoryRecallRoundMessage", "ChatMemoryCheckpoint",
  "ChatMemoryCheckpointMessage"]);

// A live chat and one row in each retired table, as an older writer may leave
// them during an upgrade overlap; replica mode skips the guards and keys.
export const dropRetiredMemoryDigestSynthesisStorageFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-storage-drop-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('memory-storage-drop-chat', 'memory-storage-drop-owner', 'Synthetic chat', now());
SET LOCAL session_replication_role = replica;
${digestRows("memory-storage-drop-digest", "memory-storage-drop-owner", "memory-storage-drop-chat")}
INSERT INTO "MemoryHistoryExecution" (id, "userId", "memoryJobId", "executionBindingId", "inputHash",
  "acceptedOutputHash", "acceptedOutput", "recoverableUntil")
VALUES ('memory-storage-drop-history', 'memory-storage-drop-owner', 'memory-storage-drop-job',
  'memory-storage-drop-history-binding', repeat('a', 64), repeat('b', 64), '{"keys":["synthetic"]}'::jsonb,
  now() + interval '1 day');
INSERT INTO "MemorySynthesisExecution" (id, "userId", "memoryJobId", "executionBindingId", "inputHash",
  "acceptedOutputHash", "sourceSetFingerprint", "sourceSnapshotHash", "acceptedOutput", "sourceBindings")
VALUES ('memory-storage-drop-synthesis', 'memory-storage-drop-owner', 'memory-storage-drop-job',
  'memory-storage-drop-synthesis-binding', repeat('c', 64), repeat('d', 64), repeat('e', 64), repeat('f', 64),
  '{"patterns":[]}', '[]');
COMMIT;
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy. */
export const dropRetiredMemoryDigestSynthesisStorageProofSql = `
BEGIN;
DO $proof$ BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[${retiredTables}]) AS retired(name)
      WHERE to_regclass(format('%I', retired.name)) IS NOT NULL)
  THEN RAISE EXCEPTION 'retired_memory_storage_retained'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[${retiredFunctions}]) AS retired(signature)
      WHERE to_regprocedure(retired.signature) IS NOT NULL)
  THEN RAISE EXCEPTION 'retired_memory_storage_functions_retained'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[${sharedFunctions}]) AS shared(signature)
      WHERE to_regprocedure(shared.signature) IS NULL)
  THEN RAISE EXCEPTION 'shared_memory_guard_function_dropped'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = current_schema()
        AND routine.prosrc ~ '(ChatMemoryDigest|MemoryHistoryExecution|MemorySynthesisExecution)')
  THEN RAISE EXCEPTION 'retired_memory_storage_still_read'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[${sourceGuardTables}]) AS guarded(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger AS trigger_catalog
        WHERE trigger_catalog.tgrelid = to_regclass(format('%I', guarded.name))
          AND trigger_catalog.tgfoid = 'aiqsa_memory_source_guard_forget()'::regprocedure))
  THEN RAISE EXCEPTION 'memory_source_guard_forget_trigger_dropped'; END IF;
END $proof$;
-- The remaining deferred source guards still validate a write to the chat the
-- dropped rows belonged to.
UPDATE "Chat" SET title = 'Synthetic chat renamed' WHERE id = 'memory-storage-drop-chat';
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
`;
