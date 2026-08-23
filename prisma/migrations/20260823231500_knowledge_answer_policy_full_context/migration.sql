CREATE TABLE "KnowledgeAnswerPolicy" (
    "id" TEXT NOT NULL,
    "maximumKnowledgeSearches" INTEGER NOT NULL DEFAULT 12,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeAnswerPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeAnswerPolicy_updatedByUserId_idx"
    ON "KnowledgeAnswerPolicy"("updatedByUserId");

ALTER TABLE "KnowledgeAnswerPolicy"
    ADD CONSTRAINT "KnowledgeAnswerPolicy_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeAnswerPolicy"
    ADD CONSTRAINT "KnowledgeAnswerPolicy_singleton_check"
    CHECK ("id" = 'installation');

ALTER TABLE "KnowledgeAnswerPolicy"
    ADD CONSTRAINT "KnowledgeAnswerPolicy_maximum_searches_check"
    CHECK ("maximumKnowledgeSearches" BETWEEN 1 AND 32);

ALTER TABLE "KnowledgeAnswerPolicy"
    ADD CONSTRAINT "KnowledgeAnswerPolicy_version_check"
    CHECK ("version" >= 1);

INSERT INTO "KnowledgeAnswerPolicy" (
    "id",
    "maximumKnowledgeSearches",
    "version",
    "updatedAt"
) VALUES ('installation', 12, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "KnowledgeRunScope"
    ADD COLUMN "answerPolicy" JSONB NOT NULL DEFAULT
      '{"version":1,"revision":1,"maximumKnowledgeSearches":12,"fullContextThresholdBasisPoints":7000}'::jsonb,
    ADD COLUMN "answerRoute" VARCHAR(32) NOT NULL DEFAULT 'rag_v1';

ALTER TABLE "KnowledgeRunScope"
    ADD CONSTRAINT "KnowledgeRunScope_answer_route_check"
    CHECK ("answerRoute" IN ('rag_v1', 'full_context_v1'));
