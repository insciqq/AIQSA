-- Reclassification distinguishes secret material from legacy statements that
-- are outside the v1 Personal Memory contract (for example third-party
-- allegations). Both remain permanently fenced from reusable Memory, while
-- the reason code preserves a content-free audit explanation.
ALTER TYPE "MemorySafetyClassificationState"
  ADD VALUE 'REJECTED_FENCED';

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "safetyClassificationReasonCode" VARCHAR(64);
