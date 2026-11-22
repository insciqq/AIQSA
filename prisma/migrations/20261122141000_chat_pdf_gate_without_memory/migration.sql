-- A run's answer no longer waits for a Personal Memory preparation (operator decision 2026-11-22: Memory is replaced
-- by the note and past-chat search). Admission creates no Memory attempt or binding, so the document gate's old
-- condition, that a retained chat's prepared run had its Memory binding before its answer, would refuse every PDF
-- answer outside a Temporary chat once its documents are ready (`chat_pdf_memory_not_ready`).
--
-- The gate keeps its document check: an answer starts only when every prepared document is ready, or kept as the
-- original for a run with a Workspace. The Memory condition goes; the rest of the function is unchanged from
-- `20260905120000_workspace_pdf_original_only`. Replacing a function tolerates a repeated deploy.
CREATE OR REPLACE FUNCTION chat_pdf_answer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('queued','streaming','in_progress') AND EXISTS (
    SELECT 1 FROM "ChatPdfAttachmentPreparation" p WHERE p."modelRunId" = NEW."id"
      AND p."route" <> 'direct_pdf' AND NOT (p."state" = 'ready' OR
        p."state" = 'original_only' AND EXISTS (
          SELECT 1 FROM "WorkspaceRunBinding" w WHERE w."modelRunId" = NEW."id"))
  ) THEN RAISE EXCEPTION 'chat_pdf_answer_not_ready' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
