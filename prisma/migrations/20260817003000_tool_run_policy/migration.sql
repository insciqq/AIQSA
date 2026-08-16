ALTER TABLE "ModelPolicy"
  ADD COLUMN "maxToolCalls" BIGINT NOT NULL DEFAULT 20,
  ADD COLUMN "maxToolRounds" BIGINT NOT NULL DEFAULT 8;

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_tool_budgets_check"
  CHECK (
    "maxToolCalls" > 0
    AND "maxToolCalls" <= 9007199254740991
    AND "maxToolRounds" > 0
    AND "maxToolRounds" <= 9007199254740991
  );
