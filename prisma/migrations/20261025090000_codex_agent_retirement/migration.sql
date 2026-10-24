-- The Codex Agent is removed (operator decision 2026-10-23). Its per-run
-- bindings, provider attempts, admitted MCP tool snapshots and installation
-- limits have no reader left: an answer it produced renders from its message,
-- its run's Workspace activity events and its outputs, and recovery ends a turn
-- it left running from that run's accepted request alone, never replaying it.
-- Usage such a turn had reported only in its attempts goes with them.
-- `McpToolApprovalSource.agent`, `TelegramCallbackKind.toggle_agent` and
-- `TelegramLink.agentEnabled` stay: old approval cards and buttons still name
-- them, and the previous release still selects the column.
--
-- The releases since the Agent's removal (0.4.0) never read or write these
-- tables at run time; only their installation bootstrap still creates the
-- Agent policy row, and an upgrade runs bootstrap from the new image. Nothing
-- else depends on the dropped tables.
--
-- Dropping a table removes its foreign key triggers from every table it
-- references under an exclusive lock, after locking the dropped tables, while a
-- previous-release writer locks a referenced table before its cascade reaches a
-- dropped one. Every lock is therefore taken up front, referenced tables first,
-- and a deadlock retries instead of failing the upgrade.
DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "User", "ProviderRunBinding", "WorkspaceRunBinding",
        "AgentRunBinding", "AgentProviderAttempt", "AgentMcpTool", "AgentPolicy" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

DROP TABLE "AgentMcpTool", "AgentProviderAttempt", "AgentRunBinding", "AgentPolicy";

DROP TYPE "AgentAttemptState";
