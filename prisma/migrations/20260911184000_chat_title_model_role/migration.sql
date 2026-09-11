ALTER TABLE "SystemModelPolicy"
    ADD COLUMN "chatTitleProviderModelId" TEXT,
    ADD COLUMN "chatTitleReasoningEffort" VARCHAR(32);

-- Copy existing installations once. Fresh policies and explicit later clears
-- stay unassigned; bootstrap never couples the two roles again.
UPDATE "SystemModelPolicy"
SET "chatTitleProviderModelId" = "providerModelId",
    "chatTitleReasoningEffort" = "reasoningEffort"
WHERE "providerModelId" IS NOT NULL;

CREATE INDEX "SystemModelPolicy_chatTitleProviderModelId_idx" ON "SystemModelPolicy"("chatTitleProviderModelId");
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_chatTitleProviderModelId_fkey"
    FOREIGN KEY ("chatTitleProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
