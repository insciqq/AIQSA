-- Browser storage states may reach 8 MiB raw. Their encrypted envelope holds
-- the base64 value (at most 11188908 bytes of JSON), encoded as base64url
-- (14918544 bytes) plus version, nonce and tag. Ordinary kinds keep their
-- previous bounds; the 64 MiB aggregate stays an owner-locked application check.
ALTER TABLE "WorkspaceSecretValue"
  DROP CONSTRAINT "WorkspaceSecretValue_shape",
  ADD CONSTRAINT "WorkspaceSecretValue_shape" CHECK (
    "kind" IN ('ssh_key', 'env', 'text', 'file', 'browser_session') AND
    "byteSize" > 0 AND "payloadEnvelope" LIKE 'v2.%' AND
    cardinality("envNames") <= 64 AND array_position("envNames", NULL) IS NULL AND
    CASE WHEN "kind" = 'browser_session' THEN
      "byteSize" <= 8388608 AND octet_length("payloadEnvelope") <= 14918672 AND
      "originalName" IS NOT NULL AND "originalName" LIKE '%.json' AND
      "checksum" IS NOT NULL AND "checksum" ~ '^[0-9a-f]{64}$' AND NOT "sshProtected" AND cardinality("envNames") = 0
    ELSE
      "byteSize" <= 786432 AND octet_length("payloadEnvelope") <= 1048704 AND
      "checksum" IS NULL AND NOT "autoSaved"
    END
  );
