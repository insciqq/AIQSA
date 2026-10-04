-- Browser push notifications: the per-account setting, the installation VAPID
-- key, per-device subscriptions bound to the session that registered them and
-- the at-most-once delivery claims. New tables and a defaulted column only;
-- previous-release writers never touch them.
ALTER TABLE "UserSettings" ADD COLUMN "browserNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "BrowserPushVapidKey" (
  "id" TEXT NOT NULL,
  "publicKey" VARCHAR(128) NOT NULL,
  "privateKeyEnvelope" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrowserPushVapidKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrowserPushVapidKey_singleton_check" CHECK ("id" = 'installation')
);

CREATE TABLE "BrowserPushSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "endpoint" VARCHAR(2048) NOT NULL,
  "p256dh" VARCHAR(128) NOT NULL,
  "auth" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "BrowserPushSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrowserPushSubscription_endpoint_check" CHECK ("endpoint" LIKE 'https://%'),
  CONSTRAINT "BrowserPushSubscription_failure_check" CHECK ("failureCount" >= 0)
);

CREATE TABLE "BrowserPushDelivery" (
  "id" TEXT NOT NULL,
  "runId" TEXT,
  "occurrenceId" TEXT,
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrowserPushDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrowserPushDelivery_event_check" CHECK (num_nonnulls("runId", "occurrenceId") = 1)
);

CREATE UNIQUE INDEX "AuthSession_userId_id_key" ON "AuthSession"("userId", "id");
CREATE UNIQUE INDEX "BrowserPushSubscription_endpoint_key" ON "BrowserPushSubscription"("endpoint");
CREATE INDEX "BrowserPushSubscription_userId_updatedAt_idx" ON "BrowserPushSubscription"("userId", "updatedAt");
CREATE INDEX "BrowserPushSubscription_sessionId_idx" ON "BrowserPushSubscription"("sessionId");
CREATE UNIQUE INDEX "BrowserPushDelivery_runId_key" ON "BrowserPushDelivery"("runId");
CREATE UNIQUE INDEX "BrowserPushDelivery_occurrenceId_key" ON "BrowserPushDelivery"("occurrenceId");

-- A subscription belongs to its account and to the session that registered
-- it: deleting either removes it. Claims leave with their run or occurrence.
ALTER TABLE "BrowserPushSubscription" ADD CONSTRAINT "BrowserPushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrowserPushSubscription" ADD CONSTRAINT "BrowserPushSubscription_userId_sessionId_fkey"
  FOREIGN KEY ("userId", "sessionId") REFERENCES "AuthSession"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "BrowserPushDelivery" ADD CONSTRAINT "BrowserPushDelivery_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrowserPushDelivery" ADD CONSTRAINT "BrowserPushDelivery_occurrenceId_fkey"
  FOREIGN KEY ("occurrenceId") REFERENCES "ScheduledTaskOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every session revocation (logout, password change or reset, administrator
-- revocation, account disable or rejection) removes that device's
-- subscriptions, whichever writer revoked it.
CREATE FUNCTION aiqsa_revoked_session_push_cleanup() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "BrowserPushSubscription" WHERE "sessionId" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "AuthSession_revoked_push_cleanup"
  AFTER UPDATE OF "revokedAt" ON "AuthSession"
  FOR EACH ROW WHEN (OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL)
  EXECUTE FUNCTION aiqsa_revoked_session_push_cleanup();
