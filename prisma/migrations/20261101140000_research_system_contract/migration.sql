-- The research system's one migration (operator decisions 2026-11-01, `agent_docs/RUN_CONTRACTS.md`, Research;
-- the page store's story is in `agent_docs/ARCHITECTURE.md`). New tables and nullable policy columns only: no
-- earlier release reads or writes them, so its writers stay safe during the upgrade. The verifier's columns stay
-- as they are and become the checks role, so both installations keep what the administrator chose.

-- The researchers' role, beside the verifier's, under the same rules: an unset role keeps the chat's model.
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "researchResearcherProviderModelId" TEXT,
  ADD COLUMN "researchResearcherReasoningEffort" VARCHAR(32);
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_research_researcher_effort_check" CHECK (
  "researchResearcherReasoningEffort" IS NULL OR "researchResearcherProviderModelId" IS NOT NULL AND length("researchResearcherReasoningEffort") BETWEEN 1 AND 32
    AND btrim("researchResearcherReasoningEffort") = "researchResearcherReasoningEffort" AND "researchResearcherReasoningEffort" !~ '[[:cntrl:]]'
);
CREATE INDEX "SystemModelPolicy_researchResearcherProviderModelId_idx" ON "SystemModelPolicy"("researchResearcherProviderModelId");
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_researchResearcherProviderModelId_fkey"
  FOREIGN KEY ("researchResearcherProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One row per research run, keyed by the run. A proposal comes with its window's end; a released plan comes with
-- the user's answer and the frame, all three at once.
CREATE TABLE "ResearchFrame" (
    "modelRunId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "continuedFromRunId" TEXT,
    "proposal" JSONB,
    "windowEndsAt" TIMESTAMP(3),
    "heldUntil" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "answer" JSONB,
    "frame" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchFrame_pkey" PRIMARY KEY ("modelRunId"),
    CONSTRAINT "ResearchFrame_goal_check" CHECK (length(btrim("goal")) >= 1 AND length("goal") <= 2000),
    CONSTRAINT "ResearchFrame_continuation_check" CHECK ("continuedFromRunId" IS DISTINCT FROM "modelRunId"),
    CONSTRAINT "ResearchFrame_window_check" CHECK (
      ("proposal" IS NULL) = ("windowEndsAt" IS NULL)
      AND ("heldUntil" IS NULL OR "windowEndsAt" IS NOT NULL)
      AND ("proposal" IS NULL OR jsonb_typeof("proposal") = 'object')
    ),
    CONSTRAINT "ResearchFrame_release_check" CHECK (
      ("releasedAt" IS NULL) = ("answer" IS NULL)
      AND ("releasedAt" IS NULL) = ("frame" IS NULL)
      AND ("releasedAt" IS NULL OR "proposal" IS NOT NULL)
      AND ("answer" IS NULL OR jsonb_typeof("answer") = 'object')
      AND ("frame" IS NULL OR jsonb_typeof("frame") = 'object')
    ),
    CONSTRAINT "ResearchFrame_version_check" CHECK ("version" >= 1)
);

-- Append-only. Each kind holds what `decodeResearchRecord` gives it and nothing else, so a row always reads as its kind.
CREATE TABLE "ResearchEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "authorThreadId" TEXT,
    "authorName" VARCHAR(48),
    "supersedesId" TEXT,
    "rowKey" VARCHAR(48),
    "criterionKey" VARCHAR(48),
    "claim" TEXT,
    "url" TEXT,
    "quote" TEXT,
    "sourceClass" VARCHAR(32),
    "standing" VARCHAR(32),
    "reason" TEXT,
    "target" TEXT,
    "dataset" JSONB,
    "quoteCheck" VARCHAR(16),
    "quoteCheckReason" VARCHAR(32),
    "pageId" TEXT,
    "registrableDomain" VARCHAR(253),
    "textGroupKey" VARCHAR(64),
    "publishedOn" VARCHAR(10),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResearchEvidence_kind_check" CHECK ("kind" IN ('finding', 'not_found', 'dataset', 'unreachable')),
    CONSTRAINT "ResearchEvidence_shape_check" CHECK (
      CASE "kind"
        WHEN 'finding' THEN "claim" IS NOT NULL AND "url" IS NOT NULL AND "quote" IS NOT NULL AND "sourceClass" IS NOT NULL
          AND "standing" IS NOT NULL AND "quoteCheck" IS NOT NULL AND "reason" IS NULL AND "target" IS NULL AND "dataset" IS NULL
        WHEN 'not_found' THEN "rowKey" IS NOT NULL AND "criterionKey" IS NOT NULL AND "reason" IS NOT NULL AND "claim" IS NULL
          AND "url" IS NULL AND "quote" IS NULL AND "standing" IS NULL AND "target" IS NULL AND "dataset" IS NULL
        WHEN 'dataset' THEN "rowKey" IS NOT NULL AND "claim" IS NOT NULL AND "url" IS NOT NULL AND "sourceClass" IS NOT NULL
          AND "standing" IS NOT NULL AND "dataset" IS NOT NULL AND jsonb_typeof("dataset") = 'object' AND "quote" IS NULL
          AND "reason" IS NULL AND "target" IS NULL
        WHEN 'unreachable' THEN "target" IS NOT NULL AND "reason" IS NOT NULL AND "claim" IS NULL AND "url" IS NULL
          AND "quote" IS NULL AND "standing" IS NULL AND "dataset" IS NULL
        ELSE false
      END
    ),
    CONSTRAINT "ResearchEvidence_bounds_check" CHECK (
      "sequence" >= 0
      AND ("claim" IS NULL OR length("claim") BETWEEN 1 AND 2000)
      AND ("url" IS NULL OR length("url") BETWEEN 1 AND 2048)
      AND ("quote" IS NULL OR length("quote") BETWEEN 1 AND 4000)
      AND ("reason" IS NULL OR length("reason") BETWEEN 1 AND 1000)
      AND ("target" IS NULL OR length("target") BETWEEN 1 AND 512)
    ),
    CONSTRAINT "ResearchEvidence_author_check" CHECK (("authorThreadId" IS NULL) = ("authorName" IS NULL)),
    CONSTRAINT "ResearchEvidence_supersedes_check" CHECK ("supersedesId" IS DISTINCT FROM "id"),
    CONSTRAINT "ResearchEvidence_sourceClass_check" CHECK (
      "sourceClass" IS NULL OR "sourceClass" IN ('primary_official', 'independent_tests', 'owner_reviews', 'action_channel')
    ),
    CONSTRAINT "ResearchEvidence_standing_check" CHECK ("standing" IS NULL OR "standing" IN ('confirmed', 'claimed', 'not_verified')),
    CONSTRAINT "ResearchEvidence_quoteCheck_check" CHECK (
      ("quoteCheck" IS NULL OR "quoteCheck" IN ('found', 'not_verbatim', 'not_checked', 'unsupported'))
      AND ("quoteCheckReason" IS NULL OR "quoteCheck" IS NOT NULL)
    ),
    CONSTRAINT "ResearchEvidence_publishedOn_check" CHECK ("publishedOn" IS NULL OR "publishedOn" ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$')
);

-- Immutable text the server keeps from an agent's own results. `sizeBytes` is what the run's bound sums, so the database
-- holds it to the text, and the bound per page is `RESEARCH_PAGE_LIMITS.bytesPerPage`. `octet_length` reads the stored
-- size without decompressing the value.
CREATE TABLE "ResearchPage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "linkHash" CHAR(64) NOT NULL,
    "text" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "obtainedBy" VARCHAR(16) NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchPage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResearchPage_url_check" CHECK (length("url") BETWEEN 1 AND 2048),
    CONSTRAINT "ResearchPage_text_check" CHECK ("sizeBytes" = octet_length("text") AND "sizeBytes" BETWEEN 1 AND 262144),
    CONSTRAINT "ResearchPage_hashes_check" CHECK ("linkHash" ~ '^[0-9a-f]{64}$' AND "contentHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ResearchPage_obtainedBy_check" CHECK ("obtainedBy" IN ('tool', 'browser'))
);

CREATE UNIQUE INDEX "ResearchFrame_userId_chatId_modelRunId_key" ON "ResearchFrame"("userId", "chatId", "modelRunId");
CREATE INDEX "ResearchFrame_userId_chatId_continuedFromRunId_idx" ON "ResearchFrame"("userId", "chatId", "continuedFromRunId");

CREATE UNIQUE INDEX "ResearchEvidence_userId_chatId_id_key" ON "ResearchEvidence"("userId", "chatId", "id");
CREATE UNIQUE INDEX "ResearchEvidence_modelRunId_sequence_key" ON "ResearchEvidence"("modelRunId", "sequence");
CREATE UNIQUE INDEX "ResearchEvidence_userId_chatId_supersedesId_key" ON "ResearchEvidence"("userId", "chatId", "supersedesId");
CREATE INDEX "ResearchEvidence_userId_chatId_pageId_idx" ON "ResearchEvidence"("userId", "chatId", "pageId");

CREATE UNIQUE INDEX "ResearchPage_userId_chatId_id_key" ON "ResearchPage"("userId", "chatId", "id");
CREATE UNIQUE INDEX "ResearchPage_modelRunId_linkHash_contentHash_key" ON "ResearchPage"("modelRunId", "linkHash", "contentHash");

-- Each row carries its owner and chat into its keys, so no row can name another user's or another chat's run, page or
-- record (`agent_docs/PERSISTENCE.md`), and each goes with its run. A reference to a row of another run of the chat, which
-- a Continue makes, clears only its own column when that run goes (the columns `userId` and `chatId` are required): nothing
-- dangles and nothing blocks the deletion.
ALTER TABLE "ResearchFrame" ADD CONSTRAINT "ResearchFrame_modelRun_fkey"
  FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ResearchFrame" ADD CONSTRAINT "ResearchFrame_continuedFrom_fkey"
  FOREIGN KEY ("userId", "chatId", "continuedFromRunId") REFERENCES "ResearchFrame"("userId", "chatId", "modelRunId")
  ON DELETE SET NULL ("continuedFromRunId") ON UPDATE RESTRICT;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_modelRun_fkey"
  FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_supersedes_fkey"
  FOREIGN KEY ("userId", "chatId", "supersedesId") REFERENCES "ResearchEvidence"("userId", "chatId", "id")
  ON DELETE SET NULL ("supersedesId") ON UPDATE RESTRICT;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_page_fkey"
  FOREIGN KEY ("userId", "chatId", "pageId") REFERENCES "ResearchPage"("userId", "chatId", "id")
  ON DELETE SET NULL ("pageId") ON UPDATE RESTRICT;
ALTER TABLE "ResearchPage" ADD CONSTRAINT "ResearchPage_modelRun_fkey"
  FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
