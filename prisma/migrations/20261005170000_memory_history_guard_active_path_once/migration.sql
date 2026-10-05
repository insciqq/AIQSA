-- History source guards fire per inserted, updated or deleted row and
-- re-validate the whole chat. Each call checked every source map against
-- the active branch with a NOT EXISTS probe into a recursive walk, which
-- scans the walked branch once per map row: a purge or index write over a
-- long chat cost rows x maps x branch length. Probe a branch computed once
-- per call instead (an uncorrelated NOT IN that PostgreSQL can hash); the
-- mapped message ids are non-null, so every result is unchanged. UNION also
-- ends a corrupt parent cycle. Only that probe changes: the installed
-- definitions, including their later version-literal extensions, keep every
-- other condition, signature, error code and message.
DO $migration$
DECLARE
  definition text;
  new_probe text;
  old_probe text;
  rewritten text;
BEGIN
  definition := pg_get_functiondef('aiqsa_memory_assert_history_source(text,text)'::regprocedure);
  old_probe := $old$                OR NOT EXISTS (
                  WITH RECURSIVE active_path AS (
                    SELECT message."id", message."parentMessageId"
                    FROM "Message" AS message
                    WHERE message."chatId" = chat_row."id"
                      AND message."id" = chat_row."activeLeafMessageId"
                    UNION ALL
                    SELECT parent."id", parent."parentMessageId"
                    FROM active_path AS child
                    INNER JOIN "Message" AS parent
                      ON parent."chatId" = chat_row."id"
                      AND parent."id" = child."parentMessageId"
                  )
                  SELECT 1 FROM active_path
                  WHERE active_path."id" = source_map."messageId"
                )$old$;
  new_probe := $new$                OR source_map."messageId" NOT IN (
                  WITH RECURSIVE active_path AS (
                    SELECT message."id", message."parentMessageId"
                    FROM "Message" AS message
                    WHERE message."chatId" = chat_row."id"
                      AND message."id" = chat_row."activeLeafMessageId"
                    UNION
                    SELECT parent."id", parent."parentMessageId"
                    FROM active_path AS child
                    INNER JOIN "Message" AS parent
                      ON parent."chatId" = chat_row."id"
                      AND parent."id" = child."parentMessageId"
                  )
                  SELECT active_path."id" FROM active_path
                )$new$;
  -- Exactly one installed probe is replaced, and no walk remains.
  IF length(definition) - length(replace(definition, old_probe, ''))
      <> length(old_probe) THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_history_source active path probe not found';
  END IF;
  rewritten := replace(definition, old_probe, new_probe);
  IF position('UNION ALL' IN rewritten) > 0
    OR position('WHERE active_path.' IN rewritten) > 0 THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_history_source active path rewrite incomplete';
  END IF;
  EXECUTE rewritten;
  definition := pg_get_functiondef('aiqsa_memory_assert_digest_sources(text)'::regprocedure);
  old_probe := $old$          OR NOT EXISTS (
            WITH RECURSIVE active_path AS (
              SELECT message."id", message."parentMessageId"
              FROM "Message" AS message
              WHERE message."chatId" = digest_row."chatId"
                AND message."id" = digest_row."activeLeafMessageId"
              UNION ALL
              SELECT parent."id", parent."parentMessageId"
              FROM active_path AS child
              INNER JOIN "Message" AS parent
                ON parent."chatId" = digest_row."chatId"
                AND parent."id" = child."parentMessageId"
            )
            SELECT 1 FROM active_path
            WHERE active_path."id" = digest_source_message."messageId"
          )$old$;
  new_probe := $new$          OR digest_source_message."messageId" NOT IN (
            WITH RECURSIVE active_path AS (
              SELECT message."id", message."parentMessageId"
              FROM "Message" AS message
              WHERE message."chatId" = digest_row."chatId"
                AND message."id" = digest_row."activeLeafMessageId"
              UNION
              SELECT parent."id", parent."parentMessageId"
              FROM active_path AS child
              INNER JOIN "Message" AS parent
                ON parent."chatId" = digest_row."chatId"
                AND parent."id" = child."parentMessageId"
            )
            SELECT active_path."id" FROM active_path
          )$new$;
  -- Exactly one installed probe is replaced, and no walk remains.
  IF length(definition) - length(replace(definition, old_probe, ''))
      <> length(old_probe) THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_digest_sources active path probe not found';
  END IF;
  rewritten := replace(definition, old_probe, new_probe);
  IF position('UNION ALL' IN rewritten) > 0
    OR position('WHERE active_path.' IN rewritten) > 0 THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_digest_sources active path rewrite incomplete';
  END IF;
  EXECUTE rewritten;
  definition := pg_get_functiondef('aiqsa_memory_assert_recall_round_source(text,text)'::regprocedure);
  old_probe := $old$              OR NOT EXISTS (
                WITH RECURSIVE active_path AS (
                  SELECT message."id", message."parentMessageId"
                  FROM "Message" AS message
                  WHERE message."chatId" = chat_row."id"
                    AND message."id" = chat_row."activeLeafMessageId"
                  UNION ALL
                  SELECT parent."id", parent."parentMessageId"
                  FROM active_path AS child
                  INNER JOIN "Message" AS parent
                    ON parent."chatId" = chat_row."id"
                    AND parent."id" = child."parentMessageId"
                )
                SELECT 1
                FROM active_path
                WHERE active_path."id" = source_map."messageId"
              )$old$;
  new_probe := $new$              OR source_map."messageId" NOT IN (
                WITH RECURSIVE active_path AS (
                  SELECT message."id", message."parentMessageId"
                  FROM "Message" AS message
                  WHERE message."chatId" = chat_row."id"
                    AND message."id" = chat_row."activeLeafMessageId"
                  UNION
                  SELECT parent."id", parent."parentMessageId"
                  FROM active_path AS child
                  INNER JOIN "Message" AS parent
                    ON parent."chatId" = chat_row."id"
                    AND parent."id" = child."parentMessageId"
                )
                SELECT active_path."id" FROM active_path
              )$new$;
  -- Exactly one installed probe is replaced, and no walk remains.
  IF length(definition) - length(replace(definition, old_probe, ''))
      <> length(old_probe) THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_recall_round_source active path probe not found';
  END IF;
  rewritten := replace(definition, old_probe, new_probe);
  IF position('UNION ALL' IN rewritten) > 0
    OR position('WHERE active_path.' IN rewritten) > 0 THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_recall_round_source active path rewrite incomplete';
  END IF;
  EXECUTE rewritten;
END;
$migration$;
