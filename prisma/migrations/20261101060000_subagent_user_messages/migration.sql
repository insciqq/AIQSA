-- User speech addressed to a sub-agent stays in that turn's mailbox above the run's own revision.
ALTER TABLE "RunFollowup" DROP CONSTRAINT "RunFollowup_subagent_turn_check",
  ADD CONSTRAINT "RunFollowup_subagent_turn_check" CHECK (
    ("origin" <> 'subagent_callback' OR "subagentTurnId" IS NOT NULL) AND
    ("origin" <> 'user' OR "subagentTurnId" IS NULL OR "ordinal" > 96)
  ) NOT VALID;
