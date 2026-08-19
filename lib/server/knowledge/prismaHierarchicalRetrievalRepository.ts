import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  knowledgeExactNormalizedValue,
  KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
  type KnowledgeExactEntryKind,
  type KnowledgeLexicalLanguage
} from "./hierarchicalIndex";
import {
  decodeKnowledgeExactCursor,
  decodeKnowledgeHierarchicalLimit,
  decodeKnowledgeHierarchicalQuery,
  decodeKnowledgeHierarchicalScope,
  decodeKnowledgeSafeRegex,
  encodeKnowledgeExactCursor,
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
  type KnowledgeMetadataDiscoveryHit
} from "./hierarchicalRetrieval";

type HierarchicalRetrievalClient = Pick<PrismaClient, "$queryRaw" | "$transaction">;

const lexicalLanguages = new Set<KnowledgeLexicalLanguage>([
  "english",
  "mixed",
  "russian",
  "unknown"
]);
const lexicalFields = new Set<KnowledgeLexicalMatchedField>([
  "body",
  "context",
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

function authorizedArtifactsSql(scope: Readonly<{
  ownerUserId: string;
  sourceArtifactIds: readonly string[];
}>): Prisma.Sql {
  return Prisma.sql`
    SELECT
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
      AND hierarchy."schemaVersion" = ${KNOWLEDGE_HIERARCHICAL_INDEX_VERSION}
      AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
      AND source."ownerUserId" = ${scope.ownerUserId}
      AND source_artifact."id" IN (${Prisma.join([...scope.sourceArtifactIds])})
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
      item."languageConfig",
      item."fileName" AS "filenameField",
      item."sourceName" AS "sourceNameField",
      COALESCE(item."title", '') AS "titleField",
      item."outlineText" AS "headingField",
      item."tagsText" AS "tagsField",
      item."keywordsText" AS "keywordsField",
      item."entitiesText" AS "entitiesField",
      item."description" AS "descriptionField",
      item."summary" AS "summaryField",
      ''::text AS "contextField",
      ''::text AS "bodyField",
      item."simpleSearchVector",
      item."englishSearchVector",
      item."russianSearchVector"
    FROM "KnowledgeArtifactDocumentIndex" AS item
    INNER JOIN authorized_artifacts AS authorized
      ON authorized."indexArtifactId" = item."indexArtifactId"
  `;
  if (level === "section") return Prisma.sql`
    SELECT
      authorized."sourceArtifactId",
      item."indexArtifactId",
      item."id" AS "targetId",
      item."label",
      item."page",
      item."pageEnd",
      NULL::text AS "text",
      item."languageConfig",
      item."fileName" AS "filenameField",
      ''::text AS "sourceNameField",
      item."documentTitle" AS "titleField",
      item."headingText" AS "headingField",
      item."tagsText" AS "tagsField",
      item."keywordsText" AS "keywordsField",
      item."entitiesText" AS "entitiesField",
      item."sourceDescription" AS "descriptionField",
      item."summary" AS "summaryField",
      ''::text AS "contextField",
      ''::text AS "bodyField",
      item."simpleSearchVector",
      item."englishSearchVector",
      item."russianSearchVector"
    FROM "KnowledgeArtifactSectionIndex" AS item
    INNER JOIN authorized_artifacts AS authorized
      ON authorized."indexArtifactId" = item."indexArtifactId"
  `;
  return Prisma.sql`
    SELECT
      authorized."sourceArtifactId",
      item."indexArtifactId",
      item."id" AS "targetId",
      COALESCE(NULLIF(item."headingPath"[cardinality(item."headingPath")], ''), item."fileName") AS "label",
      item."page",
      item."pageEnd",
      item."text",
      item."languageConfig",
      item."fileName" AS "filenameField",
      item."sourceName" AS "sourceNameField",
      item."documentTitle" AS "titleField",
      item."headingText" AS "headingField",
      item."tagsText" AS "tagsField",
      ''::text AS "keywordsField",
      ''::text AS "entitiesField",
      item."sourceDescription" AS "descriptionField",
      ''::text AS "summaryField",
      item."contextPrefix" AS "contextField",
      item."text" AS "bodyField",
      item."simpleSearchVector",
      item."englishSearchVector",
      item."russianSearchVector"
    FROM "KnowledgeArtifactPassageIndex" AS item
    INNER JOIN authorized_artifacts AS authorized
      ON authorized."indexArtifactId" = item."indexArtifactId"
  `;
}

function fieldMatches(field: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    to_tsvector('simple'::regconfig, COALESCE(${field}, '')) @@ candidate."simpleQuery"
    OR to_tsvector('english'::regconfig, COALESCE(${field}, '')) @@ candidate."englishQuery"
    OR to_tsvector('russian'::regconfig, COALESCE(${field}, '')) @@ candidate."russianQuery"
  )`;
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
    ["summary", Prisma.sql`candidate."summaryField"`],
    ["context", Prisma.sql`candidate."contextField"`],
    ["body", Prisma.sql`candidate."bodyField"`]
  ];
  return Prisma.sql`array_remove(ARRAY[${Prisma.join(fields.map(([name, field]) =>
    Prisma.sql`CASE WHEN ${fieldMatches(field)} THEN ${name}::text ELSE NULL::text END`
  ))}], NULL)`;
}

export function knowledgeHierarchicalLexicalSearchSql(input: Readonly<{
  level: KnowledgeLexicalTargetLevel;
  limit: number;
  query: string;
  scope: Readonly<{ ownerUserId: string; sourceArtifactIds: readonly string[] }>;
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
        websearch_to_tsquery('english'::regconfig, ${input.query}) AS "englishStrictQuery",
        websearch_to_tsquery('russian'::regconfig, ${input.query}) AS "russianStrictQuery",
        to_tsquery(
          'simple'::regconfig,
          replace(plainto_tsquery('simple'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "simpleQuery",
        to_tsquery(
          'english'::regconfig,
          replace(plainto_tsquery('english'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "englishQuery",
        to_tsquery(
          'russian'::regconfig,
          replace(plainto_tsquery('russian'::regconfig, ${input.query})::text, ' & ', ' | ')
        ) AS "russianQuery"
    ),
    indexed AS (${indexed}),
    candidates AS MATERIALIZED (
      SELECT
        indexed.*,
        query_terms."simpleQuery",
        query_terms."englishQuery",
        query_terms."russianQuery",
        ts_rank_cd(indexed."simpleSearchVector", query_terms."simpleQuery") +
          CASE WHEN indexed."simpleSearchVector" @@ query_terms."simpleStrictQuery"
            THEN 1 ELSE 0 END AS "simpleRank",
        ts_rank_cd(indexed."englishSearchVector", query_terms."englishQuery") +
          CASE WHEN indexed."englishSearchVector" @@ query_terms."englishStrictQuery"
            THEN 1 ELSE 0 END AS "englishRank",
        ts_rank_cd(indexed."russianSearchVector", query_terms."russianQuery") +
          CASE WHEN indexed."russianSearchVector" @@ query_terms."russianStrictQuery"
            THEN 1 ELSE 0 END AS "russianRank"
      FROM indexed
      CROSS JOIN query_terms
      WHERE indexed."simpleSearchVector" @@ query_terms."simpleQuery"
        OR indexed."englishSearchVector" @@ query_terms."englishQuery"
        OR indexed."russianSearchVector" @@ query_terms."russianQuery"
    )
    SELECT
      candidate."sourceArtifactId",
      candidate."indexArtifactId",
      candidate."targetId",
      candidate."label",
      candidate."page",
      candidate."pageEnd",
      candidate."text",
      candidate."languageConfig",
      GREATEST(candidate."simpleRank", candidate."englishRank", candidate."russianRank") AS "rank",
      CASE
        WHEN candidate."simpleRank" >= candidate."englishRank"
          AND candidate."simpleRank" >= candidate."russianRank" THEN 'simple'
        WHEN candidate."russianRank" >= candidate."englishRank" THEN 'russian'
        ELSE 'english'
      END AS "queryVariant",
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
    typeof value.languageConfig !== "string" ||
    !lexicalLanguages.has(value.languageConfig as KnowledgeLexicalLanguage) ||
    !["english", "russian", "simple"].includes(String(value.queryVariant)) ||
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
    languageConfig: value.languageConfig as KnowledgeLexicalLanguage,
    level,
    matchedFields: Object.freeze(value.matchedFields as KnowledgeLexicalMatchedField[]),
    page,
    pageEnd,
    queryVariant: value.queryVariant as "english" | "russian" | "simple",
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
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '250ms'`;
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
  scope: Readonly<{ ownerUserId: string; sourceArtifactIds: readonly string[] }>;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
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
  limit: number;
  offset: number;
  operation: "phrase" | "regex" | "token";
  query: string;
  scope: Readonly<{ ownerUserId: string; sourceArtifactIds: readonly string[] }>;
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
  return Prisma.sql`
    WITH
    authorized_artifacts AS MATERIALIZED (${authorized}),
    scoped AS MATERIALIZED (
      SELECT
        authorized."sourceArtifactId",
        passage."indexArtifactId",
        passage."sectionId",
        passage."id" AS "passageId",
        passage."page",
        passage."pageEnd",
        passage."text",
        passage."ordinal",
        octet_length(passage."text") AS "textBytes"
      FROM "KnowledgeArtifactPassageIndex" AS passage
      INNER JOIN authorized_artifacts AS authorized
        ON authorized."indexArtifactId" = passage."indexArtifactId"
      ORDER BY authorized."sourceArtifactId", passage."ordinal"
    ),
    measured AS MATERIALIZED (
      SELECT scoped.*,
        COALESCE(sum(scoped."textBytes") OVER (
          ORDER BY scoped."sourceArtifactId", scoped."ordinal"
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
      ORDER BY "sourceArtifactId", "ordinal"
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
          'value', matches."text"
        ) ORDER BY matches."sourceArtifactId", matches."ordinal")
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
    typeof value.value !== "string" || !value.value ||
    (value.sectionId !== null && typeof value.sectionId !== "string") ||
    (value.passageId !== null && typeof value.passageId !== "string") ||
    (page === null) !== (pageEnd === null) ||
    page !== null && (page < 1 || pageEnd! < page)
  ) return null;
  return Object.freeze({
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
  const hasMore = decoded.length > input.limit;
  return Object.freeze({
    nextCursor: hasMore ? encodeKnowledgeExactCursor(input.offset + input.limit) : null,
    results: Object.freeze((decoded as KnowledgeExactIndexHit[]).slice(0, input.limit)),
    scannedBytes: scanned,
    scanTruncated: row.scanTruncated
  });
}

export function knowledgeHierarchicalMetadataDiscoverySql(input: Readonly<{
  limit: number;
  query: string;
  scope: Readonly<{ ownerUserId: string; sourceArtifactIds: readonly string[] }>;
}>): Prisma.Sql {
  const authorized = authorizedArtifactsSql(input.scope);
  const normalized = knowledgeExactNormalizedValue(input.query);
  return Prisma.sql`
    WITH authorized_artifacts AS MATERIALIZED (${authorized})
    SELECT
      authorized."sourceArtifactId",
      entry."indexArtifactId",
      entry."kind"::text AS kind,
      entry."value",
      similarity(entry."normalizedValue", ${normalized}) AS similarity
    FROM "KnowledgeArtifactExactEntry" AS entry
    INNER JOIN authorized_artifacts AS authorized
      ON authorized."indexArtifactId" = entry."indexArtifactId"
    WHERE entry."kind" IN (
      'filename'::"KnowledgeExactEntryKind",
      'heading'::"KnowledgeExactEntryKind",
      'tag'::"KnowledgeExactEntryKind",
      'title'::"KnowledgeExactEntryKind"
    )
      AND entry."normalizedValue" % ${normalized}
    ORDER BY similarity DESC, authorized."sourceArtifactId", entry."ordinal"
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

export function createPrismaKnowledgeHierarchicalRetrievalRepository(
  client: HierarchicalRetrievalClient = prisma
): KnowledgeHierarchicalRetrievalRepository {
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

  return {
    discoverDocuments: (input) => lexical("document", input),
    async discoverMetadata(input): Promise<readonly KnowledgeMetadataDiscoveryHit[]> {
      const scope = decodeKnowledgeHierarchicalScope(input);
      const query = decodeKnowledgeHierarchicalQuery(input.query);
      const limit = decodeKnowledgeHierarchicalLimit(input.limit);
      if (query.length < 2) {
        throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
      }
      const rows = await boundedQuery(client, async (tx) => {
        await tx.$executeRaw`SET LOCAL pg_trgm.similarity_threshold = 0.2`;
        return tx.$queryRaw<unknown[]>(knowledgeHierarchicalMetadataDiscoverySql({
          limit,
          query,
          scope
        }));
      });
      const decoded = rows.map(decodeMetadataHit);
      if (decoded.some((row) => row === null)) throw new Error("knowledge_metadata_result_invalid");
      return Object.freeze(decoded as KnowledgeMetadataDiscoveryHit[]);
    },
    discoverSections: (input) => lexical("section", input),
    async findExact(input): Promise<KnowledgeExactSearchPage> {
      const scope = decodeKnowledgeHierarchicalScope(input);
      const query = decodeKnowledgeHierarchicalQuery(input.query);
      const limit = decodeKnowledgeHierarchicalLimit(input.limit);
      const offset = decodeKnowledgeExactCursor(input.cursor);
      const operation = input.operation;
      const caseSensitive = input.caseSensitive ?? false;
      if (![...exactEntryKinds, "phrase", "regex", "token"].includes(operation)) {
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
            limit,
            offset,
            operation: operation as "phrase" | "regex" | "token",
            query: operation === "regex" ? decodeKnowledgeSafeRegex(query) : query,
            scope
          });
      const rows = await boundedQuery(client, (tx) => tx.$queryRaw<unknown[]>(sql));
      return decodeExactPage(rows[0], { limit, offset, operation });
    },
    searchPassages: (input) => lexical("passage", input)
  };
}

export type PrismaKnowledgeHierarchicalRetrievalRepository = ReturnType<
  typeof createPrismaKnowledgeHierarchicalRetrievalRepository
>;
