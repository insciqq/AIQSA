-- Chats cited by a retained Memory search receipt. Purging one history
-- source otherwise expands the full results payload of every retained
-- receipt of the owner, twice per deletion attempt and again on each
-- completed-purge audit. The expression is immutable and lax, so receipts
-- without results or with another shape index nothing and never fail a write.
-- Built CONCURRENTLY as the only statement of this file (Persistence,
-- Migrations And Bootstrap).
CREATE INDEX CONCURRENTLY "MemoryHistoryRun_cited_source_chat_idx"
  ON "MemoryHistoryRun" USING gin (
    jsonb_path_query_array("results", '$.results[*].sourceChatId'::jsonpath)
  );
