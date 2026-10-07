-- Installation-wide usage periods: Control Center analytics and the pooled
-- monthly budget sum usage by time across every user. Without this index those
-- ranges scan the whole table. Built CONCURRENTLY as the only statement of this
-- file so usage writers continue during the upgrade (Persistence, Migrations
-- And Bootstrap).
CREATE INDEX CONCURRENTLY "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");
