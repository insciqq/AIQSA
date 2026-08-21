CREATE TYPE "MemoryPauseScope" AS ENUM (
  'MASTER',
  'SEARCH_HISTORY',
  'AUTOMATIC_LEARNING'
);

CREATE TABLE "MemoryPauseInterval" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scope" "MemoryPauseScope" NOT NULL,
  "pausedAt" TIMESTAMP(3) NOT NULL,
  "resumedAt" TIMESTAMP(3),
  "memoryGeneration" INTEGER NOT NULL,

  CONSTRAINT "MemoryPauseInterval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryPauseInterval_userId_id_key"
  ON "MemoryPauseInterval"("userId", "id");

CREATE INDEX "MemoryPauseInterval_userId_scope_pausedAt_resumedAt_idx"
  ON "MemoryPauseInterval"("userId", "scope", "pausedAt", "resumedAt");

CREATE UNIQUE INDEX "MemoryPauseInterval_one_open_scope_key"
  ON "MemoryPauseInterval"("userId", "scope")
  WHERE "resumedAt" IS NULL;

ALTER TABLE "MemoryPauseInterval"
  ADD CONSTRAINT "MemoryPauseInterval_generation_check"
    CHECK ("memoryGeneration" >= 0),
  ADD CONSTRAINT "MemoryPauseInterval_bounds_check"
    CHECK ("resumedAt" IS NULL OR "resumedAt" >= "pausedAt"),
  ADD CONSTRAINT "MemoryPauseInterval_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"(id)
    ON UPDATE RESTRICT ON DELETE CASCADE;

-- A short-lived pre-release implementation represented setting pauses as
-- reusable-source barriers. Preserve any locally-created rows as admission
-- intervals and remove them from the destructive barrier authority. Closed
-- legacy barriers retained their pause timestamp in createdAt and
-- their resume cutoff in sourceCreatedAtCutoff. If no distinct resume was
-- recorded, preserve the conservative zero-length boundary.
WITH pause_barriers AS (
  SELECT
    barrier."id",
    barrier."userId",
    CASE barrier."kind"
      WHEN 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        THEN 'MASTER'::"MemoryPauseScope"
      WHEN 'HISTORY_INDEX'::"MemorySourceBarrierKind"
        THEN 'SEARCH_HISTORY'::"MemoryPauseScope"
      ELSE 'AUTOMATIC_LEARNING'::"MemoryPauseScope"
    END AS scope,
    barrier."createdAt" AS "pausedAt",
    barrier."sourceCreatedAtCutoff",
    barrier."memoryGeneration",
    settings."useMemoryFacts",
    settings."referenceChatHistory",
    settings."learnAutomatically",
    row_number() OVER (
      PARTITION BY barrier."userId", barrier."kind"
      ORDER BY barrier."createdAt" DESC, barrier."id" DESC
    ) AS ordinal
  FROM "MemorySourceBarrier" AS barrier
  INNER JOIN "UserMemorySettings" AS settings
    ON settings."userId" = barrier."userId"
  WHERE barrier."explicitOverrideAllowed" = TRUE
    OR (
      barrier."kind" IN (
        'HISTORY_INDEX'::"MemorySourceBarrierKind",
        'AUTOMATIC_FACTS'::"MemorySourceBarrierKind"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryDeletionOutbox" AS deletion
        WHERE deletion."userId" = barrier."userId"
          AND deletion."targetId" = barrier."id"
      )
    )
), migrated AS (
  INSERT INTO "MemoryPauseInterval" (
    "id", "userId", "scope", "pausedAt", "resumedAt", "memoryGeneration"
  )
  SELECT
    "id",
    "userId",
    scope,
    "pausedAt",
    CASE
      WHEN ordinal = 1 AND (
        scope = 'MASTER'::"MemoryPauseScope" AND "useMemoryFacts" = FALSE
        OR scope = 'SEARCH_HISTORY'::"MemoryPauseScope"
          AND "referenceChatHistory" = FALSE
        OR scope = 'AUTOMATIC_LEARNING'::"MemoryPauseScope"
          AND "learnAutomatically" = FALSE
      ) THEN NULL
      ELSE GREATEST("pausedAt", "sourceCreatedAtCutoff")
    END,
    "memoryGeneration"
  FROM pause_barriers
  RETURNING "id", "userId"
)
DELETE FROM "MemorySourceBarrier" AS barrier
USING migrated
WHERE barrier."userId" = migrated."userId"
  AND barrier."id" = migrated."id";
