-- PostgreSQL requires a newly added enum value to be committed before it is
-- referenced by constraints or functions. Keep this migration deliberately
-- separate from the entity-authority migration that follows it.

ALTER TYPE "MemoryEntityState" ADD VALUE 'RETRACTED' AFTER 'MERGED';
