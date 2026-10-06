-- Operator health telemetry kept inside the installation: hourly totals of the
-- validated, content-free log records of every process with a database client,
-- and a rate-limited sample of recent error and fatal records. Each process
-- adds its own totals (the primary key sums concurrent writers); the
-- application prunes both tables. New tables only; previous-release writers
-- never touch them. The checks hold what every writer already guarantees, so a
-- violation is a writer defect, never a value to store.
CREATE TABLE "TelemetryCounter" (
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "event" VARCHAR(64) NOT NULL,
  "level" VARCHAR(8) NOT NULL,
  "appVersion" VARCHAR(64) NOT NULL,
  "dimensionHash" CHAR(64) NOT NULL,
  "dimensions" JSONB NOT NULL,
  "count" BIGINT NOT NULL,
  "valueSum" BIGINT NOT NULL,
  "durationCount" BIGINT NOT NULL,
  "durationSumMs" BIGINT NOT NULL,
  "durationMaxMs" BIGINT,
  "durationBuckets" BIGINT[],
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelemetryCounter_pkey" PRIMARY KEY ("bucketStart","role","event","level","appVersion","dimensionHash"),
  CONSTRAINT "TelemetryCounter_level_check" CHECK ("level" IN ('info', 'warn', 'error', 'fatal')),
  CONSTRAINT "TelemetryCounter_bucket_check" CHECK (
    "bucketStart" = date_trunc('hour', "bucketStart")
    AND "firstSeenAt" >= "bucketStart"
    AND "lastSeenAt" >= "firstSeenAt"
    AND "lastSeenAt" < "bucketStart" + interval '1 hour'
  ),
  CONSTRAINT "TelemetryCounter_dimensions_check" CHECK (
    "dimensionHash" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("dimensions") = 'object'
  ),
  CONSTRAINT "TelemetryCounter_metrics_check" CHECK (
    "count" >= 1
    AND "valueSum" >= 0
    AND "durationCount" BETWEEN 0 AND "count"
    AND "durationSumMs" >= 0
    AND ("durationMaxMs" IS NULL OR "durationMaxMs" >= 0)
  ),
  CONSTRAINT "TelemetryCounter_duration_buckets_check" CHECK (
    "durationBuckets" IS NOT NULL
    AND cardinality("durationBuckets") = 12
    AND array_position("durationBuckets", NULL) IS NULL
    AND 0 <= ALL ("durationBuckets")
  )
);

CREATE TABLE "TelemetryIncident" (
  "id" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "event" VARCHAR(64) NOT NULL,
  "level" VARCHAR(8) NOT NULL,
  "appVersion" VARCHAR(64) NOT NULL,
  "instanceId" CHAR(32) NOT NULL,
  "code" VARCHAR(128),
  "subsystem" VARCHAR(64),
  "connectionId" VARCHAR(128),
  "runId" VARCHAR(128),
  "traceId" CHAR(32),
  "details" JSONB NOT NULL,
  CONSTRAINT "TelemetryIncident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TelemetryIncident_level_check" CHECK ("level" IN ('error', 'fatal')),
  CONSTRAINT "TelemetryIncident_identity_check" CHECK (
    "instanceId" ~ '^[0-9a-f]{32}$' AND ("traceId" IS NULL OR "traceId" ~ '^[0-9a-f]{32}$')
  ),
  CONSTRAINT "TelemetryIncident_details_check" CHECK (jsonb_typeof("details") = 'object')
);

-- Time-range reads (and hourly retention) follow the counter key's leading
-- bucket; one event's series uses its own index. Incidents page newest first
-- and resolve an exact run or trace reference.
CREATE INDEX "TelemetryCounter_event_bucketStart_idx" ON "TelemetryCounter"("event", "bucketStart");
CREATE INDEX "TelemetryIncident_occurredAt_id_idx" ON "TelemetryIncident"("occurredAt", "id");
CREATE INDEX "TelemetryIncident_runId_idx" ON "TelemetryIncident"("runId");
CREATE INDEX "TelemetryIncident_traceId_idx" ON "TelemetryIncident"("traceId");
