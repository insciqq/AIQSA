-- Automation webhooks: a scheduled task's two trigger switches, its webhook
-- (public address and the hash of its one bearer token) and the queue of the
-- events the webhook accepted. Defaulted columns and new tables only: every
-- existing task keeps running on its schedule with the webhook off, and the
-- previous release, which never reads the new columns, never fires a task
-- whose next run is null, so its writers stay safe during the upgrade.
CREATE TYPE "ScheduledTaskWebhookEventState" AS ENUM ('QUEUED', 'ADMITTED', 'DISCARDED');

-- At least one trigger is on, and a schedule that is off has no due run, so
-- the scheduler can never pick a webhook-only automation. Existing rows and a
-- previous-release writer get the schedule on and the webhook off.
ALTER TABLE "ScheduledTask"
  ADD COLUMN "scheduleEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "ScheduledTask_trigger_check" CHECK (
    ("scheduleEnabled" OR "webhookEnabled") AND ("scheduleEnabled" OR "nextRunAt" IS NULL)
  );

-- Webhook occurrences, and the task-consistent key an event's link references.
ALTER TABLE "ScheduledTaskOccurrence" DROP CONSTRAINT "ScheduledTaskOccurrence_trigger_check";
ALTER TABLE "ScheduledTaskOccurrence" ADD CONSTRAINT "ScheduledTaskOccurrence_trigger_check"
  CHECK ("trigger" IN ('schedule', 'manual', 'webhook'));
CREATE UNIQUE INDEX "ScheduledTaskOccurrence_taskId_id_key" ON "ScheduledTaskOccurrence"("taskId", "id");

-- One webhook per automation, created the first time its trigger is turned
-- on. Only the hex SHA-256 of the token is stored, with the time it was issued.
CREATE TABLE "ScheduledTaskWebhook" (
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "publicId" VARCHAR(22) NOT NULL,
  "tokenHash" CHAR(64),
  "tokenIssuedAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledTaskWebhook_pkey" PRIMARY KEY ("taskId"),
  CONSTRAINT "ScheduledTaskWebhook_check" CHECK (
    "publicId" ~ '^[A-Za-z0-9_-]{22}$'
    AND ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$')
    AND ("tokenHash" IS NULL) = ("tokenIssuedAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "ScheduledTaskWebhook_publicId_key" ON "ScheduledTaskWebhook"("publicId");
CREATE UNIQUE INDEX "ScheduledTaskWebhook_userId_taskId_key" ON "ScheduledTaskWebhook"("userId", "taskId");

-- The body exists exactly while the event waits and is bounded; the header
-- facts are trimmed printable ASCII and the media type a lowercased essence.
CREATE TABLE "ScheduledTaskWebhookEvent" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "dedupeKey" VARCHAR(200),
  "eventName" VARCHAR(100),
  "contentType" VARCHAR(100),
  "bodyText" TEXT,
  "state" "ScheduledTaskWebhookEventState" NOT NULL DEFAULT 'QUEUED',
  "occurrenceId" TEXT,
  CONSTRAINT "ScheduledTaskWebhookEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledTaskWebhookEvent_check" CHECK (
    ("state" = 'QUEUED'::"ScheduledTaskWebhookEventState") = ("bodyText" IS NOT NULL)
    AND ("bodyText" IS NULL OR octet_length("bodyText") <= 131072)
    AND ("dedupeKey" IS NULL OR "dedupeKey" ~ '^[!-~]([ -~]*[!-~])?$')
    AND ("eventName" IS NULL OR "eventName" ~ '^[!-~]([ -~]*[!-~])?$')
    AND ("contentType" IS NULL OR "contentType" ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$')
  )
);
CREATE INDEX "ScheduledTaskWebhookEvent_taskId_state_receivedAt_idx"
  ON "ScheduledTaskWebhookEvent"("taskId", "state", "receivedAt");
CREATE INDEX "ScheduledTaskWebhookEvent_receivedAt_idx" ON "ScheduledTaskWebhookEvent"("receivedAt");
CREATE UNIQUE INDEX "ScheduledTaskWebhookEvent_taskId_receivedAt_key"
  ON "ScheduledTaskWebhookEvent"("taskId", "receivedAt");
CREATE UNIQUE INDEX "ScheduledTaskWebhookEvent_taskId_dedupeKey_key"
  ON "ScheduledTaskWebhookEvent"("taskId", "dedupeKey");
CREATE UNIQUE INDEX "ScheduledTaskWebhookEvent_taskId_occurrenceId_key"
  ON "ScheduledTaskWebhookEvent"("taskId", "occurrenceId");

-- The webhook and its events leave with the automation and so with the
-- account. An event's occurrence belongs to the same task; pruning the
-- occurrence history clears only the link, so the bodyless row keeps
-- deduplicating and counting toward the rate cap.
ALTER TABLE "ScheduledTaskWebhook" ADD CONSTRAINT "ScheduledTaskWebhook_userId_taskId_fkey"
  FOREIGN KEY ("userId", "taskId") REFERENCES "ScheduledTask"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskWebhookEvent" ADD CONSTRAINT "ScheduledTaskWebhookEvent_userId_taskId_fkey"
  FOREIGN KEY ("userId", "taskId") REFERENCES "ScheduledTask"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ScheduledTaskWebhookEvent" ADD CONSTRAINT "ScheduledTaskWebhookEvent_taskId_occurrenceId_fkey"
  FOREIGN KEY ("taskId", "occurrenceId") REFERENCES "ScheduledTaskOccurrence"("taskId", "id")
  ON DELETE SET NULL ("occurrenceId") ON UPDATE RESTRICT;
