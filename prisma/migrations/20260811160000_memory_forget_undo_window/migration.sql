-- A cancelled row preserves the durable identity of a purge obligation that
-- was explicitly undone before its claim deadline.
ALTER TYPE "MemoryDeletionState" ADD VALUE 'CANCELLED';
