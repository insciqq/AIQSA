ALTER TABLE "ChatMemoryDigest"
  DROP CONSTRAINT "ChatMemoryDigest_incremental_metadata_check",
  ADD CONSTRAINT "ChatMemoryDigest_incremental_metadata_check"
  CHECK (
    "pipelineVersion" NOT IN (
      'memory-chat-digest-v2',
      'memory-chat-digest-v3',
      'memory-chat-digest-v4'
    )
    OR (
      "sourceFingerprint" IS NOT NULL
      AND "sourceFingerprint" ~ '^[a-f0-9]{64}$'
      AND "inputFingerprint" IS NOT NULL
      AND "inputFingerprint" ~ '^[a-f0-9]{64}$'
      AND "rebuildPolicyVersion" IS NOT NULL
      AND "rebuildPolicyVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "updateMode" IS NOT NULL
      AND "updateMode" IN ('FULL_REBUILD', 'INCREMENTAL', 'REBOUND', 'UNCHANGED')
    )
  );
