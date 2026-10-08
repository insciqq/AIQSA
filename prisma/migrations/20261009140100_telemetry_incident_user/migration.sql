-- Error incidents name the user they hit: the internal id of the user whose
-- signed-in request, run or job the record belonged to, so Health can tell an
-- error that reached many users from one that keeps hitting one. Never a
-- counter dimension. No foreign key: a telemetry write never fails on a deleted
-- account; account deletion clears the id in its transaction and the hourly
-- retention pass clears any written afterwards. Expand only: existing rows and
-- previous-release writers leave it NULL. The table holds at most 50,000 rows,
-- so the index builds in one short statement.
ALTER TABLE "TelemetryIncident" ADD COLUMN "userId" VARCHAR(128);

-- CreateIndex
CREATE INDEX "TelemetryIncident_userId_idx" ON "TelemetryIncident"("userId");
