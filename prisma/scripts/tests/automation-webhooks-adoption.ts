/**
 * Automation webhooks (operator decisions 2026-10-24 and 2026-10-25): every
 * task saved by the previous release keeps running on its schedule with the
 * webhook off and is otherwise unchanged, and the new tables start empty.
 */
export const AUTOMATION_WEBHOOKS_MIGRATION = "20261025120000_automation_webhooks";

// Active and paused tasks of every schedule kind with occurrences of both
// triggers, saved before the switches existed. Explicit columns keep the
// fixture valid when later migrations add columns.
export const automationWebhooksFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('webhook-adoption-owner', 'Synthetic owner', 'active', now());
INSERT INTO "ScheduledTask" (id, "userId", title, prompt, "scheduleKind", "timeOfDayMinutes", "daysOfWeekMask", "dayOfMonth",
  "onceLocalDate", "everyHours", "untilMinutes", "timeZone", "modelId", provider, "chatMode", status, "nextRunAt", "updatedAt")
VALUES
  ('webhook-adoption-once', 'webhook-adoption-owner', 'Synthetic once', 'Synthetic scheduled prompt', 'ONCE', 540, 0, NULL,
    '2026-11-02', NULL, NULL, 'Europe/Moscow', 'synthetic-model', 'synthetic-provider', 'NEW', 'ACTIVE', '2026-11-02 06:00:00', now()),
  ('webhook-adoption-daily', 'webhook-adoption-owner', 'Synthetic daily', 'Synthetic scheduled prompt', 'DAILY', 540, 0, NULL,
    NULL, NULL, NULL, 'Europe/Moscow', 'synthetic-model', 'synthetic-provider', 'NEW', 'ACTIVE', '2026-10-26 06:00:00', now()),
  ('webhook-adoption-weekly', 'webhook-adoption-owner', 'Synthetic weekly', 'Synthetic scheduled prompt', 'WEEKLY', 600, 31, NULL,
    NULL, NULL, NULL, 'Europe/Moscow', 'synthetic-model', 'synthetic-provider', 'NEW', 'PAUSED', NULL, now()),
  ('webhook-adoption-monthly', 'webhook-adoption-owner', 'Synthetic monthly', 'Synthetic scheduled prompt', 'MONTHLY', 480, 0, 31,
    NULL, NULL, NULL, 'Europe/Moscow', 'synthetic-model', 'synthetic-provider', 'NEW', 'ACTIVE', '2026-10-31 05:00:00', now()),
  ('webhook-adoption-hourly', 'webhook-adoption-owner', 'Synthetic hourly', 'Synthetic scheduled prompt', 'HOURLY', 540, 31, NULL,
    NULL, 2, 1080, 'Europe/Moscow', 'synthetic-model', 'synthetic-provider', 'SAME', 'ACTIVE', '2026-10-27 06:00:00', now());
INSERT INTO "ScheduledTaskOccurrence" (id, "taskId", "userId", trigger, "scheduledFor", state, "finishedAt")
VALUES
  ('webhook-adoption-scheduled', 'webhook-adoption-daily', 'webhook-adoption-owner', 'schedule', '2026-10-25 06:00:00', 'COMPLETED',
    '2026-10-25 06:01:00'),
  ('webhook-adoption-manual', 'webhook-adoption-daily', 'webhook-adoption-owner', 'manual', '2026-10-25 07:00:00', 'PENDING', NULL);
CREATE TABLE "_AutomationWebhooksTaskFixture" AS
  SELECT id, to_jsonb(task) AS row FROM "ScheduledTask" task WHERE id LIKE 'webhook-adoption-%';
CREATE TABLE "_AutomationWebhooksOccurrenceFixture" AS
  SELECT id, to_jsonb(occurrence) AS row FROM "ScheduledTaskOccurrence" occurrence WHERE id LIKE 'webhook-adoption-%';
`;

export const automationWebhooksProofSql = `
DO $$ BEGIN
  -- Every existing task runs on its schedule with the webhook off; nothing else of it changed, its next run included.
  IF (SELECT count(*) FROM "ScheduledTask" task JOIN "_AutomationWebhooksTaskFixture" fixture ON fixture.id = task.id
    WHERE task."scheduleEnabled" AND NOT task."webhookEnabled"
      AND fixture.row = to_jsonb(task) - 'scheduleEnabled' - 'webhookEnabled') <> 5
    THEN RAISE EXCEPTION 'automation_webhooks_existing_task_changed'; END IF;
  IF (SELECT count(*) FROM "ScheduledTaskOccurrence" occurrence
    JOIN "_AutomationWebhooksOccurrenceFixture" fixture ON fixture.id = occurrence.id
    WHERE fixture.row = to_jsonb(occurrence)) <> 2
    THEN RAISE EXCEPTION 'automation_webhooks_existing_occurrence_changed'; END IF;
  IF EXISTS (SELECT 1 FROM "ScheduledTaskWebhook") OR EXISTS (SELECT 1 FROM "ScheduledTaskWebhookEvent")
    THEN RAISE EXCEPTION 'automation_webhooks_tables_not_empty'; END IF;
  -- A task a previous-release writer saves during the upgrade runs on its schedule.
  INSERT INTO "ScheduledTask" (id, "userId", title, prompt, "scheduleKind", "timeOfDayMinutes", "timeZone", "modelId", provider,
    "nextRunAt", "updatedAt")
  VALUES ('webhook-adoption-previous-writer', 'webhook-adoption-owner', 'Synthetic note', 'Synthetic scheduled prompt', 'DAILY', 600,
    'Europe/Moscow', 'synthetic-model', 'synthetic-provider', now(), now());
  IF NOT EXISTS (SELECT 1 FROM "ScheduledTask" WHERE id = 'webhook-adoption-previous-writer' AND "scheduleEnabled"
    AND NOT "webhookEnabled") THEN RAISE EXCEPTION 'automation_webhooks_previous_writer_defaults'; END IF;
  -- Its occurrences keep their triggers, and webhook occurrences are new.
  INSERT INTO "ScheduledTaskOccurrence" (id, "taskId", "userId", trigger, "scheduledFor")
  VALUES ('webhook-adoption-previous-manual', 'webhook-adoption-previous-writer', 'webhook-adoption-owner', 'manual', now()),
    ('webhook-adoption-webhook', 'webhook-adoption-previous-writer', 'webhook-adoption-owner', 'webhook', now());
  -- A webhook-only task keeps no due time, so a previous-release edit that would arm its schedule fails instead of running it.
  UPDATE "ScheduledTask" SET "scheduleEnabled" = false, "webhookEnabled" = true, "nextRunAt" = NULL
  WHERE id = 'webhook-adoption-daily';
  BEGIN
    UPDATE "ScheduledTask" SET "nextRunAt" = now() WHERE id = 'webhook-adoption-daily';
    RAISE EXCEPTION 'automation_webhooks_due_without_schedule';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "ScheduledTask" SET "webhookEnabled" = false WHERE id = 'webhook-adoption-daily';
    RAISE EXCEPTION 'automation_webhooks_trigger_unchecked';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
DROP TABLE "_AutomationWebhooksTaskFixture";
DROP TABLE "_AutomationWebhooksOccurrenceFixture";
`;
