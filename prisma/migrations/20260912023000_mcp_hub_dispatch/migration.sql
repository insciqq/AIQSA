CREATE TYPE "McpHubDispatchState" AS ENUM ('DISPATCHED', 'COMPLETE', 'ERROR', 'UNKNOWN');

CREATE TABLE "McpHubDispatch" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientId" VARCHAR(2048) NOT NULL,
  "grantId" VARCHAR(64) NOT NULL,
  "resourcePath" VARCHAR(32) NOT NULL,
  "toolId" VARCHAR(128) NOT NULL,
  "toolVersion" VARCHAR(128) NOT NULL,
  "state" "McpHubDispatchState" NOT NULL DEFAULT 'DISPATCHED',
  "resultCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "McpHubDispatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpHubDispatch_state_check" CHECK (
    ("state" = 'DISPATCHED' AND "completedAt" IS NULL)
    OR ("state" IN ('COMPLETE', 'ERROR', 'UNKNOWN') AND "completedAt" IS NOT NULL)
  )
);

CREATE INDEX "McpHubDispatch_userId_createdAt_idx" ON "McpHubDispatch"("userId", "createdAt");
CREATE INDEX "McpHubDispatch_grantId_createdAt_idx" ON "McpHubDispatch"("grantId", "createdAt");
CREATE INDEX "McpHubDispatch_state_createdAt_idx" ON "McpHubDispatch"("state", "createdAt");
ALTER TABLE "McpHubDispatch"
  ADD CONSTRAINT "McpHubDispatch_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
