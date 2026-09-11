-- Keep the previous writer's label readable during a stable rolling update.
-- Commit the enum addition before the following migration references it.
ALTER TYPE "MemoryJobState" ADD VALUE 'WAITING_FOR_CONFIGURATION';
