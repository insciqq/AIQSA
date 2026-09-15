CREATE TYPE "WorkspaceFollowupState" AS ENUM
  ('waiting', 'preparing', 'released', 'dispatched', 'failed', 'cancelled');

ALTER TABLE "ModelRun" ADD COLUMN "workspaceWaitPending" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "ModelRun_chatId_id_key" ON "ModelRun"("chatId", "id");

-- A waiting message has accepted bindings but no authority to execute yet.
-- Previous writers retain the original active-run guard through the false default.
DROP INDEX "ModelRun_one_active_per_chat_idx";
CREATE UNIQUE INDEX "ModelRun_one_active_per_chat_idx" ON "ModelRun"("chatId")
  WHERE NOT "workspaceWaitPending" AND "status" IN ('preparing', 'queued', 'streaming', 'in_progress');
CREATE UNIQUE INDEX "ModelRun_one_workspace_wait_per_chat_idx" ON "ModelRun"("chatId")
  WHERE "workspaceWaitPending" AND "status" = 'preparing';
ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_workspace_wait_status_check"
  CHECK (NOT "workspaceWaitPending" OR "status" IN ('preparing', 'cancelled', 'error'));

CREATE TABLE "WorkspaceFollowup" (
  "modelRunId" TEXT NOT NULL PRIMARY KEY,
  "chatId" TEXT NOT NULL,
  "predecessorRunId" TEXT NOT NULL,
  "admissionKey" CHAR(64) NOT NULL,
  "state" "WorkspaceFollowupState" NOT NULL DEFAULT 'waiting',
  "snapshot" JSONB,
  "admissionResult" JSONB,
  "sourceRevisionAdvance" INTEGER NOT NULL DEFAULT 0,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "claimToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceFollowup_source_revision_check" CHECK ("sourceRevisionAdvance" IN (0, 1)),
  CONSTRAINT "WorkspaceFollowup_predecessor_check" CHECK ("modelRunId" <> "predecessorRunId"),
  CONSTRAINT "WorkspaceFollowup_lease_check" CHECK (("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "WorkspaceFollowup_chatId_modelRunId_fkey" FOREIGN KEY ("chatId", "modelRunId")
    REFERENCES "ModelRun"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceFollowup_chatId_predecessorRunId_fkey" FOREIGN KEY ("chatId", "predecessorRunId")
    REFERENCES "ModelRun"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "WorkspaceFollowup_admissionKey_key" ON "WorkspaceFollowup"("admissionKey");
CREATE UNIQUE INDEX "WorkspaceFollowup_chatId_modelRunId_key" ON "WorkspaceFollowup"("chatId", "modelRunId");
CREATE INDEX "WorkspaceFollowup_state_createdAt_idx" ON "WorkspaceFollowup"("state", "createdAt");
CREATE INDEX "WorkspaceFollowup_chatId_predecessorRunId_idx" ON "WorkspaceFollowup"("chatId", "predecessorRunId");

-- Validate after atomic admission/activation, including previous-release
-- writers. A waiting row can coexist only with its published predecessor.
-- Cascades permit whole-chat deletion; deleting its prerequisite alone cannot
-- leave a live waiting run without a durable owner.
CREATE FUNCTION "check_workspace_followup_ownership"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_chat TEXT := COALESCE(NEW."chatId", OLD."chatId");
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ModelRun" waiting
    WHERE waiting."chatId" = affected_chat AND waiting."workspaceWaitPending" AND waiting."status" = 'preparing'
      AND NOT EXISTS (SELECT 1 FROM "WorkspaceFollowup" f WHERE f."modelRunId" = waiting."id"
        AND f."state" IN ('waiting', 'preparing') AND f."snapshot" IS NOT NULL AND f."admissionResult" IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM "ModelRun" waiting
    JOIN "WorkspaceFollowup" f ON f."modelRunId" = waiting."id"
    JOIN "ModelRun" executing ON executing."chatId" = waiting."chatId"
      AND NOT executing."workspaceWaitPending" AND executing."status" IN ('preparing', 'queued', 'streaming', 'in_progress')
    WHERE waiting."chatId" = affected_chat AND waiting."workspaceWaitPending" AND waiting."status" = 'preparing'
      AND (executing."id" <> f."predecessorRunId" OR executing."answerCompletedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION 'workspace_followup_ownership_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ModelRun_workspace_followup_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "ModelRun" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_workspace_followup_ownership"();
CREATE CONSTRAINT TRIGGER "WorkspaceFollowup_ownership_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "WorkspaceFollowup" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_workspace_followup_ownership"();
