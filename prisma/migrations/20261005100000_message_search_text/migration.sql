-- Readable text of a message for sidebar content search: the joined `text`
-- blocks of a content document in order, or a bare JSON string as is. It
-- mirrors `chatExportText` (lib/domain/chatExport.ts): attachment, tool and
-- other blocks, JSON keys and empty text contribute nothing. Every write path
-- (runs, edits, branches, imports, raw SQL) stays covered without a stored
-- column or backfill because the search index is built over this function;
-- the next migration creates it. Only pg_catalog objects are referenced, so
-- the restricted search_path of maintenance commands and restores resolves it.
CREATE FUNCTION aiqsa_message_search_text(content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE jsonb_typeof(content)
    WHEN 'string' THEN content #>> '{}'
    WHEN 'object' THEN CASE
      WHEN jsonb_typeof(content -> 'blocks') = 'array' THEN COALESCE((
        SELECT string_agg(item.block ->> 'text', E'\n' ORDER BY item.position)
        FROM jsonb_array_elements(content -> 'blocks') WITH ORDINALITY AS item(block, position)
        WHERE jsonb_typeof(item.block) = 'object'
          AND item.block -> 'type' = '"text"'::jsonb
          AND jsonb_typeof(item.block -> 'text') = 'string'
          AND item.block ->> 'text' <> ''
      ), '')
      ELSE ''
    END
    ELSE ''
  END
$function$;
