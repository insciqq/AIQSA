-- Every owner's first v5 pass starts from its first version, owners in order.
-- Separate from the v5 shape check of 20261006120000: each migration is its own
-- transaction, so the review table's exclusive lock is released before these
-- settings row locks are taken, and a previous-release planner holding an
-- owner's settings row lock while it scans reviews cannot deadlock with it.
UPDATE "UserMemorySettings" SET "maintenanceCursor" = NULL, "maintenanceScannedAt" = NULL;
