-- Monitoring scheduled tasks: the task type, a runner completion reason (a
-- reached goal), the streak of checks that never reported an outcome, the
-- model-reported outcome and accepting revision on occurrences, and the
-- settled outcome on the run itself so the transcript keeps it after the
-- occurrence history is pruned. Defaulted or nullable columns only.
CREATE TYPE "ScheduledTaskKind" AS ENUM ('STANDARD', 'MONITORING');

ALTER TABLE "ScheduledTask"
  ADD COLUMN "kind" "ScheduledTaskKind" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "completionReason" VARCHAR(64),
  ADD COLUMN "consecutiveMissingVerdicts" INTEGER NOT NULL DEFAULT 0;

-- Only ACTIVE tasks are due; a task completes after a once task's single run
-- or with a runner completion reason; only automatic pauses and completions
-- carry a bounded lowercase reason code; hourly and monitoring tasks always
-- continue in one chat.
ALTER TABLE "ScheduledTask" DROP CONSTRAINT "ScheduledTask_state_check";
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_state_check" CHECK (
  "revision" > 0 AND "generation" > 0 AND "consecutiveFailures" >= 0 AND "consecutiveMissingVerdicts" >= 0
  AND ("status" = 'ACTIVE'::"ScheduledTaskStatus" OR "nextRunAt" IS NULL)
  AND ("status" <> 'COMPLETED'::"ScheduledTaskStatus" OR "scheduleKind" = 'ONCE'::"ScheduledTaskScheduleKind"
    OR "completionReason" IS NOT NULL)
  AND ("pauseReason" IS NULL OR (
    "status" = 'PAUSED'::"ScheduledTaskStatus" AND "pauseReason" ~ '^[a-z][a-z0-9_]{0,63}$'
  ))
  AND ("completionReason" IS NULL OR (
    "status" = 'COMPLETED'::"ScheduledTaskStatus" AND "completionReason" ~ '^[a-z][a-z0-9_]{0,63}$'
  ))
  AND ("chatMode" = 'SAME'::"ScheduledTaskChatMode" OR (
    "scheduleKind" <> 'HOURLY'::"ScheduledTaskScheduleKind" AND "kind" = 'STANDARD'::"ScheduledTaskKind"
  ))
) NOT VALID;
ALTER TABLE "ScheduledTask" VALIDATE CONSTRAINT "ScheduledTask_state_check";

ALTER TABLE "ScheduledTaskOccurrence"
  ADD COLUMN "taskRevision" INTEGER,
  ADD COLUMN "verdict" VARCHAR(16),
  ADD CONSTRAINT "ScheduledTaskOccurrence_monitoring_check" CHECK (
    ("taskRevision" IS NULL OR "taskRevision" > 0)
    AND ("verdict" IS NULL OR "verdict" IN ('update', 'no_update', 'goal_reached'))
  );

-- Only a run with a scheduled origin carries a check outcome.
ALTER TABLE "ModelRun"
  ADD COLUMN "scheduledOutcome" VARCHAR(64),
  ADD CONSTRAINT "ModelRun_scheduled_outcome_check" CHECK (
    "scheduledOutcome" IS NULL OR (
      "scheduledOccurrenceId" IS NOT NULL AND "scheduledOutcome" ~ '^[a-z][a-z0-9_]{0,63}$'
    )
  ) NOT VALID;
ALTER TABLE "ModelRun" VALIDATE CONSTRAINT "ModelRun_scheduled_outcome_check";
