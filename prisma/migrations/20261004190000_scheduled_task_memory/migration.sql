-- Scheduled task Memory: runs of a task with the switch on read the owner's
-- Memory and never add to it. A defaulted column only: existing tasks keep
-- running without Memory, and previous-release writers never touch it. The
-- owner API and the chat tool write it on every new task.
ALTER TABLE "ScheduledTask"
  ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT false;
