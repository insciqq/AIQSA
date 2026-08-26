-- Resolve a fact container through bounded cross-fact moves. Only a complete
-- owner-scoped chain of RETRACTED intermediates ending at one ACTIVE root is
-- reusable. Missing links, cycles, conflicted/terminal roots, and over-depth
-- chains fail closed as NULL.
CREATE OR REPLACE FUNCTION public.aiqsa_memory_fact_root_id(
  p_user_id TEXT,
  p_fact_id TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  WITH RECURSIVE chain AS (
    SELECT
      fact."id",
      fact."movedToFactId",
      fact."state",
      ARRAY[fact."id"]::TEXT[] AS visited,
      0 AS depth,
      FALSE AS cycle
    FROM public."MemoryFact" AS fact
    WHERE fact."userId" = p_user_id
      AND fact."id" = p_fact_id

    UNION ALL

    SELECT
      next_fact."id",
      next_fact."movedToFactId",
      next_fact."state",
      chain.visited || next_fact."id",
      chain.depth + 1,
      next_fact."id" = ANY(chain.visited)
    FROM chain
    INNER JOIN public."MemoryFact" AS next_fact
      ON next_fact."userId" = p_user_id
      AND next_fact."id" = chain."movedToFactId"
    WHERE chain."movedToFactId" IS NOT NULL
      AND NOT chain.cycle
      AND chain.depth < 64
  ),
  terminal AS (
    SELECT *
    FROM chain
    ORDER BY depth DESC
    LIMIT 1
  )
  SELECT terminal."id"
  FROM terminal
  WHERE NOT terminal.cycle
    AND terminal."movedToFactId" IS NULL
    AND terminal."state" = 'ACTIVE'::public."MemoryFactState"
    AND NOT EXISTS (SELECT 1 FROM chain WHERE chain.cycle)
    AND NOT EXISTS (
      SELECT 1
      FROM chain AS intermediate
      WHERE intermediate.depth < terminal.depth
        AND (
          intermediate.cycle
          OR intermediate."state" <>
            'RETRACTED'::public."MemoryFactState"
          OR intermediate."movedToFactId" IS NULL
        )
    );
$function$;
