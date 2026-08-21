-- Personal Memory v1 keeps Project Memory rows/code dormant. Existing values
-- are preserved, while newly created Projects cannot opt in implicitly.
ALTER TABLE "Project"
  ALTER COLUMN "memoryEnabled" SET DEFAULT false;
