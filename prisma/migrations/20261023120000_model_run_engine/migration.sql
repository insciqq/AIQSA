-- The old run core and the native agent engine share this database until the
-- switch. A run records the engine that executes it, so each engine's recovery
-- and background claims touch only its own runs. Previous writers omit the
-- column and keep creating old-core runs through the default; the native
-- engine always writes its value. The one-active-run-per-chat index stays
-- engine-agnostic. A constant default changes only the catalog: no rewrite.
CREATE TYPE "ModelRunEngine" AS ENUM ('v1', 'native');

ALTER TABLE "ModelRun" ADD COLUMN "engine" "ModelRunEngine" NOT NULL DEFAULT 'v1';
