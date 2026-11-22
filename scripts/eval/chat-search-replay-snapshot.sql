-- Read-only snapshot of the recorded `memory_search` calls, taken on a production host BEFORE the upgrade to v0.5.0
-- drops their tables. It prints one JSON object per line: the search's owner, time and query, the chat it ran in, and
-- the chats and messages the old search returned from chat history, best first. Facts are left out: the new search
-- has none. The output holds private queries: it stays on the host in a file only the operator can read, goes into
-- `scripts/eval/chat-search-replay.ts` (inside the upgraded app container, through stdin) and is deleted afterwards.
--
-- Run with a read-only role, unaligned and tuples only so each row is exactly one JSON line (psql prints values
-- as they are, so the JSON is not escaped again as COPY's text format would):
--
--   umask 077
--   docker compose exec -T postgres psql -X -q -A -t -v ON_ERROR_STOP=1 -U <read-only role> -d <database> \
--     < scripts/eval/chat-search-replay-snapshot.sql > chat-search-snapshot.jsonl
--
-- Lines that are not JSON objects (none are expected with -q -A -t) are skipped by the replay.
--
-- Where an old result names its source messages, they come from the result itself (`results.results[].sourceMessageIds`);
-- the recall link tables add the messages of the chunks, rounds and round segments the result's items name
-- (`MemoryRecallChunkMessage`, `MemoryRecallRoundMessage`, `MemoryRecallRoundSegmentMessage`). A chat's rank is the
-- best rank any of its items had.

SET default_transaction_read_only = on;
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH runs AS (
  SELECT h."id", h."userId", h."createdAt", h."query", h."durationMs", h."outcome"::text AS "outcome", h."results",
    r."chatId" AS "searchChatId"
  FROM "MemoryHistoryRun" h
  JOIN "ModelRun" r ON r."id" = h."modelRunId" AND r."userId" = h."userId"
  WHERE h."state" = 'COMPLETE'
    AND h."retentionState" = 'RETAINED'
    AND h."plaintextPurgedAt" IS NULL
    AND h."query" IS NOT NULL
    AND btrim(h."query") <> ''
),
sources AS (
  SELECT runs."id" AS "runId", runs."userId", entry.ordinality AS "rank", entry.value AS "entry"
  FROM runs
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(runs."results" -> 'results') = 'array' THEN runs."results" -> 'results' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value ->> 'itemType' IS DISTINCT FROM 'FACT_VERSION'
),
items AS (
  SELECT runs."id" AS "runId", runs."userId", item.ordinality AS "rank", item.value AS "item"
  FROM runs
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(runs."results" -> 'items') = 'array' THEN runs."results" -> 'items' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS item(value, ordinality)
  WHERE item.value ->> 'itemType' IN ('RECALL_CHUNK', 'RECALL_ROUND', 'RECALL_ROUND_SEGMENT')
),
hits AS (
  SELECT s."runId", s."rank", s."entry" ->> 'sourceChatId' AS "chatId", m.value AS "messageId"
  FROM sources s
  LEFT JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(s."entry" -> 'sourceMessageIds') = 'array' THEN s."entry" -> 'sourceMessageIds' ELSE '[]'::jsonb END
  ) AS m(value) ON true
  WHERE s."entry" ->> 'sourceChatId' IS NOT NULL
  UNION ALL
  SELECT i."runId", i."rank", cm."chatId", cm."messageId"
  FROM items i
  JOIN "MemoryRecallChunkMessage" cm ON cm."userId" = i."userId" AND cm."chunkId" = i."item" ->> 'recallChunkId'
  WHERE i."item" ->> 'itemType' = 'RECALL_CHUNK'
  UNION ALL
  SELECT i."runId", i."rank", rm."chatId", rm."messageId"
  FROM items i
  JOIN "MemoryRecallRoundMessage" rm ON rm."userId" = i."userId" AND rm."roundId" = i."item" ->> 'recallRoundId'
  WHERE i."item" ->> 'itemType' = 'RECALL_ROUND'
  UNION ALL
  SELECT i."runId", i."rank", sm."chatId", sm."messageId"
  FROM items i
  JOIN "MemoryRecallRoundSegmentMessage" sm ON sm."userId" = i."userId" AND sm."segmentId" = i."item" ->> 'recallRoundSegmentId'
  WHERE i."item" ->> 'itemType' = 'RECALL_ROUND_SEGMENT'
),
chats AS (
  SELECT h."runId", h."chatId", min(h."rank") AS "rank",
    COALESCE(array_agg(DISTINCT h."messageId") FILTER (WHERE h."messageId" IS NOT NULL), ARRAY[]::text[]) AS "messageIds"
  FROM hits h
  WHERE h."chatId" IS NOT NULL
  GROUP BY h."runId", h."chatId"
)
SELECT jsonb_build_object(
  'v', 1,
  'ownerId', runs."userId",
  'searchedAt', to_char(runs."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'searchChatId', runs."searchChatId",
  'query', runs."query",
  'oldOutcome', runs."outcome",
  'oldDurationMs', runs."durationMs",
  'chats', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('chatId', c."chatId", 'rank', c."rank", 'messageIds', to_jsonb(c."messageIds"))
      ORDER BY c."rank", c."chatId")
    FROM chats c WHERE c."runId" = runs."id"
  ), '[]'::jsonb)
)::text
FROM runs
ORDER BY runs."createdAt", runs."id";

COMMIT;
