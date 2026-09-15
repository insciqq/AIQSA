-- Workspace waiting precedes document/Memory preparation. Keep the existing
-- gates strict while recognizing their durable upstream owner.
CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_run_preparation(p_run_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run_status "ModelRunStatus";
  workspace_pending boolean;
  workspace_state text;
  live_attempt_count integer;
  pdf_state text;
  pending_pdf_count integer;
  pdf_count integer;
BEGIN
  SELECT "status", "workspaceWaitPending" INTO run_status, workspace_pending
    FROM "ModelRun" WHERE "id" = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO live_attempt_count FROM "MemoryRetrievalAttempt"
    WHERE "modelRunId" = p_run_id AND "state" IN ('PENDING','EXECUTING','READY');
  SELECT "state" INTO workspace_state FROM "WorkspaceFollowup"
    WHERE "modelRunId" = p_run_id AND "snapshot" IS NOT NULL AND "admissionResult" IS NOT NULL;
  IF workspace_pending AND run_status = 'preparing' AND (live_attempt_count <> 0 OR
      COALESCE(workspace_state, '') NOT IN ('waiting','preparing')) THEN
    RAISE EXCEPTION 'workspace_followup_preparation_gate_invalid' USING ERRCODE = '23514';
  END IF;
  SELECT "state" INTO pdf_state FROM "ChatPdfRunPreparation" WHERE "modelRunId" = p_run_id;
  IF pdf_state IN ('pending','preparing','answer_ready') THEN
    SELECT count(*), count(*) FILTER (WHERE NOT ("state" = 'ready' OR
      "state" = 'original_only' AND EXISTS (SELECT 1 FROM "WorkspaceRunBinding" w WHERE w."modelRunId" = p_run_id)))
      INTO pdf_count, pending_pdf_count FROM "ChatPdfAttachmentPreparation" WHERE "modelRunId" = p_run_id;
    IF pdf_count = 0 OR live_attempt_count > 1 OR
      (pending_pdf_count > 0 AND live_attempt_count <> 0) OR
      (run_status = 'preparing' AND pdf_state = 'answer_ready') OR
      (run_status <> 'preparing' AND (pdf_state <> 'answer_ready' OR pending_pdf_count <> 0 OR live_attempt_count <> 0)) THEN
      RAISE EXCEPTION 'chat_pdf_preparation_gate_invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF run_status = 'preparing' AND (live_attempt_count > 1 OR
    live_attempt_count = 0 AND NOT (workspace_pending OR COALESCE(workspace_state, '') = 'preparing')) THEN
    RAISE EXCEPTION 'preparing_run_requires_durable_gate' USING ERRCODE = '23514';
  ELSIF run_status <> 'preparing' AND live_attempt_count <> 0 THEN
    RAISE EXCEPTION 'dispatchable_run_has_live_memory_gate' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE CONSTRAINT TRIGGER "WorkspaceFollowup_memory_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "WorkspaceFollowup" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();
