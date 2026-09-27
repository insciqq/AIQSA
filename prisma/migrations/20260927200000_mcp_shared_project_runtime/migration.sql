-- Project runs use an installation-owned runtime generation per server instead
-- of borrowing a member's personal generation. Existing generations stay owned
-- by their McpUserServer; shared generations have no user or preference owner.
ALTER TABLE "McpRuntimeGeneration" ADD COLUMN "sharedServerId" TEXT,
ALTER COLUMN "userServerId" DROP NOT NULL;

CREATE TABLE "McpSharedRuntime" (
    "serverId" TEXT NOT NULL,
    "desiredRuntimeGenerationId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpSharedRuntime_pkey" PRIMARY KEY ("serverId")
);

CREATE UNIQUE INDEX "McpSharedRuntime_desiredRuntimeGenerationId_key" ON "McpSharedRuntime"("desiredRuntimeGenerationId");

CREATE INDEX "McpRuntimeGeneration_sharedServerId_idx" ON "McpRuntimeGeneration"("sharedServerId");

ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_sharedServerId_fkey" FOREIGN KEY ("sharedServerId") REFERENCES "McpSharedRuntime"("serverId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpSharedRuntime" ADD CONSTRAINT "McpSharedRuntime_desiredRuntimeGenerationId_fkey" FOREIGN KEY ("desiredRuntimeGenerationId") REFERENCES "McpRuntimeGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "McpSharedRuntime" ADD CONSTRAINT "McpSharedRuntime_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner: a member's preference or the server's shared runtime.
ALTER TABLE "McpRuntimeGeneration" ADD CONSTRAINT "McpRuntimeGeneration_owner_check"
  CHECK (num_nonnulls("userServerId", "sharedServerId") = 1);
