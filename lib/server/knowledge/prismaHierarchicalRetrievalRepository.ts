import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  knowledgeExactNormalizedValue,
  KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS,
  type KnowledgeExactEntryKind
} from "./hierarchicalIndex";
import {
  decodeKnowledgeExactCursor,
  decodeKnowledgeHierarchicalLimit,
  decodeKnowledgeHierarchicalQuery,
  decodeKnowledgeHierarchicalScope,
  decodeKnowledgeSafeRegex,
  encodeKnowledgeExactCursor,
  KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET,
  KNOWLEDGE_EXACT_SCAN_MAX_BYTES,
  KnowledgeHierarchicalQueryError,
  type KnowledgeExactIndexHit,
  type KnowledgeExactOperation,
  type KnowledgeExactSearchPage,
  type KnowledgeHierarchicalRetrievalRepository,
  type KnowledgeHierarchicalScope,
  type KnowledgeLexicalIndexHit,
  type KnowledgeLexicalMatchedField,
  type KnowledgeLexicalTargetLevel,
  type KnowledgeMetadataDiscoveryHit,
  type KnowledgeSourceMetadataDiscoveryHit
} from "./hierarchicalRetrieval";
import type {
  KnowledgeExactSearchField,
  KnowledgeSourceDiscoveryField
} from "./retrievalTypes";

type HierarchicalRetrievalClient = Pick<PrismaClient, "$queryRaw" | "$transaction">;

const lexicalFields = new Set<KnowledgeLexicalMatchedField>([
  "description",
  "entities",
  "filename",
  "heading",
  "keywords",
  "source_name",
  "summary",
  "tags",
  "title"
]);
const exactEntryKinds = new Set<KnowledgeExactEntryKind>([
  "date",
  "filename",
  "heading",
  "identifier",
  "number",
  "tag",
  "title"
]);
const metadataKinds = new Set<KnowledgeMetadataDiscoveryHit["kind"]>([
  "filename",
  "heading",
  "source_name",
  "tag",
  "title"
]);
const exactSearchFields = new Set<KnowledgeExactSearchField>([
  "any",
  "body",
  "filename",
  "heading",
  "tag",
  "title"
]);
const exactResultFields = new Set<Exclude<KnowledgeExactSearchField, "any">>([
  "body",
  "filename",
  "heading",
  "tag",
  "title"
]);

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ready compatible hierarchical index versions; each artifact contributes
 * exactly one index (the highest compatible ready version) so pre-cutover
 * version-3 rows stay retrievable without ever double-counting an artifact. */
const compatibleIndexVersionsSql = Prisma.sql`ANY(ARRAY[${Prisma.join([
  ...KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS
])}]::integer[])`;

function authorizedArtifactsSql(scope: KnowledgeHierarchicalScope): Prisma.Sql {
  if (scope.scopeKind === "admitted_run") return Prisma.sql`
    SELECT DISTINCT ON (source_artifact."id")
      hierarchy."id" AS "indexArtifactId",
      source_artifact."id" AS "sourceArtifactId"
    FROM "ModelRun" AS run
    INNER JOIN "KnowledgeRunSourceBinding" AS source_binding
      ON source_binding."modelRunId" = run."id"
     AND source_binding."readinessState" = 'ready'
     AND source_binding."tombstonedAt" IS NULL
     AND source_binding."sourceId" IS NOT NULL
     AND source_binding."sourceVersionId" IS NOT NULL
     AND source_binding."sourceArtifactId" IS NOT NULL
    INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
      ON source_artifact."id" = source_binding."sourceArtifactId"
     AND source_artifact."sourceVersionId" = source_binding."sourceVersionId"
    INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
      ON hierarchy."sourceArtifactId" = source_artifact."id"
     AND hierarchy."sourceVersionId" = source_artifact."sourceVersionId"
    WHERE run."id" = ${scope.runId}
      AND run."userId" = ${scope.userId}
      AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
      AND hierarchy."schemaVersion" = ${compatibleIndexVersionsSql}
      AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
      AND source_artifact."id" IN (${Prisma.join([...scope.sourceArtifactIds])})
    ORDER BY source_artifact."id", hierarchy."schemaVersion" DESC
  `;
  return Prisma.sql`
    SELECT DISTINCT ON (source_artifact."id")
      hierarchy."id" AS "indexArtifactId",
      source_artifact."id" AS "sourceArtifactId"
    FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
    INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
      ON source_artifact."id" = hierarchy."sourceArtifactId"
     AND source_artifact."sourceVersionId" = hierarchy."sourceVersionId"
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = source_artifact."sourceVersionId"
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = version."sourceId"
    WHERE hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
      AND hierarchy."schemaVersion" = ${compatibleIndexVersionsSql}
      AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
      AND source."ownerUserId" = ${scope.ownerUserId}
      AND source_artifact."id" IN (${Prisma.join([...scope.sourceArtifactIds])})
    ORDER BY source_artifact."id", hierarchy."schemaVersion" DESC
  `;
}

function indexedRowsSql(level: KnowledgeLexicalTargetLevel): Prisma.Sql {
  if (level === "document") return Prisma.sql`
    SELECT
      authorized."sourceArtifactId",
      item."indexArtifactId",
      item."indexArtifactId" AS "targetId",
      COALESCE(NULLIF(item."title", ''), item."sourceName", item."fileName") AS "label",
      NULL::integer AS "page",
      NULL::integer AS "pageEnd",
      NULL::text AS "text",
      item."fileName" AS "filenameField",
      item."sourceName" AS "sourceNameField",
      COALESCE(item."title", '') AS "titleField",
      item."outlineText" AS "headingField",
      item."tagsText" AS "tagsField",
      item."keywordsText" AS "keywordsField",
      item."entitiesText" AS "entitiesField",
      item."description" AS "descriptionField",
      item."summary" AS "summaryField",
      item."simpleSearchVector"
    FROM "KnowledgeArtifactDocumentIndex" AS item
    INNER JOIN authorized_artifacts AS authorized
      ON authorized."indexArtifactId" = item."indexArtifactId"
  `;
  return Prisma.sql`
    SELECT
      authorized."sourceArtifactId",
      item."indexArtifactId",
      item."id" AS "targetId",
      item."label",
      item."page",
      item."pageEnd",
      NULL::text AS "text",
      item."fileName" AS "filenameField",
      ''::text AS "sourceNameField",
      item."documentTitle" AS "titleField",
      item."headingText" AS "headingField",
      item."tagsText" AS "tagsField",
      item."keywordsText" AS "keywordsField",
      item."entitiesText" AS "entitiesField",
      item."sourceDescription" AS "descriptionField",
      item."summary" AS "summaryField",
      item."simpleSearchVector"
    FROM "KnowledgeArtifactSectionIndex" AS item
    INNER JOIN authorized_artifacts AS authorized
      ON authorized."indexArtifactId" = item."indexArtifactId"
  `;
}

function fieldMatches(field: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    to_tsvector('simple'::regconfig, COALESCE(${field}, '')) @@ candidate."simpleQuery"
  `;
}

function matchedFieldsSql(): Prisma.Sql {
  const fields: Array<readonly [KnowledgeLexicalMatchedField, Prisma.Sql]> = [
    ["filename", Prisma.sql`candidate."filenameField"`],
    ["source_name", Prisma.sql`candidate."sourceNameField"`],
    ["title", Prisma.sql`candidate."titleField"`],
    ["heading", Prisma.sql`candidate."headingField"`],
    ["tags", Prisma.sql`candidate."tagsField"`],
    ["keywords", Prisma.sql`candidate."keywordsField"`],
    ["entities", Prisma.sql`candidate."entitiesField"`],
    ["description", Prisma.sql`candidate."descriptionField"`],
    ["summary", Prisma.sql`candidate."summaryField"`]
  ];
  return Prisma.sql`array_remove(ARRAY[${Prisma.join(fields.map(([name, field]) =>
    Prisma.sql`CASE WHEN ${fieldMatches(field)} THEN ${name}::text ELSE NULL::text END`
  ))}], NULL)`;
}

export function knowledgeHierarchicalLexicalSearchSql(input: Readonly<{
  level: KnowledgeLexicalTargetLevel;
  limit: number;
  query: string;
  scope: KnowledgeHierarchicalScope;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
  const indexed = indexedRowsSql(input.level);
  const matchedFields = matchedFieldsSql();
  return Prisma.sql`
    WITH
    authorized_artifacts AS MATERIALIZED (${authorized}),
    query_terms AS (
      SELECT
        websearch_to_tsquery('simple'::regconfig, ${input.query}) AS "simpleStrictQuery",
        to_tsquery(
          'simple'::regconfig,
          replace(plainto_tsquery('simple'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "simpleQuery"
    ),
    indexed AS (${indexed}),
    candidates AS MATERIALIZED (
      SELECT
        indexed.*,
        query_terms."simpleQuery",
        ts_rank_cd(indexed."simpleSearchVector", query_terms."simpleQuery") +
          CASE WHEN indexed."simpleSearchVector" @@ query_terms."simpleStrictQuery"
            THEN 1 ELSE 0 END AS "rank"
      FROM indexed
      CROSS JOIN query_terms
      WHERE indexed."simpleSearchVector" @@ query_terms."simpleQuery"
    )
    SELECT
      candidate."sourceArtifactId",
      candidate."indexArtifactId",
      candidate."targetId",
      candidate."label",
      candidate."page",
      candidate."pageEnd",
      candidate."text",
      candidate."rank",
      ${matchedFields} AS "matchedFields"
    FROM candidates AS candidate
    ORDER BY "rank" DESC, candidate."sourceArtifactId", candidate."targetId"
    LIMIT ${input.limit}
  `;
}

function decodeLexicalHit(value: unknown, level: KnowledgeLexicalTargetLevel): KnowledgeLexicalIndexHit | null {
  if (!record(value)) return null;
  const page = value.page === null ? null : integer(value.page);
  const pageEnd = value.pageEnd === null ? null : integer(value.pageEnd);
  const rank = finite(value.rank);
  if (
    typeof value.sourceArtifactId !== "string" || !value.sourceArtifactId ||
    typeof value.indexArtifactId !== "string" || !value.indexArtifactId ||
    typeof value.targetId !== "string" || !value.targetId ||
    typeof value.label !== "string" || !value.label ||
    rank === null || rank < 0 ||
    !Array.isArray(value.matchedFields) ||
    value.matchedFields.some((field) =>
      typeof field !== "string" || !lexicalFields.has(field as KnowledgeLexicalMatchedField)) ||
    (value.text !== null && typeof value.text !== "string") ||
    (page === null) !== (pageEnd === null) ||
    page !== null && (page < 1 || pageEnd! < page)
  ) return null;
  return Object.freeze({
    indexArtifactId: value.indexArtifactId,
    label: value.label,
    level,
    matchedFields: Object.freeze(value.matchedFields as KnowledgeLexicalMatchedField[]),
    page,
    pageEnd,
    rank,
    sourceArtifactId: value.sourceArtifactId,
    targetId: value.targetId,
    text: value.text as string | null
  });
}

function timeoutError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2010" &&
    record(error.meta) && error.meta.code === "57014";
}

async function boundedQuery<T>(
  client: HierarchicalRetrievalClient,
  statementTimeoutMs: number,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`;
      return operation(tx);
    });
  } catch (error) {
    if (timeoutError(error)) {
      throw new KnowledgeHierarchicalQueryError("knowledge_exact_query_timed_out");
    }
    throw error;
  }
}

function entryExactSql(input: Readonly<{
  caseSensitive: boolean;
  limit: number;
  offset: number;
  operation: KnowledgeExactEntryKind;
  query: string;
  scope: KnowledgeHierarchicalScope;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
  const field: Exclude<KnowledgeExactSearchField, "any"> =
    input.operation === "filename" || input.operation === "heading" ||
      input.operation === "tag" || input.operation === "title"
      ? input.operation
      : "body";
  const comparison = input.caseSensitive
    ? Prisma.sql`entry."value" = ${input.query}`
    : Prisma.sql`entry."normalizedValue" = ${knowledgeExactNormalizedValue(input.query)}`;
  return Prisma.sql`
    WITH
    authorized_artifacts AS MATERIALIZED (${authorized}),
    matches AS MATERIALIZED (
      SELECT
        authorized."sourceArtifactId",
        entry."indexArtifactId",
        entry."sectionId",
        entry."passageId",
        entry."page",
        entry."pageEnd",
        entry."value",
        ${field}::text AS field,
        entry."ordinal"
      FROM "KnowledgeArtifactExactEntry" AS entry
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = entry."indexArtifactId"
      WHERE entry."kind" = ${input.operation}::"KnowledgeExactEntryKind"
        AND ${comparison}
      ORDER BY authorized."sourceArtifactId", entry."ordinal"
      OFFSET ${input.offset}
      LIMIT ${input.limit + 1}
    )
    SELECT
      0::integer AS "scannedBytes",
      false AS "scanTruncated",
      COALESCE(jsonb_agg(jsonb_build_object(
        'sourceArtifactId', matches."sourceArtifactId",
        'indexArtifactId', matches."indexArtifactId",
        'sectionId', matches."sectionId",
        'passageId', matches."passageId",
        'page', matches."page",
        'pageEnd', matches."pageEnd",
        'field', matches.field,
        'value', matches."value"
      ) ORDER BY matches."sourceArtifactId", matches."ordinal"), '[]'::jsonb) AS results
    FROM matches
  `;
}

function escapedRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function scannedExactSql(input: Readonly<{
  caseSensitive: boolean;
  field: KnowledgeExactSearchField;
  limit: number;
  offset: number;
  operation: "phrase" | "regex" | "token";
  query: string;
  scope: KnowledgeHierarchicalScope;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
  let condition: Prisma.Sql;
  if (input.operation === "phrase") {
    condition = input.caseSensitive
      ? Prisma.sql`strpos(bounded."text", ${input.query}) > 0`
      : Prisma.sql`strpos(lower(bounded."text"), lower(${input.query})) > 0`;
  } else {
    const pattern = input.operation === "regex"
      ? input.query
      : `(^|[^[:alnum:]_])${escapedRegexLiteral(input.query)}([^[:alnum:]_]|$)`;
    condition = input.caseSensitive
      ? Prisma.sql`bounded."text" ~ ${pattern}`
      : Prisma.sql`bounded."text" ~* ${pattern}`;
  }
  const includeBody = input.field === "any" || input.field === "body";
  const metadataFields: readonly Exclude<KnowledgeExactSearchField, "any" | "body">[] =
    input.field === "any"
      ? ["filename", "heading", "tag", "title"]
      : input.field === "body" ? [] : [input.field];
  const bodyRows = includeBody ? Prisma.sql`
      SELECT
        authorized."sourceArtifactId",
        passage."indexArtifactId",
        passage."sectionId",
        passage."id" AS "passageId",
        passage."page",
        passage."pageEnd",
        passage."text",
        'body'::text AS field,
        0::integer AS "fieldOrder",
        passage."ordinal" AS "rowOrdinal",
        octet_length(passage."text") AS "textBytes"
      FROM "KnowledgeArtifactPassageIndex" AS passage
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = passage."indexArtifactId"
  ` : Prisma.empty;
  const metadataRows = metadataFields.length > 0 ? Prisma.sql`
      SELECT
        authorized."sourceArtifactId",
        entry."indexArtifactId",
        entry."sectionId",
        entry."passageId",
        entry."page",
        entry."pageEnd",
        entry."value" AS text,
        entry."kind"::text AS field,
        CASE entry."kind"
          WHEN 'filename'::"KnowledgeExactEntryKind" THEN 1
          WHEN 'title'::"KnowledgeExactEntryKind" THEN 2
          WHEN 'heading'::"KnowledgeExactEntryKind" THEN 3
          ELSE 4
        END AS "fieldOrder",
        entry."ordinal" AS "rowOrdinal",
        octet_length(entry."value") AS "textBytes"
      FROM "KnowledgeArtifactExactEntry" AS entry
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = entry."indexArtifactId"
      WHERE entry."kind" IN (${Prisma.join(metadataFields.map((field) =>
        Prisma.sql`${field}::"KnowledgeExactEntryKind"`))})
  ` : Prisma.empty;
  const scopedRows = includeBody && metadataFields.length > 0
    ? Prisma.sql`${bodyRows} UNION ALL ${metadataRows}`
    : includeBody ? bodyRows : metadataRows;
  return Prisma.sql`
    WITH
    authorized_artifacts AS MATERIALIZED (${authorized}),
    scoped AS MATERIALIZED (
      ${scopedRows}
      ORDER BY "sourceArtifactId", "fieldOrder", "rowOrdinal"
    ),
    measured AS MATERIALIZED (
      SELECT scoped.*,
        COALESCE(sum(scoped."textBytes") OVER (
          ORDER BY scoped."sourceArtifactId", scoped."fieldOrder", scoped."rowOrdinal"
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0)::bigint AS "bytesBefore"
      FROM scoped
    ),
    bounded AS MATERIALIZED (
      SELECT * FROM measured
      WHERE "bytesBefore" + "textBytes" <= ${KNOWLEDGE_EXACT_SCAN_MAX_BYTES}
    ),
    matches AS MATERIALIZED (
      SELECT *
      FROM bounded
      WHERE ${condition}
      ORDER BY "sourceArtifactId", "fieldOrder", "rowOrdinal"
      OFFSET ${input.offset}
      LIMIT ${input.limit + 1}
    ),
    scan_stats AS (
      SELECT
        COALESCE(max("bytesBefore" + "textBytes"), 0)::bigint AS "scannedBytes",
        COALESCE((SELECT sum("textBytes") FROM scoped), 0)::bigint >
          ${KNOWLEDGE_EXACT_SCAN_MAX_BYTES}::bigint AS "scanTruncated"
      FROM bounded
    )
    SELECT
      scan_stats."scannedBytes",
      scan_stats."scanTruncated",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'sourceArtifactId', matches."sourceArtifactId",
          'indexArtifactId', matches."indexArtifactId",
          'sectionId', matches."sectionId",
          'passageId', matches."passageId",
          'page', matches."page",
          'pageEnd', matches."pageEnd",
          'field', matches.field,
          'value', matches."text"
        ) ORDER BY matches."sourceArtifactId", matches."fieldOrder", matches."rowOrdinal")
        FROM matches
      ), '[]'::jsonb) AS results
    FROM scan_stats
  `;
}

function decodeExactHit(value: unknown, operation: KnowledgeExactOperation): KnowledgeExactIndexHit | null {
  if (!record(value)) return null;
  const page = value.page === null ? null : integer(value.page);
  const pageEnd = value.pageEnd === null ? null : integer(value.pageEnd);
  if (
    typeof value.sourceArtifactId !== "string" || !value.sourceArtifactId ||
    typeof value.indexArtifactId !== "string" || !value.indexArtifactId ||
    typeof value.field !== "string" ||
    !exactResultFields.has(value.field as Exclude<KnowledgeExactSearchField, "any">) ||
    typeof value.value !== "string" || !value.value ||
    (value.sectionId !== null && typeof value.sectionId !== "string") ||
    (value.passageId !== null && typeof value.passageId !== "string") ||
    (page === null) !== (pageEnd === null) ||
    page !== null && (page < 1 || pageEnd! < page)
  ) return null;
  return Object.freeze({
    field: value.field as Exclude<KnowledgeExactSearchField, "any">,
    indexArtifactId: value.indexArtifactId,
    kind: operation,
    page,
    pageEnd,
    passageId: value.passageId as string | null,
    sectionId: value.sectionId as string | null,
    sourceArtifactId: value.sourceArtifactId,
    value: value.value
  });
}

function decodeExactPage(
  row: unknown,
  input: Readonly<{ limit: number; offset: number; operation: KnowledgeExactOperation }>
): KnowledgeExactSearchPage {
  if (!record(row) || !Array.isArray(row.results) || typeof row.scanTruncated !== "boolean") {
    throw new Error("knowledge_exact_result_invalid");
  }
  const scanned = typeof row.scannedBytes === "bigint"
    ? Number(row.scannedBytes)
    : integer(row.scannedBytes);
  const decoded = row.results.map((value) => decodeExactHit(value, input.operation));
  if (
    scanned === null || !Number.isSafeInteger(scanned) || scanned < 0 ||
    scanned > KNOWLEDGE_EXACT_SCAN_MAX_BYTES ||
    decoded.some((value) => value === null)
  ) throw new Error("knowledge_exact_result_invalid");
  const hasMore = decoded.length > input.limit &&
    input.offset + input.limit <= KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET;
  return Object.freeze({
    nextCursor: hasMore ? encodeKnowledgeExactCursor(input.offset + input.limit) : null,
    results: Object.freeze((decoded as KnowledgeExactIndexHit[]).slice(0, input.limit)),
    scannedBytes: scanned,
    scanTruncated: row.scanTruncated
  });
}

export function knowledgeHierarchicalMetadataDiscoverySql(input: Readonly<{
  fields?: readonly KnowledgeSourceDiscoveryField[];
  limit: number;
  offset?: number;
  query: string;
  scope: KnowledgeHierarchicalScope;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
  const normalized = knowledgeExactNormalizedValue(input.query);
  const fields = input.fields ?? [...metadataKinds];
  const offset = input.offset ?? 0;
  return Prisma.sql`
    WITH
    authorized_artifacts AS MATERIALIZED (${authorized}),
    metadata AS MATERIALIZED (
      SELECT
        authorized."sourceArtifactId",
        document."indexArtifactId",
        'filename'::text AS kind,
        document."fileName" AS value,
        lower(document."fileName") AS "normalizedValue"
      FROM "KnowledgeArtifactDocumentIndex" AS document
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = document."indexArtifactId"
      UNION ALL
      SELECT
        authorized."sourceArtifactId",
        document."indexArtifactId",
        'source_name'::text AS kind,
        document."sourceName" AS value,
        lower(document."sourceName") AS "normalizedValue"
      FROM "KnowledgeArtifactDocumentIndex" AS document
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = document."indexArtifactId"
      UNION ALL
      SELECT
        authorized."sourceArtifactId",
        document."indexArtifactId",
        'title'::text AS kind,
        document."title" AS value,
        lower(document."title") AS "normalizedValue"
      FROM "KnowledgeArtifactDocumentIndex" AS document
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = document."indexArtifactId"
      WHERE document."title" IS NOT NULL AND document."title" <> ''
      UNION ALL
      SELECT
        authorized."sourceArtifactId",
        entry."indexArtifactId",
        entry."kind"::text AS kind,
        entry."value",
        entry."normalizedValue"
      FROM "KnowledgeArtifactExactEntry" AS entry
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = entry."indexArtifactId"
      WHERE entry."kind" IN (
        'heading'::"KnowledgeExactEntryKind",
        'tag'::"KnowledgeExactEntryKind"
      )
    )
    SELECT
      metadata."sourceArtifactId",
      metadata."indexArtifactId",
      metadata.kind,
      metadata.value,
      similarity(metadata."normalizedValue", ${normalized}) AS similarity
    FROM metadata
    WHERE metadata.kind = ANY(ARRAY[${Prisma.join(fields)}]::text[])
      AND metadata."normalizedValue" % ${normalized}
    ORDER BY similarity DESC, metadata."sourceArtifactId", metadata.kind, metadata.value
    OFFSET ${offset}
    LIMIT ${input.limit}
  `;
}

export function knowledgeHierarchicalSourceMetadataDiscoverySql(input: Readonly<{
  fields: readonly KnowledgeSourceDiscoveryField[];
  limit: number;
  offset: number;
  query: string;
  scope: KnowledgeHierarchicalScope;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
  const normalized = knowledgeExactNormalizedValue(input.query);
  return Prisma.sql`
    WITH
    authorized_artifacts AS MATERIALIZED (${authorized}),
    metadata AS MATERIALIZED (
      SELECT
        authorized."sourceArtifactId",
        document."indexArtifactId",
        'filename'::text AS kind,
        lower(document."fileName") AS "normalizedValue"
      FROM "KnowledgeArtifactDocumentIndex" AS document
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = document."indexArtifactId"
      UNION ALL
      SELECT
        authorized."sourceArtifactId",
        document."indexArtifactId",
        'source_name'::text AS kind,
        lower(document."sourceName") AS "normalizedValue"
      FROM "KnowledgeArtifactDocumentIndex" AS document
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = document."indexArtifactId"
      UNION ALL
      SELECT
        authorized."sourceArtifactId",
        document."indexArtifactId",
        'title'::text AS kind,
        lower(document."title") AS "normalizedValue"
      FROM "KnowledgeArtifactDocumentIndex" AS document
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = document."indexArtifactId"
      WHERE document."title" IS NOT NULL AND document."title" <> ''
      UNION ALL
      SELECT
        authorized."sourceArtifactId",
        entry."indexArtifactId",
        entry."kind"::text AS kind,
        entry."normalizedValue"
      FROM "KnowledgeArtifactExactEntry" AS entry
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = entry."indexArtifactId"
      WHERE entry."kind" IN (
        'heading'::"KnowledgeExactEntryKind",
        'tag'::"KnowledgeExactEntryKind"
      )
    ),
    matched AS MATERIALIZED (
      SELECT
        metadata."sourceArtifactId",
        metadata."indexArtifactId",
        metadata.kind,
        similarity(metadata."normalizedValue", ${normalized}) AS similarity
      FROM metadata
      WHERE metadata.kind = ANY(ARRAY[${Prisma.join([...input.fields])}]::text[])
        AND metadata."normalizedValue" % ${normalized}
    ),
    source_matches AS MATERIALIZED (
      SELECT
        matched."sourceArtifactId",
        min(matched."indexArtifactId") AS "indexArtifactId",
        max(matched.similarity) AS similarity,
        array_remove(ARRAY[
          CASE WHEN bool_or(matched.kind = 'filename') THEN 'filename'::text END,
          CASE WHEN bool_or(matched.kind = 'heading') THEN 'heading'::text END,
          CASE WHEN bool_or(matched.kind = 'source_name') THEN 'source_name'::text END,
          CASE WHEN bool_or(matched.kind = 'tag') THEN 'tag'::text END,
          CASE WHEN bool_or(matched.kind = 'title') THEN 'title'::text END
        ], NULL) AS "matchedFields"
      FROM matched
      GROUP BY matched."sourceArtifactId"
    )
    SELECT
      source_matches."sourceArtifactId",
      source_matches."indexArtifactId",
      source_matches."matchedFields",
      source_matches.similarity
    FROM source_matches
    ORDER BY source_matches.similarity DESC, source_matches."sourceArtifactId"
    OFFSET ${input.offset}
    LIMIT ${input.limit}
  `;
}

function decodeMetadataHit(value: unknown): KnowledgeMetadataDiscoveryHit | null {
  if (!record(value)) return null;
  const similarity = finite(value.similarity);
  if (
    typeof value.sourceArtifactId !== "string" || !value.sourceArtifactId ||
    typeof value.indexArtifactId !== "string" || !value.indexArtifactId ||
    typeof value.kind !== "string" ||
    !metadataKinds.has(value.kind as KnowledgeMetadataDiscoveryHit["kind"]) ||
    typeof value.value !== "string" || !value.value ||
    similarity === null || similarity < 0 || similarity > 1
  ) return null;
  return Object.freeze({
    indexArtifactId: value.indexArtifactId,
    kind: value.kind as KnowledgeMetadataDiscoveryHit["kind"],
    similarity,
    sourceArtifactId: value.sourceArtifactId,
    value: value.value
  });
}

function decodeSourceMetadataHit(value: unknown): KnowledgeSourceMetadataDiscoveryHit | null {
  if (!record(value)) return null;
  const similarity = finite(value.similarity);
  if (
    typeof value.sourceArtifactId !== "string" || !value.sourceArtifactId ||
    typeof value.indexArtifactId !== "string" || !value.indexArtifactId ||
    !Array.isArray(value.matchedFields) || value.matchedFields.length < 1 ||
    value.matchedFields.length > metadataKinds.size ||
    value.matchedFields.some((field) => typeof field !== "string" ||
      !metadataKinds.has(field as KnowledgeSourceDiscoveryField)) ||
    new Set(value.matchedFields).size !== value.matchedFields.length ||
    similarity === null || similarity < 0 || similarity > 1
  ) return null;
  const selected = new Set(value.matchedFields as KnowledgeSourceDiscoveryField[]);
  return Object.freeze({
    indexArtifactId: value.indexArtifactId,
    matchedFields: Object.freeze(
      [...metadataKinds].filter((field) => selected.has(field))
    ),
    similarity,
    sourceArtifactId: value.sourceArtifactId
  });
}

export function createPrismaKnowledgeHierarchicalRetrievalRepository(
  client: HierarchicalRetrievalClient = prisma,
  options: Readonly<{ statementTimeoutMs?: number }> = {}
): KnowledgeHierarchicalRetrievalRepository {
  const statementTimeoutMs = options.statementTimeoutMs ?? 250;
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 ||
    statementTimeoutMs > 5_000) {
    throw new Error("knowledge_hierarchical_statement_timeout_invalid");
  }
  async function lexical(
    level: KnowledgeLexicalTargetLevel,
    input: KnowledgeHierarchicalScope & { limit: number; query: string }
  ): Promise<readonly KnowledgeLexicalIndexHit[]> {
    const scope = decodeKnowledgeHierarchicalScope(input);
    const query = decodeKnowledgeHierarchicalQuery(input.query);
    const limit = decodeKnowledgeHierarchicalLimit(input.limit);
    const rows = await client.$queryRaw<unknown[]>(knowledgeHierarchicalLexicalSearchSql({
      level,
      limit,
      query,
      scope
    }));
    const decoded = rows.map((row) => decodeLexicalHit(row, level));
    if (decoded.some((row) => row === null)) throw new Error("knowledge_lexical_result_invalid");
    return Object.freeze(decoded as KnowledgeLexicalIndexHit[]);
  }

  async function discoverSourceMetadata(
    input: KnowledgeHierarchicalScope & {
      cursor?: string;
      fields?: readonly KnowledgeSourceDiscoveryField[];
      limit: number;
      query: string;
    }
  ) {
    const scope = decodeKnowledgeHierarchicalScope(input);
    const query = decodeKnowledgeHierarchicalQuery(input.query);
    const limit = decodeKnowledgeHierarchicalLimit(input.limit);
    const offset = decodeKnowledgeExactCursor(input.cursor);
    const fields = input.fields ?? [...metadataKinds];
    if (query.length < 2 || fields.length < 1 || fields.length > metadataKinds.size ||
      fields.some((field) => !metadataKinds.has(field)) ||
      new Set(fields).size !== fields.length) {
      throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
    }
    const rows = await boundedQuery(client, statementTimeoutMs, async (tx) => {
      await tx.$executeRaw`SET LOCAL pg_trgm.similarity_threshold = 0.2`;
      return tx.$queryRaw<unknown[]>(knowledgeHierarchicalSourceMetadataDiscoverySql({
        fields,
        limit: limit + 1,
        offset,
        query,
        scope
      }));
    });
    const decoded = rows.map(decodeSourceMetadataHit);
    if (decoded.some((row) => row === null)) throw new Error("knowledge_metadata_result_invalid");
    const hasMore = decoded.length > limit &&
      offset + limit <= KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET;
    return Object.freeze({
      nextCursor: hasMore ? encodeKnowledgeExactCursor(offset + limit) : null,
      results: Object.freeze((decoded as KnowledgeSourceMetadataDiscoveryHit[]).slice(0, limit))
    });
  }

  return {
    discoverDocuments: (input) => lexical("document", input),
    async discoverMetadata(input): Promise<readonly KnowledgeMetadataDiscoveryHit[]> {
      const scope = decodeKnowledgeHierarchicalScope(input);
      const query = decodeKnowledgeHierarchicalQuery(input.query);
      const limit = decodeKnowledgeHierarchicalLimit(input.limit);
      if (query.length < 2) {
        throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
      }
      const rows = await boundedQuery(client, statementTimeoutMs, async (tx) => {
        await tx.$executeRaw`SET LOCAL pg_trgm.similarity_threshold = 0.2`;
        return tx.$queryRaw<unknown[]>(knowledgeHierarchicalMetadataDiscoverySql({
          limit,
          query,
          scope
        }));
      });
      const decoded = rows.map(decodeMetadataHit);
      if (decoded.some((row) => row === null)) {
        throw new Error("knowledge_metadata_result_invalid");
      }
      return Object.freeze(decoded as KnowledgeMetadataDiscoveryHit[]);
    },
    discoverSourceMetadata,
    discoverSections: (input) => lexical("section", input),
    async findExact(input): Promise<KnowledgeExactSearchPage> {
      const scope = decodeKnowledgeHierarchicalScope(input);
      const query = decodeKnowledgeHierarchicalQuery(input.query);
      const limit = decodeKnowledgeHierarchicalLimit(input.limit);
      const offset = decodeKnowledgeExactCursor(input.cursor);
      const operation = input.operation;
      const caseSensitive = input.caseSensitive ?? false;
      const field = input.field ?? "body";
      if (![...exactEntryKinds, "phrase", "regex", "token"].includes(operation)) {
        throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
      }
      if (!exactSearchFields.has(field) ||
        exactEntryKinds.has(operation as KnowledgeExactEntryKind) && input.field !== undefined) {
        throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
      }
      const sql = exactEntryKinds.has(operation as KnowledgeExactEntryKind)
        ? entryExactSql({
            caseSensitive,
            limit,
            offset,
            operation: operation as KnowledgeExactEntryKind,
            query,
            scope
          })
        : scannedExactSql({
            caseSensitive,
            field,
            limit,
            offset,
            operation: operation as "phrase" | "regex" | "token",
            query: operation === "regex" ? decodeKnowledgeSafeRegex(query) : query,
            scope
          });
      const rows = await boundedQuery(
        client,
        statementTimeoutMs,
        (tx) => tx.$queryRaw<unknown[]>(sql)
      );
      return decodeExactPage(rows[0], { limit, offset, operation });
    }
  };
}

export type PrismaKnowledgeHierarchicalRetrievalRepository = ReturnType<
  typeof createPrismaKnowledgeHierarchicalRetrievalRepository
>;
