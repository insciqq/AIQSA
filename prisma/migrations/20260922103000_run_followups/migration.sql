-- Additive: existing/previous-release writers do not advertise this capability.
ALTER TABLE "Message" ADD COLUMN "branchFollowups" JSONB;
ALTER TABLE "ModelRun"
  ADD COLUMN "followupMode" VARCHAR(16),
  ADD COLUMN "followupRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "followupBudgetTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "followupClosedAt" TIMESTAMP(3),
  ADD COLUMN "followupKnowledgeRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "followupKnowledgeOffset" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "ModelRun_followup_bounds" CHECK (
    "followupRevision" BETWEEN 0 AND 32 AND "followupBudgetTokens" >= 0 AND
    "followupKnowledgeRevision" BETWEEN 0 AND "followupRevision" AND "followupKnowledgeOffset" BETWEEN 0 AND 8 AND
    ("followupMode" IS NULL OR "followupMode" IN ('chat', 'workspace', 'agent'))
  );

CREATE TABLE "RunFollowup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chatId" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "nonce" VARCHAR(128) NOT NULL,
  "text" TEXT NOT NULL,
  "authorUserId" TEXT,
  "authorName" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  "precedingText" TEXT,
  CONSTRAINT "RunFollowup_bounds" CHECK ("ordinal" BETWEEN 1 AND 32 AND length(btrim("text")) > 0 AND length("text") <= 16000),
  CONSTRAINT "RunFollowup_delivery" CHECK ("precedingText" IS NULL OR "deliveredAt" IS NOT NULL),
  -- Account deletion nulls authors and cascades their runs in one statement.
  -- Check the surviving rows after both referential actions have settled.
  CONSTRAINT "RunFollowup_chatId_modelRunId_fkey" FOREIGN KEY ("chatId", "modelRunId") REFERENCES "ModelRun"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "RunFollowup_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "RunFollowup_modelRunId_ordinal_key" ON "RunFollowup"("modelRunId", "ordinal");
CREATE UNIQUE INDEX "RunFollowup_modelRunId_nonce_key" ON "RunFollowup"("modelRunId", "nonce");
CREATE INDEX "RunFollowup_chatId_modelRunId_idx" ON "RunFollowup"("chatId", "modelRunId");
CREATE INDEX "RunFollowup_authorUserId_idx" ON "RunFollowup"("authorUserId");

-- Older workers cannot publish an answer that bypasses an accepted update.
CREATE FUNCTION aiqsa_run_followup_completion_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."followupRevision" > 0 AND
    (NEW."status" = 'complete' OR NEW."answerCompletedAt" IS NOT NULL) AND
    (NEW."followupClosedAt" IS NULL OR EXISTS (
      SELECT 1 FROM "RunFollowup" WHERE "modelRunId" = NEW."id" AND "deliveredAt" IS NULL
    )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'run_followup_completion_conflict';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ModelRun_followup_completion_guard"
  BEFORE UPDATE OF "status", "answerCompletedAt", "followupRevision", "followupClosedAt" ON "ModelRun"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_run_followup_completion_guard();

CREATE FUNCTION aiqsa_run_followup_history_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."chatId", NEW."modelRunId", NEW."ordinal", NEW."nonce", NEW."text", NEW."authorName", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."chatId", OLD."modelRunId", OLD."ordinal", OLD."nonce", OLD."text", OLD."authorName", OLD."createdAt")
    OR NEW."authorUserId" IS DISTINCT FROM OLD."authorUserId" AND NEW."authorUserId" IS NOT NULL
    OR OLD."deliveredAt" IS NOT NULL AND ROW(NEW."deliveredAt", NEW."precedingText") IS DISTINCT FROM ROW(OLD."deliveredAt", OLD."precedingText") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'run_followup_history_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "RunFollowup_history_guard" BEFORE UPDATE ON "RunFollowup"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_run_followup_history_guard();

-- A copied branch owns an immutable readable snapshot, surviving deletion
-- of its source run without retaining source credentials or private payloads.
CREATE FUNCTION aiqsa_branch_followup_history_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."branchFollowups" IS DISTINCT FROM OLD."branchFollowups" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'branch_followup_history_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Message_branch_followup_history_guard" BEFORE UPDATE OF "branchFollowups" ON "Message"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_branch_followup_history_guard();
