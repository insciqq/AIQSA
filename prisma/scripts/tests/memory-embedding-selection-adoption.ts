/** Synthetic predecessor rows in the migration runner's disposable database. */
export const MEMORY_EMBEDDING_SELECTION_BACKFILL_MIGRATION =
  "20261006140001_memory_embedding_selection_resolved_backfill";

const model = "memory-embedding-selection-model";
// Settings revision x stored embedding. Revision 1 without one is the owner
// cohort that the 2026-09-11 default-on migration bumped.
const owners = [0, 1, 2].flatMap((revision) => [false, true].map((selected) => ({
  id: `memory-embedding-selection-${revision}-${selected ? "set" : "unset"}`,
  revision,
  selected
})));
const ids = (selected: boolean) => owners.filter((owner) => owner.selected === selected)
  .map(({ id }) => `'${id}'`).join(", ");

export const memoryEmbeddingSelectionFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('memory-embedding-selection-provider', 'Synthetic provider', 'fake', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities, "defaultParams", "updatedAt")
VALUES ('${model}', 'memory-embedding-selection-provider', 'fake', 'fixture', 'Synthetic embedding', 'embedding', '{}', '{}', now());
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
${owners.map(({ id }) => `('${id}', 'Synthetic owner', 'active', now())`).join(",\n")};
${owners.map(({ id, revision, selected }) => `UPDATE "UserMemorySettings" SET "settingsRevision" = ${revision},
  "embeddingProviderModelId" = ${selected ? `'${model}'` : "NULL"} WHERE "userId" = '${id}';`).join("\n")}
`;

/** Ends rolled back, so it also proves a repeated deploy. */
export const memoryEmbeddingSelectionProofSql = `
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM "UserMemorySettings" WHERE "userId" IN (${ids(true)})
      AND "embeddingSelectionResolved" AND "embeddingProviderModelId" = '${model}') <> 3
  THEN RAISE EXCEPTION 'memory_embedding_selection_not_resolved'; END IF;
  -- No owner route ever cleared a selection: a revision never resolves one.
  IF (SELECT count(*) FROM "UserMemorySettings" WHERE "userId" IN (${ids(false)})
      AND NOT "embeddingSelectionResolved" AND "embeddingProviderModelId" IS NULL) <> 3
  THEN RAISE EXCEPTION 'memory_embedding_selection_resolved_by_revision'; END IF;
  IF (SELECT count(*) FROM "UserMemorySettings" AS settings
      JOIN (VALUES ${owners.map(({ id, revision }) => `('${id}', ${revision})`).join(", ")}) AS expected (id, revision)
        ON expected.id = settings."userId" AND expected.revision = settings."settingsRevision") <> ${owners.length}
  THEN RAISE EXCEPTION 'memory_embedding_selection_revision_changed'; END IF;
END $$;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-embedding-selection-new', 'Synthetic owner', 'active', now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "UserMemorySettings"
      WHERE "userId" = 'memory-embedding-selection-new' AND NOT "embeddingSelectionResolved")
  THEN RAISE EXCEPTION 'memory_embedding_selection_new_owner_resolved'; END IF;
END $$;
ROLLBACK;
`;
