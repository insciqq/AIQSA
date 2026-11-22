import { Prisma, type PrismaClient } from "@prisma/client";
import { MEMORY_SWITCH_DEFAULTS } from "../../../contracts/memoryNote";
import { chatSearchEligibleSql } from "../eligibility";
import type { PastChatTurnRange } from "./dates";
import { PAST_CHAT_QUERY_LIMITS, type PastChatUnitStatistics, type PastChatWordUnit } from "./query";
import type { PastChatLaneHit, PastChatWordHit } from "./rank";

/**
 * The SQL of past-chat search over `ChatSearchPassage`, one owner at a time.
 * Every query joins the passage's chat and applies the one eligibility rule
 * (`chatSearchEligibleSql`): the owner's own ordinary chats, never Temporary,
 * Excluded, imported, scheduled, Discord or fenced ones, and never the current
 * chat. User text only ever travels as bound parameters. Exact vector distance
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
  title: string;
}>;

export type PastChatSearchStore = Readonly<{
  /** The user's Memory and past-chat search switches; both default to on. */
  switches(ownerId: string): Promise<PastChatSwitches>;
  /** How many of the owner's passages each unit of the query matches (`query.ts`). */
  wordStatistics(ownerId: string, query: string, phrases: readonly string[]): Promise<PastChatUnitStatistics[]>;
  wordHits(scope: PastChatScope, units: readonly PastChatWordUnit[], limit: number): Promise<PastChatWordHit[]>;
  vectorHits(scope: PastChatScope, vector: Readonly<{ providerModelId: string; values: readonly number[] }>, limit: number): Promise<PastChatLaneHit[]>;
  /** The texts and chat titles of these passages that are still eligible, in no order. */
  passages(scope: Omit<PastChatScope, "range">, ids: readonly string[]): Promise<PastChatPassageRow[]>;
  /** Each eligible chat once by its latest turn in the range (that turn's first window), newest first. */
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
        WITH units AS MATERIALIZED (
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
          WHERE ${scopeSql(scope)}
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
        SELECT ranked."id", ranked."chatId", ranked."userMessageId", ranked."turnAt"
        FROM (
          SELECT p."id", p."chatId", p."userMessageId", p."turnAt",
            CASE WHEN vector_dims(p."embedding") = ${dimension} THEN p."embedding" <=> ${literal}::vector END AS distance
          FROM "ChatSearchPassage" p
          JOIN "Chat" c ON c."id" = p."chatId"
          WHERE ${scopeSql(scope)}
            AND p."embeddingProviderModelId" = ${vector.providerModelId}
            AND p."embeddingDimension" = ${dimension}
        ) ranked
        WHERE ranked.distance IS NOT NULL AND ranked.distance <> 'NaN'::float8
        ORDER BY ranked.distance, ranked."id"
        LIMIT ${limit}`);
    },

    async passages(scope: Omit<PastChatScope, "range">, ids: readonly string[]): Promise<PastChatPassageRow[]> {
      if (ids.length === 0) return [];
      return db.$queryRaw<PastChatPassageRow[]>(Prisma.sql`
        SELECT p."id", p."chatId", p."userMessageId", p."turnAt", p."text", c."title"
        FROM "ChatSearchPassage" p
        JOIN "Chat" c ON c."id" = p."chatId"
        WHERE p."id" = ANY(${[...ids]}::text[]) AND ${scopeSql(scope)}`);
    },

    async recent(scope: PastChatScope, limit: number): Promise<PastChatPassageRow[]> {
      return db.$queryRaw<PastChatPassageRow[]>(Prisma.sql`
        WITH latest AS MATERIALIZED (
          SELECT DISTINCT ON (p."chatId") p."id", p."chatId", p."turnAt"
          FROM "ChatSearchPassage" p
          JOIN "Chat" c ON c."id" = p."chatId"
          WHERE ${scopeSql(scope)}
          ORDER BY p."chatId", p."turnAt" DESC, p."ordinal", p."id"
        ),
        newest AS MATERIALIZED (
          SELECT * FROM latest ORDER BY "turnAt" DESC, "chatId" LIMIT ${limit}
        )
        SELECT p."id", p."chatId", p."userMessageId", p."turnAt", p."text", c."title"
        FROM newest n
        JOIN "ChatSearchPassage" p ON p."id" = n."id"
        JOIN "Chat" c ON c."id" = p."chatId"
        ORDER BY n."turnAt" DESC, n."chatId"`);
    }
  });
}
