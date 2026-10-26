-- Per-answer tool call and round limits are off by default for everyone,
-- existing installations included, even limits an administrator typed
-- (operator decision 2026-10-26): an answer ends at its time limit, at Stop
-- or at a repeated call instead. Every row, new or existing, starts off; an
-- administrator turns the limits back on, and the saved numbers stay the
-- limits that then apply. The numbers keep their columns and checks, so the
-- previous release reads valid limits while Compose replaces its containers.
-- Accepted runs keep the budgets frozen in their request.
ALTER TABLE "ModelPolicy" ADD COLUMN "toolLimitsEnabled" BOOLEAN NOT NULL DEFAULT false;
