CREATE TABLE "KnowledgeRelevanceAttempt" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "executionSnapshot" JSONB NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "state" "KnowledgeProviderAttemptState" NOT NULL DEFAULT 'dispatched',
    "usefulness" DOUBLE PRECISION,
    "failureCode" VARCHAR(128),
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "KnowledgeRelevanceAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeRelevanceAttempt_ordinal_check" CHECK ("ordinal" >= 1),
    CONSTRAINT "KnowledgeRelevanceAttempt_state_check" CHECK ("state" IN ('dispatched', 'settled', 'ambiguous')),
    CONSTRAINT "KnowledgeRelevanceAttempt_score_check" CHECK ("usefulness" IS NULL OR ("usefulness" >= 0 AND "usefulness" <= 1 AND "state" = 'settled' AND "failureCode" IS NULL)),
    CONSTRAINT "KnowledgeRelevanceAttempt_input_check" CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "KnowledgeRelevanceAttempt_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "KnowledgeBudgetReservation"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "KnowledgeRelevanceAttempt_reservationId_ordinal_key" ON "KnowledgeRelevanceAttempt"("reservationId", "ordinal");
ALTER TABLE "UsageEvent" ADD COLUMN "knowledgeRelevanceAttemptId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_knowledgeRelevanceAttemptId_key" ON "UsageEvent"("knowledgeRelevanceAttemptId");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledgeRelevanceAttemptId_fkey" FOREIGN KEY ("knowledgeRelevanceAttemptId") REFERENCES "KnowledgeRelevanceAttempt"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- An accounting link may not attribute another run's private provider work.
CREATE FUNCTION "validate_knowledge_relevance_usage_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "UsageEvent" u WHERE u."id" = NEW."id" AND u."knowledgeRelevanceAttemptId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "KnowledgeRelevanceAttempt" a
      JOIN "KnowledgeBudgetReservation" r ON r."id" = a."reservationId"
      JOIN "ModelRun" m ON m."id" = r."modelRunId"
      WHERE a."id" = u."knowledgeRelevanceAttemptId"
        AND m."id" = u."modelRunId" AND m."userId" = u."userId" AND m."chatId" = u."chatId"
    )
  ) THEN RAISE EXCEPTION 'knowledge_relevance_usage_owner_mismatch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "UsageEvent_knowledge_relevance_owner_check"
AFTER INSERT OR UPDATE ON "UsageEvent" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."knowledgeRelevanceAttemptId" IS NOT NULL) EXECUTE FUNCTION "validate_knowledge_relevance_usage_owner"();

CREATE FUNCTION "guard_knowledge_relevance_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."reservationId", NEW."ordinal", NEW."executionSnapshot", NEW."inputHash", NEW."dispatchedAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."reservationId", OLD."ordinal", OLD."executionSnapshot", OLD."inputHash", OLD."dispatchedAt")
     OR OLD."state" = 'settled' AND NEW IS DISTINCT FROM OLD
     OR OLD."state" = 'ambiguous' AND NEW."state" = 'dispatched'
  THEN RAISE EXCEPTION 'knowledge_relevance_attempt_immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "KnowledgeRelevanceAttempt_immutable"
BEFORE UPDATE ON "KnowledgeRelevanceAttempt"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_relevance_attempt"();
