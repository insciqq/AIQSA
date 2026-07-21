ALTER TABLE "UserSettings" ALTER COLUMN "defaultSearchStrategyId" SET DEFAULT 'openai-native-web-search';

UPDATE "UserSettings"
SET "defaultSearchStrategyId" = CASE
  WHEN "defaultProvider" = 'openrouter' THEN 'perplexity-tool-search'
  WHEN "defaultProvider" = 'openai' THEN 'openai-native-web-search'
  ELSE 'search-disabled'
END
WHERE "defaultSearchStrategyId" IN ('search-auto', 'openrouter-perplexity-sonar');

UPDATE "UserSettings" settings
SET "defaultControlValues" = COALESCE((
  SELECT jsonb_object_agg(
    key,
    CASE
      WHEN jsonb_typeof(value) = 'object'
        AND value->>'searchStrategyId' IN ('search-auto', 'openrouter-perplexity-sonar')
      THEN jsonb_set(
        value,
        '{searchStrategyId}',
        to_jsonb((CASE
          WHEN key LIKE 'openrouter:%' THEN 'perplexity-tool-search'
          WHEN key LIKE 'openai:%' THEN 'openai-native-web-search'
          ELSE 'search-disabled'
        END)::text),
        true
      )
      ELSE value
    END
  )
  FROM jsonb_each(settings."defaultControlValues")
), '{}'::jsonb)
WHERE settings."defaultControlValues"::text LIKE '%search-auto%'
   OR settings."defaultControlValues"::text LIKE '%openrouter-perplexity-sonar%';

DELETE FROM "AccessGrant"
WHERE "searchStrategy" IN ('search-auto', 'openrouter-perplexity-sonar');

DELETE FROM "SearchStrategy"
WHERE "strategyId" IN ('search-auto', 'openrouter-perplexity-sonar');
