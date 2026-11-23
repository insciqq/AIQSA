import { Prisma, type PrismaClient } from "@prisma/client";
import { MEMORY_SWITCH_DEFAULTS } from "../../../contracts/memoryNote";
import { chatSearchEligibleSql } from "../eligibility";
import { chatSearchPassageTitle } from "../index/passages";
import type { PastChatTurnRange } from "./dates";
import { PAST_CHAT_QUERY_LIMITS, type PastChatUnitStatistics, type PastChatWordUnit } from "./query";
import type { PastChatLaneHit, PastChatWordHit } from "./rank";

/**
 * The SQL of past-chat search over `ChatSearchPassage`, one owner at a time.
 * Every query joins the passage's chat and applies the one eligibility rule
 * (`chatSearchEligibleSql`): the owner's own ordinary chats, never Temporary,
 * Excluded, imported, scheduled, Discord or fenced ones, and never the current
 * chat, and keeps to each chat's active branch (`ON_ACTIVE_BRANCH`) before it
 * limits anything. User text only ever travels as bound parameters. Exact vector distance
 * over the owner's passages of the current embedding model is enough at the
 * measured sizes (about 6 000 passages per user); there is no approximate index.
 */

export type PastChatScope = Readonly<{
  ownerId: string;
  /** The chat the agent answers in: never returned. */
  currentChatId: string;
  range: PastChatTurnRange;
}>;

export type PastChatPassageRow = Readonly<{
  id: string;
  chatId: string;
  userMessageId: string;
  turnAt: Date;
  text: string;
  /**
   * The chat's search title as the passage's header names it (`chatSearchPassageTitle`), never the stored title, so a
   * result names a chat only by what its passages hold (`chatSearchTitle`); a rename shows once the indexer rebuilt
   * the chat's passages, which it marks for that.
   */
  title: string;
}>;

type StoredPassageRow = Omit<PastChatPassageRow, "title">;

function withTitles(rows: readonly StoredPassageRow[]): PastChatPassageRow[] {
  return rows.map((row) => ({ ...row, title: chatSearchPassageTitle(row.text) }));
}

export type PastChatSearchStore = Readonly<{
  /** The user's Memory and past-chat search switches; both default to on. */
  switches(ownerId: string): Promise<PastChatSwitches>;
  /** How many of the owner's passages each unit of the query matches (`query.ts`). */
  wordStatistics(ownerId: string, query: string, phrases: readonly string[]): Promise<PastChatUnitStatistics[]>;
  wordHits(scope: PastChatScope, units: readonly PastChatWordUnit[], limit: number): Promise<PastChatWordHit[]>;
  vectorHits(scope: PastChatScope, vector: Readonly<{ providerModelId: string; values: readonly number[] }>, limit: number): Promise<PastChatLaneHit[]>;
  /** The texts and search titles of these passages that are still eligible and on their chat's active branch, in no order. */
  passages(scope: Omit<PastChatScope, "range">, ids: readonly string[]): Promise<PastChatPassageRow[]>;
  /** Each eligible chat once by its latest active-branch turn in the range (that turn's first window), newest first. */
  recent(scope: PastChatScope, limit: number): Promise<PastChatPassageRow[]>;
}>;

type SearchDb = Pick<PrismaClient, "$queryRaw" | "userSettings">;

export type PastChatSwitches = Readonly<{ memoryEnabled: boolean; pastChatSearchEnabled: boolean }>;

/** The user's Memory and past-chat search switches, read at every call; a user without settings has the defaults (on). */
export async function readPastChatSwitches(db: Pick<Prisma.TransactionClient, "userSettings">, ownerId: string): Promise<PastChatSwitches> {
  const row = await db.userSettings.findUnique({ select: { memoryEnabled: true, pastChatSearchEnabled: true }, where: { userId: ownerId } });
  return row ?? { memoryEnabled: MEMORY_SWITCH_DEFAULTS.memoryEnabled, pastChatSearchEnabled: MEMORY_SWITCH_DEFAULTS.pastChatSearchEnabled };
}

const QUOTE = Prisma.sql`chr(39)`;
const BACKSLASH = Prisma.sql`chr(92)`;

/** A lexeme as a one-lexeme `tsquery` literal: quoted, its quotes and backslashes doubled, never re-parsed. */
const quotedLexeme = Prisma.sql`(${QUOTE} || replace(replace(l.lexeme, ${BACKSLASH}, ${BACKSLASH} || ${BACKSLASH}), ${QUOTE}, ${QUOTE} || ${QUOTE}) || ${QUOTE})`;

function rangeSql(range: PastChatTurnRange): Prisma.Sql {
  return Prisma.sql`${range.from ? Prisma.sql`AND p."turnAt" >= ${range.from}` : Prisma.empty}
    ${range.until ? Prisma.sql`AND p."turnAt" < ${range.until}` : Prisma.empty}`;
}

function scopeSql(scope: Omit<PastChatScope, "range"> & Partial<Pick<PastChatScope, "range">>): Prisma.Sql {
  return Prisma.sql`p."userId" = ${scope.ownerId}
    AND ${chatSearchEligibleSql("c", scope.ownerId)}
    AND p."chatId" <> ${scope.currentChatId}
    ${scope.range ? rangeSql(scope.range) : Prisma.empty}`;
}

/**
 * The `moved_leaves` and `active_path` CTEs (without a trailing comma, under `WITH RECURSIVE`) that `ON_ACTIVE_BRANCH`
 * reads. A chat's passages are all built from one active leaf (`ChatSearchState.indexedLeafMessageId`), so while that
 * is still the chat's leaf every passage is on its active branch; only the owner's chats whose leaf moved since (a
 * branch switch, a turn not yet indexed, the upgrade backfill still running) are walked, from the current leaf up to
 * the root. `UNION` ends a walk that meets a message twice.
 */
function activeBranchSql(ownerId: string): Prisma.Sql {
  return Prisma.sql`moved_leaves AS MATERIALIZED (
    SELECT c."id" AS "chatId", c."activeLeafMessageId"
    FROM "Chat" c
    WHERE c."userId" = ${ownerId}
      AND EXISTS (SELECT 1 FROM "ChatSearchPassage" indexed WHERE indexed."chatId" = c."id")
      AND NOT EXISTS (SELECT 1 FROM "ChatSearchState" s
        WHERE s."chatId" = c."id" AND s."indexedLeafMessageId" = c."activeLeafMessageId")
  ),
  active_path AS (
    SELECT m."chatId", m."id", m."parentMessageId"
    FROM moved_leaves leaf
    JOIN "Message" m ON m."chatId" = leaf."chatId" AND m."id" = leaf."activeLeafMessageId"
    UNION
    SELECT parent."chatId", parent."id", parent."parentMessageId"
    FROM active_path a
    JOIN "Message" parent ON parent."chatId" = a."chatId" AND parent."id" = a."parentMessageId"
  )`;
}

/**
 * Passage `p` is on its chat's active branch: its chat's leaf has not moved since it was indexed, or its answer is on
 * the path from the current leaf (its question is that answer's parent). Every lane and every read applies it before
 * it limits anything, so after a branch switch an abandoned branch's passages can neither be returned nor fill a
 * lane's candidates ahead of a live match before the indexer drops them, and the ancestry both branches share stays
 * searchable (reviews 2026-11-23). A chat with no leaf has no branch. Needs `activeBranchSql`.
 */
const ON_ACTIVE_BRANCH = Prisma.sql`(
  NOT EXISTS (SELECT 1 FROM moved_leaves moved WHERE moved."chatId" = p."chatId")
  OR EXISTS (SELECT 1 FROM active_path a WHERE a."chatId" = p."chatId" AND a."id" = p."assistantMessageId")
)`;

function textArray(values: readonly string[]): Prisma.Sql {
  return values.length ? Prisma.sql`${[...values]}::text[]` : Prisma.sql`ARRAY[]::text[]`;
}

/** The vector as pgvector's text form; null for one that is empty or holds a value that is not finite. */
function vectorLiteral(values: readonly number[]): string | null {
  return values.length === 0 || values.some((value) => !Number.isFinite(value)) ? null : `[${values.join(",")}]`;
}

export function createPrismaPastChatSearchStore(db: SearchDb): PastChatSearchStore {
  return Object.freeze({
    switches: (ownerId: string) => readPastChatSwitches(db, ownerId),

    async wordStatistics(ownerId: string, query: string, phrases: readonly string[]): Promise<PastChatUnitStatistics[]> {
      const rows = await db.$queryRaw<Array<{ kind: string; key: string; query: string; df: number; n: number }>>(Prisma.sql`
        WITH lexemes AS MATERIALIZED (
          SELECT l.lexeme
          FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, ${query}))) AS l(lexeme)
          ORDER BY char_length(l.lexeme) DESC, l.lexeme
          LIMIT ${PAST_CHAT_QUERY_LIMITS.lexemes}
        ),
        units AS MATERIALIZED (
          SELECT 'exact'::text AS kind, l.lexeme AS key, ${quotedLexeme}::tsquery AS q FROM lexemes l
          UNION ALL
          SELECT 'prefix'::text, l.lexeme, (${quotedLexeme} || ':*')::tsquery FROM lexemes l WHERE char_length(l.lexeme) >= 4
          UNION ALL
          SELECT 'phrase'::text, ph.chunk, phraseto_tsquery('simple'::regconfig, ph.chunk) FROM unnest(${textArray(phrases)}) AS ph(chunk)
        )
        SELECT u.kind, u.key, u.q::text AS query,
          (SELECT count(*) FROM "ChatSearchPassage" s WHERE s."userId" = ${ownerId} AND s."searchVectorSimple" @@ u.q)::int AS df,
          (SELECT count(*) FROM "ChatSearchPassage" s WHERE s."userId" = ${ownerId})::int AS n
        FROM units u
        WHERE numnode(u.q) > 0`);
      return rows.flatMap((row) => row.kind === "exact" || row.kind === "prefix" || row.kind === "phrase"
        ? [{ documentFrequency: Number(row.df), key: row.key, kind: row.kind, passages: Number(row.n), query: row.query }]
        : []);
    },

    async wordHits(scope: PastChatScope, units: readonly PastChatWordUnit[], limit: number): Promise<PastChatWordHit[]> {
      if (units.length === 0) return [];
      const rows = await db.$queryRaw<Array<{ id: string; chatId: string; userMessageId: string; turnAt: Date; pinned: boolean; terms: string[];
        score: number }>>(Prisma.sql`
        WITH RECURSIVE ${activeBranchSql(scope.ownerId)},
        units AS MATERIALIZED (
          SELECT u.term, u.query::tsquery AS q, u.weight, u.pin, u.admits
          FROM unnest(${units.map((unit) => unit.term)}::text[], ${units.map((unit) => unit.query)}::text[],
            ${units.map((unit) => unit.weight)}::float8[], ${units.map((unit) => unit.pin)}::boolean[],
            ${units.map((unit) => unit.admits)}::boolean[]) AS u(term, query, weight, pin, admits)
        ),
        matches AS MATERIALIZED (
          SELECT p."id", p."chatId", p."userMessageId", p."turnAt", u.term, MAX(u.weight) AS weight, bool_or(u.pin) AS pin,
            bool_or(u.admits) AS admits
          FROM units u
          JOIN "ChatSearchPassage" p ON p."searchVectorSimple" @@ u.q
          JOIN "Chat" c ON c."id" = p."chatId"
          WHERE ${scopeSql(scope)} AND ${ON_ACTIVE_BRANCH}
          GROUP BY p."id", p."chatId", p."userMessageId", p."turnAt", u.term
        )
        SELECT m."id", m."chatId", m."userMessageId", m."turnAt", bool_or(m.pin) AS pinned,
          array_agg(m.term ORDER BY m.weight DESC, m.term) AS terms, SUM(m.weight)::float8 AS score
        FROM matches m
        GROUP BY m."id", m."chatId", m."userMessageId", m."turnAt"
        -- A common unit only adds weight to a passage another unit brought in (query.ts).
        HAVING bool_or(m.admits)
        ORDER BY bool_or(m.pin) DESC, SUM(m.weight) DESC, m."turnAt" DESC, m."id"
        LIMIT ${limit}`);
      return rows.map((row) => ({ chatId: row.chatId, id: row.id, pinned: row.pinned === true, score: Number(row.score), terms: row.terms ?? [],
        turnAt: row.turnAt, userMessageId: row.userMessageId }));
    },

    async vectorHits(scope: PastChatScope, vector: Readonly<{ providerModelId: string; values: readonly number[] }>,
      limit: number): Promise<PastChatLaneHit[]> {
      const dimension = vector.values.length;
      const literal = vectorLiteral(vector.values);
      if (!literal) return [];
      // The CASE keeps a passage of another dimension from ever reaching the operator, whatever order the planner evaluates in.
      return db.$queryRaw<PastChatLaneHit[]>(Prisma.sql`
        WITH RECURSIVE ${activeBranchSql(scope.ownerId)}
        SELECT ranked."id", ranked."chatId", ranked."userMessageId", ranked."turnAt"
        FROM (
          SELECT p."id", p."chatId", p."userMessageId", p."turnAt",
            CASE WHEN vector_dims(p."embedding") = ${dimension} THEN p."embedding" <=> ${literal}::vector END AS distance
          FROM "ChatSearchPassage" p
          JOIN "Chat" c ON c."id" = p."chatId"
          WHERE ${scopeSql(scope)}
            AND p."embeddingProviderModelId" = ${vector.providerModelId}
            AND p."embeddingDimension" = ${dimension}
            AND ${ON_ACTIVE_BRANCH}
        ) ranked
        WHERE ranked.distance IS NOT NULL AND ranked.distance <> 'NaN'::float8
        ORDER BY ranked.distance, ranked."id"
        LIMIT ${limit}`);
    },

    async passages(scope: Omit<PastChatScope, "range">, ids: readonly string[]): Promise<PastChatPassageRow[]> {
      if (ids.length === 0) return [];
      // Checked again where the text is read: the branch may have moved since the lanes ranked it.
      return withTitles(await db.$queryRaw<StoredPassageRow[]>(Prisma.sql`
        WITH RECURSIVE ${activeBranchSql(scope.ownerId)}
        SELECT p."id", p."chatId", p."userMessageId", p."turnAt", p."text"
        FROM "ChatSearchPassage" p
        JOIN "Chat" c ON c."id" = p."chatId"
        WHERE p."id" = ANY(${[...ids]}::text[]) AND ${scopeSql(scope)} AND ${ON_ACTIVE_BRANCH}`));
    },

    async recent(scope: PastChatScope, limit: number): Promise<PastChatPassageRow[]> {
      return withTitles(await db.$queryRaw<StoredPassageRow[]>(Prisma.sql`
        WITH RECURSIVE ${activeBranchSql(scope.ownerId)},
        latest AS MATERIALIZED (
          SELECT DISTINCT ON (p."chatId") p."id", p."chatId", p."turnAt"
          FROM "ChatSearchPassage" p
          JOIN "Chat" c ON c."id" = p."chatId"
          WHERE ${scopeSql(scope)} AND ${ON_ACTIVE_BRANCH}
          ORDER BY p."chatId", p."turnAt" DESC, p."ordinal", p."id"
        ),
        newest AS MATERIALIZED (
          SELECT * FROM latest ORDER BY "turnAt" DESC, "chatId" LIMIT ${limit}
        )
        SELECT p."id", p."chatId", p."userMessageId", p."turnAt", p."text"
        FROM newest n
        JOIN "ChatSearchPassage" p ON p."id" = n."id"
        ORDER BY n."turnAt" DESC, n."chatId"`));
    }
  });
}
