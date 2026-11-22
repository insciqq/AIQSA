-- Personal Memory is replaced by one note per user (operator decision 2026-11-22).
-- This upgrade carries what the old Memory held into the new storage, once, before a
-- later migration of the same release drops the old tables:
--
-- 1. The three switches map one to one (useMemoryFacts -> memoryEnabled,
--    referenceChatHistory -> pastChatSearchEnabled, learnAutomatically ->
--    memorySuggestionsEnabled); an open pause turns its switch off. Only a switch that
--    is off is written, and a UserSettings row is created only for a user with one off.
-- 2. The facts the owner's Settings > Memory list showed are carried: an ACTIVE fact
--    whose current version is ACTIVE, open, unexpired, CLASSIFIED, not a PATTERN, in
--    the owner's global scope, and, for an automatic version, still supported by a
--    user message the list accepted (an ordinary chat that is not being deleted, the
--    active branch, no suppression, barrier or learning pause), with valid
--    dependencies. A saved fact (explicit, or automatic from a remember request) that
--    was saved, remembered or edited in a chat whose pending deletion asked to forget
--    its memories is not carried: the user asked to forget it.
--    Saved facts become the note, one line per fact in the order they became saved (a
--    fact learned automatically and edited later counts from the edit), trimmed, exact
--    duplicates once. Lines after the first that does not fit 6 000 characters wait as
--    SAVED_OVERFLOW suggestions, and so do saved facts the note must not carry: those
--    the old Memory kept out of prompts (classified HIGHLY_SENSITIVE or SECRET; its
--    prompts read only NORMAL and SENSITIVE, lib/server/memory/persistence/
--    reusableFactAuthority.ts) and every saved fact of an owner whose saved-secret
--    cleanup has not succeeded (one may still repeat a saved secret's value, and Keep
--    checks it). Every other automatic fact waits as an AUTOMATIC suggestion. A
--    suggestion keeps its fact's creation time and is clipped at 6 000 characters; a
--    blank fact carries nothing.
-- 3. The past-chat embedding role takes the embedding model the installation uses:
--    the one most owners selected, else the old installation default; never a model
--    that is gone, nothing when none was in use, and never over a value already set.
--    embeddingConfiguredAt stays NULL: it marks only an administrator's save or clear.
-- 4. Inbound Memory MCP grants are revoked as Connected apps' Revoke does (Hub and
--    Skills grants stay); their token families end and unused codes go.
-- 5. A chat deletion that finished in the last week keeps answering its owner's status
--    reads as complete (BackgroundWorkItem). Unfinished deletions need nothing: their
--    obligation is the chat's own fence, which the background worker drains.
--
-- Idempotent in effect: owners who already have a note or suggestions are skipped, and
-- every other write converges. The old Memory tables are only read.

-- 1. Switches.
INSERT INTO "UserSettings" ("id", "userId", "memoryEnabled", "pastChatSearchEnabled", "memorySuggestionsEnabled", "updatedAt")
SELECT gen_random_uuid()::text, mapped."userId", mapped."memoryEnabled", mapped."pastChatSearchEnabled",
  mapped."memorySuggestionsEnabled", CURRENT_TIMESTAMP
FROM (
  SELECT settings."userId",
    settings."useMemoryFacts" AND NOT EXISTS (
      SELECT 1 FROM "MemoryPauseInterval" AS pause
      WHERE pause."userId" = settings."userId" AND pause."scope" = 'MASTER'::"MemoryPauseScope"
        AND pause."resumedAt" IS NULL
    ) AS "memoryEnabled",
    settings."referenceChatHistory" AND NOT EXISTS (
      SELECT 1 FROM "MemoryPauseInterval" AS pause
      WHERE pause."userId" = settings."userId" AND pause."scope" = 'SEARCH_HISTORY'::"MemoryPauseScope"
        AND pause."resumedAt" IS NULL
    ) AS "pastChatSearchEnabled",
    settings."learnAutomatically" AND NOT EXISTS (
      SELECT 1 FROM "MemoryPauseInterval" AS pause
      WHERE pause."userId" = settings."userId" AND pause."scope" = 'AUTOMATIC_LEARNING'::"MemoryPauseScope"
        AND pause."resumedAt" IS NULL
    ) AS "memorySuggestionsEnabled"
  FROM "UserMemorySettings" AS settings
  INNER JOIN "User" AS owner ON owner."id" = settings."userId"
) AS mapped
WHERE NOT (mapped."memoryEnabled" AND mapped."pastChatSearchEnabled" AND mapped."memorySuggestionsEnabled")
-- An existing row keeps its other preferences and its updatedAt; a switch only turns off.
ON CONFLICT ("userId") DO UPDATE SET
  "memoryEnabled" = "UserSettings"."memoryEnabled" AND EXCLUDED."memoryEnabled",
  "pastChatSearchEnabled" = "UserSettings"."pastChatSearchEnabled" AND EXCLUDED."pastChatSearchEnabled",
  "memorySuggestionsEnabled" = "UserSettings"."memorySuggestionsEnabled" AND EXCLUDED."memorySuggestionsEnabled";

-- 2. Facts. One row per text to carry, with where it goes.
CREATE TEMPORARY TABLE "aiqsa_memory_note_carry" ON COMMIT DROP AS
WITH RECURSIVE spaces AS (
  -- What JavaScript's trim() removes, with what PostgreSQL calls space, so a carried text
  -- is never blank for the application's contract nor for the table checks.
  SELECT E'[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' AS "characters"
), active_branch AS (
  -- The active branch of every ordinary chat that evidence cites, walked once per chat; UNION ends at a cycle.
  SELECT chat."id" AS "chatId", leaf."id" AS "messageId", leaf."parentMessageId"
  FROM "Chat" AS chat
  INNER JOIN "Message" AS leaf ON leaf."chatId" = chat."id" AND leaf."id" = chat."activeLeafMessageId"
  WHERE chat."memoryMode" = 'NORMAL'::"MemoryChatMode" AND chat."permanentDeletionAt" IS NULL
    AND chat."id" IN (
      SELECT cited."chatId" FROM "MemoryEvidence" AS cited
      WHERE cited."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
    )
  UNION
  SELECT parent."chatId", parent."id", parent."parentMessageId"
  FROM active_branch AS child
  INNER JOIN "Message" AS parent ON parent."chatId" = child."chatId" AND parent."id" = child."parentMessageId"
), live_support AS (
  -- Automatic versions the list still showed (lib/server/memory/persistence/eligibility.ts): supported by a complete
  -- user message on the active branch of an ordinary chat that is not being deleted, with no source suppression,
  -- barrier or learning pause covering it.
  SELECT DISTINCT support."userId", support."factVersionId"
  FROM "MemoryEvidence" AS support
  INNER JOIN "Chat" AS evidence_chat
    ON evidence_chat."userId" = support."userId" AND evidence_chat."id" = support."chatId"
    AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
    AND evidence_chat."permanentDeletionAt" IS NULL
  INNER JOIN "Message" AS evidence_message
    ON evidence_message."chatId" = support."chatId" AND evidence_message."id" = support."messageId"
    AND evidence_message."role" = 'user'
    AND evidence_message."status" = 'complete'::"MessageStatus"
  INNER JOIN active_branch AS branch
    ON branch."chatId" = support."chatId" AND branch."messageId" = support."messageId"
  WHERE support."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
    AND support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
    AND support."sourceRole" = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySuppression" AS source_suppression
      WHERE source_suppression."userId" = support."userId"
        AND source_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
        AND source_suppression."sourceChatId" = support."chatId"
        AND source_suppression."sourceMessageId" = support."messageId"
        AND (source_suppression."sourceBranchGeneration" IS NULL
          OR source_suppression."sourceBranchGeneration" = support."branchGeneration")
        AND (source_suppression."expiresAt" IS NULL OR source_suppression."expiresAt" > CURRENT_TIMESTAMP)
        AND NOT (support."id" = ANY(source_suppression."preservedEvidenceIds"))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySourceBarrier" AS source_barrier
      WHERE source_barrier."userId" = support."userId"
        AND source_barrier."kind" IN ('AUTOMATIC_FACTS'::"MemorySourceBarrierKind", 'ALL_REUSABLE'::"MemorySourceBarrierKind")
        AND source_barrier."explicitOverrideAllowed" = FALSE
        AND evidence_message."createdAt" <= source_barrier."sourceCreatedAtCutoff"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MemoryPauseInterval" AS learning_pause
      WHERE learning_pause."userId" = support."userId"
        AND learning_pause."scope" IN ('MASTER'::"MemoryPauseScope", 'AUTOMATIC_LEARNING'::"MemoryPauseScope")
        AND evidence_message."createdAt" >= learning_pause."pausedAt"
        AND (learning_pause."resumedAt" IS NULL OR evidence_message."createdAt" <= learning_pause."resumedAt")
    )
), carried AS (
  SELECT fact."userId", fact."id" AS "factId", fact."createdAt",
    regexp_replace(version."displayText", '^' || spaces."characters" || '+|' || spaces."characters" || '+$', '', 'g') AS "text",
    (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      OR COALESCE(version."semanticFrame"->>'memoryDirective' = 'EXPLICIT_REMEMBER', FALSE)) AS "saved",
    -- When the fact first became saved: a fact learned automatically and edited later counts from the edit.
    (SELECT min(saved_version."createdAt") FROM "MemoryFactVersion" AS saved_version
      WHERE saved_version."userId" = fact."userId" AND saved_version."factId" = fact."id"
        AND (saved_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
          OR COALESCE(saved_version."semanticFrame"->>'memoryDirective' = 'EXPLICIT_REMEMBER', FALSE))) AS "savedAt",
    -- Never put into the note: what the old Memory kept out of every prompt, and every saved fact of an owner whose
    -- saved-secret cleanup has not finished, since one of them may still repeat a saved secret's value.
    (version."sensitivityClass" NOT IN ('NORMAL'::"MemorySensitivityClass", 'SENSITIVE'::"MemorySensitivityClass")
      OR EXISTS (
        SELECT 1 FROM "MemoryDeletionOutbox" AS scrub
        WHERE scrub."userId" = fact."userId"
          AND scrub."operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
          AND scrub."targetType" = 'SAVED_SECRET@memory-saved-secret-scrub-v1'
          AND scrub."state" <> 'SUCCEEDED'::"MemoryDeletionState"
      )) AS "withheld"
  FROM "MemoryFact" AS fact
  CROSS JOIN spaces
  INNER JOIN "MemoryFactVersion" AS version
    ON version."userId" = fact."userId" AND version."factId" = fact."id" AND version."id" = fact."currentVersionId"
  INNER JOIN "MemoryScope" AS scope
    ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
  WHERE fact."state" = 'ACTIVE'::"MemoryFactState"
    AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
    AND version."systemTo" IS NULL
    AND version."contentPurgedAt" IS NULL
    AND version."displayText" IS NOT NULL
    AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
    AND version."modality" <> 'PATTERN'::"MemoryFactModality"
    AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
    AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
    AND scope."targetIdSnapshot" IS NULL AND scope."targetDisplaySnapshot" IS NULL
    AND scope."folderId" IS NULL AND scope."assistantId" IS NULL AND scope."chatId" IS NULL
    AND (
      version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      OR EXISTS (
        SELECT 1 FROM live_support AS live
        WHERE live."userId" = version."userId" AND live."factVersionId" = version."id"
      )
    )
    AND aiqsa_memory_fact_dependencies_valid(fact."userId", version."id")
    -- What the pending deletion of its chat would have forgotten: a saved fact that came from there. An explicit fact
    -- by any of its events, as the old worker forgot it; a fact remembered on request by the event that saved it; either
    -- by a save or edit receipt of a run there. An ordinary automatic fact needs no rule: a fenced chat supports nothing,
    -- and support elsewhere keeps it.
    AND NOT (
      (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        OR COALESCE(version."semanticFrame"->>'memoryDirective' = 'EXPLICIT_REMEMBER', FALSE))
      AND EXISTS (
        SELECT 1 FROM "MemoryDeletionOutbox" AS purge
        WHERE purge."userId" = fact."userId"
          AND purge."operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
          AND purge."targetType" = 'CHAT@memory-chat-delete-v1'
          AND purge."alsoForgetOriginMemories" = TRUE
          AND purge."state" NOT IN ('SUCCEEDED'::"MemoryDeletionState", 'CANCELLED'::"MemoryDeletionState")
          AND (
            (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode" AND EXISTS (
              SELECT 1 FROM "MemoryEvent" AS origin
              WHERE origin."userId" = fact."userId" AND origin."factId" = fact."id"
                AND origin."sourceChatId" = purge."targetId"
            ))
            OR EXISTS (
              SELECT 1 FROM "MemoryFactVersion" AS saved_version
              INNER JOIN "MemoryEvent" AS saving
                ON saving."userId" = saved_version."userId" AND saving."id" = saved_version."createdByEventId"
              WHERE saved_version."userId" = fact."userId" AND saved_version."factId" = fact."id"
                AND (saved_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
                  OR COALESCE(saved_version."semanticFrame"->>'memoryDirective' = 'EXPLICIT_REMEMBER', FALSE))
                AND saving."sourceChatId" = purge."targetId"
            )
            OR EXISTS (
              SELECT 1 FROM "MemoryOperationReceipt" AS receipt
              INNER JOIN "ModelRun" AS run ON run."userId" = receipt."userId" AND run."id" = receipt."modelRunId"
              WHERE receipt."userId" = fact."userId" AND receipt."targetFactId" = fact."id"
                AND receipt."operation" IN ('SAVE'::"MemoryMutationAction", 'EDIT'::"MemoryMutationAction")
                AND run."chatId" = purge."targetId"
            )
          )
      )
    )
    AND NOT EXISTS (SELECT 1 FROM "UserMemoryNote" AS note WHERE note."userId" = fact."userId")
    AND NOT EXISTS (SELECT 1 FROM "MemoryLegacySuggestion" AS waiting WHERE waiting."userId" = fact."userId")
), lines AS (
  -- An exact duplicate is carried once: saved before automatic, the copy kept out of the note first, then the earliest.
  SELECT DISTINCT ON (carried."userId", carried."text") carried.*
  FROM carried
  WHERE carried."text" <> ''
  ORDER BY carried."userId", carried."text", carried."saved" DESC, carried."withheld" DESC,
    CASE WHEN carried."saved" THEN carried."savedAt" ELSE carried."createdAt" END, carried."factId"
), placed AS (
  -- Saved lines in the order they became saved; the first that does not fit 6 000 characters and every later one wait.
  SELECT lines.*,
    CASE WHEN lines."saved" AND NOT lines."withheld" THEN
      sum(char_length(lines."text") + 1) OVER (
        PARTITION BY lines."userId", lines."saved" AND NOT lines."withheld"
        ORDER BY lines."savedAt", lines."factId"
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) - 1
    END AS "noteLength"
  FROM lines
)
SELECT placed."userId", placed."factId", placed."createdAt", placed."savedAt", placed."text",
  CASE
    WHEN placed."noteLength" <= 6000 THEN 'NOTE'
    WHEN placed."saved" THEN 'SAVED_OVERFLOW'
    ELSE 'AUTOMATIC'
  END AS "destination"
FROM placed;

-- The saved lines that fit, in the order they were saved. The user saved them.
INSERT INTO "UserMemoryNote" ("userId", "text", "revision", "lastChangedBy", "updatedAt")
SELECT carry."userId", string_agg(carry."text", E'\n' ORDER BY carry."savedAt", carry."factId"), 1,
  'USER'::"MemoryNoteAuthor", CURRENT_TIMESTAMP
FROM "aiqsa_memory_note_carry" AS carry
WHERE carry."destination" = 'NOTE'
GROUP BY carry."userId"
ON CONFLICT ("userId") DO NOTHING;

INSERT INTO "MemoryLegacySuggestion" ("id", "userId", "text", "origin", "createdAt")
SELECT gen_random_uuid()::text, carry."userId", left(carry."text", 6000),
  carry."destination"::"MemoryLegacySuggestionOrigin", carry."createdAt"
FROM "aiqsa_memory_note_carry" AS carry
WHERE carry."destination" IN ('SAVED_OVERFLOW', 'AUTOMATIC');

DROP TABLE "aiqsa_memory_note_carry";

-- 3. The past-chat embedding role.
UPDATE "SystemModelPolicy" AS policy
SET "embeddingProviderModelId" = chosen."id"
FROM (
  SELECT candidate."id"
  FROM (
    SELECT model."id", 0 AS tier, count(*) AS owners, max(settings."updatedAt") AS "lastSelectedAt"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "ProviderModel" AS model ON model."id" = settings."embeddingProviderModelId"
    WHERE model."modelClass" = 'embedding'::"ProviderModelClass"
    GROUP BY model."id"
    UNION ALL
    SELECT model."id", 1 AS tier, 0 AS owners, NULL AS "lastSelectedAt"
    FROM "MemoryUtilityModelPolicy" AS memory_policy
    INNER JOIN "ProviderModel" AS model ON model."id" = memory_policy."embeddingDefaultProviderModelId"
    WHERE memory_policy."id" = 'installation' AND model."modelClass" = 'embedding'::"ProviderModelClass"
  ) AS candidate
  ORDER BY candidate.tier, candidate.owners DESC, candidate."lastSelectedAt" DESC NULLS LAST, candidate."id"
  LIMIT 1
) AS chosen
WHERE policy."id" = 'installation'
  AND policy."embeddingProviderModelId" IS NULL
  AND policy."embeddingConfiguredAt" IS NULL;

-- 4. Inbound Memory MCP. Families and codes before grants, the order every revocation uses.
UPDATE "InboundMcpOAuthTokenFamily"
SET "revokedAt" = CURRENT_TIMESTAMP, "revocationReason" = 'memory_mcp_removed', "updatedAt" = CURRENT_TIMESTAMP
WHERE "resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "revokedAt" IS NULL;

DELETE FROM "InboundMcpOAuthAuthorizationCode"
WHERE "resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "consumedAt" IS NULL;

UPDATE "InboundMcpOAuthGrant"
SET "state" = 'REVOKED'::"InboundMcpOAuthGrantState", "revokedAt" = CURRENT_TIMESTAMP,
  "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "state" = 'ACTIVE'::"InboundMcpOAuthGrantState";

-- 5. Chat deletions finished in the last week, which a browser may still be asking about
-- (lib/server/chats/permanentDeletion/repository.ts reads them; the worker prunes them).
INSERT INTO "BackgroundWorkItem" ("duty", "itemId", "userId", "attemptCount", "completedAt", "createdAt", "updatedAt")
SELECT DISTINCT ON (deletion."targetId")
  'permanent_chat_deletion', deletion."targetId", deletion."userId", deletion."attemptCount",
  deletion."completedAt", deletion."createdAt", deletion."completedAt"
FROM "MemoryDeletionOutbox" AS deletion
INNER JOIN "User" AS owner ON owner."id" = deletion."userId"
WHERE deletion."operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
  AND deletion."targetType" = 'CHAT@memory-chat-delete-v1'
  AND deletion."state" = 'SUCCEEDED'::"MemoryDeletionState"
  AND deletion."completedAt" > CURRENT_TIMESTAMP - INTERVAL '7 days'
  AND char_length(deletion."targetId") BETWEEN 1 AND 256
  AND NOT EXISTS (SELECT 1 FROM "Chat" AS chat WHERE chat."id" = deletion."targetId")
ORDER BY deletion."targetId", deletion."completedAt" DESC
ON CONFLICT ("duty", "itemId") DO NOTHING;
