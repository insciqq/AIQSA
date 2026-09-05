BEGIN;
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "chatPdfProviderModelId" text,
  ADD COLUMN "chatPdfReasoningEffort" varchar(32);

-- Preserve the explicitly enabled PDF route, without letting future Memory
-- changes silently select a new document destination. Accepted snapshots stay.
UPDATE "SystemModelPolicy" SET
  "chatPdfProviderModelId" = "providerModelId",
  "chatPdfReasoningEffort" = "reasoningEffort"
WHERE "chatPdfPreparationAllowed";

ALTER TABLE "SystemModelPolicy"
  ADD CONSTRAINT "SystemModelPolicy_chatPdfProviderModelId_fkey"
    FOREIGN KEY ("chatPdfProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SystemModelPolicy_chat_pdf_reasoning_target_check"
    CHECK ("chatPdfProviderModelId" IS NOT NULL OR "chatPdfReasoningEffort" IS NULL),
  ADD CONSTRAINT "SystemModelPolicy_chat_pdf_reasoning_check"
    CHECK ("chatPdfReasoningEffort" IS NULL OR (
      length("chatPdfReasoningEffort") BETWEEN 1 AND 32
      AND btrim("chatPdfReasoningEffort") = "chatPdfReasoningEffort"
      AND "chatPdfReasoningEffort" !~ '[[:cntrl:]]'));
CREATE INDEX "SystemModelPolicy_chatPdfProviderModelId_idx" ON "SystemModelPolicy"("chatPdfProviderModelId");

DO $migration$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('chat_pdf_preparation_guard()'::regprocedure);
  IF position('p."providerModelId" = NEW."providerModelId"' IN definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected chat PDF policy guard';
  END IF;
  EXECUTE replace(definition, 'p."providerModelId" = NEW."providerModelId"',
    'p."chatPdfProviderModelId" = NEW."providerModelId"');
END;
$migration$;
COMMIT;
