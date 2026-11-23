/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const DROP_PROJECT_LEFTOVERS_MIGRATION = "20261123040000_drop_project_leftovers";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const list = (values: readonly string[]): string => values.map(quote).join(", ");

const BEFORE = "2026-10-20 07:00:00";
const content = (text: string): string => quote(JSON.stringify({ blocks: [{ text, type: "text" }] }));
const hex = (digit: string): string => quote(digit.repeat(64));

/** Every Project column the migration drops, by table. */
const DROPPED: Readonly<Record<string, readonly string[]>> = {
  Attachment: ["projectId", "uploaderUserId", "uploaderDisplayName"],
  AttachmentUpload: ["projectId", "projectScoped"],
  Chat: ["projectId", "projectFolderId", "createdByUserId", "createdByDisplayName"],
  Folder: ["projectMemory"],
  Message: ["authorUserId", "authorDisplayName", "authorProjectRole"],
  SharedChatSnapshot: ["projectId", "createdByDisplayName"],
  UsageEvent: ["projectId"]
};
const KEPT_TABLES = ["User", "Folder", "Chat", "Message", "ModelRun", "Attachment", "AttachmentUpload", "SharedChatSnapshot",
  "UsageEvent"] as const;

/** One digest of the `dpl-kept-` rows of every table that stays, less the columns that go. */
const keptDigest = `md5(concat_ws('|', ${KEPT_TABLES.map((table) => {
  const row = `(to_jsonb(r) - ARRAY[${list(DROPPED[table] ?? [])}]::text[])`;
  return `(SELECT md5(COALESCE(string_agg(${row}::text, ',' ORDER BY r.id), '')) FROM "${table}" AS r WHERE r.id LIKE 'dpl-kept-%')`;
}).join(",\n  ")}))`;

// An installation where a missed retirement left Project rows never got the retired null checks
// (`20261025092000_drop_projects_knowledge` added each only where no row broke it), so the fixture drops them first.
const retiredChecksMissing = (tables: readonly string[]): string => tables.map((table) =>
  `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table === "Message" ? "Message_project_attribution" : `${table}_project`}_retired_check";`
).join("\n");

// One owner with an ordinary chat in a folder, its turn, run, usage, file, saved file, share and open upload, which must
// stay as they were; and what a removed Project left without an owner: its chat with an attributed turn, a run and its
// usage, a revoked share, and an upload it started that is still open. Written in replica mode (no triggers or keys,
// checks kept).
export const dropProjectLeftoversFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
${retiredChecksMissing(["Chat", "Message", "AttachmentUpload", "SharedChatSnapshot", "UsageEvent"])}
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('dpl-kept-owner', 'Synthetic owner', 'active', '${BEFORE}');
INSERT INTO "Folder" (id, "userId", name, "projectMemory", "updatedAt")
VALUES ('dpl-kept-folder', 'dpl-kept-owner', 'Synthetic folder', 'Synthetic folder memory', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", "folderId", title, "createdAt", "updatedAt")
VALUES ('dpl-kept-chat', 'dpl-kept-owner', 'dpl-kept-folder', 'Synthetic chat', '${BEFORE}', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", "memoryMode", title, "createdAt",
  "updatedAt")
VALUES ('dpl-gone-chat', NULL, 'dpl-project', 'dpl-kept-owner', 'Synthetic member', 'EXCLUDED', 'Synthetic Project chat',
  '${BEFORE}', '${BEFORE}');
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, status, "createdAt", "updatedAt") VALUES
  ('dpl-kept-question', 'dpl-kept-chat', 'user', NULL, ${content("Synthetic question")}, 'complete', '${BEFORE}', '${BEFORE}'),
  ('dpl-kept-answer', 'dpl-kept-chat', 'assistant', 'dpl-kept-question', ${content("Synthetic answer")}, 'complete',
    '${BEFORE}', '${BEFORE}'),
  ('dpl-gone-answer', 'dpl-gone-chat', 'assistant', 'dpl-gone-question', ${content("Synthetic Project answer")}, 'complete',
    '${BEFORE}', '${BEFORE}');
INSERT INTO "Message" (id, "chatId", role, "parentMessageId", content, status, "authorUserId", "authorDisplayName",
  "authorProjectRole", "createdAt", "updatedAt")
VALUES ('dpl-gone-question', 'dpl-gone-chat', 'user', NULL, ${content("Synthetic Project question")}, 'complete',
  'dpl-kept-owner', 'Synthetic member', 'MANAGER', '${BEFORE}', '${BEFORE}');
UPDATE "Chat" SET "activeLeafMessageId" = 'dpl-kept-answer' WHERE id = 'dpl-kept-chat';
UPDATE "Chat" SET "activeLeafMessageId" = 'dpl-gone-answer' WHERE id = 'dpl-gone-chat';
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", "assistantMessageId", provider, "modelId", status,
  "normalizedRequest", engine, "createdAt", "updatedAt") VALUES
  ('dpl-kept-run', 'dpl-kept-owner', 'dpl-kept-chat', 'dpl-kept-question', 'dpl-kept-answer', 'fake', 'synthetic-model',
    'complete', '{}', 'native', '${BEFORE}', '${BEFORE}'),
  ('dpl-gone-run', 'dpl-kept-owner', 'dpl-gone-chat', 'dpl-gone-question', 'dpl-gone-answer', 'fake', 'synthetic-model',
    'complete', '{}', 'native', '${BEFORE}', '${BEFORE}');
INSERT INTO "UsageEvent" (id, "userId", purpose, provider, "modelId", "chatId", "modelRunId", "projectId", "inputTokens",
  "outputTokens", "createdAt") VALUES
  ('dpl-kept-usage', 'dpl-kept-owner', 'chat_answer', 'fake', 'synthetic-model', 'dpl-kept-chat', 'dpl-kept-run', NULL, 20, 5,
    '${BEFORE}'),
  ('dpl-gone-usage', 'dpl-kept-owner', 'chat_answer', 'fake', 'synthetic-model', 'dpl-gone-chat', 'dpl-gone-run',
    'dpl-project', 30, 7, '${BEFORE}');
INSERT INTO "Attachment" (id, "userId", "chatId", "messageId", kind, "mimeType", "fileName", "storageKey", "byteSize",
  "savedAt", metadata, "createdAt", "updatedAt") VALUES
  ('dpl-kept-file', 'dpl-kept-owner', 'dpl-kept-chat', 'dpl-kept-question', 'file', 'text/plain', 'synthetic.txt',
    'dpl-kept-object', 5, NULL, '{}', '${BEFORE}', '${BEFORE}'),
  ('dpl-kept-saved', 'dpl-kept-owner', NULL, NULL, 'file', 'text/plain', 'saved.txt', 'dpl-kept-saved-object', 5,
    '${BEFORE}', '{}', '${BEFORE}', '${BEFORE}');
INSERT INTO "SharedChatSnapshot" (id, "ownerUserId", "projectId", "createdByDisplayName", "chatId", "slugHash", title,
  snapshot, "revokedAt", "createdAt") VALUES
  ('dpl-kept-share', 'dpl-kept-owner', NULL, NULL, 'dpl-kept-chat', ${hex("a")}, 'Synthetic chat', '{"version":1}', NULL,
    '${BEFORE}'),
  ('dpl-gone-share', NULL, 'dpl-project', 'Synthetic member', 'dpl-gone-chat', ${hex("b")}, 'Synthetic Project chat',
    '{"version":1}', '${BEFORE}', '${BEFORE}');
INSERT INTO "AttachmentUpload" (id, "userId", "projectId", "projectScoped", "idempotencyKey", "fileName", "mimeType",
  "byteSize", state, "expiresAt", "deadlineAt", "createdAt", "updatedAt") VALUES
  ('dpl-kept-upload', 'dpl-kept-owner', NULL, false, 'dpl-kept-upload', 'synthetic.bin', 'application/octet-stream', 5,
    'uploading', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP + INTERVAL '2 hours', '${BEFORE}', '${BEFORE}'),
  ('dpl-ended-upload', 'dpl-kept-owner', 'dpl-project', true, 'dpl-ended-upload', 'synthetic.bin', 'application/octet-stream',
    5, 'uploading', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP + INTERVAL '2 hours', '${BEFORE}', '${BEFORE}');
COMMIT;

CREATE TABLE "_DropProjectLeftoversFixture" AS SELECT ${keptDigest} AS kept;
`;

const droppedPairs = Object.entries(DROPPED).flatMap(([table, columns]) => columns.map((column) => `(${quote(table)}, ${quote(column)})`));
const REPLACED_CHECKS = ["Chat_import_source_key_check", "Attachment_owner_boundary_check", "Attachment_saved_file_boundary_check",
  "SharedChatSnapshot_owner_boundary_check", "UsageEvent_shape_check"] as const;

// Read-only, so it also serves as the repeat proof.
export const dropProjectLeftoversProofSql = `
DO $$
BEGIN
  -- The Project columns and their type are gone, and every chat has an owner.
  IF EXISTS (SELECT 1 FROM information_schema.columns AS column_row
      JOIN (VALUES ${droppedPairs.join(", ")}) AS dropped(table_name, column_name)
        ON dropped.table_name = column_row.table_name::text AND dropped.column_name = column_row.column_name::text
      WHERE column_row.table_schema = current_schema())
    OR to_regtype('"ProjectRole"') IS NOT NULL
    THEN RAISE EXCEPTION 'drop_project_leftovers_columns_left'; END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Chat'
      AND column_name = 'userId') IS DISTINCT FROM 'NO'
    THEN RAISE EXCEPTION 'drop_project_leftovers_chat_owner_optional'; END IF;

  -- The checks that named a dropped column stand again with their personal branch, validated; the owner checks of files
  -- and shares require an owner.
  IF (SELECT count(*) FROM pg_constraint AS constraint_row JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema() AND constraint_row.contype = 'c' AND constraint_row.convalidated
        AND constraint_row.conname IN (${list(REPLACED_CHECKS)})) <> ${REPLACED_CHECKS.length}
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Attachment"'::regclass
      AND conname = 'Attachment_owner_boundary_check' AND pg_get_constraintdef(oid) ~ '"userId" IS NOT NULL')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"SharedChatSnapshot"'::regclass
      AND conname = 'SharedChatSnapshot_owner_boundary_check' AND pg_get_constraintdef(oid) ~ '"ownerUserId" IS NOT NULL')
    THEN RAISE EXCEPTION 'drop_project_leftovers_checks'; END IF;

  -- What the Project left without an owner is gone; its usage keeps its row and counts, its run link cleared.
  IF EXISTS (SELECT 1 FROM "Chat" WHERE id = 'dpl-gone-chat')
    OR EXISTS (SELECT 1 FROM "Message" WHERE id LIKE 'dpl-gone-%')
    OR EXISTS (SELECT 1 FROM "ModelRun" WHERE id = 'dpl-gone-run')
    OR EXISTS (SELECT 1 FROM "SharedChatSnapshot" WHERE id = 'dpl-gone-share')
    THEN RAISE EXCEPTION 'drop_project_leftovers_ownerless_left'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "UsageEvent" WHERE id = 'dpl-gone-usage' AND "userId" = 'dpl-kept-owner'
      AND "chatId" = 'dpl-gone-chat' AND "modelRunId" IS NULL AND "inputTokens" = 30 AND "outputTokens" = 7)
    THEN RAISE EXCEPTION 'drop_project_leftovers_usage_lost'; END IF;
  IF (SELECT state FROM "AttachmentUpload" WHERE id = 'dpl-ended-upload') IS DISTINCT FROM 'expired'
    THEN RAISE EXCEPTION 'drop_project_leftovers_upload_open'; END IF;

  -- Everything of the owner stays as it was, less the columns that went.
  IF (SELECT kept FROM "_DropProjectLeftoversFixture") IS DISTINCT FROM ${keptDigest}
    THEN RAISE EXCEPTION 'drop_project_leftovers_changed_what_stays'; END IF;
END $$;
`;

// A Project chat whose file nobody owns: there is no deletion path for its object, so the migration refuses.
export const dropProjectLeftoversRefusedFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
${retiredChecksMissing(["Chat", "Attachment"])}
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('dpr-owner', 'Synthetic owner', 'active', '${BEFORE}');
INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", "memoryMode", title, "createdAt",
  "updatedAt")
VALUES ('dpr-chat', NULL, 'dpr-project', 'dpr-owner', 'Synthetic member', 'EXCLUDED', 'Synthetic Project chat', '${BEFORE}',
  '${BEFORE}');
INSERT INTO "Attachment" (id, "userId", "projectId", "uploaderUserId", "uploaderDisplayName", "chatId", kind, "mimeType",
  "fileName", "storageKey", "byteSize", metadata, "createdAt", "updatedAt")
VALUES ('dpr-file', NULL, 'dpr-project', 'dpr-owner', 'Synthetic member', 'dpr-chat', 'file', 'text/plain', 'synthetic.txt',
  'dpr-object', 5, '{}', '${BEFORE}', '${BEFORE}');
COMMIT;
`;

/** The refusal names what holds objects, by count only. */
export const DROP_PROJECT_LEFTOVERS_REFUSAL =
  /project_leftovers_hold_objects chats_without_owner=1 files=1 workspaces=0 tool_results=0/u;

// The refused migration changed nothing: its file runs as one transaction.
export const dropProjectLeftoversRefusedProofSql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'dpr-chat' AND "userId" IS NULL AND "projectId" = 'dpr-project')
    OR NOT EXISTS (SELECT 1 FROM "Attachment" WHERE id = 'dpr-file' AND "userId" IS NULL AND "chatId" = 'dpr-chat')
    OR to_regtype('"ProjectRole"') IS NULL
    OR (SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Chat'
      AND column_name = 'userId') IS DISTINCT FROM 'YES'
    THEN RAISE EXCEPTION 'drop_project_leftovers_refusal_changed_rows'; END IF;
END $$;
`;
