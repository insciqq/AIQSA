-- The DeepSeek Search API is its own logical Search source on a DeepSeek
-- connection, beside that connection's hosted DeepSeek Search (`web_search`):
-- (sourceConnectionId, kind) stays unique, so it needs its own kind. Only a
-- value is added; rows written by the previous release remain valid.
ALTER TABLE "SearchOption"
  DROP CONSTRAINT "SearchOption_kind_check";

ALTER TABLE "SearchOption"
  ADD CONSTRAINT "SearchOption_kind_check" CHECK (
    kind = ANY (ARRAY[
      'none'::text,
      'web_search'::text,
      'gemini_google_search'::text,
      'perplexity_search'::text,
      'deepseek_search_api'::text
    ])
  );
