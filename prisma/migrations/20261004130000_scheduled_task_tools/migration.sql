-- Scheduled task tools: the task's tool and Workspace switches, its streak of
-- runs that completed without a relevant source, and each occurrence's frozen
-- source health. Defaulted and nullable columns only: existing tasks keep
-- running without tools, and previous-release writers never touch them.
ALTER TABLE "ScheduledTask"
  ADD COLUMN "toolsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "workspaceEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveIncompleteRuns" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "ScheduledTask_incomplete_runs_check" CHECK ("consecutiveIncompleteRuns" >= 0);

-- A non-empty bounded list, or null when no relevant source was missing.
ALTER TABLE "ScheduledTaskOccurrence"
  ADD COLUMN "unavailableSources" JSONB,
  ADD CONSTRAINT "ScheduledTaskOccurrence_unavailable_sources_check" CHECK (
    "unavailableSources" IS NULL OR (
      jsonb_typeof("unavailableSources") = 'array' AND jsonb_array_length("unavailableSources") BETWEEN 1 AND 64
    )
  );
