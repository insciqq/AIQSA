// Every PostgreSQL column that stores an object-storage key. The schema
// coverage test fails when a new key column is not listed, so the storage
// guard and the migration cannot silently ignore it.
//
// durable: the object must exist while the row references it.
// staging: an upload may not have written the object yet.
// obligation: a pending deletion that may outlive the object.
export type ObjectKeyColumn = Readonly<{
  column: string;
  kind: "durable" | "obligation" | "staging";
  model: string;
}>;

export const OBJECT_KEY_COLUMNS: readonly ObjectKeyColumn[] = [
  { column: "bundleStorageKey", kind: "durable", model: "ArtifactVersion" },
  { column: "storageKey", kind: "durable", model: "ArtifactBlob" },
  { column: "renderedStorageKey", kind: "durable", model: "ArtifactRender" },
  { column: "bundleStorageKey", kind: "durable", model: "ArtifactPublication" },
  { column: "storageKey", kind: "durable", model: "SkillRevisionFile" },
  { column: "storageKey", kind: "staging", model: "KnowledgeUploadItem" },
  { column: "storageKey", kind: "obligation", model: "KnowledgeDeletionObject" },
  { column: "originalStorageKey", kind: "durable", model: "KnowledgeSourceVersion" },
  { column: "normalizedTextStorageKey", kind: "durable", model: "KnowledgeSourceIndexArtifact" },
  { column: "originalStorageKey", kind: "durable", model: "KnowledgeDocumentVersion" },
  { column: "normalizedTextStorageKey", kind: "durable", model: "KnowledgeDocumentVersion" },
  { column: "storageKey", kind: "durable", model: "ChatContinuationWorkspaceSeed" },
  { column: "storageKey", kind: "durable", model: "ToolObservation" },
  { column: "storageKey", kind: "staging", model: "AttachmentUploadObject" },
  { column: "storageKey", kind: "durable", model: "Attachment" },
  { column: "storageKey", kind: "durable", model: "WorkspaceCapturedFile" },
  { column: "storageKey", kind: "obligation", model: "AttachmentDeletionJob" },
  { column: "storageKey", kind: "durable", model: "ChatPdfArtifact" }
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

/**
 * One keyset page of distinct keys that durable rows require to exist. The
 * order is the database collation's; callers only need a stable total order.
 */
export async function durableObjectReferencePage(
  db: RawQueryClient,
  input: Readonly<{ after: string | null; limit: number }>
): Promise<string[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
    throw new RangeError("object_reference_page_limit_invalid");
  }
  const branches = OBJECT_KEY_COLUMNS.filter(({ kind }) => kind === "durable").map(({ column, model }) => {
    const key = quoted(column);
    return `(SELECT ${key} AS "key" FROM ${quoted(model)} WHERE ${key} IS NOT NULL` +
      ` AND ($1::text IS NULL OR ${key} > $1::text) ORDER BY ${key} LIMIT $2)`;
  });
  const rows = await db.$queryRawUnsafe<Array<{ key: string }>>(
    `SELECT "key" FROM (${branches.join(" UNION ")}) AS "refs" ORDER BY "key" LIMIT $2`,
    input.after,
    input.limit
  );
  return rows.map(({ key }) => key);
}
