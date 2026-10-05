-- Trigram index for sidebar message search over the readable text of every
-- message (all branches). A plain build would block Message writes for the
-- whole build (about 18 s per 200k messages measured on a laptop), so it is
-- built CONCURRENTLY and stays the only statement of this file (Persistence,
-- Migrations And Bootstrap).
CREATE INDEX CONCURRENTLY "Message_searchText_trgm_idx"
  ON "Message" USING gin (aiqsa_message_search_text("content") gin_trgm_ops);
