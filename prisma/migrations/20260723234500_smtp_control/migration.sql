-- One permanent installation SMTP control row. Configuration may be cleared,
-- but the row and its monotonic counters are never deleted or recreated.
CREATE TABLE "SmtpControl" (
  "id" TEXT NOT NULL,
  "draftConfig" JSONB,
  "draftPasswordEnvelope" TEXT,
  "draftSecretGeneration" INTEGER,
  "draftVersion" INTEGER NOT NULL DEFAULT 0,
  "testedDraftVersion" INTEGER,
  "draftTestVersion" INTEGER,
  "draftTestAt" TIMESTAMP(3),
  "draftTestCode" TEXT,
  "activeConfig" JSONB,
  "activePasswordEnvelope" TEXT,
  "activeSecretGeneration" INTEGER,
  "activeVersion" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "secretGenerationCounter" INTEGER NOT NULL DEFAULT 0,
  "healthActiveVersion" INTEGER,
  "lastAttemptAt" TIMESTAMP(3),
  "lastAcceptedAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastFailureCode" TEXT,
  "configurationUpdatedAt" TIMESTAMP(3),
  "configurationUpdatedByUserId" TEXT,
  "activatedAt" TIMESTAMP(3),
  "activatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SmtpControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SmtpControl_singleton_check"
    CHECK ("id" = 'installation-smtp'),
  CONSTRAINT "SmtpControl_versions_check"
    CHECK (
      "draftVersion" >= 0
      AND "activeVersion" >= 0
      AND "secretGenerationCounter" >= 0
    ),
  CONSTRAINT "SmtpControl_draft_secret_check"
    CHECK (
      ("draftPasswordEnvelope" IS NULL) = ("draftSecretGeneration" IS NULL)
      AND (
        "draftSecretGeneration" IS NULL
        OR (
          "draftSecretGeneration" > 0
          AND "draftSecretGeneration" <= "secretGenerationCounter"
        )
      )
    ),
  CONSTRAINT "SmtpControl_active_secret_check"
    CHECK (
      ("activePasswordEnvelope" IS NULL) = ("activeSecretGeneration" IS NULL)
      AND (
        "activeSecretGeneration" IS NULL
        OR (
          "activeSecretGeneration" > 0
          AND "activeSecretGeneration" <= "secretGenerationCounter"
        )
      )
    ),
  CONSTRAINT "SmtpControl_draft_slot_check"
    CHECK (
      "draftConfig" IS NOT NULL
      OR (
        "draftPasswordEnvelope" IS NULL
        AND "draftSecretGeneration" IS NULL
        AND "testedDraftVersion" IS NULL
        AND "draftTestVersion" IS NULL
        AND "draftTestAt" IS NULL
        AND "draftTestCode" IS NULL
      )
    ),
  CONSTRAINT "SmtpControl_draft_test_check"
    CHECK (
      (
        "draftTestVersion" IS NULL
        AND "draftTestAt" IS NULL
        AND "draftTestCode" IS NULL
      )
      OR (
        "draftTestVersion" = "draftVersion"
        AND "draftTestAt" IS NOT NULL
        AND "draftTestCode" IS NOT NULL
      )
    ),
  CONSTRAINT "SmtpControl_tested_draft_check"
    CHECK (
      "testedDraftVersion" IS NULL
      OR (
        "testedDraftVersion" = "draftVersion"
        AND "draftTestVersion" = "draftVersion"
        AND "draftTestCode" = 'accepted'
      )
    ),
  CONSTRAINT "SmtpControl_active_slot_check"
    CHECK (
      (
        "activeConfig" IS NULL
        AND "activePasswordEnvelope" IS NULL
        AND "activeSecretGeneration" IS NULL
        AND "enabled" = false
        AND "activatedAt" IS NULL
        AND "activatedByUserId" IS NULL
      )
      OR (
        "activeConfig" IS NOT NULL
        AND "activatedAt" IS NOT NULL
      )
    ),
  CONSTRAINT "SmtpControl_health_check"
    CHECK (
      (
        "healthActiveVersion" IS NULL
        AND "lastAttemptAt" IS NULL
        AND "lastAcceptedAt" IS NULL
        AND "lastFailureAt" IS NULL
        AND "lastFailureCode" IS NULL
      )
      OR (
        "healthActiveVersion" = "activeVersion"
        AND ("lastFailureAt" IS NULL) = ("lastFailureCode" IS NULL)
      )
    )
);

ALTER TABLE "SmtpControl"
ADD CONSTRAINT "SmtpControl_configurationUpdatedByUserId_fkey"
FOREIGN KEY ("configurationUpdatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmtpControl"
ADD CONSTRAINT "SmtpControl_activatedByUserId_fkey"
FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "SmtpControl" ("id") VALUES ('installation-smtp');

