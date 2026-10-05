-- The deferred history, digest and recall-round source guards fire once per
-- inserted, updated or deleted row and each call re-validates the whole chat
-- or digest. A purge or index write over one chat therefore repeated the same
-- full validation hundreds of times at COMMIT. Validate each chat or digest
-- once per batch of deferred events instead.
--
-- A guard's result depends only on its key and on rows of the twelve tables
-- the three assert functions read: Chat, Message, MemoryPauseInterval,
-- MemoryRecallChunk, MemoryRecallChunkMessage, MemoryRecallRound,
-- MemoryRecallRoundMessage, ChatMemoryCheckpoint, ChatMemoryCheckpointMessage,
-- ChatMemoryDigest, ChatMemoryDigestChunk and ChatMemoryDigestMessage. Each
-- trigger wrapper skips a key that already passed since the last write to
-- any of those tables, and records the key only after its assert passed.
-- A BEFORE STATEMENT trigger on each of the twelve tables forgets every
-- recorded key before any row of a statement changes. Every row event of a
-- later statement, including one inside another trigger, is therefore checked
-- again in its own batch (COMMIT, SET CONSTRAINTS ... IMMEDIATE, or the end of
-- the statement while constraints are immediate). The record is
-- transaction-local (set_config is_local), so a rolled-back savepoint reverts
-- it together with the rows, and nothing survives the transaction.
--
-- This does not rely on statement_timestamp(): one client message carrying
-- several statements (as a migration file is sent) shares one timestamp, so a
-- marker keyed by it could skip a later batch in that message.
-- Audit, 2026-10-05: no constraint trigger function, or assert function it
-- calls, writes to any table; there are no deferrable foreign keys between
-- these tables; the trigger wrappers below are the only callers of the three
-- assert functions, and every trigger that runs them is a DEFERRABLE INITIALLY
-- DEFERRED constraint trigger. The assert functions themselves are unchanged.

CREATE FUNCTION public.aiqsa_memory_source_guard_forget()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF COALESCE(current_setting('aiqsa.memory_source_guard_passed', true), '') <> '' THEN
    PERFORM set_config('aiqsa.memory_source_guard_passed', '', true);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.aiqsa_memory_source_guard_passed(p_marker text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $function$
BEGIN
  RETURN position(
    '|' || p_marker || '|'
    IN COALESCE(current_setting('aiqsa.memory_source_guard_passed', true), '')
  ) > 0;
END;
$function$;

CREATE FUNCTION public.aiqsa_memory_source_guard_remember(p_marker text)
RETURNS void LANGUAGE plpgsql VOLATILE AS $function$
BEGIN
  PERFORM set_config(
    'aiqsa.memory_source_guard_passed',
    COALESCE(
      NULLIF(current_setting('aiqsa.memory_source_guard_passed', true), ''),
      '|'
    ) || p_marker || '|',
    true
  );
END;
$function$;

CREATE FUNCTION public.aiqsa_memory_assert_history_source_once(
  p_user_id text,
  p_chat_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  marker text := 'h' || md5(COALESCE(p_user_id, '') || chr(31) || COALESCE(p_chat_id, ''));
BEGIN
  IF aiqsa_memory_source_guard_passed(marker) THEN
    RETURN;
  END IF;
  PERFORM aiqsa_memory_assert_history_source(p_user_id, p_chat_id);
  PERFORM aiqsa_memory_source_guard_remember(marker);
END;
$function$;

CREATE FUNCTION public.aiqsa_memory_assert_recall_round_source_once(
  p_user_id text,
  p_chat_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  marker text := 'r' || md5(COALESCE(p_user_id, '') || chr(31) || COALESCE(p_chat_id, ''));
BEGIN
  IF aiqsa_memory_source_guard_passed(marker) THEN
    RETURN;
  END IF;
  PERFORM aiqsa_memory_assert_recall_round_source(p_user_id, p_chat_id);
  PERFORM aiqsa_memory_source_guard_remember(marker);
END;
$function$;

CREATE FUNCTION public.aiqsa_memory_assert_digest_sources_once(p_digest_id text)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  marker text := 'd' || md5(COALESCE(p_digest_id, ''));
BEGIN
  IF aiqsa_memory_source_guard_passed(marker) THEN
    RETURN;
  END IF;
  PERFORM aiqsa_memory_assert_digest_sources(p_digest_id);
  PERFORM aiqsa_memory_source_guard_remember(marker);
END;
$function$;

-- The wrappers keep their exact branches; only the assert calls change.
CREATE OR REPLACE FUNCTION public.aiqsa_memory_history_source_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_history_source_once(NEW."userId", NEW."id");
    END IF;
    IF TG_OP <> 'INSERT'
       AND (OLD."userId", OLD."id") IS DISTINCT FROM (NEW."userId", NEW."id") THEN
      PERFORM aiqsa_memory_assert_history_source_once(OLD."userId", OLD."id");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_history_source_once(NEW."userId", NEW."chatId");
    END IF;
    IF TG_OP <> 'INSERT'
       AND (OLD."userId", OLD."chatId") IS DISTINCT FROM (NEW."userId", NEW."chatId") THEN
      PERFORM aiqsa_memory_assert_history_source_once(OLD."userId", OLD."chatId");
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_recall_round_source_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_recall_round_source_once(NEW."userId", NEW."id");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_recall_round_source_once(OLD."userId", OLD."id");
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_recall_round_source_once(NEW."userId", NEW."chatId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_recall_round_source_once(OLD."userId", OLD."chatId");
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_digest_row_source_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM aiqsa_memory_assert_digest_sources_once(
    CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_digest_map_source_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM aiqsa_memory_assert_digest_sources_once(
    CASE WHEN TG_OP = 'DELETE' THEN OLD."digestId" ELSE NEW."digestId" END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Chat_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "Chat"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "Message_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "Message"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "MemoryPauseInterval_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "MemoryPauseInterval"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "MemoryRecallChunk_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "MemoryRecallChunk"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "MemoryRecallChunkMessage_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "MemoryRecallChunkMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "MemoryRecallRound_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "MemoryRecallRound"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "MemoryRecallRoundMessage_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "MemoryRecallRoundMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "ChatMemoryCheckpoint_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "ChatMemoryCheckpoint"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "ChatMemoryCheckpointMessage_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "ChatMemoryCheckpointMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "ChatMemoryDigest_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "ChatMemoryDigest"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "ChatMemoryDigestChunk_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "ChatMemoryDigestChunk"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
CREATE TRIGGER "ChatMemoryDigestMessage_memory_source_guard_forget"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "ChatMemoryDigestMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION aiqsa_memory_source_guard_forget();
