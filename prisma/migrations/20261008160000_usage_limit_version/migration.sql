-- Group allowance and user override saves compare a version, like the
-- installation singleton. Inserts and changes take the next value of the
-- column's own sequence ("UsageLimit_version_seq"), so a row removed and
-- created again never repeats a version that a stale draft still holds.
-- SERIAL numbers existing rows; the table holds one row per configured group
-- or user, so the rewrite is small.
ALTER TABLE "UsageLimit" ADD COLUMN "version" SERIAL NOT NULL;
