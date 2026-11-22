-- Answer Review's storage goes in v0.5.0 (operator decision 2026-11-22): its sessions and their enums, the step columns
-- of messages and the two server-written turn kinds of its steps. Answer Review was removed on 2026-10-25 and nothing
-- has written any of it since; nothing in this release reads it, and the production rollout stops the previous
-- release's app and worker before migrating (`agent_docs/PERSISTENCE.md`).
--
-- A recorded session's steps stay where they are in the chat tree (operator decision 2026-11-22): its review and
-- revision requests become ordinary user turns and their answers ordinary answers, so an old chat reads as the
-- conversation it stored, its steps included. No message is deleted, moved or otherwise changed, no chat's active leaf
-- moves, and every accepted run keeps its stored request (snapshots are never rewritten). The text of each such turn
-- still opens with the header the previous release wrote, which names it as written by AIQSA.
--
-- PostgreSQL drops no enum value in place. Message is the largest live table and carries a trigram index over every
-- message's text, while only the turns the server wrote hold a kind, so converting the column in place, which rewrites
-- the table with its text and rebuilds every index, is avoided: the kinds that stay move to a new column of the new
-- type (no rewrite), only rows that hold a kind are updated, the old column is dropped and the new one takes its name.
-- The check that keeps a kind on user messages goes with the old column and is added back unchanged; it reads the
-- table once. No index, default, trigger or routine names the column or its type (the step check, which named both,
-- goes with the step columns).
--
-- Every lock is taken up front in a fixed order, the tables that stay first, and a deadlock retries instead of failing
-- the upgrade.

DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "User", "Chat", "Message", "AnswerReviewSession" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

-- Content-free counts of what goes, for the operator of an installation whose data nobody inspected.
DO $migration$
DECLARE
  sessions integer;
  turns integer;
BEGIN
  SELECT count(*) INTO sessions FROM "AnswerReviewSession";
  SELECT count(*) INTO turns FROM "Message"
  WHERE "systemTurnKind"::text IN ('answer_review_request', 'answer_revision_request');
  IF sessions > 0 OR turns > 0 THEN
    RAISE WARNING 'answer_review_storage_dropped sessions=% turns_made_ordinary=%', sessions, turns;
  END IF;
END;
$migration$;

CREATE TYPE "MessageSystemTurnKind_next" AS ENUM ('mcp_approval_continuation', 'subagent_callback', 'browser_sign_in_request');

ALTER TABLE "Message" ADD COLUMN "systemTurnKind_next" "MessageSystemTurnKind_next";

-- A review or revision request keeps no kind: it is an ordinary turn from now on.
UPDATE "Message" SET "systemTurnKind_next" = "systemTurnKind"::text::"MessageSystemTurnKind_next"
WHERE "systemTurnKind" IS NOT NULL
  AND "systemTurnKind"::text NOT IN ('answer_review_request', 'answer_revision_request');

-- Any deferred check runs now, so no trigger event is pending when the table changes below.
SET CONSTRAINTS ALL IMMEDIATE;

-- The step columns go with their check, the session key and the unique step claim index.
ALTER TABLE "Message"
  DROP CONSTRAINT "Message_system_turn_kind_check",
  DROP CONSTRAINT "Message_answer_review_step_check",
  DROP CONSTRAINT "Message_chatId_answerReviewSessionId_fkey",
  DROP COLUMN "systemTurnKind",
  DROP COLUMN "answerReviewSessionId",
  DROP COLUMN "answerReviewRound",
  DROP COLUMN "answerReviewStep";

ALTER TABLE "Message" RENAME COLUMN "systemTurnKind_next" TO "systemTurnKind";
DROP TYPE "MessageSystemTurnKind";
ALTER TYPE "MessageSystemTurnKind_next" RENAME TO "MessageSystemTurnKind";

ALTER TABLE "Message" ADD CONSTRAINT "Message_system_turn_kind_check" CHECK ("systemTurnKind" IS NULL OR "role" = 'user');

DROP TABLE "AnswerReviewSession";
DROP TYPE "AnswerReviewMode";
DROP TYPE "AnswerReviewState";
DROP TYPE "AnswerReviewStopReason";

-- Nothing that stays may still name what went: a routine, constraint or index naming a dropped table, column or type,
-- or the retired turn kinds, would fail on its next use, so it fails the migration here instead.
DO $migration$
DECLARE
  missed text;
BEGIN
  WITH retired AS (
    SELECT '"(AnswerReviewSession|answerReviewSessionId|answerReviewRound|answerReviewStep|AnswerReviewMode|'
      || 'AnswerReviewState|AnswerReviewStopReason|systemTurnKind_next|MessageSystemTurnKind_next)"'
      || '|answer_review_request|answer_revision_request' AS pattern
  ), found AS (
    SELECT 'routine ' || routine.oid::regprocedure::text AS item
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = current_schema() AND routine.prosrc ~ (SELECT pattern FROM retired)
    UNION ALL
    SELECT 'constraint ' || relation.relname || '.' || constraint_row.conname
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND constraint_row.contype <> 'n'
      AND (constraint_row.conname ~* 'answerReview|answer_review'
        OR pg_get_constraintdef(constraint_row.oid) ~ (SELECT pattern FROM retired))
    UNION ALL
    SELECT 'index ' || index_relation.relname
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND (index_relation.relname ~* 'answerReview' OR pg_get_indexdef(index_row.indexrelid) ~ (SELECT pattern FROM retired))
  )
  SELECT string_agg(item, ', ' ORDER BY item) INTO missed FROM found;
  IF missed IS NOT NULL THEN
    RAISE EXCEPTION 'answer_review_dependency_left: %', missed;
  END IF;
END;
$migration$;
