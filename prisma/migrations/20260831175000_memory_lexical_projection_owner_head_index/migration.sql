-- Claiming is owner-ordered: a later event is eligible only when no earlier
-- outstanding event exists for that owner. Keep the anti-join bounded to the
-- small outstanding set instead of repeatedly scanning succeeded history.
CREATE INDEX "MemoryLexicalProjectionEvent_owner_outstanding_sequence_idx"
  ON "MemoryLexicalProjectionEvent"("userId", "sequence")
  WHERE "state" <> 'SUCCEEDED'::"MemoryLexicalProjectionEventState";
