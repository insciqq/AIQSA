CREATE TABLE "ArtifactChatBinding" (
  "artifactId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ArtifactChatBinding_pkey" PRIMARY KEY ("artifactId", "chatId")
);

CREATE INDEX "ArtifactChatBinding_chatId_updatedAt_idx" ON "ArtifactChatBinding"("chatId", "updatedAt");
CREATE INDEX "ArtifactChatBinding_versionId_idx" ON "ArtifactChatBinding"("versionId");

ALTER TABLE "ArtifactChatBinding"
  ADD CONSTRAINT "ArtifactChatBinding_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ArtifactChatBinding"
  ADD CONSTRAINT "ArtifactChatBinding_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ArtifactChatBinding"
  ADD CONSTRAINT "ArtifactChatBinding_version_fkey"
  FOREIGN KEY ("artifactId", "versionId") REFERENCES "ArtifactVersion"("artifactId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Preserve context for artifacts created before the binding table existed when
-- their original personal chat and current ready version still exist.
INSERT INTO "ArtifactChatBinding" ("artifactId", "chatId", "versionId", "updatedAt")
SELECT a."id", a."sourceChatId", a."currentVersionId", CURRENT_TIMESTAMP
FROM "Artifact" a
JOIN "Chat" c ON c."id" = a."sourceChatId"
  AND c."userId" = a."ownerUserId"
  AND c."projectId" IS NULL
  AND c."memoryMode" <> 'TEMPORARY'
JOIN "ArtifactVersion" v ON v."artifactId" = a."id"
  AND v."id" = a."currentVersionId"
  AND v."status" = 'READY'
WHERE a."sourceChatId" IS NOT NULL
  AND a."currentVersionId" IS NOT NULL
ON CONFLICT ("artifactId", "chatId") DO NOTHING;
