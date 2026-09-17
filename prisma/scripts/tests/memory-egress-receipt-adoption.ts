export const MEMORY_EGRESS_RECEIPT_MIGRATION = "20260917203000_memory_egress_receipt_capacity";

export const memoryEgressReceiptFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('egress-upgrade-owner', 'Receipt fixture', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('egress-upgrade-chat', 'egress-upgrade-owner', 'Receipt fixture', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('egress-upgrade-message', 'egress-upgrade-chat', 'user', '{"blocks":[{"type":"text","text":"Work"}]}', now());
INSERT INTO "ModelRun" (id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('egress-upgrade-run', 'egress-upgrade-owner', 'egress-upgrade-chat', 'egress-upgrade-message', 'test', 'fixture', 'in_progress',
  '{"prompt":{"baseline":{"source":"standard_chat","timeZone":"UTC","timeZoneSource":"client"}}}', now());
INSERT INTO "MemoryToolEgressReceipt" (id, "userId", "modelRunId", "requestOrdinal", mode,
  "destinationKind", "destinationFingerprint", "destinationSnapshot", "requestEvidenceHash",
  "dispatchState", "dispatchStartedAt", "dispatchCompletedAt", "updatedAt")
SELECT 'egress-upgrade-' || n, 'egress-upgrade-owner', 'egress-upgrade-run', n, 'PROVIDER_REQUEST',
  'answer_provider', repeat('a',64), '{}', repeat('b',64), 'COMPLETED', now(), now(), now()
FROM generate_series(1,64) AS n;
CREATE TABLE "EgressUpgradeFixture" AS
SELECT to_jsonb(receipt) AS snapshot FROM "MemoryToolEgressReceipt" AS receipt
WHERE "modelRunId" = 'egress-upgrade-run';
DO $$ BEGIN
  BEGIN
    UPDATE "MemoryToolEgressReceipt" SET "requestOrdinal" = 65 WHERE id = 'egress-upgrade-64';
    RAISE EXCEPTION 'egress_predecessor_did_not_enforce_limit';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
`;

export const memoryEgressReceiptProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "EgressUpgradeFixture" AS original
      JOIN "MemoryToolEgressReceipt" AS receipt ON original.snapshot = to_jsonb(receipt)) <> 64 THEN
    RAISE EXCEPTION 'egress_upgrade_changed_prior_receipts';
  END IF;
END $$;
INSERT INTO "MemoryToolEgressReceipt" (id, "userId", "modelRunId", "requestOrdinal", mode,
  "destinationKind", "destinationFingerprint", "destinationSnapshot", "requestEvidenceHash",
  "dispatchState", "dispatchStartedAt", "dispatchCompletedAt", "updatedAt")
SELECT 'egress-upgrade-' || n, 'egress-upgrade-owner', 'egress-upgrade-run', n, 'PROVIDER_REQUEST',
  'answer_provider', repeat('a',64), '{}', repeat('b',64), 'COMPLETED', now(), now(), now()
FROM generate_series(65,301) AS n ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM "MemoryToolEgressReceipt" WHERE "modelRunId" = 'egress-upgrade-run') <> 301 THEN
    RAISE EXCEPTION 'egress_upgrade_did_not_accept_long_run';
  END IF;
  BEGIN
    UPDATE "MemoryToolEgressReceipt" SET "requestOrdinal" = 0 WHERE id = 'egress-upgrade-301';
    RAISE EXCEPTION 'egress_upgrade_lost_positive_ordinal_guard';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryToolEgressReceipt" SET "requestEvidenceHash" = 'invalid' WHERE id = 'egress-upgrade-301';
    RAISE EXCEPTION 'egress_upgrade_lost_evidence_shape_guard';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryToolEgressReceipt" SET "dispatchCompletedAt" = NULL WHERE id = 'egress-upgrade-301';
    RAISE EXCEPTION 'egress_upgrade_lost_settlement_guard';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
`;
