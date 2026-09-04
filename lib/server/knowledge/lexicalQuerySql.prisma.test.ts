import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { knowledgeBroadLexicalQuerySql } from "./lexicalQuerySql";

afterAll(async () => prisma.$disconnect());

describe("broad lexical query simplification", () => {
  it("preserves exact matches and cover-density scores across repeated and compound terms", async () => {
    const queries = [
      "", "!!!", "alpha", "alpha alpha alpha", "alpha beta alpha beta gamma",
      "alpha-beta alpha-beta beta alpha", "can't can't quote's quote's",
      "foo_bar foo_bar v1.2 v1.2", "пример пример поиск поиск",
      "café café naïve naïve", "東京 東京 検索 検索",
      '"alpha beta" "alpha beta" -gamma OR gamma',
      "https://example.test/a https://example.test/a",
      "alpha\\beta alpha\\beta", "a:b a:b a&b a&b",
      Array.from({ length: 24 }, () => "alpha beta gamma").join(" ")
    ];
    const samples = [
      "", "unrelated", "alpha", "beta", "alpha alpha alpha beta beta gamma",
      "alpha-beta beta alpha gamma", "can't quote's quote", "foo_bar v1.2",
      "пример поиск", "café naïve", "東京 検索", "alpha beta gamma OR",
      "https://example.test/a", "alpha\\beta", "a:b a&b"
    ];
    for (const query of queries) {
      const rows = await prisma.$queryRaw<Array<{
        originalNodes: number;
        simplifiedNodes: number;
        mismatches: number;
        compared: number;
      }>>(Prisma.sql`
        WITH compiled AS MATERIALIZED (${knowledgeBroadLexicalQuerySql(query)}),
        original AS MATERIALIZED (
          SELECT to_tsquery('simple'::regconfig,
            replace(plainto_tsquery('simple'::regconfig, ${query})::text, ' & ', ' | ')
          ) AS query
        ), samples AS (
          SELECT setweight(to_tsvector('simple'::regconfig, sample), 'A') ||
            setweight(to_tsvector('simple'::regconfig, sample), 'D') AS vector
          FROM unnest(${samples}::text[]) AS sample
          UNION ALL
          SELECT strip(to_tsvector('simple'::regconfig, sample))
          FROM unnest(${samples}::text[]) AS sample
        )
        SELECT numnode(original.query) AS "originalNodes",
          numnode(compiled.query) AS "simplifiedNodes",
          count(*) FILTER (WHERE
            (samples.vector @@ original.query) IS DISTINCT FROM (samples.vector @@ compiled.query)
            OR ts_rank_cd(samples.vector, original.query) IS DISTINCT FROM ts_rank_cd(samples.vector, compiled.query)
          )::integer AS mismatches,
          count(*)::integer AS compared
        FROM original CROSS JOIN compiled CROSS JOIN samples
        GROUP BY original.query, compiled.query
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.compared).toBe(samples.length * 2);
      expect(rows[0]!.mismatches).toBe(0);
      expect(rows[0]!.simplifiedNodes).toBeLessThanOrEqual(rows[0]!.originalNodes);
      if (query === queries.at(-1)) {
        expect(rows[0]!.simplifiedNodes).toBe(5);
      }
    }
  });
});
