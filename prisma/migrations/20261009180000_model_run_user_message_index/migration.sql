-- Deleting a message checks this RESTRICT foreign key once per message, and
-- runs are found by their prompt (edit and regeneration sources, scheduled
-- task origins and calls). Without this index each check scans every run:
-- deleting a 2,100-message chat among 41,000 runs took 18 s in these checks
-- alone. ModelRun is a large live table, so the index is built CONCURRENTLY
-- and stays the only statement of this file (Persistence, Migrations And
-- Bootstrap).
CREATE INDEX CONCURRENTLY "ModelRun_userMessageId_idx" ON "ModelRun"("userMessageId");
