CREATE FUNCTION knowledge_read_receipt_canonical_locator(target JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE target ->> 'kind'
    WHEN 'evidence_handle' THEN target ->> 'handle'
    WHEN 'page' THEN 'page ' || (target ->> 'page')
    WHEN 'heading' THEN CASE
      WHEN jsonb_typeof(target -> 'headingPath') = 'array' THEN (
        SELECT CASE
          WHEN count(*) BETWEEN 1 AND 16
            AND bool_and(char_length(part) BETWEEN 1 AND 256)
            AND bool_and(part !~ '[[:cntrl:]]')
            AND bool_and(
              part = regexp_replace(
                normalize(btrim(part), NFKC),
                '[[:space:]]+',
                ' ',
                'g'
              )
            )
          THEN 'heading: ' || string_agg(part, ' › ' ORDER BY ordinal)
          ELSE NULL
        END
        FROM jsonb_array_elements_text(target -> 'headingPath')
          WITH ORDINALITY AS heading(part, ordinal)
      )
      ELSE NULL
    END
    WHEN 'section' THEN 'section:' || (target ->> 'sectionId')
    WHEN 'passage' THEN 'passage:' || (target ->> 'passageId')
    WHEN 'block' THEN 'block:' || (target ->> 'blockId')
    WHEN 'structured_range' THEN CASE
      WHEN (target ->> 'sheet') = normalize(btrim(target ->> 'sheet'), NFKC)
        AND (target ->> 'sheet') !~ '[[:cntrl:]]'
      THEN
        'range:' || chr(39) ||
        replace((target ->> 'sheet'), chr(39), chr(39) || chr(39)) ||
        chr(39) || '!' || (target ->> 'range')
      ELSE NULL
    END
    ELSE NULL
  END
$function$;

ALTER TABLE "KnowledgeRun"
  ADD COLUMN "readReceipt" JSONB;

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check"
  CHECK (
    "readReceipt" IS NULL
    OR ((
      "operation" = 'read_source'
      AND jsonb_typeof("readReceipt") = 'object'
      AND pg_column_size("readReceipt") <= 4096
      AND (
        "readReceipt" - ARRAY[
          'contractVersion',
          'direction',
          'embedding',
          'locator',
          'resolution',
          'resolvedSource',
          'target',
          'version',
          'window'
        ]::text[]
      ) = '{}'::jsonb
      AND "readReceipt" -> 'version' = '1'::jsonb
      AND "readReceipt" -> 'contractVersion' = '1'::jsonb
      AND "readReceipt" ->> 'embedding' = 'forbidden'
      AND "readReceipt" ->> 'resolution' = 'exact'
      AND "readReceipt" ->> 'direction' IN ('after', 'around', 'before')
      AND jsonb_typeof("readReceipt" -> 'locator') = 'string'
      AND char_length("readReceipt" ->> 'locator') BETWEEN 1 AND 500
      AND "readReceipt" -> 'window' IN (
        '1'::jsonb,
        '2'::jsonb,
        '3'::jsonb,
        '4'::jsonb,
        '5'::jsonb,
        '6'::jsonb,
        '7'::jsonb,
        '8'::jsonb
      )
      AND jsonb_typeof("readReceipt" -> 'target') = 'object'
      AND "readReceipt" #>> '{target,kind}' IN (
        'block',
        'evidence_handle',
        'heading',
        'page',
        'passage',
        'section',
        'structured_range'
      )
      AND CASE "readReceipt" #>> '{target,kind}'
        WHEN 'evidence_handle' THEN
          (("readReceipt" -> 'target') - ARRAY['handle', 'kind']::text[]) = '{}'::jsonb
          AND "readReceipt" #>> '{target,handle}' ~
            '^K(?:(?:[1-9][0-9]{0,2}|1[0-9]{3}|20[0-3][0-9]|204[0-8])|(?:[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-6])\.[1-8])$'
        WHEN 'page' THEN
          (("readReceipt" -> 'target') - ARRAY['kind', 'page']::text[]) = '{}'::jsonb
          AND jsonb_typeof("readReceipt" #> '{target,page}') = 'number'
          AND "readReceipt" #>> '{target,page}' ~ '^[1-9][0-9]{0,5}$'
        WHEN 'heading' THEN
          (("readReceipt" -> 'target') - ARRAY['headingPath', 'kind']::text[]) = '{}'::jsonb
          AND CASE
            WHEN jsonb_typeof("readReceipt" #> '{target,headingPath}') = 'array'
              THEN jsonb_array_length("readReceipt" #> '{target,headingPath}') BETWEEN 1 AND 16
                AND NOT jsonb_path_exists(
                  "readReceipt" #> '{target,headingPath}',
                  '$[*] ? (@.type() != "string")'
                )
            ELSE false
          END
        WHEN 'section' THEN
          (("readReceipt" -> 'target') - ARRAY['kind', 'sectionId']::text[]) = '{}'::jsonb
          AND "readReceipt" #>> '{target,sectionId}' ~ '^kis_[0-9a-f]{40}$'
        WHEN 'passage' THEN
          (("readReceipt" -> 'target') - ARRAY['kind', 'passageId']::text[]) = '{}'::jsonb
          AND "readReceipt" #>> '{target,passageId}' ~ '^kip_[0-9a-f]{40}$'
        WHEN 'block' THEN
          (("readReceipt" -> 'target') - ARRAY['blockId', 'kind']::text[]) = '{}'::jsonb
          AND "readReceipt" #>> '{target,blockId}' ~ '^b_[0-9a-f]{24}_(0|[1-9][0-9]{0,5})$'
        WHEN 'structured_range' THEN
          (("readReceipt" -> 'target') - ARRAY['kind', 'range', 'sheet']::text[]) = '{}'::jsonb
          AND jsonb_typeof("readReceipt" #> '{target,sheet}') = 'string'
          AND char_length("readReceipt" #>> '{target,sheet}') BETWEEN 1 AND 256
          AND jsonb_typeof("readReceipt" #> '{target,range}') = 'string'
          AND "readReceipt" #>> '{target,range}' ~
            '^(?:[A-Z]|[A-R][A-Z]|S[A-R])(?:[1-9][0-9]{0,4}|100000)(?::(?:[A-Z]|[A-R][A-Z]|S[A-R])(?:[1-9][0-9]{0,4}|100000))?$'
        ELSE false
      END
      AND "readReceipt" ->> 'locator' =
        knowledge_read_receipt_canonical_locator("readReceipt" -> 'target')
      AND jsonb_typeof("readReceipt" -> 'resolvedSource') = 'object'
      AND (
        ("readReceipt" -> 'resolvedSource') - ARRAY[
          'sourceAlias',
          'sourceArtifactId',
          'sourceId',
          'sourceName',
          'sourceVersionId'
        ]::text[]
      ) = '{}'::jsonb
      AND "query" = "readReceipt" ->> 'locator'
      AND "readReceipt" #>> '{resolvedSource,sourceAlias}' ~ '^S[1-9][0-9]{0,2}$'
      AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceArtifactId}') = 'string'
      AND char_length("readReceipt" #>> '{resolvedSource,sourceArtifactId}') BETWEEN 1 AND 512
      AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceId}') = 'string'
      AND char_length("readReceipt" #>> '{resolvedSource,sourceId}') BETWEEN 1 AND 512
      AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceName}') = 'string'
      AND char_length("readReceipt" #>> '{resolvedSource,sourceName}') BETWEEN 1 AND 1024
      AND jsonb_typeof("readReceipt" #> '{resolvedSource,sourceVersionId}') = 'string'
      AND char_length("readReceipt" #>> '{resolvedSource,sourceVersionId}') BETWEEN 1 AND 512
    ) IS TRUE)
  );
