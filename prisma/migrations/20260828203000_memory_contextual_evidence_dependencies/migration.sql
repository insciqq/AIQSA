ALTER TABLE "MemoryRecallRound"
ADD COLUMN "supportingRoundIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "MemoryRecallRound"
ADD CONSTRAINT "MemoryRecallRound_contextual_dependencies_check" CHECK (
  cardinality("supportingRoundIds") <= 2
  AND char_length(array_to_string("supportingRoundIds", ',')) <= 129
  AND array_position("supportingRoundIds", NULL) IS NULL
  AND array_to_string("supportingRoundIds", ',') ~
    '^([a-f0-9]{64}(,[a-f0-9]{64})?)?$'
  AND (cardinality("supportingRoundIds") < 2
    OR "supportingRoundIds"[1] <> "supportingRoundIds"[2])
  AND NOT ("id" = ANY("supportingRoundIds"))
  AND ("contextualKeyState" = 'GENERATED'
    OR cardinality("supportingRoundIds") = 0)
);

ALTER TABLE "MemoryRecallRoundSegment"
ADD CONSTRAINT "MemoryRecallRoundSegment_contextual_dependencies_check" CHECK (
  (cardinality("supportingRoundIds") < 2
    OR "supportingRoundIds"[1] <> "supportingRoundIds"[2])
  AND NOT ("roundId" = ANY("supportingRoundIds"))
  AND ("contextualKeyState" = 'GENERATED'
    OR cardinality("supportingRoundIds") = 0)
);

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_recall_round_segment(
  p_user_id text,
  p_round_id text
)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryRecallRoundSegment" AS segment
    LEFT JOIN "MemoryRecallRound" AS round
      ON round."userId" = segment."userId"
      AND round."chatId" = segment."chatId"
      AND round."id" = segment."roundId"
    WHERE segment."userId" = p_user_id
      AND segment."roundId" = p_round_id
      AND segment."state" IN (
        'ACTIVE'::"MemoryHistoryItemState",
        'SUPPRESSED'::"MemoryHistoryItemState"
      )
      AND (
        round."id" IS NULL
        OR round."state" IS DISTINCT FROM segment."state"
        OR round."evidenceRootHash" IS DISTINCT FROM segment."evidenceRootHash"
        OR round."sourceRevisionAtCreation" IS DISTINCT FROM
          segment."sourceRevisionAtCreation"
        OR round."contextualKeyPolicyVersion" IS DISTINCT FROM
          segment."contextualKeyPolicyVersion"
        OR (
          segment."contextualKeyState" = 'GENERATED'
          AND (
            round."contextualKeyState" IS DISTINCT FROM 'GENERATED'
            OR round."supportingRoundIds" IS DISTINCT FROM
              segment."supportingRoundIds"
          )
        )
        OR round."safetyClass" IS DISTINCT FROM segment."safetyClass"
        OR round."redactionState" IS DISTINCT FROM segment."redactionState"
        OR round."redactionReasonCodes" IS DISTINCT FROM
          segment."redactionReasonCodes"
        OR NOT EXISTS (
          SELECT 1 FROM "MemoryRecallRoundSegmentMessage" AS source_map
          WHERE source_map."userId" = segment."userId"
            AND source_map."roundId" = segment."roundId"
            AND source_map."segmentId" = segment."id"
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Published Memory recall round segment must match its parent and source map';
  END IF;
END;
$function$;
