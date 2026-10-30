-- One Workspace session serves several attached runs of its chat (the main agent's and background sub-agent
-- runs). A row is one run's guest execution authority under the session generation it attached at; the
-- session's operation owner and version stay the runner's fence token.
CREATE TABLE "WorkspaceRunAttachment" (
    "modelRunId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "operationGeneration" INTEGER NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceRunAttachment_pkey" PRIMARY KEY ("modelRunId"),
    CONSTRAINT "WorkspaceRunAttachment_generation_check" CHECK ("operationGeneration" >= 1)
);

CREATE UNIQUE INDEX "WorkspaceRunAttachment_chatId_modelRunId_key" ON "WorkspaceRunAttachment"("chatId", "modelRunId");
CREATE INDEX "WorkspaceRunAttachment_chatId_operationGeneration_idx" ON "WorkspaceRunAttachment"("chatId", "operationGeneration");

ALTER TABLE "WorkspaceRunAttachment" ADD CONSTRAINT "WorkspaceRunAttachment_modelRun_fkey"
  FOREIGN KEY ("chatId", "modelRunId") REFERENCES "ModelRun"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "WorkspaceRunAttachment" ADD CONSTRAINT "WorkspaceRunAttachment_session_fkey"
  FOREIGN KEY ("chatId") REFERENCES "WorkspaceSession"("chatId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- The single owner a session has today becomes its one attached run, at the generation it holds. A session whose
-- owner names no run of its chat (export, maintenance, reset, continuation, carryover) keeps that exclusive owner
-- and gets no row. The previous release's writers keep working during the upgrade: a run they admit owns the
-- session by its owner string alone, which the application still accepts while the session has no attachment.
INSERT INTO "WorkspaceRunAttachment" ("modelRunId", "chatId", "operationGeneration")
SELECT run."id", session."chatId", session."version"
FROM "WorkspaceSession" session
JOIN "ModelRun" run ON run."chatId" = session."chatId" AND session."operationOwner" = 'run:' || run."id"
WHERE session."operationOwner" LIKE 'run:%'
ON CONFLICT DO NOTHING;
