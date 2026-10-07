-- Voice dictation: a personal usage purpose for transcriptions and the
-- administrator's Speech to text role (connection, upstream model id, the
-- tested default-key version and the explicit configuration time).
ALTER TYPE "UsagePurpose" ADD VALUE 'speech_to_text';

ALTER TABLE "SystemModelPolicy" ADD COLUMN "speechToTextConfiguredAt" TIMESTAMP(3),
ADD COLUMN "speechToTextConnectionId" TEXT,
ADD COLUMN "speechToTextCredentialVersionId" TEXT,
ADD COLUMN "speechToTextModelId" VARCHAR(256);
