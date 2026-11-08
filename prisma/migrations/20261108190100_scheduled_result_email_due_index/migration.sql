-- The runner's email sweep reads due result emails by `emailDueAt` on every
-- tick. Occurrences are written by every run, so the index is built
-- CONCURRENTLY and stays the only statement of this file (Persistence,
-- Migrations And Bootstrap).
CREATE INDEX CONCURRENTLY "ScheduledTaskOccurrence_emailDueAt_idx" ON "ScheduledTaskOccurrence"("emailDueAt");
