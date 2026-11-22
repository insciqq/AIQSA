import { memoryNoteAdoptionFixtureSql } from "./memory-note-adoption";

/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const DROP_OLD_MEMORY_MIGRATION = "20261122150000_drop_old_memory";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const INTERRUPTED = "This answer was interrupted when the server restarted. Its work so far is kept; use Continue to pick it up.";

/** The memory note's tables, and the enums of the chat's Memory mode and the note, keep "Memory" in their names. */
const KEPT_TABLES = ["UserMemoryNote", "MemoryNoteOffer", "MemoryLegacySuggestion"] as const;
const KEPT_ENUMS = ["MemoryChatMode", "MemoryNoteAuthor", "MemoryNoteOperation", "MemoryNoteOfferState",
  "MemoryLegacySuggestionOrigin"] as const;
/** Columns of tables that stay whose names mention Memory and that stay with them. */
const KEPT_COLUMNS = [["Chat", "memoryMode"], ["UserSettings", "memoryEnabled"], ["UserSettings", "memorySuggestionsEnabled"],
  ["ScheduledTask", "memoryEnabled"], ["ModelPolicy", "memorySearchTimeoutSeconds"], ["Folder", "projectMemory"]] as const;
/** Constraints of tables that stay named after Memory: the chat's mode and Temporary shape, the run request shape, the
 * Memory search time limit. */
const KEPT_CONSTRAINTS = ["Chat_memory_state_check", "Chat_import_memory_excluded_check", "ModelRun_memory_request_shape_check",
  "ModelPolicy_memory_search_timeout_check"] as const;
/** Routines the drop removes although their names do not say Memory. */
const RETIRED_GENERIC_ROUTINES = ["aiqsa_permanent_chat_source_snapshot_write_guard", "aiqsa_permanent_chat_source_write_guard",
  "usage_event_legacy_model_class", "usage_event_legacy_purpose", "usage_event_legacy_writer_purpose"] as const;
const DROPPED_COLUMNS = ["memoryExecutionBindingId", "memoryBranchGeneration", "memorySourceRevision", "sourceRevisionAdvance"];

const list = (values: readonly string[]): string => values.map(quote).join(", ");
const OLD_IDENTIFIER = `'"((ChatMemory|ModelRunMemory|UserMemory|Memory)[A-Za-z]*)"'`;

/**
 * Every object of the old subsystem the catalog could still hold, as one text listing them (empty when none):
 * relations (tables, indexes, sequences, views), enums and domains, routines, triggers, constraints and columns whose
 * names mention Memory, and routines or constraints that name a dropped table, enum or column or call a dropped routine.
 * The exceptions are the chat's Memory mode with its index, checks and guard, the memory note's tables and enums, the
 * run request shape check, the Memory switches of settings and scheduled tasks, the Memory search time limit and the
 * retired Project memory column. `fixtureTables` leaves out tables a migration proof created for itself.
 */
export function oldMemoryLeftoverSql(fixtureTables: readonly string[] = []): string {
  const fixtures = list(fixtureTables.length > 0 ? fixtureTables : [""]);
  return `(WITH kept_table(name) AS (VALUES ${KEPT_TABLES.map((name) => `(${quote(name)})`).join(", ")}
  ), kept_name(name) AS (
    SELECT name FROM kept_table UNION ALL VALUES ${KEPT_ENUMS.map((name) => `(${quote(name)})`).join(", ")}
  ), found AS (
    SELECT 'relation ' || relation.relname AS item
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_index AS index_row ON index_row.indexrelid = relation.oid
    LEFT JOIN pg_class AS indexed ON indexed.oid = index_row.indrelid
    LEFT JOIN pg_depend AS owner_row ON owner_row.objid = relation.oid AND owner_row.classid = 'pg_class'::regclass
      AND owner_row.refclassid = 'pg_class'::regclass AND owner_row.deptype = 'a' AND relation.relkind = 'S'
    LEFT JOIN pg_class AS owner ON owner.oid = owner_row.refobjid
    WHERE namespace.nspname = current_schema() AND relation.relname ~* 'memory'
      AND relation.relname NOT IN (SELECT name FROM kept_table)
      AND COALESCE(indexed.relname, owner.relname, '') NOT IN (SELECT name FROM kept_table)
      AND relation.relname <> 'Chat_memoryMode_temporaryRetentionDeadline_idx'
      AND relation.relname NOT IN (${fixtures})
    UNION ALL
    SELECT 'type ' || type_row.typname
    FROM pg_type AS type_row
    JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
    WHERE namespace.nspname = current_schema() AND type_row.typtype IN ('e', 'd') AND type_row.typname ~* 'memory'
      AND type_row.typname NOT IN (SELECT name FROM kept_name)
    UNION ALL
    SELECT 'routine ' || routine.oid::regprocedure::text
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = current_schema()
      AND ((routine.proname ~* 'memory' AND routine.proname <> 'aiqsa_chat_memory_mode_guard')
        OR routine.proname IN (${list(RETIRED_GENERIC_ROUTINES)})
        OR routine.prosrc ~ '"(${DROPPED_COLUMNS.join("|")})"'
        OR routine.prosrc ~ '\\maiqsa_memory_'
        OR EXISTS (SELECT 1 FROM regexp_matches(routine.prosrc, ${OLD_IDENTIFIER}, 'g') AS named(parts)
          WHERE named.parts[1] NOT IN (SELECT name FROM kept_name)))
    UNION ALL
    SELECT 'trigger ' || relation.relname || '.' || trigger_row.tgname
    FROM pg_trigger AS trigger_row
    JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND NOT trigger_row.tgisinternal
      AND relation.relname NOT IN (SELECT name FROM kept_table)
      AND trigger_row.tgname ~* 'memory' AND trigger_row.tgname <> 'Chat_memory_mode_guard'
    UNION ALL
    SELECT 'constraint ' || relation.relname || '.' || constraint_row.conname
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND relation.relname NOT IN (SELECT name FROM kept_table)
      AND ((constraint_row.conname ~* 'memory' AND constraint_row.conname NOT IN (${list(KEPT_CONSTRAINTS)}))
        OR pg_get_constraintdef(constraint_row.oid) ~ '''memory-(job|delete)''|"(${DROPPED_COLUMNS.join("|")})"'
        OR EXISTS (SELECT 1 FROM regexp_matches(pg_get_constraintdef(constraint_row.oid), ${OLD_IDENTIFIER}, 'g') AS named(parts)
          WHERE named.parts[1] NOT IN (SELECT name FROM kept_name)))
    UNION ALL
    SELECT 'column ' || relation.relname || '.' || attribute.attname
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND relation.relkind IN ('r', 'p', 'v', 'm')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND (attribute.attname ~* 'memory' OR attribute.attname IN (${list(DROPPED_COLUMNS)}))
      AND relation.relname NOT IN (SELECT name FROM kept_table) AND relation.relname NOT IN (${fixtures})
      AND (relation.relname::text, attribute.attname::text) NOT IN (VALUES
        ${KEPT_COLUMNS.map(([table, column]) => `(${quote(table)}, ${quote(column)})`).join(", ")})
  )
  SELECT COALESCE(string_agg(item, ', ' ORDER BY item), '') FROM found)`;
}

/** One digest of a table's rows (less the named keys), so a proof can show they did not change. */
const rowsDigest = (table: string, where = "TRUE", minus: readonly string[] = []): string => {
  const row = minus.length > 0 ? `(to_jsonb(r) - ARRAY[${list(minus)}]::text[])` : "to_jsonb(r)";
  return `(SELECT md5(COALESCE(string_agg(${row}::text, ',' ORDER BY ${row}::text), '')) FROM "${table}" AS r WHERE ${where})`;
};

const STUCK_RUNS = ["dom-stuck-run", "dom-temporary-run"];
const STUCK_CHATS = ["dom-stuck-chat", "dom-temporary-chat"];
const STUCK_ANSWERS = ["dom-stuck-answer", "dom-temporary-answer"];

/** What the drop must leave as it was: the note, offers, suggestions, the past-chat index, the worker's tables, settings,
 * roles, inbound OAuth, every other chat, run and message, and every usage row less its execution binding. */
const keptDigest = `md5(concat_ws('|', ${[
  ...["User", "UserSettings", "UserMemoryNote", "MemoryNoteOffer", "MemoryLegacySuggestion", "ChatSearchState",
    "ChatSearchPassage", "BackgroundWorkItem", "BackgroundWorkerHeartbeat", "SystemModelPolicy", "ProviderConnection",
    "ProviderModel", "InboundMcpOAuthClient", "InboundMcpOAuthGrant", "InboundMcpOAuthTokenFamily", "InboundMcpOAuthToken",
    "InboundMcpOAuthAuthorizationCode", "ChatPdfRunPreparation", "ModelRunToolCall"].map((table) => rowsDigest(table)),
  rowsDigest("Chat", `r.id NOT IN (${list(STUCK_CHATS)})`, ["memoryBranchGeneration", "memorySourceRevision"]),
  rowsDigest("ModelRun", `r.id NOT IN (${list(STUCK_RUNS)})`),
  rowsDigest("Message", `r.id NOT IN (${list(STUCK_ANSWERS)})`),
  rowsDigest("UsageEvent", "TRUE", ["memoryExecutionBindingId"])
].join(",\n  ")}))`;

const question = `'{"blocks":[{"type":"text","text":"Synthetic question"}]}'`;

// The memory note adoption's fixture fills the big old tables (facts, versions, events, evidence, scopes, pauses,
// deletion outbox, settings, the utility policy), with chats fenced for deletion and inbound OAuth grants. On top of it:
// two runs the previous release left preparing for Memory (an ordinary chat and a Temporary one), written as it wrote
// them so the old guards accept them; then, in replica mode, which skips triggers and foreign keys but keeps checks,
// a run waiting at its PDF gate and one at its Workspace gate, usage with and without an execution binding, and a row
// in each table that stays (note, offer, suggestion, past-chat state and passage, worker item and heartbeat).
export const dropOldMemoryFixtureSql = `
BEGIN;
${memoryNoteAdoptionFixtureSql}
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('dom-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "createdAt", "updatedAt")
VALUES ('dom-stuck-chat', 'dom-owner', 'Synthetic chat', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour', now());
INSERT INTO "Chat" (id, "userId", title, "memoryMode", "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
  "createdAt", "updatedAt")
VALUES ('dom-temporary-chat', 'dom-owner', 'Synthetic chat', 'TEMPORARY', 'temporary-24h-v1',
  (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 hour', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 hour', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt") VALUES
  ('dom-stuck-question', 'dom-stuck-chat', 'user', 'complete', ${question}, NULL, now()),
  ('dom-stuck-answer', 'dom-stuck-chat', 'assistant', 'streaming', '{"blocks":[]}', 'dom-stuck-question', now()),
  ('dom-temporary-question', 'dom-temporary-chat', 'user', 'complete', ${question}, NULL, now()),
  ('dom-temporary-answer', 'dom-temporary-chat', 'assistant', 'queued', '{"blocks":[]}', 'dom-temporary-question', now());
UPDATE "Chat" SET "activeLeafMessageId" = 'dom-stuck-answer' WHERE id = 'dom-stuck-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'dom-temporary-answer' WHERE id = 'dom-temporary-chat';
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status, engine,
  "updatedAt") VALUES
  ('dom-stuck-run', 'dom-owner', 'dom-stuck-chat', 'dom-stuck-question', 'dom-stuck-answer', 'fake', 'synthetic-model',
    'preparing', 'native', now()),
  ('dom-temporary-run', 'dom-owner', 'dom-temporary-chat', 'dom-temporary-question', 'dom-temporary-answer', 'fake',
    'synthetic-model', 'preparing', 'native', now());
INSERT INTO "MemoryRetrievalAttempt" (id, "userId", "modelRunId", "attemptOrdinal", "chatId", "admissionKind",
  "admittedUserMessageId", "admittedAssistantLeafMessageId", "chatMemoryModeSnapshot", "settingsSnapshot",
  "memoryGenerationSnapshot", "retrievalRevisionSnapshot", "utilityEgressMode", "queryHash",
  "boundedPrivateBaseRequestSnapshot", "baseRequestHash", state, "expiresAt", "updatedAt") VALUES
  ('dom-stuck-attempt', 'dom-owner', 'dom-stuck-run', 0, 'dom-stuck-chat', 'NORMAL_SEND', 'dom-stuck-question',
    'dom-stuck-answer', 'NORMAL', '{}', 0, 0, 'LOCAL_ONLY', repeat('c', 64), '{}', repeat('b', 64), 'PENDING',
    CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP),
  ('dom-temporary-attempt', 'dom-owner', 'dom-temporary-run', 0, 'dom-temporary-chat', 'NORMAL_SEND',
    'dom-temporary-question', 'dom-temporary-answer', 'TEMPORARY', '{}', 0, 0, 'LOCAL_ONLY', repeat('c', 64), '{}',
    repeat('b', 64), 'EXECUTING', CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP);
COMMIT;

BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES
  ('dom-indexed-chat', 'dom-owner', 'Synthetic chat', now()),
  ('dom-pdf-chat', 'dom-owner', 'Synthetic chat', now()),
  ('dom-workspace-chat', 'dom-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt") VALUES
  ('dom-indexed-question', 'dom-indexed-chat', 'user', 'complete', ${question}, NULL, now()),
  ('dom-indexed-answer', 'dom-indexed-chat', 'assistant', 'complete',
    '{"blocks":[{"type":"text","text":"Synthetic answer"}]}', 'dom-indexed-question', now()),
  ('dom-pdf-question', 'dom-pdf-chat', 'user', 'complete', ${question}, NULL, now()),
  ('dom-pdf-answer', 'dom-pdf-chat', 'assistant', 'streaming', '{"blocks":[]}', 'dom-pdf-question', now()),
  ('dom-workspace-question', 'dom-workspace-chat', 'user', 'complete', ${question}, NULL, now()),
  ('dom-workspace-answer', 'dom-workspace-chat', 'assistant', 'streaming', '{"blocks":[]}', 'dom-workspace-question', now());
UPDATE "Chat" SET "activeLeafMessageId" = 'dom-indexed-answer' WHERE id = 'dom-indexed-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'dom-pdf-answer' WHERE id = 'dom-pdf-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'dom-workspace-answer' WHERE id = 'dom-workspace-chat';
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", "workspaceWaitPending", engine, "updatedAt") VALUES
  ('dom-indexed-run', 'dom-owner', 'dom-indexed-chat', 'dom-indexed-question', 'dom-indexed-answer', 'fake',
    'synthetic-model', 'complete', '{}', false, 'native', now()),
  ('dom-pdf-run', 'dom-owner', 'dom-pdf-chat', 'dom-pdf-question', 'dom-pdf-answer', 'fake', 'synthetic-model',
    'preparing', NULL, false, 'native', now()),
  ('dom-workspace-run', 'dom-owner', 'dom-workspace-chat', 'dom-workspace-question', 'dom-workspace-answer', 'fake',
    'synthetic-model', 'preparing', NULL, true, 'native', now());
INSERT INTO "ChatPdfRunPreparation" ("modelRunId", "admissionKey", snapshot, state, "updatedAt")
VALUES ('dom-pdf-run', repeat('d', 64), '{}', 'pending', now());
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state,
  "updatedAt")
VALUES ('dom-offer-call', 'dom-indexed-run', 0, 0, 'synthetic-call', 'manage_memory', '{}', 'complete', now());
INSERT INTO "MemoryNoteOffer" (id, "userId", "chatId", "runId", "assistantMessageId", "toolCallId", operation, "afterText")
VALUES ('dom-offer', 'dom-owner', 'dom-indexed-chat', 'dom-indexed-run', 'dom-indexed-answer', 'dom-offer-call', 'ADD',
  'Synthetic rule.');
INSERT INTO "UserMemoryNote" ("userId", text, revision, "lastChangedBy") VALUES ('dom-owner', 'Synthetic note line.', 2, 'AGENT');
INSERT INTO "MemoryLegacySuggestion" (id, "userId", text, origin)
VALUES ('dom-suggestion', 'dom-owner', 'Synthetic suggestion.', 'AUTOMATIC');
INSERT INTO "ChatSearchState" ("chatId", "userId", "indexedLeafMessageId")
VALUES ('dom-indexed-chat', 'dom-owner', 'dom-indexed-answer');
INSERT INTO "ChatSearchPassage" (id, "userId", "chatId", "userMessageId", "assistantMessageId", "turnAt", ordinal, text,
  "contentHash", embedding, "embeddingProviderModelId", "embeddingDimension")
VALUES ('dom-passage', 'dom-owner', 'dom-indexed-chat', 'dom-indexed-question', 'dom-indexed-answer', now(), 0,
  'Chat: Synthetic chat' || chr(10) || 'User: Synthetic question' || chr(10) || chr(10) || 'Assistant: Synthetic answer',
  repeat('a', 64), '[0.1,0.2,0.3]', 'mna-embed-a', 3);
INSERT INTO "BackgroundWorkItem" (duty, "itemId", "userId", "attemptCount", "completedAt")
VALUES ('permanent_chat_deletion', 'dom-gone-chat', 'dom-owner', 1, CURRENT_TIMESTAMP - INTERVAL '1 day');
INSERT INTO "BackgroundWorkerHeartbeat" (id, "instanceId", "startedAt", "lastSeenAt", ready)
VALUES ('dom-worker', 'dom-instance', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true);
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "providerModelId", "memoryExecutionBindingId",
  "inputTokens") VALUES ('dom-usage-memory', 'dom-owner', 'memory_indexing', 'openai', 'synthetic-embedding-a', 'mna-embed-a',
  'dom-gone-binding', 12);
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "chatId", "modelRunId", "inputTokens", "outputTokens")
VALUES ('dom-usage-answer', 'dom-owner', 'chat_answer', 'fake', 'synthetic-model', 'dom-indexed-chat', 'dom-indexed-run', 20, 5);
COMMIT;

INSERT INTO "DocumentProcessingFairnessCursor" (pipeline, "lastGrantedOwnerUserId", "updatedAt") VALUES
  ('attachment', NULL, now()), ('memory-job', 'dom-owner', now()), ('memory-delete', NULL, now())
ON CONFLICT (pipeline) DO NOTHING;
CREATE TABLE "_DropOldMemoryFixture" AS SELECT ${keptDigest} AS kept;
`;

const probeOwner = (id: string): string => `
    INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('${id}', 'Synthetic owner', 'active', now());`;

// Each probe ends rolled back, so the proof also serves as the repeat proof.
export const dropOldMemoryProofSql = `
DO $$
DECLARE
  leftover text;
BEGIN
  leftover := ${oldMemoryLeftoverSql(["_MemoryNoteAdoptionFixture", "_DropOldMemoryFixture"])};
  IF leftover <> '' THEN RAISE EXCEPTION 'drop_old_memory_left: %', leftover; END IF;

  -- What keeps a Memory name stays, and the preparation gate moved to its own triggers.
  IF (SELECT count(*) FROM pg_type WHERE typtype = 'e' AND typname IN (${list(KEPT_ENUMS)})) <> ${KEPT_ENUMS.length}
    OR (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relname IN (${list(KEPT_TABLES)})) <> ${KEPT_TABLES.length}
    OR (SELECT count(*) FROM pg_constraint WHERE conname IN (${list(KEPT_CONSTRAINTS)})) <> ${KEPT_CONSTRAINTS.length}
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Chat_memory_mode_guard' AND tgrelid = '"Chat"'::regclass)
    THEN RAISE EXCEPTION 'drop_old_memory_dropped_what_stays'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgdeferrable AND tginitdeferred
      AND tgfoid = 'aiqsa_run_preparation_gate_trigger'::regproc
      AND ((tgname = 'ModelRun_preparation_gate' AND tgrelid = '"ModelRun"'::regclass)
        OR (tgname = 'ChatPdfRunPreparation_preparation_gate' AND tgrelid = '"ChatPdfRunPreparation"'::regclass)
        OR (tgname = 'ChatPdfAttachmentPreparation_preparation_gate' AND tgrelid = '"ChatPdfAttachmentPreparation"'::regclass)
        OR (tgname = 'WorkspaceFollowup_preparation_gate' AND tgrelid = '"WorkspaceFollowup"'::regclass))) <> 4
    THEN RAISE EXCEPTION 'drop_old_memory_preparation_gate_missing'; END IF;

  -- Runs left preparing for Memory ended interrupted, their answers with them; a Temporary chat lives a day more.
  IF (SELECT count(*) FROM "ModelRun" AS run JOIN "Message" AS answer ON answer.id = run."assistantMessageId"
      WHERE run.id IN (${list(STUCK_RUNS)}) AND run.status = 'error' AND run."normalizedRequest" = '{}'::jsonb
        AND run."errorPayload" = jsonb_build_object('code', 'run_interrupted', 'message', ${quote(INTERRUPTED)},
          'recoveryTerminal', true)
        AND answer.status = 'error' AND answer."errorMessage" = ${quote(INTERRUPTED)}) <> 2
    THEN RAISE EXCEPTION 'drop_old_memory_preparing_run_not_interrupted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'dom-temporary-chat' AND "memoryMode" = 'TEMPORARY'
      AND "temporaryRetentionPolicyVersion" = 'temporary-24h-v1' AND "activeLeafMessageId" = 'dom-temporary-answer'
      AND "temporaryRetentionDeadline" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '23 hours')
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'dom-stuck-chat' AND "memoryMode" = 'NORMAL'
      AND "temporaryRetentionDeadline" IS NULL AND "activeLeafMessageId" = 'dom-stuck-answer')
    THEN RAISE EXCEPTION 'drop_old_memory_interrupted_chat_shape'; END IF;

  -- Runs waiting at their PDF or Workspace gate keep waiting; everything that stays is as it was, usage included.
  IF (SELECT count(*) FROM "ModelRun" WHERE id IN ('dom-pdf-run', 'dom-workspace-run') AND status = 'preparing'
      AND "normalizedRequest" IS NULL AND "errorPayload" IS NULL) <> 2
    THEN RAISE EXCEPTION 'drop_old_memory_gated_run_ended'; END IF;
  IF (SELECT kept FROM "_DropOldMemoryFixture") IS DISTINCT FROM ${keptDigest}
    OR (SELECT count(*) FROM "UsageEvent" WHERE id IN ('dom-usage-memory', 'dom-usage-answer')) <> 2
    THEN RAISE EXCEPTION 'drop_old_memory_changed_what_stays'; END IF;

  -- Only attachment processing keeps a fairness cursor.
  IF EXISTS (SELECT 1 FROM "DocumentProcessingFairnessCursor" WHERE pipeline <> 'attachment')
    OR NOT EXISTS (SELECT 1 FROM "DocumentProcessingFairnessCursor" WHERE pipeline = 'attachment')
    THEN RAISE EXCEPTION 'drop_old_memory_cursor_left'; END IF;
END $$;

DO $$
DECLARE
  violated text;
BEGIN
  -- A new account needs no old Memory settings, and a run waits only at a PDF or Workspace gate.
  BEGIN
    ${probeOwner("dom-probe-gate")}
    INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES ('dom-probe-gate-chat', 'dom-probe-gate', 'Synthetic chat', now());
    INSERT INTO "Message" (id, "chatId", role, status, content, "updatedAt")
    VALUES ('dom-probe-gate-question', 'dom-probe-gate-chat', 'user', 'complete', ${question}, now());
    INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, engine, "updatedAt")
    VALUES ('dom-probe-gate-run', 'dom-probe-gate', 'dom-probe-gate-chat', 'dom-probe-gate-question', 'fake',
      'synthetic-model', 'preparing', 'native', now());
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'drop_old_memory_ungated_preparing_run_accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'preparing_run_requires_durable_gate' THEN RAISE; END IF;
  END;

  -- A dispatchable run starts without any Memory binding or preparation.
  BEGIN
    ${probeOwner("dom-probe-run")}
    INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES ('dom-probe-run-chat', 'dom-probe-run', 'Synthetic chat', now());
    INSERT INTO "Message" (id, "chatId", role, status, content, "updatedAt")
    VALUES ('dom-probe-run-question', 'dom-probe-run-chat', 'user', 'complete', ${question}, now());
    INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", engine,
      "updatedAt")
    VALUES ('dom-probe-run-run', 'dom-probe-run', 'dom-probe-run-chat', 'dom-probe-run-question', 'fake', 'synthetic-model',
      'streaming', '{}', 'native', now());
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'drop_old_memory_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'drop_old_memory_probe_rollback' THEN RAISE; END IF;
  END;

  -- A Temporary chat is deleted only once its deadline has passed, with no outbox claim.
  BEGIN
    ${probeOwner("dom-probe-temporary")}
    INSERT INTO "Chat" (id, "userId", title, "memoryMode", "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
      "createdAt", "updatedAt") VALUES
      ('dom-probe-live', 'dom-probe-temporary', 'Synthetic chat', 'TEMPORARY', 'temporary-24h-v1',
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 hour', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '2 days', now()),
      ('dom-probe-expired', 'dom-probe-temporary', 'Synthetic chat', 'TEMPORARY', 'temporary-24h-v1',
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 day', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '2 days', now());
    BEGIN
      DELETE FROM "Chat" WHERE id = 'dom-probe-live';
      RAISE EXCEPTION 'drop_old_memory_temporary_chat_deleted_early';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM <> 'Temporary chat is deleted only after its retention deadline' THEN RAISE; END IF;
    END;
    DELETE FROM "Chat" WHERE id = 'dom-probe-expired';
    IF EXISTS (SELECT 1 FROM "Chat" WHERE id = 'dom-probe-expired')
      THEN RAISE EXCEPTION 'drop_old_memory_expired_temporary_chat_kept'; END IF;
    RAISE EXCEPTION 'drop_old_memory_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'drop_old_memory_probe_rollback' THEN RAISE; END IF;
  END;

  -- The old coordinator's cursors are refused, and the usage shape still holds without the execution binding.
  BEGIN
    INSERT INTO "DocumentProcessingFairnessCursor" (pipeline, "updatedAt") VALUES ('memory-job', now());
    RAISE EXCEPTION 'drop_old_memory_cursor_accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated <> 'DocumentProcessingFairnessCursor_pipeline_check' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "knowledgeBaseId")
    VALUES ('dom-probe-usage', 'dom-owner', 'knowledge_indexing', 'fake', 'synthetic-model', 'dom-gone-base');
    RAISE EXCEPTION 'drop_old_memory_usage_shape_lost';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated <> 'UsageEvent_knowledge_shape_check' THEN RAISE; END IF;
  END;
END $$;
`;
