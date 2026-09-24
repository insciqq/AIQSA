/** Synthetic existing answer accounting must survive auxiliary Vision adoption. */
export const VISION_ANALYSIS_MIGRATION = "20260924110000_vision_analysis_attempt";
export const visionAnalysisFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('vision-analysis-adoption-user', 'Synthetic owner', 'active', now());
INSERT INTO "UsageEvent" (id, "userId", provider, "modelId", "inputTokens", "outputTokens", "totalTokens", "usageCompleteness")
VALUES ('vision-analysis-adoption-usage', 'vision-analysis-adoption-user', 'fake', 'fake', 3, 2, 5, 'COMPLETE');
CREATE TABLE "_VisionAnalysisUpgradeFixture" AS SELECT to_jsonb(u) AS usage FROM "UsageEvent" u WHERE id = 'vision-analysis-adoption-usage';
`;
export const visionAnalysisProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_VisionAnalysisUpgradeFixture" f JOIN "UsageEvent" u ON u.id = 'vision-analysis-adoption-usage'
    WHERE f.usage = to_jsonb(u) - 'visionAnalysis' - 'visionAnalysisAttemptId' AND NOT u."visionAnalysis" AND u."visionAnalysisAttemptId" IS NULL)
    THEN RAISE EXCEPTION 'vision_analysis_changed_existing_accounting'; END IF;
  IF EXISTS (SELECT 1 FROM "VisionAnalysisAttempt") THEN RAISE EXCEPTION 'vision_analysis_invented_dispatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = '"ProviderRunRole"'::regtype AND enumlabel = 'vision_analysis')
    THEN RAISE EXCEPTION 'vision_analysis_role_missing'; END IF;
END $$;
DROP TABLE "_VisionAnalysisUpgradeFixture";
`;
