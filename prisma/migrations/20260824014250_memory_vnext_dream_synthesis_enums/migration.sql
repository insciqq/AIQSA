-- PostgreSQL requires newly added enum values to be committed before later
-- statements can use them in constraints, indexes, or function bodies.

ALTER TYPE "MemoryFactModality" ADD VALUE 'PATTERN';
ALTER TYPE "MemoryEventOperation" ADD VALUE 'SYNTHESIZE';
ALTER TYPE "MemoryJobKind" ADD VALUE 'SYNTHESIZE_MEMORIES';
