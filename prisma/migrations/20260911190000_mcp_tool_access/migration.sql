-- Tool policy is independent of revisions and runtime/credential identity.
-- Deleting the last recipient leaves a restricted, empty policy in place.
CREATE TABLE "McpToolAccessPolicy" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "McpToolAccessPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpToolUserGrant" (
    "policyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "McpToolUserGrant_pkey" PRIMARY KEY ("policyId", "userId")
);

CREATE TABLE "McpToolGroupGrant" (
    "policyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    CONSTRAINT "McpToolGroupGrant_pkey" PRIMARY KEY ("policyId", "groupId")
);

CREATE UNIQUE INDEX "McpToolAccessPolicy_serverId_toolName_key" ON "McpToolAccessPolicy"("serverId", "toolName");
CREATE INDEX "McpToolUserGrant_userId_idx" ON "McpToolUserGrant"("userId");
CREATE INDEX "McpToolGroupGrant_groupId_idx" ON "McpToolGroupGrant"("groupId");

ALTER TABLE "McpToolAccessPolicy" ADD CONSTRAINT "McpToolAccessPolicy_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpToolUserGrant" ADD CONSTRAINT "McpToolUserGrant_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "McpToolAccessPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpToolUserGrant" ADD CONSTRAINT "McpToolUserGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpToolGroupGrant" ADD CONSTRAINT "McpToolGroupGrant_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "McpToolAccessPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpToolGroupGrant" ADD CONSTRAINT "McpToolGroupGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
