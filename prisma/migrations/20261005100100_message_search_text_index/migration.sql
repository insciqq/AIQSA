-- Trigram index for sidebar message content search over the readable text of
-- every message (all branches). CONCURRENTLY keeps runs, edits and imports
-- writing while an existing installation builds it: a plain build holds a
-- SHARE lock on "Message" for the whole build (about 18 s per 200k messages
-- measured on a laptop). Prisma sends a migration file as one simple query,
-- so this must stay the only statement in its file: PostgreSQL refuses
-- CONCURRENTLY inside the implicit transaction of a multi-statement query.
-- A failed build leaves an INVALID index and a failed migration; drop that
-- index and resolve the migration as rolled back before deploying again.
CREATE INDEX CONCURRENTLY "Message_searchText_trgm_idx"
  ON "Message" USING gin (aiqsa_message_search_text("content") gin_trgm_ops);
