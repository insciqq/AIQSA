/** Synthetic receipts the old run core left; migration-contract owns the disposable database. */
export const DROP_MEMORY_TOOL_EGRESS_RECEIPT_MIGRATION = "20261025093000_drop_memory_tool_egress_receipt";

// One receipt of each mode on a run of a previous release, as the old core
// wrote them before the engine switch; replica mode skips unrelated guards.
export const dropMemoryToolEgressReceiptFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('egress-drop-owner', 'Receipt drop fixture', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('egress-drop-chat', 'egress-drop-owner', 'Receipt drop fixture', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('egress-drop-message', 'egress-drop-chat', 'user', '{"blocks":[{"type":"text","text":"Work"}]}', now());
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('egress-drop-run', 'egress-drop-owner', 'egress-drop-chat', 'egress-drop-message', 'test', 'fixture', 'in_progress',
  '{"prompt":{"baseline":{"source":"standard_chat","timeZone":"UTC","timeZoneSource":"client"}}}', now());
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state,
  "startedAt", "completedAt", "updatedAt")
VALUES ('egress-drop-call', 'egress-drop-run', 0, 0, 'egress-drop-provider-call', 'search_my_history', '{}', 'complete',
  now(), now(), now());
INSERT INTO "MemoryToolEgressReceipt" (id, "userId", "modelRunId", "modelRunToolCallId", "requestOrdinal", mode,
  "destinationKind", "destinationFingerprint", "destinationSnapshot", "requestEvidenceHash",
  "dispatchState", "dispatchStartedAt", "dispatchCompletedAt", "updatedAt")
VALUES
  ('egress-drop-request', 'egress-drop-owner', 'egress-drop-run', NULL, 1, 'PROVIDER_REQUEST',
    'answer_provider', repeat('a', 64), '{}', repeat('b', 64), 'COMPLETED', now(), now(), now()),
  ('egress-drop-tool', 'egress-drop-owner', 'egress-drop-run', 'egress-drop-call', 2, 'TOOL_CALL',
    'mcp', repeat('c', 64), '{}', repeat('d', 64), 'COMPLETED', now(), now(), now());
COMMIT;
`;

/** The table and its types are gone whatever rows it held, and the run and its
 * call it named stay. Runs in a rolled-back transaction, so it also proves a
 * repeated deploy. */
export const dropMemoryToolEgressReceiptProofSql = `
BEGIN;
DO $proof$ BEGIN
  IF to_regclass('"MemoryToolEgressReceipt"') IS NOT NULL THEN RAISE EXCEPTION 'memory_tool_egress_receipt_retained'; END IF;
  IF to_regtype('"MemoryToolEgressMode"') IS NOT NULL OR to_regtype('"MemoryToolEgressDispatchState"') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_tool_egress_types_retained'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ModelRun" WHERE id = 'egress-drop-run')
    OR NOT EXISTS (SELECT 1 FROM "ModelRunToolCall" WHERE id = 'egress-drop-call')
  THEN RAISE EXCEPTION 'memory_tool_egress_owner_rows_dropped'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = current_schema() AND routine.prosrc ~ 'MemoryToolEgressReceipt')
  THEN RAISE EXCEPTION 'memory_tool_egress_receipt_still_read'; END IF;
END $proof$;
ROLLBACK;
`;
