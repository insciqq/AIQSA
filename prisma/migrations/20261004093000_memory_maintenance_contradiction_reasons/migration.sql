-- Policy v4 also settles contradictions between a reviewed automatic fact and
-- another current fact of its owner, with two more closed, content-free
-- reasons: contradicted on a REMOVED or REJECTED review, and
-- conflict_unresolved on a keep whose verified contradiction left both facts
-- current. Such a keep keeps its normal usefulness label, so unlike
-- unresolved_scope it admits DURABLE and ONGOING. The shape check already
-- admits these rows. Expand only: previous-release writers keep settling
-- without these reasons during Compose replacement, and existing rows already
-- satisfy the wider check.
ALTER TABLE "MemoryMaintenanceReview" DROP CONSTRAINT "MemoryMaintenanceReview_reason_check";
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_reason_check" CHECK (
  "reasonCode" IS NULL
  OR ("disposition" = 'BLOCKED'
    AND "reasonCode" IN ('pending_relation', 'evidence_without_offsets', 'source_changed'))
  OR ("disposition" = 'UNREVIEWABLE'
    AND "reasonCode" IN ('unreviewable_context', 'statement_too_long', 'evidence_not_current'))
  OR ("disposition" IN ('REMOVED', 'REJECTED')
    AND "reasonCode" IN ('episode', 'short_term', 'not_distinctive', 'one_off_task_detail', 'context_dependent_fragment',
      'contradicted'))
  OR ("disposition" = 'KEEP' AND "usefulness" IS NULL AND "reasonCode" = 'unresolved_scope')
  OR ("disposition" = 'KEEP' AND ("usefulness" IS NULL OR "usefulness" IN ('DURABLE', 'ONGOING'))
    AND "reasonCode" = 'conflict_unresolved')
);
