-- Installation-scoped liveness evidence for the supported single Memory
-- worker. Job/deletion leases remain the work-ownership authority; this row
-- is deliberately not a leader-election or failover primitive.
CREATE TABLE "MemoryWorkerHeartbeat" (
  "id" VARCHAR(64) NOT NULL,
  "instanceId" VARCHAR(128) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MemoryWorkerHeartbeat_pkey" PRIMARY KEY ("id")
);
