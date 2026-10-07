-- Scheduled Workspace capacity: when an occurrence first waited for a
-- scheduled Workspace slot, kept after the wait for the administrator's
-- content-free counts. A nullable column only, so previous-release writers
-- keep working during replacement.
ALTER TABLE "ScheduledTaskOccurrence" ADD COLUMN "workspaceWaitStartedAt" TIMESTAMP(3);
