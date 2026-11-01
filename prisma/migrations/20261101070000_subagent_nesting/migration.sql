-- A sub-agent may start children of its own, one level deep (operator decision
-- 2026-10-31, `agent_docs/RUN_CONTRACTS.md`). A thread names the sub-agent that
-- started it; null is the main agent, as every existing thread is. Expand only:
-- a nullable column changes only the catalog, the rows of a previous release's
-- writers stay null, and with every value null the foreign key finds nothing to
-- check. The composite key keeps a child in its parent's chat and owner, and a
-- child goes with its parent, whose anchor is on the same branch.
ALTER TABLE "SubagentThread" ADD COLUMN "parentThreadId" TEXT,
  ADD CONSTRAINT "SubagentThread_parent_check" CHECK ("parentThreadId" IS DISTINCT FROM "id");

-- AddForeignKey
ALTER TABLE "SubagentThread" ADD CONSTRAINT "SubagentThread_parentThread_fkey"
  FOREIGN KEY ("userId", "chatId", "parentThreadId") REFERENCES "SubagentThread"("userId", "chatId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- CreateIndex
CREATE INDEX "SubagentThread_userId_chatId_parentThreadId_idx" ON "SubagentThread"("userId", "chatId", "parentThreadId");
