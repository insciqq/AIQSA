import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CURSOR_MIGRATION = "20260809160000_document_processing_fairness";
const TARGET_MIGRATION = "20260809170000_document_processing_owner_indexes";
const POSTGRES_SERVICE = "postgres";
const POSTGRES_USER = "aiqsa";
const SCALE_OWNER_COUNT = 128;
const SCALE_ROWS_PER_OWNER = 80;
const SCALE_ROWS_PER_QUEUE = SCALE_OWNER_COUNT * SCALE_ROWS_PER_OWNER;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsRoot = join(repositoryRoot, "prisma/migrations");
const suffix = `${process.pid}_${Date.now()}`;
const upgradeDatabase = `aiqsa_fairness_upgrade_${suffix}`;
const freshDatabase = `aiqsa_fairness_fresh_${suffix}`;
const createdDatabases = new Set<string>();

type CommandResult = Readonly<{ status: number; stderr: string; stdout: string }>;
type ExplainNode = Readonly<{
  "Actual Rows"?: number;
  "Index Cond"?: string;
  "Index Name"?: string;
  "Node Type": string;
  Plans?: readonly ExplainNode[];
  "Relation Name"?: string;
}>;

function compose(args: string[], input?: string): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function requireSuccess(result: CommandResult, operation: string): string {
  assert.equal(
    result.status,
    0,
    `${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout.trim();
}

function psql(database: string, sql: string): CommandResult {
  return compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--set=ON_ERROR_STOP=1",
    "--username", POSTGRES_USER, "--dbname", database
  ], sql);
}

function scalar(database: string, sql: string): string {
  return requireSuccess(compose([
    "exec", "-T", POSTGRES_SERVICE, "psql", "-X", "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--username", POSTGRES_USER, "--dbname", database,
    "--command", sql
  ]), "read document-processing fairness contract state");
}

function migrationNames(predicate: (name: string) => boolean): string[] {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && predicate(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(name: string): string {
  return readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
}

function migrationWithForcedRollback(name: string): string {
  const sql = migrationSql(name).trimEnd();
  const beginMarker = "\nBEGIN;\n";
  const commitMarker = "\nCOMMIT;";
  assert.ok(sql.includes(beginMarker), `${name} must open an explicit transaction`);
  assert.ok(sql.endsWith(commitMarker), `${name} must end with an explicit commit`);

  const commitIndex = sql.length - commitMarker.length;
  return `${sql.slice(0, commitIndex)}

DO $migration_rollback_probe$
BEGIN
  RAISE EXCEPTION 'forced migration rollback probe';
END
$migration_rollback_probe$;
${sql.slice(commitIndex)}\n`;
}

function applyMigrations(database: string, names: readonly string[]): void {
  for (const name of names) {
    requireSuccess(
      psql(database, migrationSql(name)),
      `apply migration ${name} to ${database}`
    );
  }
}

function createDatabase(database: string): void {
  requireSuccess(
    compose(["exec", "-T", POSTGRES_SERVICE, "createdb", "--username", POSTGRES_USER, database]),
    `create ${database}`
  );
  createdDatabases.add(database);
}

function dropDatabases(): void {
  for (const database of createdDatabases) {
    requireSuccess(compose([
      "exec", "-T", POSTGRES_SERVICE, "dropdb", "--if-exists", "--force",
      "--username", POSTGRES_USER, database
    ]), `drop ${database}`);
  }
  createdDatabases.clear();
}

function expectRejected(database: string, sql: string, expected: RegExp, label: string): void {
  const result = psql(database, sql);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected, `${label} failed unexpectedly`);
}

function seedLegacyRows(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "status", "updatedAt") VALUES
      ('fairness-owner-a', 'fairness-owner-a@example.test', 'Fairness owner A', 'active', CURRENT_TIMESTAMP),
      ('fairness-owner-b', 'fairness-owner-b@example.test', 'Fairness owner B', 'active', CURRENT_TIMESTAMP);

    INSERT INTO "Attachment" (
      "id", "userId", "kind", "mimeType", "fileName", "storageKey", "status",
      "byteSize", "metadata", "updatedAt"
    ) VALUES (
      'fairness-legacy-attachment', 'fairness-owner-a', 'document', 'text/plain',
      'legacy.txt', 'private/fairness/legacy', 'processing', 1, '{}'::jsonb, CURRENT_TIMESTAMP
    );
    INSERT INTO "AttachmentProcessingJob" (
      "id", "attachmentId", "nextAttemptAt", "updatedAt"
    ) VALUES (
      'fairness-legacy-attachment-job', 'fairness-legacy-attachment',
      TIMESTAMP '2000-01-01 00:00:00', CURRENT_TIMESTAMP
    );

    INSERT INTO "ProviderConnection" (
      "id", "displayName", "family", "enabled", "draftConfig", "draftVersion",
      "activeConfig", "activeVersion", "activatedAt", "updatedAt"
    ) VALUES (
      'fairness-connection', 'Fairness connection', 'openai_compatible', true,
      '{}'::jsonb, 1, '{}'::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "ProviderModel" (
      "id", "connectionId", "provider", "modelId", "displayName", "modelClass",
      "contextWindow", "draftConfig", "draftVersion", "activeConfig", "activeVersion",
      "capabilities", "defaultParams", "activatedAt", "updatedAt"
    ) VALUES (
      'fairness-model', 'fairness-connection', 'openai_compatible', 'fairness-embedding',
      'Fairness embedding', 'embedding', 32768, '{}'::jsonb, 1, '{}'::jsonb, 1,
      '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeBase" (
      "id", "ownerUserId", "name", "contentRevision", "version", "updatedAt"
    ) VALUES (
      'fairness-legacy-base', 'fairness-owner-a', 'Fairness legacy base', 0, 1,
      CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "readyAt", "activatedAt", "updatedAt"
    ) VALUES (
      'fairness-legacy-active', 'fairness-legacy-base', 'fairness-model', '{}'::jsonb,
      repeat('a', 64), 1536, 1, 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    UPDATE "KnowledgeBase"
    SET "activeIndexGenerationId" = 'fairness-legacy-active'
    WHERE "id" = 'fairness-legacy-base';
    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "sourceIndexGenerationId",
      "sourceBaseVersion", "targetContentRevision", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "updatedAt"
    ) VALUES (
      'fairness-legacy-shadow', 'fairness-legacy-base', 'fairness-model',
      'fairness-legacy-active', 1, 0, '{}'::jsonb, repeat('b', 64), 1536, 1, 0,
      'building', CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeDocument" (
      "id", "knowledgeBaseId", "updatedAt"
    ) VALUES (
      'fairness-legacy-document', 'fairness-legacy-base', CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "ingestGenerationId", "versionNumber",
      "fileName", "mimeType", "byteSize", "checksum", "originalStorageKey",
      "ingestState", "ingestNextAttemptAt", "updatedAt"
    ) VALUES (
      'fairness-legacy-version', 'fairness-legacy-base', 'fairness-legacy-document',
      'fairness-legacy-active', 1, 'legacy.txt', 'text/plain', 1, repeat('c', 64),
      'knowledge/fairness/legacy', 'queued', TIMESTAMP '2000-01-01 00:00:00',
      CURRENT_TIMESTAMP
    );
    INSERT INTO "KnowledgeGenerationDocument" (
      "knowledgeBaseId", "indexGenerationId", "documentVersionId", "state",
      "nextAttemptAt", "updatedAt"
    ) VALUES (
      'fairness-legacy-base', 'fairness-legacy-shadow', 'fairness-legacy-version',
      'queued', TIMESTAMP '2000-01-01 00:00:00', CURRENT_TIMESTAMP
    );
  `), "seed legacy document-processing work");
}

function assertCursorMigrationRollback(database: string): void {
  assert.equal(scalar(database, `
    SELECT concat_ws('|',
      (SELECT count(*)
        FROM pg_class AS relation
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'DocumentProcessingFairnessCursor'),
      (SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'DocumentProcessingFairnessCursor_pkey',
          'DocumentProcessingFairnessCursor_pipeline_check'
        ))
    );
  `), "0|0", "failed cursor migration must leave no table or constraints");
}

function assertOwnerMigrationRollback(database: string): void {
  assert.equal(scalar(database, `
    SELECT concat_ws('|',
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'AttachmentProcessingJob', 'KnowledgeDocumentVersion', 'KnowledgeGenerationDocument'
          )
          AND column_name = 'ownerUserId'),
      (SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'AttachmentProcessingJob_attachment_owner_fkey',
          'KnowledgeDocumentVersion_knowledgeBase_owner_fkey',
          'KnowledgeGenerationDocument_knowledgeBase_owner_fkey'
        )),
      (SELECT count(*) FROM pg_indexes
        WHERE indexname IN (
          'Attachment_id_userId_key',
          'KnowledgeBase_id_ownerUserId_key',
          'AttachmentProcessingJob_attachmentId_ownerUserId_key',
          'AttachmentProcessingJob_owner_due_idx',
          'AttachmentProcessingJob_due_owner_idx',
          'KnowledgeDocumentVersion_owner_due_active_idx',
          'KnowledgeGenerationDocument_owner_due_active_idx'
        )),
      (SELECT count(*) FROM pg_constraint
        WHERE conname = 'AttachmentProcessingJob_attachmentId_fkey' AND convalidated),
      (SELECT count(*) FROM "AttachmentProcessingJob"
        WHERE "id" = 'fairness-legacy-attachment-job'),
      (SELECT count(*) FROM "KnowledgeDocumentVersion"
        WHERE "id" = 'fairness-legacy-version'),
      (SELECT count(*) FROM "KnowledgeGenerationDocument"
        WHERE "indexGenerationId" = 'fairness-legacy-shadow')
    );
  `), "0|0|0|1|1|1|1",
  "failed owner-index migration must restore the complete legacy schema and rows");
}

function assertUpgradeIntegrity(database: string): void {
  assert.equal(scalar(database, `
    SELECT concat_ws('|',
      (SELECT "ownerUserId" FROM "AttachmentProcessingJob"
        WHERE "id" = 'fairness-legacy-attachment-job'),
      (SELECT "ownerUserId" FROM "KnowledgeDocumentVersion"
        WHERE "id" = 'fairness-legacy-version'),
      (SELECT "ownerUserId" FROM "KnowledgeGenerationDocument"
        WHERE "indexGenerationId" = 'fairness-legacy-shadow'),
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'AttachmentProcessingJob', 'KnowledgeDocumentVersion', 'KnowledgeGenerationDocument'
          )
          AND column_name = 'ownerUserId'
          AND is_nullable = 'NO'),
      (SELECT count(*) FROM pg_constraint
        WHERE conname IN (
          'AttachmentProcessingJob_attachment_owner_fkey',
          'KnowledgeDocumentVersion_knowledgeBase_owner_fkey',
          'KnowledgeGenerationDocument_knowledgeBase_owner_fkey'
        ) AND convalidated),
      (SELECT count(*) FROM pg_indexes
        WHERE indexname IN (
          'AttachmentProcessingJob_attachmentId_ownerUserId_key',
          'AttachmentProcessingJob_owner_due_idx',
          'AttachmentProcessingJob_due_owner_idx',
          'KnowledgeDocumentVersion_owner_due_active_idx',
          'KnowledgeGenerationDocument_owner_due_active_idx'
        ))
    );
  `), "fairness-owner-a|fairness-owner-a|fairness-owner-a|3|3|5");

  assert.equal(scalar(database, `
    SELECT count(*)
    FROM pg_index AS idx
    INNER JOIN pg_class AS relation ON relation.oid = idx.indexrelid
    WHERE relation.relname IN (
      'KnowledgeDocumentVersion_owner_due_active_idx',
      'KnowledgeGenerationDocument_owner_due_active_idx'
    )
      AND idx.indpred IS NOT NULL
      AND pg_get_expr(idx.indpred, idx.indrelid) LIKE '%queued%'
      AND pg_get_expr(idx.indpred, idx.indrelid) LIKE '%embedding%';
  `), "2", "Knowledge queue indexes must retain their raw partial predicates");

  expectRejected(database, `
    UPDATE "AttachmentProcessingJob" SET "ownerUserId" = 'fairness-owner-b'
    WHERE "id" = 'fairness-legacy-attachment-job';
  `, /AttachmentProcessingJob_attachment_owner_fkey/u, "cross-owner Attachment job rewrite");
  expectRejected(database, `
    UPDATE "KnowledgeDocumentVersion" SET "ownerUserId" = 'fairness-owner-b'
    WHERE "id" = 'fairness-legacy-version';
  `, /KnowledgeDocumentVersion_knowledgeBase_owner_fkey/u, "cross-owner Knowledge version rewrite");
  expectRejected(database, `
    UPDATE "KnowledgeGenerationDocument" SET "ownerUserId" = 'fairness-owner-b'
    WHERE "indexGenerationId" = 'fairness-legacy-shadow';
  `, /KnowledgeGenerationDocument_knowledgeBase_owner_fkey/u, "cross-owner reindex rewrite");
  expectRejected(database, `
    UPDATE "Attachment" SET "userId" = 'fairness-owner-b'
    WHERE "id" = 'fairness-legacy-attachment';
  `, /AttachmentProcessingJob_attachment_owner_fkey/u, "queued Attachment ownership move");
  expectRejected(database, `
    UPDATE "KnowledgeBase" SET "ownerUserId" = 'fairness-owner-b'
    WHERE "id" = 'fairness-legacy-base';
  `, /Knowledge(DocumentVersion|GenerationDocument)_knowledgeBase_owner_fkey/u,
  "queued Knowledge ownership move");
}

function seedScaleQueues(database: string): void {
  requireSuccess(psql(database, `
    INSERT INTO "User" ("id", "email", "displayName", "status", "updatedAt")
    SELECT
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      format('fair-owner-%s@example.test', lpad(owner::text, 4, '0')),
      format('Fair owner %s', owner),
      'active'::"UserStatus",
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner;

    INSERT INTO "Attachment" (
      "id", "userId", "kind", "mimeType", "fileName", "storageKey", "status",
      "byteSize", "metadata", "createdAt", "updatedAt"
    )
    SELECT
      format('fair-attachment-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      'document', 'text/plain', 'queue.txt',
      format('private/fairness/%s/%s', owner, item),
      'processing'::"AttachmentStatus", 1, '{}'::jsonb,
      TIMESTAMP '2300-01-01 00:00:00' + (owner * ${SCALE_ROWS_PER_OWNER} + item) * INTERVAL '1 millisecond',
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner
    CROSS JOIN generate_series(0, ${SCALE_ROWS_PER_OWNER - 1}) AS item;

    INSERT INTO "AttachmentProcessingJob" (
      "id", "attachmentId", "ownerUserId", "nextAttemptAt", "createdAt", "updatedAt"
    )
    SELECT
      format('fair-attachment-job-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-attachment-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      TIMESTAMP '2299-01-01 00:00:00' + item * INTERVAL '1 millisecond',
      TIMESTAMP '2300-01-01 00:00:00' + (owner * ${SCALE_ROWS_PER_OWNER} + item) * INTERVAL '1 millisecond',
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner
    CROSS JOIN generate_series(0, ${SCALE_ROWS_PER_OWNER - 1}) AS item;

    INSERT INTO "KnowledgeBase" (
      "id", "ownerUserId", "name", "contentRevision", "version", "updatedAt"
    )
    SELECT
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      format('Fair base %s', owner), 0, 1, CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner;

    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "readyAt", "activatedAt", "updatedAt"
    )
    SELECT
      format('fair-active-%s', lpad(owner::text, 4, '0')),
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      'fairness-model', '{}'::jsonb, repeat('d', 64), 1536, 1, 0,
      'active'::"KnowledgeIndexGenerationStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner;

    UPDATE "KnowledgeBase" AS base
    SET "activeIndexGenerationId" = format('fair-active-%s', right(base."id", 4))
    WHERE base."id" LIKE 'fair-base-%';

    INSERT INTO "KnowledgeIndexGeneration" (
      "id", "knowledgeBaseId", "embeddingProviderModelId", "sourceIndexGenerationId",
      "sourceBaseVersion", "targetContentRevision", "embeddingConfiguration",
      "vectorSpaceFingerprint", "targetDimension", "chunkingProfileVersion",
      "indexedContentRevision", "status", "updatedAt"
    )
    SELECT
      format('fair-shadow-%s', lpad(owner::text, 4, '0')),
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      'fairness-model', format('fair-active-%s', lpad(owner::text, 4, '0')),
      1, 0, '{}'::jsonb, repeat('e', 64), 1536, 1, 0,
      'building'::"KnowledgeIndexGenerationStatus", CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner;

    INSERT INTO "KnowledgeDocument" ("id", "knowledgeBaseId", "createdAt", "updatedAt")
    SELECT
      format('fair-document-%s-%s-%s', kind, lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      TIMESTAMP '2300-01-01 00:00:00' + (owner * ${SCALE_ROWS_PER_OWNER} + item) * INTERVAL '1 millisecond',
      CURRENT_TIMESTAMP
    FROM unnest(ARRAY['document', 'reindex']) AS kind
    CROSS JOIN generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner
    CROSS JOIN generate_series(0, ${SCALE_ROWS_PER_OWNER - 1}) AS item;

    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "ingestGenerationId", "ownerUserId",
      "versionNumber", "fileName", "mimeType", "byteSize", "checksum",
      "originalStorageKey", "ingestState", "ingestNextAttemptAt", "createdAt", "updatedAt"
    )
    SELECT
      format('fair-version-document-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      format('fair-document-document-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-active-%s', lpad(owner::text, 4, '0')),
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      1, 'document.txt', 'text/plain', 1, repeat('f', 64),
      format('knowledge/fairness/document/%s/%s', owner, item),
      'queued'::"KnowledgeDocumentIngestState",
      TIMESTAMP '2299-01-01 00:00:00' + item * INTERVAL '1 millisecond',
      TIMESTAMP '2300-01-01 00:00:00' + (owner * ${SCALE_ROWS_PER_OWNER} + item) * INTERVAL '1 millisecond',
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner
    CROSS JOIN generate_series(0, ${SCALE_ROWS_PER_OWNER - 1}) AS item;

    INSERT INTO "KnowledgeDocumentVersion" (
      "id", "knowledgeBaseId", "documentId", "ownerUserId", "versionNumber",
      "fileName", "mimeType", "byteSize", "checksum", "originalStorageKey",
      "ingestState", "ingestCompletedAt", "createdAt", "updatedAt"
    )
    SELECT
      format('fair-version-reindex-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      format('fair-document-reindex-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      1, 'reindex.txt', 'text/plain', 1, repeat('1', 64),
      format('knowledge/fairness/reindex/%s/%s', owner, item),
      'ready'::"KnowledgeDocumentIngestState", CURRENT_TIMESTAMP,
      TIMESTAMP '2300-01-01 00:00:00' + (owner * ${SCALE_ROWS_PER_OWNER} + item) * INTERVAL '1 millisecond',
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner
    CROSS JOIN generate_series(0, ${SCALE_ROWS_PER_OWNER - 1}) AS item;

    INSERT INTO "KnowledgeGenerationDocument" (
      "knowledgeBaseId", "indexGenerationId", "documentVersionId", "ownerUserId",
      "state", "nextAttemptAt", "createdAt", "updatedAt"
    )
    SELECT
      format('fair-base-%s', lpad(owner::text, 4, '0')),
      format('fair-shadow-%s', lpad(owner::text, 4, '0')),
      format('fair-version-reindex-%s-%s', lpad(owner::text, 4, '0'), lpad(item::text, 4, '0')),
      format('fair-owner-%s', lpad(owner::text, 4, '0')),
      'queued'::"KnowledgeDocumentIngestState",
      TIMESTAMP '2299-01-01 00:00:00' + item * INTERVAL '1 millisecond',
      TIMESTAMP '2300-01-01 00:00:00' + (owner * ${SCALE_ROWS_PER_OWNER} + item) * INTERVAL '1 millisecond',
      CURRENT_TIMESTAMP
    FROM generate_series(0, ${SCALE_OWNER_COUNT - 1}) AS owner
    CROSS JOIN generate_series(0, ${SCALE_ROWS_PER_OWNER - 1}) AS item;

    ANALYZE "Attachment";
    ANALYZE "AttachmentProcessingJob";
    ANALYZE "User";
    ANALYZE "KnowledgeBase";
    ANALYZE "KnowledgeIndexGeneration";
    ANALYZE "KnowledgeDocument";
    ANALYZE "KnowledgeDocumentVersion";
    ANALYZE "KnowledgeGenerationDocument";
  `), `seed ${SCALE_ROWS_PER_QUEUE} rows in each physical fairness queue`);
}

function attachmentSelector(cursor: string): string {
  return `
    WITH after_cursor AS MATERIALIZED (
      SELECT job."id", job."ownerUserId"
      FROM "AttachmentProcessingJob" AS job
      INNER JOIN "Attachment" AS attachment
        ON attachment."id" = job."attachmentId"
        AND attachment."userId" = job."ownerUserId"
      WHERE attachment."status" = 'processing'::"AttachmentStatus"
        AND job."ownerUserId" > '${cursor}'
        AND job."nextAttemptAt" <= TIMESTAMP '2400-01-01 00:00:00'
        AND (job."claimedAt" IS NULL OR job."claimedAt" < TIMESTAMP '2200-01-01 00:00:00')
      ORDER BY job."ownerUserId", job."nextAttemptAt", job."createdAt", job."id"
      LIMIT 1
    ), wrapped AS MATERIALIZED (
      SELECT job."id", job."ownerUserId"
      FROM "AttachmentProcessingJob" AS job
      INNER JOIN "Attachment" AS attachment
        ON attachment."id" = job."attachmentId"
        AND attachment."userId" = job."ownerUserId"
      WHERE NOT EXISTS (SELECT 1 FROM after_cursor)
        AND attachment."status" = 'processing'::"AttachmentStatus"
        AND job."ownerUserId" <= '${cursor}'
        AND job."nextAttemptAt" <= TIMESTAMP '2400-01-01 00:00:00'
        AND (job."claimedAt" IS NULL OR job."claimedAt" < TIMESTAMP '2200-01-01 00:00:00')
      ORDER BY job."ownerUserId", job."nextAttemptAt", job."createdAt", job."id"
      LIMIT 1
    )
    SELECT "ownerUserId" FROM after_cursor
    UNION ALL
    SELECT "ownerUserId" FROM wrapped
    LIMIT 1
  `;
}

function knowledgeDocumentHead(cursor: string, operator: ">" | "<=", guard: string): string {
  return `
    SELECT version."ownerUserId"
    FROM "KnowledgeDocumentVersion" AS version
    INNER JOIN "KnowledgeDocument" AS document
      ON document."id" = version."documentId"
      AND document."knowledgeBaseId" = version."knowledgeBaseId"
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = version."knowledgeBaseId"
      AND base."ownerUserId" = version."ownerUserId"
    INNER JOIN "User" AS owner_user ON owner_user."id" = version."ownerUserId"
    WHERE ${guard}
      AND version."ownerUserId" ${operator} '${cursor}'
      AND version."ingestState" IN ('queued', 'parsing', 'chunking', 'embedding')
      AND version."ingestGenerationId" IS NOT NULL
      AND version."ingestNextAttemptAt" <= TIMESTAMP '2400-01-01 00:00:00'
      AND (version."ingestClaimedAt" IS NULL
        OR version."ingestClaimedAt" < TIMESTAMP '2200-01-01 00:00:00')
      AND document."archivedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND owner_user."status" = 'active'::"UserStatus"
    ORDER BY version."ownerUserId", version."ingestNextAttemptAt", version."createdAt", version."id"
    LIMIT 1
  `;
}

function knowledgeReindexHead(cursor: string, operator: ">" | "<=", guard: string): string {
  return `
    SELECT work."ownerUserId"
    FROM "KnowledgeGenerationDocument" AS work
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."id" = work."indexGenerationId"
      AND generation."knowledgeBaseId" = work."knowledgeBaseId"
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = work."knowledgeBaseId"
      AND base."ownerUserId" = work."ownerUserId"
    INNER JOIN "KnowledgeDocumentVersion" AS version
      ON version."id" = work."documentVersionId"
      AND version."knowledgeBaseId" = work."knowledgeBaseId"
      AND version."ownerUserId" = work."ownerUserId"
    INNER JOIN "KnowledgeDocument" AS document
      ON document."id" = version."documentId"
      AND document."knowledgeBaseId" = version."knowledgeBaseId"
    INNER JOIN "User" AS owner_user ON owner_user."id" = work."ownerUserId"
    WHERE ${guard}
      AND work."ownerUserId" ${operator} '${cursor}'
      AND generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
      AND work."state" IN ('queued', 'embedding')
      AND work."nextAttemptAt" <= TIMESTAMP '2400-01-01 00:00:00'
      AND (work."claimedAt" IS NULL OR work."claimedAt" < TIMESTAMP '2200-01-01 00:00:00')
      AND document."archivedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND owner_user."status" = 'active'::"UserStatus"
    ORDER BY work."ownerUserId", work."nextAttemptAt", work."createdAt",
      work."indexGenerationId", work."documentVersionId"
    LIMIT 1
  `;
}

function knowledgeSelector(cursor: string): string {
  return `
    WITH after_document AS MATERIALIZED (
      ${knowledgeDocumentHead(cursor, ">", "TRUE")}
    ), after_reindex AS MATERIALIZED (
      ${knowledgeReindexHead(cursor, ">", "TRUE")}
    ), after_owner AS MATERIALIZED (
      SELECT min(candidate."ownerUserId") AS "ownerUserId"
      FROM (
        SELECT "ownerUserId" FROM after_document
        UNION ALL
        SELECT "ownerUserId" FROM after_reindex
      ) AS candidate
      HAVING count(*) > 0
    ), wrapped_document AS MATERIALIZED (
      ${knowledgeDocumentHead(cursor, "<=", "NOT EXISTS (SELECT 1 FROM after_owner)")}
    ), wrapped_reindex AS MATERIALIZED (
      ${knowledgeReindexHead(cursor, "<=", "NOT EXISTS (SELECT 1 FROM after_owner)")}
    ), wrapped_owner AS MATERIALIZED (
      SELECT min(candidate."ownerUserId") AS "ownerUserId"
      FROM (
        SELECT "ownerUserId" FROM wrapped_document
        UNION ALL
        SELECT "ownerUserId" FROM wrapped_reindex
      ) AS candidate
      HAVING count(*) > 0
    )
    SELECT "ownerUserId" FROM after_owner
    UNION ALL
    SELECT "ownerUserId" FROM wrapped_owner
    LIMIT 1
  `;
}

function planNodes(database: string, query: string): ExplainNode[] {
  const explained = JSON.parse(scalar(
    database,
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
  )) as Array<{ Plan: ExplainNode }>;
  const nodes: ExplainNode[] = [];
  const visit = (node: ExplainNode): void => {
    nodes.push(node);
    node.Plans?.forEach(visit);
  };
  visit(explained[0].Plan);
  return nodes;
}

function assertIndexBoundedPlan(
  database: string,
  query: string,
  expectedIndexes: readonly string[],
  queueRelations: readonly string[],
  label: string
): void {
  const nodes = planNodes(database, query);
  const indexNames = new Set(nodes.flatMap((node) => node["Index Name"] ? [node["Index Name"]] : []));
  for (const expectedIndex of expectedIndexes) {
    assert.ok(indexNames.has(expectedIndex), `${label} omitted ${expectedIndex}`);
  }
  assert.equal(
    nodes.some((node) => node["Node Type"] === "Unique"),
    false,
    `${label} regressed to all-owner Unique`
  );
  assert.equal(
    nodes.some((node) => node["Node Type"] === "Sort"),
    false,
    `${label} regressed to a sorted eligible backlog`
  );
  assert.deepEqual(
    nodes.filter((node) =>
      node["Node Type"] === "Seq Scan" &&
      node["Relation Name"] &&
      queueRelations.includes(node["Relation Name"])
    ),
    [],
    `${label} sequentially scanned a physical queue`
  );
  assert.ok(
    nodes.some((node) => node["Index Cond"]?.includes("ownerUserId")),
    `${label} did not apply the owner cursor as an index condition`
  );
}

function assertScalePlans(database: string): void {
  assert.equal(
    scalar(database, `SELECT count(*) FROM "AttachmentProcessingJob"
      WHERE "id" LIKE 'fair-attachment-job-%';`),
    String(SCALE_ROWS_PER_QUEUE)
  );
  assert.equal(
    scalar(database, `SELECT count(*) FROM "KnowledgeDocumentVersion"
      WHERE "id" LIKE 'fair-version-document-%';`),
    String(SCALE_ROWS_PER_QUEUE)
  );
  assert.equal(
    scalar(database, `SELECT count(*) FROM "KnowledgeGenerationDocument"
      WHERE "indexGenerationId" LIKE 'fair-shadow-%';`),
    String(SCALE_ROWS_PER_QUEUE)
  );

  for (const [cursor, expectedOwner] of [
    ["fair-owner-0064", "fair-owner-0065"],
    ["zzzz", "fair-owner-0000"]
  ] as const) {
    const attachmentQuery = attachmentSelector(cursor);
    const knowledgeQuery = knowledgeSelector(cursor);
    assert.equal(scalar(database, attachmentQuery), expectedOwner);
    assert.equal(scalar(database, knowledgeQuery), expectedOwner);
    assertIndexBoundedPlan(
      database,
      attachmentQuery,
      ["AttachmentProcessingJob_owner_due_idx"],
      ["AttachmentProcessingJob"],
      `Attachment selector at ${cursor}`
    );
    assertIndexBoundedPlan(
      database,
      knowledgeQuery,
      [
        "KnowledgeDocumentVersion_owner_due_active_idx",
        "KnowledgeGenerationDocument_owner_due_active_idx"
      ],
      ["KnowledgeDocumentVersion", "KnowledgeGenerationDocument"],
      `Knowledge selector at ${cursor}`
    );
  }
}

function assertFreshPath(database: string): void {
  assert.equal(scalar(database, `
    SELECT concat_ws('|',
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'AttachmentProcessingJob', 'KnowledgeDocumentVersion', 'KnowledgeGenerationDocument'
          )
          AND column_name = 'ownerUserId'
          AND is_nullable = 'NO'),
      (SELECT count(*) FROM "DocumentProcessingFairnessCursor"
        WHERE "pipeline" IN ('attachment', 'knowledge')),
      (SELECT count(*) FROM pg_indexes
        WHERE indexname IN (
          'AttachmentProcessingJob_owner_due_idx',
          'KnowledgeDocumentVersion_owner_due_active_idx',
          'KnowledgeGenerationDocument_owner_due_active_idx'
        ))
    );
  `), "3|2|3");
}

function main(): void {
  assert.equal(
    requireSuccess(
      compose(["ps", "--status", "running", "--services", POSTGRES_SERVICE]),
      "inspect disposable development PostgreSQL"
    ),
    POSTGRES_SERVICE
  );
  const beforeCursor = migrationNames((name) => name < CURSOR_MIGRATION);
  const beforeTarget = migrationNames((name) => name < TARGET_MIGRATION);
  const cursorThroughTarget = migrationNames(
    (name) => name >= CURSOR_MIGRATION && name <= TARGET_MIGRATION
  );
  assert.ok(cursorThroughTarget.includes(CURSOR_MIGRATION), "fairness cursor migration is missing");
  assert.ok(
    cursorThroughTarget.includes(TARGET_MIGRATION),
    "fairness owner-index migration is missing"
  );

  try {
    createDatabase(upgradeDatabase);
    applyMigrations(upgradeDatabase, beforeTarget);
    seedLegacyRows(upgradeDatabase);
    expectRejected(
      upgradeDatabase,
      migrationWithForcedRollback(TARGET_MIGRATION),
      /forced migration rollback probe/u,
      "forced owner-index migration rollback"
    );
    assertOwnerMigrationRollback(upgradeDatabase);
    applyMigrations(upgradeDatabase, [TARGET_MIGRATION]);
    assertUpgradeIntegrity(upgradeDatabase);
    seedScaleQueues(upgradeDatabase);
    assertScalePlans(upgradeDatabase);

    createDatabase(freshDatabase);
    applyMigrations(freshDatabase, beforeCursor);
    expectRejected(
      freshDatabase,
      migrationWithForcedRollback(CURSOR_MIGRATION),
      /forced migration rollback probe/u,
      "forced cursor migration rollback"
    );
    assertCursorMigrationRollback(freshDatabase);
    applyMigrations(freshDatabase, cursorThroughTarget);
    assertFreshPath(freshDatabase);
  } finally {
    dropDatabases();
  }

  process.stdout.write(
    `Document-processing fairness migration contract passed: transactional rollback, ` +
    `owner backfill/integrity, fresh deploy, and index-assisted after-cursor/wrap plans across ` +
    `${SCALE_ROWS_PER_QUEUE} rows per physical queue.\n`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${message}\n`);
  process.exitCode = 1;
} finally {
  try {
    dropDatabases();
  } catch (cleanupError) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    process.stderr.write(`document-processing fairness contract cleanup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
