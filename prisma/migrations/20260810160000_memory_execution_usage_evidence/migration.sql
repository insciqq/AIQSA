-- Memory execution attribution retains only fields actually reported by the
-- provider. Existing run and Knowledge writers remain free to store explicit
-- zeroes, while an absent category or ambiguous cost stays NULL.
ALTER TABLE "UsageEvent"
  ALTER COLUMN "inputTokens" DROP DEFAULT,
  ALTER COLUMN "inputTokens" DROP NOT NULL,
  ALTER COLUMN "cachedInputTokens" DROP DEFAULT,
  ALTER COLUMN "cachedInputTokens" DROP NOT NULL,
  ALTER COLUMN "cacheWriteInputTokens" DROP DEFAULT,
  ALTER COLUMN "cacheWriteInputTokens" DROP NOT NULL,
  ALTER COLUMN "outputTokens" DROP DEFAULT,
  ALTER COLUMN "outputTokens" DROP NOT NULL,
  ALTER COLUMN "reasoningTokens" DROP DEFAULT,
  ALTER COLUMN "reasoningTokens" DROP NOT NULL,
  ALTER COLUMN "totalTokens" DROP DEFAULT,
  ALTER COLUMN "totalTokens" DROP NOT NULL,
  ALTER COLUMN "estimatedCostMicros" DROP DEFAULT,
  ALTER COLUMN "estimatedCostMicros" DROP NOT NULL;
