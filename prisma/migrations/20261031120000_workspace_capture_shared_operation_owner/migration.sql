-- One Workspace session now serves every attached run of a chat (20261030010000_workspace_run_attachments), and all of
-- them work under the fence token of the run that claimed the session. A capture therefore records that token as its
-- producer, which is not always the capturing run's own: an attached run's `view_workspace_image` and output captures
-- failed this check. The producer stays a run's operation; the capturing run is the row's "modelRunId".
-- NOT VALID keeps the exchange free of a table scan under its lock; 20261031120100 validates it, and every existing row
-- satisfies the wider check.
ALTER TABLE "WorkspaceSelectedCapture" DROP CONSTRAINT "WorkspaceSelectedCapture_identity_check";
ALTER TABLE "WorkspaceSelectedCapture" ADD CONSTRAINT "WorkspaceSelectedCapture_identity_check" CHECK (
  "id" ~ '^[a-f0-9]{32}$' AND "requestHash" ~ '^[a-f0-9]{64}$' AND "producerGeneration" > 0
  AND length("runtimeSandboxId") BETWEEN 1 AND 256 AND length("requestKey") > 0
  AND "producerOwner" LIKE 'run:_%'
  AND jsonb_typeof("selection") = 'object'
  AND "selection" ? 'files' AND "selection" ? 'producerOperation'
  AND jsonb_typeof("selection"->'files') = 'array'
  AND jsonb_array_length("selection"->'files') BETWEEN 1 AND 100
  AND "selection"->'producerOperation' = jsonb_build_object('generation', "producerGeneration", 'owner', "producerOwner")
) NOT VALID;
