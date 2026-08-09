CREATE TABLE "KnowledgePolicy" (
  "id" TEXT NOT NULL,
  "candidateLimit" INTEGER NOT NULL DEFAULT 40,
  "resultLimit" INTEGER NOT NULL DEFAULT 8,
  "scoreThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgePolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "KnowledgePolicy_version_check" CHECK ("version" >= 1),
  CONSTRAINT "KnowledgePolicy_candidate_limit_check" CHECK ("candidateLimit" BETWEEN 1 AND 100),
  CONSTRAINT "KnowledgePolicy_result_limit_check" CHECK ("resultLimit" BETWEEN 1 AND 8 AND "resultLimit" <= "candidateLimit"),
  CONSTRAINT "KnowledgePolicy_score_threshold_check" CHECK ("scoreThreshold" >= 0 AND "scoreThreshold" <= 1)
);

INSERT INTO "KnowledgePolicy" (
  "id", "candidateLimit", "resultLimit", "scoreThreshold"
) VALUES (
  'installation', 40, 8, 0.01
);

CREATE INDEX "KnowledgePolicy_updatedByUserId_idx"
ON "KnowledgePolicy"("updatedByUserId");

ALTER TABLE "KnowledgePolicy"
ADD CONSTRAINT "KnowledgePolicy_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
