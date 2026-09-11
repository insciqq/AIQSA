CREATE TYPE "TokenUsageCompleteness" AS ENUM ('COMPLETE', 'PARTIAL', 'UNAVAILABLE');

ALTER TABLE "ModelRun"
  ADD COLUMN "usageCompleteness" "TokenUsageCompleteness" NOT NULL DEFAULT 'UNAVAILABLE';

ALTER TABLE "UsageEvent"
  ADD COLUMN "usageCompleteness" "TokenUsageCompleteness" NOT NULL DEFAULT 'UNAVAILABLE';
