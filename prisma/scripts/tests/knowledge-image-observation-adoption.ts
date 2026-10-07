/** Existing accounting survives the Knowledge image description table; no description is invented. */
export const KNOWLEDGE_IMAGE_OBSERVATION_MIGRATION = "20261005090000_knowledge_image_observation";
export const knowledgeImageObservationFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('knowledge-image-adoption-user', 'Synthetic owner', 'active', now());
INSERT INTO "UsageEvent" (id, "userId", provider, "modelId", "inputTokens", "outputTokens", "totalTokens", "usageCompleteness")
VALUES ('knowledge-image-adoption-usage', 'knowledge-image-adoption-user', 'fake', 'fake', 3, 2, 5, 'COMPLETE');
CREATE TABLE "_KnowledgeImageObservationUpgradeFixture" AS SELECT to_jsonb(u) AS usage FROM "UsageEvent" u WHERE id = 'knowledge-image-adoption-usage';
`;
export const knowledgeImageObservationProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_KnowledgeImageObservationUpgradeFixture" f JOIN "UsageEvent" u ON u.id = 'knowledge-image-adoption-usage'
    WHERE f.usage = to_jsonb(u) - 'knowledgeImageObservationRunId' - 'purpose' AND u."knowledgeImageObservationRunId" IS NULL)
    THEN RAISE EXCEPTION 'knowledge_image_observation_changed_existing_accounting'; END IF;
  IF EXISTS (SELECT 1 FROM "KnowledgeImageObservation") THEN RAISE EXCEPTION 'knowledge_image_observation_invented_dispatch'; END IF;
END $$;
DROP TABLE "_KnowledgeImageObservationUpgradeFixture";
`;
