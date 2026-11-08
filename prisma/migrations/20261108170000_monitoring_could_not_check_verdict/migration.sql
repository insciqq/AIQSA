-- A monitoring check's model may report that it could not check
-- (`could_not_check`), which settles like a check whose relied-on source was
-- unavailable. Only the allowed values widen: every stored row stays valid,
-- and the previous release, which never writes the new value and reads an
-- unknown one as an unreported (shown) check, keeps running during the upgrade.
ALTER TABLE "ScheduledTaskOccurrence" DROP CONSTRAINT "ScheduledTaskOccurrence_monitoring_check";
ALTER TABLE "ScheduledTaskOccurrence" ADD CONSTRAINT "ScheduledTaskOccurrence_monitoring_check" CHECK (
  ("taskRevision" IS NULL OR "taskRevision" > 0)
  AND ("verdict" IS NULL OR "verdict" IN ('update', 'no_update', 'goal_reached', 'could_not_check'))
) NOT VALID;
ALTER TABLE "ScheduledTaskOccurrence" VALIDATE CONSTRAINT "ScheduledTaskOccurrence_monitoring_check";
