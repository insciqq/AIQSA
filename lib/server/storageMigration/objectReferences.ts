// Every PostgreSQL column that stores an object-storage key. The schema
// coverage test fails when a new key column is not listed, so the storage
// guard cannot silently ignore it.
export type ObjectKeyColumn = Readonly<{ column: string; model: string }>;

export const OBJECT_KEY_COLUMNS: readonly ObjectKeyColumn[] = [
  { column: "bundleStorageKey", model: "ArtifactVersion" },
  { column: "storageKey", model: "ArtifactBlob" },
  { column: "renderedStorageKey", model: "ArtifactRender" },
  { column: "bundleStorageKey", model: "ArtifactPublication" },
  { column: "storageKey", model: "SkillRevisionFile" },
  { column: "storageKey", model: "KnowledgeUploadItem" },
  { column: "storageKey", model: "KnowledgeDeletionObject" },
  { column: "originalStorageKey", model: "KnowledgeSourceVersion" },
  { column: "normalizedTextStorageKey", model: "KnowledgeSourceIndexArtifact" },
  { column: "originalStorageKey", model: "KnowledgeDocumentVersion" },
  { column: "normalizedTextStorageKey", model: "KnowledgeDocumentVersion" },
  { column: "storageKey", model: "ChatContinuationWorkspaceSeed" },
  { column: "storageKey", model: "ToolObservation" },
  { column: "storageKey", model: "AttachmentUploadObject" },
  { column: "storageKey", model: "Attachment" },
  { column: "storageKey", model: "WorkspaceCapturedFile" },
  { column: "storageKey", model: "AttachmentDeletionJob" },
  { column: "storageKey", model: "ChatPdfArtifact" }
];

export type RawQueryClient = Readonly<{
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}>;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/u;

function quoted(identifier: string): string {
  // The identifiers come only from the constant table above.
  if (!IDENTIFIER.test(identifier)) throw new Error("object_key_column_invalid");
  return `"${identifier}"`;
}

/**
 * True when any row in any key column references an object. A table that
 * does not exist yet (a database before its first migration, as in the
 * disposable development topology) holds no references.
 */
export async function databaseHasObjectReferences(db: RawQueryClient): Promise<boolean> {
  const models = [...new Set(OBJECT_KEY_COLUMNS.map(({ model }) => model))];
  const existing = new Set((await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT "table_name" AS "name" FROM "information_schema"."tables"
      WHERE "table_schema" = current_schema() AND "table_name" = ANY($1::text[])`,
    models
  )).map(({ name }) => name));
  const probes = OBJECT_KEY_COLUMNS.filter(({ model }) => existing.has(model)).map(({ column, model }) =>
    `EXISTS (SELECT 1 FROM ${quoted(model)} WHERE ${quoted(column)} IS NOT NULL)`);
  if (probes.length === 0) return false;
  const rows = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT (${probes.join(" OR ")}) AS "present"`
  );
  return rows[0]?.present === true;
}
