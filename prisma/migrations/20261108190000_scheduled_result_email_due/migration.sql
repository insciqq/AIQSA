-- A settled automation result's email becomes due in the transaction that
-- settles it, so a restart between the settlement and the send no longer
-- loses it; the claim (`notifiedAt`) keeps it at most once. A nullable column
-- with no default needs no rewrite or backfill: rows the previous release
-- settled stay null and are never swept, and that release, which neither
-- reads nor writes the column, keeps running during the upgrade.
ALTER TABLE "ScheduledTaskOccurrence" ADD COLUMN "emailDueAt" TIMESTAMP(3);
