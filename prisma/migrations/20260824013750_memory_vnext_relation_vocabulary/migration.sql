-- PostgreSQL requires ALTER TYPE additions to commit before a later
-- transaction may use the new values in constraints, triggers, or indexes.

CREATE TYPE "MemoryFactVersionRelationKind" AS ENUM (
  'DUPLICATE_OF',
  'ENRICHES',
  'MERGED_INTO',
  'SYNTHESIZED_FROM',
  'MOVED_FROM'
);

ALTER TYPE "MemoryFactVersionState" ADD VALUE 'MERGED' AFTER 'ORPHANED';
ALTER TYPE "MemoryEventOperation" ADD VALUE 'MERGE' AFTER 'REINFORCE';
ALTER TYPE "MemoryJobKind" ADD VALUE 'RESOLVE_FACT_RELATIONS' AFTER 'RECLASSIFY_FACTS';
