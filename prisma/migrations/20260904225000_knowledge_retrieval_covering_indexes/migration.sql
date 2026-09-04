-- Ready-scope checks need identities/state, never the normalized source body.
-- Partial covering indexes keep those checks out of the large artifact heap.
CREATE INDEX "KSIA_ready_scope_idx"
  ON "KnowledgeSourceIndexArtifact" ("id", "sourceVersionId")
  WHERE "state" = 'ready'::"KnowledgeSourceArtifactState";

CREATE INDEX "KHI_ready_source_lookup_idx"
  ON "KnowledgeHierarchicalIndexArtifact"
    ("sourceArtifactId", "sourceVersionId", "schemaVersion" DESC)
  INCLUDE ("id")
  WHERE "state" = 'ready'::"KnowledgeHierarchicalIndexState";

-- Document/section/exact lanes choose representative passage identities
-- before loading the bounded winning payloads. Preserve the existing unique
-- and FK indexes; this index adds an index-only route for those lookups.
CREATE INDEX "KAPI_artifact_ordinal_identity_idx"
  ON "KnowledgeArtifactPassageIndex" ("indexArtifactId", "ordinal")
  INCLUDE ("id", "sectionId");
