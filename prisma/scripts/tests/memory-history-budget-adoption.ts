export const MEMORY_HISTORY_BUDGET_MIGRATION = "20260917104500_memory_history_output_limit_counter";

export const memoryHistoryBudgetFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-budget-owner', 'Fixture owner', 'active', now());
INSERT INTO "MemoryJob" (id, "userId", kind, state, "pipelineVersion",
  "memoryGenerationSnapshot", "memoryRevisionSnapshot", "idempotencyFingerprint",
  "operationalCounters", "completedAt", "updatedAt")
VALUES ('memory-budget-job', 'memory-budget-owner', 'INDEX_HISTORY', 'SUCCEEDED',
  'budget-fixture-v1', 0, 0, 'memory-budget-job',
  '{"contextualFallbackProviderUnavailable":1}', now(), now());
CREATE TABLE "MemoryBudgetAdoptionFixture" AS
SELECT to_jsonb(job) AS snapshot FROM "MemoryJob" AS job WHERE id = 'memory-budget-job';
DO $$ BEGIN
  IF public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderOutputLimit":1}') THEN
    RAISE EXCEPTION 'memory_budget_predecessor_already_accepts_new_counter';
  END IF;
END $$;
`;

export const memoryHistoryBudgetProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryBudgetAdoptionFixture" AS original
      JOIN "MemoryJob" AS job ON job.id = 'memory-budget-job' WHERE original.snapshot = to_jsonb(job)) THEN
    RAISE EXCEPTION 'memory_budget_migration_changed_existing_job';
  END IF;
  IF NOT public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderOutputLimit":1}')
    OR NOT public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderUnavailable":1}') THEN
    RAISE EXCEPTION 'memory_budget_counter_writers_incompatible';
  END IF;
  IF public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderOutputLimit":-1}')
    OR public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderOutputLimit":0.5}')
    OR public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderOutputLimit":"1"}')
    OR public.aiqsa_memory_operational_counters_valid('{"contextualFallbackProviderOutputLimit":2147483648}')
    OR public.aiqsa_memory_operational_counters_valid('{"unknownField":1}') THEN
    RAISE EXCEPTION 'memory_budget_counter_boundary_weakened';
  END IF;
END $$;
`;
