-- Content-free reason why a received structured answer was rejected (the
-- shared transport decoder's reason or a Memory role decoder's closed
-- violation). errorCode keeps its existing values. Expand only: the column is
-- nullable and previous-release writers leave it NULL during Compose
-- replacement. The application owns the closed vocabulary; the database keeps
-- every value a bounded lowercase code on a FAILED settlement.
ALTER TABLE "MemoryExecutionBinding" ADD COLUMN "decodeReason" VARCHAR(64);
ALTER TABLE "MemoryExecutionBinding" ADD CONSTRAINT "MemoryExecutionBinding_decode_reason_check" CHECK (
  "decodeReason" IS NULL
  OR ("state" = 'FAILED'::"MemoryExecutionState" AND "decodeReason" ~ '^[a-z][a-z0-9_]{0,63}$')
);
