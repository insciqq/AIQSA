import { Prisma } from "@prisma/client";

/** Compile the ordinary broad lexical query, removing only redundant A | A
 * operands. Keep PostgreSQL's parser, dictionary, compound expressions and
 * cover-density rank: duplicate alternatives have identical matching covers
 * but make ts_rank_cd allocate/work in proportion to repeated query nodes.
 * The strict websearch query is deliberately not passed through this helper.
 */
export function knowledgeBroadLexicalQuerySql(query: string): Prisma.Sql {
  return Prisma.sql`
    WITH RECURSIVE terms AS MATERIALIZED (
      SELECT row_number() OVER (ORDER BY lexeme)::integer AS ordinal,
        (
          chr(39) ||
          replace(replace(lexeme, chr(92), chr(92) || chr(92)), chr(39), chr(39) || chr(39)) ||
          chr(39)
        )::tsquery AS term
      FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, ${query}))) AS lexeme
    ), rewrites AS (
      SELECT to_tsquery('simple'::regconfig,
        replace(plainto_tsquery('simple'::regconfig, ${query})::text, ' & ', ' | ')
      ) AS query, 1::integer AS ordinal, 0::integer AS step
      UNION ALL
      SELECT rewritten.query,
        previous.ordinal + CASE
          WHEN numnode(rewritten.query) = numnode(previous.query) THEN 1 ELSE 0
        END,
        previous.step + 1
      FROM rewrites AS previous
      INNER JOIN terms ON terms.ordinal = previous.ordinal
      CROSS JOIN LATERAL (
        SELECT ts_rewrite(previous.query, terms.term || terms.term, terms.term) AS query
      ) AS rewritten
      -- Each successful rewrite removes nodes; an unchanged rewrite advances
      -- to the next term. A bounded partial simplification is also equivalent.
      WHERE previous.step < 4096
    )
    SELECT query FROM rewrites ORDER BY step DESC LIMIT 1
  `;
}
