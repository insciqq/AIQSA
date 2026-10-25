-- The Memory lexical search index is retired (operator decision 2026-10-23).
-- Since 0.4.0 nothing captures projection work or reads its outbox and
-- readiness rows; the previous release only purges and counts what an account
-- left there when it deletes that account. An account deletion it runs while
-- Compose replaces it fails and is retried by this release, which no longer
-- names the tables. Nothing here touches PostgreSQL lexical data
-- (`MemorySearchEntry`).

DROP TABLE IF EXISTS "MemoryLexicalProjectionEvent";
DROP TABLE IF EXISTS "MemoryLexicalProjectionState";

DROP FUNCTION IF EXISTS aiqsa_enqueue_memory_lexical_projection_event(
  TEXT, TEXT, TEXT, "MemoryLexicalProjectionOperation", INTEGER
);
DROP FUNCTION IF EXISTS aiqsa_guard_memory_lexical_projection_event_admission();

DROP TYPE IF EXISTS "MemoryLexicalProjectionOperation";
DROP TYPE IF EXISTS "MemoryLexicalProjectionEventState";
DROP TYPE IF EXISTS "MemoryLexicalProjectionStatus";
