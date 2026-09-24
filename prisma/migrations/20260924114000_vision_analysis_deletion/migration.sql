-- Run deletion cascades through tool calls and provider bindings in either order.
-- Keep bindings restrictive while an analysis survives the transaction.
ALTER TABLE "VisionAnalysisAttempt"
  ALTER CONSTRAINT "VisionAnalysisAttempt_binding_fkey" DEFERRABLE INITIALLY DEFERRED;
