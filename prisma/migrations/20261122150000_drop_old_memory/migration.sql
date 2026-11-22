-- Personal Memory is replaced by the memory note and past-chat search, and v0.5.0 drops the old subsystem's storage
-- with its data (operator decisions 2026-11-22). Nothing in this release reads or writes it: the adoption
-- (`20261122140000_memory_note_adoption`) carried what stays, and the production rollout stops the previous release's
-- app and worker before migrating (`agent_docs/PERSISTENCE.md`).
--
-- What goes: every table, enum and routine of the old subsystem, the triggers on tables that stay that served only it,
-- the columns only it used (the chat's history counters, the usage row's execution binding, a Workspace follow-up's
-- source-revision advance), its coordinator's fairness cursors, and the trigger that classified the usage rows of
-- writers naming no purpose, which no release since 2026-10-08 is (it read the dropped execution bindings).
-- Rewritten without it: the preparation gate of PDF and Workspace runs, the Temporary chat delete guard, the chat's
-- Temporary shape check and the usage shape check. Untouched: the chat's Memory mode with its import and Temporary
-- rules, the memory note, its offers and legacy suggestions, the past-chat index, the background worker's tables, the
-- reranker and embedding roles, usage rows and purposes, and inbound OAuth (revoked Memory grants keep their capability
-- as history; the application refuses it).
--
-- A run the previous release left `preparing` for its Memory preparation, with no PDF or Workspace gate, would hold its
-- chat for good: nothing prepares it any more and Stop refuses a preparing run without a gate. It ends interrupted, as
-- the old engine's runs do (`lib/server/runs/retiredEngineRuns.ts`), once every statement that changes a table has run:
-- a row event still pending at that point would refuse the DDL. Its Memory attempt goes with its table.
--
-- Dropping a table removes its foreign key triggers from the tables it references, under an exclusive lock, so every
-- lock is taken up front in a fixed order, the tables that stay first, and a deadlock retries instead of failing the
-- upgrade. Nothing is rewritten: DROP TABLE unlinks the old rows, columns go without a rewrite, and the two checks added
-- back only read Chat and UsageEvent.

CREATE TEMPORARY TABLE "aiqsa_retired_memory_table" ("name" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "aiqsa_retired_memory_table" ("name") VALUES
  ('ChatMemoryCheckpoint'),
  ('ChatMemoryCheckpointMessage'),
  ('MemoryAuxiliarySemanticCall'),
  ('MemoryCandidate'),
  ('MemoryCandidateDecision'),
  ('MemoryCandidateMessage'),
  ('MemoryDeletionOutbox'),
  ('MemoryEgressAdminPolicy'),
  ('MemoryEmbeddingBatchItem'),
  ('MemoryEntity'),
  ('MemoryEntityAlias'),
  ('MemoryEntityAliasSupport'),
  ('MemoryEvent'),
  ('MemoryEvidence'),
  ('MemoryExecutionBinding'),
  ('MemoryFact'),
  ('MemoryFactExtractionCandidateReceipt'),
  ('MemoryFactExtractionExecution'),
  ('MemoryFactVersion'),
  ('MemoryFactVersionEntity'),
  ('MemoryFactVersionRelation'),
  ('MemoryFactVersionSourceDependency'),
  ('MemoryFeedback'),
  ('MemoryHistoryRun'),
  ('MemoryIdentityCompatibility'),
  ('MemoryIndexGeneration'),
  ('MemoryJob'),
  ('MemoryMaintenanceExecution'),
  ('MemoryMaintenanceReview'),
  ('MemoryMaintenanceSuppression'),
  ('MemoryMutationAuthorization'),
  ('MemoryOperationReceipt'),
  ('MemoryPauseInterval'),
  ('MemoryRecallChunk'),
  ('MemoryRecallChunkMessage'),
  ('MemoryRecallRound'),
  ('MemoryRecallRoundMessage'),
  ('MemoryRecallRoundSegment'),
  ('MemoryRecallRoundSegmentMessage'),
  ('MemoryRetrievalAttempt'),
  ('MemoryRetrievalAttemptItem'),
  ('MemoryScope'),
  ('MemorySearchEntry'),
  ('MemorySourceBarrier'),
  ('MemorySuppression'),
  ('MemoryToolEvent'),
  ('MemoryUtilityModelPolicy'),
  ('MemoryWorkerHeartbeat'),
  ('ModelRunMemoryBinding'),
  ('ModelRunMemoryItem'),
  ('UserMemorySettings');

-- Every routine that served only the old subsystem; all overloads of each name go.
CREATE TEMPORARY TABLE "aiqsa_retired_memory_routine" ("name" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "aiqsa_retired_memory_routine" ("name") VALUES
  ('aiqsa_memory_active_generation_trigger'),
  ('aiqsa_memory_alias_requires_support'),
  ('aiqsa_memory_assert_active_generation'),
  ('aiqsa_memory_assert_candidate_has_evidence'),
  ('aiqsa_memory_assert_fact_pointer'),
  ('aiqsa_memory_assert_history_source'),
  ('aiqsa_memory_assert_history_source_once'),
  ('aiqsa_memory_assert_recall_round_segment'),
  ('aiqsa_memory_assert_recall_round_source'),
  ('aiqsa_memory_assert_recall_round_source_once'),
  ('aiqsa_memory_assert_run_binding'),
  ('aiqsa_memory_assert_run_preparation'),
  ('aiqsa_memory_assert_scope_fact_availability'),
  ('aiqsa_memory_assert_tool_event_source'),
  ('aiqsa_memory_assert_vnext_evidence'),
  ('aiqsa_memory_attempt_item_target_guard'),
  ('aiqsa_memory_auxiliary_call_guard'),
  ('aiqsa_memory_auxiliary_semantic_call_guard'),
  ('aiqsa_memory_candidate_authority_trigger'),
  ('aiqsa_memory_candidate_decision_authority_trigger'),
  ('aiqsa_memory_candidate_decision_immutable_trigger'),
  ('aiqsa_memory_candidate_evidence_trigger'),
  ('aiqsa_memory_candidate_message_authority_trigger'),
  ('aiqsa_memory_command_identity_guard'),
  ('aiqsa_memory_create_default_settings'),
  ('aiqsa_memory_decay_touch_guard'),
  ('aiqsa_memory_delete_unsupported_alias'),
  ('aiqsa_memory_deletion_admission_immutable_guard'),
  ('aiqsa_memory_dependency_guard'),
  ('aiqsa_memory_dependency_removed_source_valid'),
  ('aiqsa_memory_dependency_source_removed'),
  ('aiqsa_memory_dependency_source_version_valid'),
  ('aiqsa_memory_entity_guard'),
  ('aiqsa_memory_entity_root_id'),
  ('aiqsa_memory_entity_root_is_active'),
  ('aiqsa_memory_event_deleted_source_guard'),
  ('aiqsa_memory_explicit_relation_binding_guard'),
  ('aiqsa_memory_explicit_relation_call_guard'),
  ('aiqsa_memory_explicit_relation_result_valid'),
  ('aiqsa_memory_fact_dependencies_valid'),
  ('aiqsa_memory_fact_extraction_binding_guard'),
  ('aiqsa_memory_fact_extraction_candidate_guard'),
  ('aiqsa_memory_fact_extraction_execution_guard'),
  ('aiqsa_memory_fact_pointer_trigger'),
  ('aiqsa_memory_fact_root_id'),
  ('aiqsa_memory_fact_scope_guard'),
  ('aiqsa_memory_fact_version_observed_at_guard'),
  ('aiqsa_memory_feedback_guard'),
  ('aiqsa_memory_feedback_target_guard'),
  ('aiqsa_memory_generation_immutable'),
  ('aiqsa_memory_history_source_trigger'),
  ('aiqsa_memory_job_source_message_guard'),
  ('aiqsa_memory_maintenance_execution_guard'),
  ('aiqsa_memory_maintenance_execution_receipt_guard'),
  ('aiqsa_memory_maintenance_review_guard'),
  ('aiqsa_memory_maintenance_suppression_guard'),
  ('aiqsa_memory_message_dependency_valid'),
  ('aiqsa_memory_model_run_item_target_guard'),
  ('aiqsa_memory_operational_counters_valid'),
  ('aiqsa_memory_preserved_source_evidence_guard'),
  ('aiqsa_memory_protect_candidate_execution_trigger'),
  ('aiqsa_memory_protect_candidate_job_trigger'),
  ('aiqsa_memory_protect_candidate_message_trigger'),
  ('aiqsa_memory_recall_round_segment_trigger'),
  ('aiqsa_memory_recall_round_source_trigger'),
  ('aiqsa_memory_relation_pointer_guard'),
  ('aiqsa_memory_relation_provenance_guard'),
  ('aiqsa_memory_relation_resolution_guard'),
  ('aiqsa_memory_run_binding_trigger'),
  ('aiqsa_memory_run_preparation_trigger'),
  ('aiqsa_memory_scope_guard'),
  ('aiqsa_memory_search_entry_guard'),
  ('aiqsa_memory_source_guard_forget'),
  ('aiqsa_memory_source_guard_passed'),
  ('aiqsa_memory_source_guard_remember'),
  ('aiqsa_memory_synthesis_claims_valid'),
  ('aiqsa_memory_synthesis_relation_guard'),
  ('aiqsa_memory_synthesis_source_eligibility_hash'),
  ('aiqsa_memory_tool_event_source_guard'),
  ('aiqsa_memory_vnext_identity_temporal_guard'),
  ('aiqsa_memory_vnext_provenance_guard'),
  ('aiqsa_memory_vnext_semantic_guard'),
  -- Generic in name, but only old Memory tables used them.
  ('aiqsa_permanent_chat_source_snapshot_write_guard'),
  ('aiqsa_permanent_chat_source_write_guard'),
  -- The purpose classification of writers that named no purpose.
  ('usage_event_legacy_model_class'),
  ('usage_event_legacy_purpose'),
  ('usage_event_legacy_writer_purpose');

DO $migration$
DECLARE
  locks text;
BEGIN
  WITH retired AS (
    SELECT relation.oid
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN "aiqsa_retired_memory_table" AS retired_table ON retired_table."name" = relation.relname
    WHERE namespace.nspname = current_schema() AND relation.relkind IN ('r', 'p')
  ), linked AS (
    SELECT constraint_row.confrelid AS oid FROM pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f' AND constraint_row.conrelid IN (SELECT oid FROM retired)
    UNION
    SELECT constraint_row.conrelid FROM pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f' AND constraint_row.confrelid IN (SELECT oid FROM retired)
    UNION
    SELECT relation.oid FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname IN ('User', 'Chat', 'Message', 'ModelRun', 'UsageEvent', 'WorkspaceFollowup',
        'ChatPdfRunPreparation', 'ChatPdfAttachmentPreparation', 'DocumentProcessingFairnessCursor')
  ), ordered AS (
    SELECT relation.relname, relation.oid IN (SELECT oid FROM retired) AS retiring
    FROM pg_class AS relation
    WHERE relation.oid IN (SELECT oid FROM retired UNION SELECT oid FROM linked)
  )
  SELECT string_agg(format('%I', ordered.relname), ', ' ORDER BY ordered.retiring, ordered.relname)
  INTO locks
  FROM ordered;
  LOOP
    BEGIN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', locks);
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

-- Triggers on tables that stay and serve only the old subsystem: default Memory settings for a new account, the
-- candidate message guard, the once-per-batch source guard's reset, the run's Memory binding guard and the purpose
-- classification of writers that name none.
DROP TRIGGER IF EXISTS "User_memory_settings_default" ON "User";
DROP TRIGGER IF EXISTS "Message_memory_candidate_authority_trigger" ON "Message";
DROP TRIGGER IF EXISTS "Chat_memory_source_guard_forget" ON "Chat";
DROP TRIGGER IF EXISTS "Message_memory_source_guard_forget" ON "Message";
DROP TRIGGER IF EXISTS "ModelRun_memory_binding_guard" ON "ModelRun";
DROP TRIGGER IF EXISTS "UsageEvent_legacy_writer_purpose" ON "UsageEvent";

-- The preparation gate keeps its PDF and Workspace rules: a preparing run waits at a durable gate, a PDF run starts only
-- with every document ready (or kept as the original for a Workspace run), and a run waiting for a Workspace hand-off
-- has its follow-up waiting or preparing. A Memory attempt no longer counts as a gate; the rules are those of
-- `20260915173500_workspace_followup_preparation_gate` with no live attempt, which is what every admission of this
-- release writes, so its runs keep passing exactly as before. Error codes are unchanged.
CREATE FUNCTION aiqsa_assert_run_preparation_gate(p_run_id text)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  run_status "ModelRunStatus";
  workspace_pending boolean;
  workspace_state text;
  pdf_state text;
  pending_pdf_count integer;
  pdf_count integer;
BEGIN
  SELECT "status", "workspaceWaitPending" INTO run_status, workspace_pending
    FROM "ModelRun" WHERE "id" = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT "state" INTO workspace_state FROM "WorkspaceFollowup"
    WHERE "modelRunId" = p_run_id AND "snapshot" IS NOT NULL AND "admissionResult" IS NOT NULL;
  IF workspace_pending AND run_status = 'preparing' AND COALESCE(workspace_state, '') NOT IN ('waiting', 'preparing') THEN
    RAISE EXCEPTION 'workspace_followup_preparation_gate_invalid' USING ERRCODE = '23514';
  END IF;
  SELECT "state" INTO pdf_state FROM "ChatPdfRunPreparation" WHERE "modelRunId" = p_run_id;
  IF pdf_state IN ('pending', 'preparing', 'answer_ready') THEN
    SELECT count(*), count(*) FILTER (WHERE NOT ("state" = 'ready' OR
      "state" = 'original_only' AND EXISTS (SELECT 1 FROM "WorkspaceRunBinding" w WHERE w."modelRunId" = p_run_id)))
      INTO pdf_count, pending_pdf_count FROM "ChatPdfAttachmentPreparation" WHERE "modelRunId" = p_run_id;
    IF pdf_count = 0 OR
      (run_status = 'preparing' AND pdf_state = 'answer_ready') OR
      (run_status <> 'preparing' AND (pdf_state <> 'answer_ready' OR pending_pdf_count <> 0)) THEN
      RAISE EXCEPTION 'chat_pdf_preparation_gate_invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF run_status = 'preparing' AND NOT (workspace_pending OR COALESCE(workspace_state, '') = 'preparing') THEN
    RAISE EXCEPTION 'preparing_run_requires_durable_gate' USING ERRCODE = '23514';
  END IF;
END
$function$;

CREATE FUNCTION aiqsa_run_preparation_gate_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_TABLE_NAME = 'ModelRun' THEN
    PERFORM aiqsa_assert_run_preparation_gate(NEW."id");
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_assert_run_preparation_gate(NEW."modelRunId");
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_assert_run_preparation_gate(OLD."modelRunId");
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS "ModelRun_memory_preparation_guard" ON "ModelRun";
DROP TRIGGER IF EXISTS "ChatPdfRunPreparation_memory_gate" ON "ChatPdfRunPreparation";
DROP TRIGGER IF EXISTS "ChatPdfAttachmentPreparation_memory_gate" ON "ChatPdfAttachmentPreparation";
DROP TRIGGER IF EXISTS "WorkspaceFollowup_memory_gate" ON "WorkspaceFollowup";
CREATE CONSTRAINT TRIGGER "ModelRun_preparation_gate"
  AFTER INSERT OR UPDATE ON "ModelRun" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_run_preparation_gate_trigger();
CREATE CONSTRAINT TRIGGER "ChatPdfRunPreparation_preparation_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatPdfRunPreparation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_run_preparation_gate_trigger();
CREATE CONSTRAINT TRIGGER "ChatPdfAttachmentPreparation_preparation_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatPdfAttachmentPreparation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_run_preparation_gate_trigger();
CREATE CONSTRAINT TRIGGER "WorkspaceFollowup_preparation_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "WorkspaceFollowup" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_run_preparation_gate_trigger();

-- A Temporary chat is deleted only once its retention deadline has passed; the claimed outbox row of the previous
-- release's worker goes with the outbox. Deadlines are UTC timestamps without a zone.
CREATE OR REPLACE FUNCTION aiqsa_temporary_chat_delete_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."memoryMode" = 'TEMPORARY'
     AND NOT (
       OLD."temporaryRetentionDeadline" IS NOT NULL
       AND OLD."temporaryRetentionDeadline" <= (clock_timestamp() AT TIME ZONE 'UTC')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary chat is deleted only after its retention deadline';
  END IF;
  RETURN OLD;
END
$function$;

-- Columns only the old subsystem used. A check naming a dropped column would go with it silently, so each such check
-- is dropped first and added back without it; neither can refuse an existing row, since each only loosens: the usage
-- shape loses its execution-binding branch, which the plain shape (no Knowledge columns) covers, and the chat keeps
-- its Memory mode and Temporary shape without the two counters.
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_knowledge_shape_check",
  DROP CONSTRAINT "UsageEvent_memory_execution_fkey",
  DROP COLUMN "memoryExecutionBindingId";
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
  (NOT "visionAnalysis" AND "visionAnalysisAttemptId" IS NULL AND (

  (NOT "optionalDecision" AND (
  (NOT "knowledgeRelevance" AND (
  (NOT "mcpHubDiscovery" AND (
    (NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL AND (
    (NOT "imageGeneration" AND "imageToolCallId" IS NULL AND (
    (NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL AND (
    (
      "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    OR (
      "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NOT NULL
      AND "knowledgeIndexGenerationId" IS NOT NULL
      AND "knowledgeDocumentVersionId" IS NOT NULL
      AND "knowledgeBatchIndex" >= 0
      AND "knowledgePdfProcessingAttemptId" IS NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    OR (
      "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NOT NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    )) OR (
      "chatPdfPreparation" AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    )) OR (
      "imageGeneration" AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    )) OR (
      "chatTitleGeneration" AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
      AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL AND "projectId" IS NULL
    )
  )) OR (
    "mcpHubDiscovery" AND "providerModelId" IS NOT NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
    AND "chatId" IS NULL AND "modelRunId" IS NULL AND "projectId" IS NULL
  )
)) OR (
    "knowledgeRelevance" AND "providerModelId" IS NOT NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "mcpHubDiscovery" AND "mcpHubDiscoveryAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
  )
)) OR (
    "optionalDecision" AND "providerModelId" IS NOT NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "knowledgeRelevance" AND "knowledgeRelevanceAttemptId" IS NULL
    AND NOT "mcpHubDiscovery" AND "mcpHubDiscoveryAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
  )
  )) OR (
    "visionAnalysis" AND "providerModelId" IS NOT NULL
    AND "knowledgeBaseId" IS NULL AND "knowledgeIndexGenerationId" IS NULL
    AND "knowledgeDocumentVersionId" IS NULL AND "knowledgeBatchIndex" IS NULL
    AND "knowledgePdfProcessingAttemptId" IS NULL
    AND NOT "optionalDecision" AND "optionalDecisionAttemptId" IS NULL
    AND NOT "knowledgeRelevance" AND "knowledgeRelevanceAttemptId" IS NULL
    AND NOT "mcpHubDiscovery" AND "mcpHubDiscoveryAttemptId" IS NULL
    AND NOT "chatTitleGeneration" AND "chatTitleGenerationId" IS NULL
    AND NOT "imageGeneration" AND "imageToolCallId" IS NULL
    AND NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL
  )
);

ALTER TABLE "Chat"
  DROP CONSTRAINT "Chat_memory_state_check",
  DROP COLUMN "memoryBranchGeneration",
  DROP COLUMN "memorySourceRevision";
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_memory_state_check" CHECK (
  "memoryMode" IN ('NORMAL', 'EXCLUDED')
    AND "temporaryRetentionPolicyVersion" IS NULL AND "temporaryRetentionDeadline" IS NULL
  OR "memoryMode" = 'TEMPORARY'
    AND "temporaryRetentionPolicyVersion" IS NOT NULL AND "temporaryRetentionPolicyVersion" = 'temporary-24h-v1'
    AND "temporaryRetentionDeadline" IS NOT NULL AND "temporaryRetentionDeadline" > "createdAt"
);

ALTER TABLE "WorkspaceFollowup"
  DROP CONSTRAINT "WorkspaceFollowup_source_revision_check",
  DROP COLUMN "sourceRevisionAdvance";

-- The old coordinator's job and deletion cursors; attachment processing keeps its own.
DELETE FROM "DocumentProcessingFairnessCursor" WHERE "pipeline" IN ('memory-job', 'memory-delete');
ALTER TABLE "DocumentProcessingFairnessCursor" DROP CONSTRAINT "DocumentProcessingFairnessCursor_pipeline_check";
ALTER TABLE "DocumentProcessingFairnessCursor" ADD CONSTRAINT "DocumentProcessingFairnessCursor_pipeline_check"
  CHECK ("pipeline" IN ('attachment', 'knowledge'));

-- The tables, with their rows, indexes, sequences, checks, triggers and foreign keys. Without CASCADE: anything that
-- stays and still depends on one is a missed dependency and fails the migration.
DO $migration$
DECLARE
  retired text;
BEGIN
  SELECT string_agg(format('%I', retired_table."name"), ', ' ORDER BY retired_table."name")
  INTO retired
  FROM "aiqsa_retired_memory_table" AS retired_table;
  EXECUTE format('DROP TABLE %s', retired);
END;
$migration$;

-- A trigger still calling one of the routines on a table that stays would be a missed dependency, so it fails the
-- migration instead of being dropped; so does a listed routine that is missing.
DO $migration$
DECLARE
  routine record;
  stray text;
  missing text;
BEGIN
  SELECT string_agg(retired_routine."name", ', ' ORDER BY retired_routine."name")
  INTO missing
  FROM "aiqsa_retired_memory_routine" AS retired_routine
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc AS procedure_row
    JOIN pg_namespace AS namespace ON namespace.oid = procedure_row.pronamespace
    WHERE namespace.nspname = current_schema() AND procedure_row.proname = retired_routine."name");
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'retired_memory_routine_missing: %', missing;
  END IF;
  FOR routine IN
    SELECT procedure_row.oid, procedure_row.oid::regprocedure AS signature
    FROM pg_proc AS procedure_row
    JOIN pg_namespace AS namespace ON namespace.oid = procedure_row.pronamespace
    JOIN "aiqsa_retired_memory_routine" AS retired_routine ON retired_routine."name" = procedure_row.proname
    WHERE namespace.nspname = current_schema() AND procedure_row.prokind = 'f'
    ORDER BY procedure_row.proname, procedure_row.oid
  LOOP
    SELECT string_agg(format('%I on %s', trigger_row.tgname, trigger_row.tgrelid::regclass), ', ')
    INTO stray
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = routine.oid AND NOT trigger_row.tgisinternal;
    IF stray IS NOT NULL THEN
      RAISE EXCEPTION 'retired_memory_routine_still_triggered: % (%)', routine.signature, stray;
    END IF;
    EXECUTE format('DROP FUNCTION %s', routine.signature);
  END LOOP;
END;
$migration$;

-- The enums only the dropped tables and routines used. MemoryChatMode stays with the chat's Memory mode, and the
-- memory note's enums with it.
DROP TYPE
  "MemoryActorType", "MemoryCandidateDecisionState", "MemoryCandidateState",
  "MemoryCommandOperation", "MemoryCommandStatus", "MemoryConsolidationOperation",
  "MemoryCoreSalience", "MemoryDeletionOperation", "MemoryDeletionState",
  "MemoryDerivedSafetyClass", "MemoryDirectness", "MemoryEmbeddingBatchItemState",
  "MemoryEmbeddingState", "MemoryEntityAliasSupportKind", "MemoryEntityLinkRole",
  "MemoryEntityState", "MemoryEventOperation", "MemoryEvidenceSourceType",
  "MemoryEvidenceStance", "MemoryExecutionOwnerType", "MemoryExecutionState",
  "MemoryFactExtractionCandidateOutcome", "MemoryFactIdentityKind", "MemoryFactModality",
  "MemoryFactSourceMode", "MemoryFactState", "MemoryFactVersionRelationKind",
  "MemoryFactVersionState", "MemoryFeedbackTargetKind", "MemoryFeedbackType",
  "MemoryHistoryCheckpointStatus", "MemoryHistoryItemState", "MemoryHistoryRunOutcome",
  "MemoryHistoryRunState", "MemoryIndexGenerationState", "MemoryIndexMode",
  "MemoryJobKind", "MemoryJobState", "MemoryMutationAction",
  "MemoryOperationOutcome", "MemoryPauseScope", "MemoryReceiptOutcome",
  "MemoryReceiptRetentionState", "MemoryRedactionState", "MemoryRetrievalAdmissionKind",
  "MemoryRetrievalAttemptState", "MemorySafetyClassificationState", "MemoryScopeState",
  "MemoryScopeType", "MemorySearchItemType", "MemorySensitiveAutomaticPolicy",
  "MemorySensitivityClass", "MemorySourceBarrierKind", "MemorySourceDependencyKind",
  "MemorySuppressionScope", "MemoryTemperatureClass", "MemoryToolEventOutcome",
  "MemoryUsageCompleteness", "MemoryUtilityAssignmentSource", "MemoryUtilityEgressMode";

-- Runs the previous release left preparing for Memory end as interrupted, as the run repository's recovery terminal
-- path ends a run (`failRun` with `recoveryTerminal`, the preparing branch of `settlePreparingRunInTransaction`): the
-- run errors with an empty request and the recovery marker, its answer errors with the same message, and its chat moves
-- up the list, a Temporary chat a day past now. A run waiting at its PDF or Workspace gate keeps waiting for it. The
-- past-chat index needs no mark: an interrupted answer has no text, and the backfill reaches chats without a state row.
DO $migration$
DECLARE
  interrupted integer;
BEGIN
  WITH stuck AS (
    SELECT run."id"
    FROM "ModelRun" AS run
    WHERE run."status" = 'preparing'
      AND NOT run."workspaceWaitPending"
      AND NOT EXISTS (
        SELECT 1 FROM "ChatPdfRunPreparation" AS pdf
        WHERE pdf."modelRunId" = run."id" AND pdf."state" IN ('pending', 'preparing', 'answer_ready'))
      AND NOT EXISTS (
        SELECT 1 FROM "WorkspaceFollowup" AS followup
        WHERE followup."modelRunId" = run."id" AND followup."state" IN ('waiting', 'preparing'))
  ), runs AS (
    UPDATE "ModelRun" AS run
    SET "status" = 'error',
      "normalizedRequest" = '{}'::jsonb,
      "errorPayload" = jsonb_build_object(
        'code', 'run_interrupted',
        'message', 'This answer was interrupted when the server restarted. Its work so far is kept; use Continue to pick it up.',
        'recoveryTerminal', true),
      "updatedAt" = CURRENT_TIMESTAMP
    FROM stuck
    WHERE run."id" = stuck."id"
    RETURNING run."id", run."userId", run."chatId", run."assistantMessageId"
  ), answers AS (
    UPDATE "Message" AS message
    SET "status" = 'error',
      "errorMessage" = 'This answer was interrupted when the server restarted. Its work so far is kept; use Continue to pick it up.',
      "updatedAt" = CURRENT_TIMESTAMP
    FROM runs
    WHERE message."id" = runs."assistantMessageId" AND message."chatId" = runs."chatId"
      AND message."status" IN ('queued', 'streaming')
    RETURNING message."id"
  ), chats AS (
    UPDATE "Chat" AS chat
    SET "updatedAt" = CURRENT_TIMESTAMP,
      "temporaryRetentionDeadline" = CASE
        WHEN chat."memoryMode" = 'TEMPORARY' THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '24 hours'
        ELSE chat."temporaryRetentionDeadline"
      END
    WHERE chat."permanentDeletionAt" IS NULL
      AND EXISTS (SELECT 1 FROM runs WHERE runs."chatId" = chat."id" AND runs."userId" = chat."userId")
    RETURNING chat."id"
  )
  SELECT count(*) INTO interrupted FROM runs;
  IF interrupted > 0 THEN
    RAISE WARNING 'memory_preparing_runs_interrupted count=%', interrupted;
  END IF;
END;
$migration$;

-- Nothing that stays may still name what went: a routine or constraint naming a dropped table, enum or column, or
-- calling a dropped routine, would fail on its next use, so it fails the migration here instead. The names that stay
-- are the chat's Memory mode (MemoryChatMode) and the memory note's tables and enums. The catalog query that proves no
-- object named after the old subsystem is left is the migration contract's (`prisma/scripts/tests/drop-old-memory-adoption.ts`).
DO $migration$
DECLARE
  missed text;
BEGIN
  WITH kept_name(name) AS (
    VALUES ('MemoryChatMode'), ('UserMemoryNote'), ('MemoryNoteOffer'), ('MemoryLegacySuggestion'), ('MemoryNoteAuthor'),
      ('MemoryNoteOperation'), ('MemoryNoteOfferState'), ('MemoryLegacySuggestionOrigin')
  ), found AS (
    SELECT 'routine ' || routine.oid::regprocedure::text AS item
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = current_schema()
      AND (routine.prosrc ~ '"(memoryExecutionBindingId|memoryBranchGeneration|memorySourceRevision|sourceRevisionAdvance)"'
        OR EXISTS (
          SELECT 1 FROM regexp_matches(routine.prosrc, '"((ChatMemory|ModelRunMemory|UserMemory|Memory)[A-Za-z]*)"', 'g')
            AS named(parts)
          WHERE named.parts[1] NOT IN (SELECT name FROM kept_name))
        OR EXISTS (
          SELECT 1 FROM "aiqsa_retired_memory_routine" AS retired_routine
          WHERE strpos(routine.prosrc, retired_routine."name") > 0))
    UNION ALL
    SELECT 'constraint ' || relation.relname || '.' || constraint_row.conname
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND (pg_get_constraintdef(constraint_row.oid)
          ~ '''memory-(job|delete)''|"(memoryExecutionBindingId|memoryBranchGeneration|memorySourceRevision)"'
        OR EXISTS (
          SELECT 1 FROM regexp_matches(pg_get_constraintdef(constraint_row.oid),
            '"((ChatMemory|ModelRunMemory|UserMemory|Memory)[A-Za-z]*)"', 'g') AS named(parts)
          WHERE named.parts[1] NOT IN (SELECT name FROM kept_name)))
  )
  SELECT string_agg(item, ', ' ORDER BY item) INTO missed FROM found;
  IF missed IS NOT NULL THEN
    RAISE EXCEPTION 'retired_memory_dependency_left: %', missed;
  END IF;
END;
$migration$;
