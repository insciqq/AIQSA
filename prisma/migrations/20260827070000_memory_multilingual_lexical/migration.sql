CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Transliteration is a deterministic search projection only. Authoritative
-- Memory display text remains byte-preserving and is never rewritten through
-- this function.
CREATE OR REPLACE FUNCTION aiqsa_memory_transliterate_ru(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
DECLARE
  character text;
  normalized text := lower(value);
  result text := '';
BEGIN
  FOR position IN 1..char_length(normalized) LOOP
    character := substr(normalized, position, 1);
    result := result || CASE character
      WHEN 'а' THEN 'a'
      WHEN 'б' THEN 'b'
      WHEN 'в' THEN 'v'
      WHEN 'г' THEN 'g'
      WHEN 'д' THEN 'd'
      WHEN 'е' THEN 'e'
      WHEN 'ё' THEN 'e'
      WHEN 'ж' THEN 'zh'
      WHEN 'з' THEN 'z'
      WHEN 'и' THEN 'i'
      WHEN 'й' THEN 'y'
      WHEN 'к' THEN 'k'
      WHEN 'л' THEN 'l'
      WHEN 'м' THEN 'm'
      WHEN 'н' THEN 'n'
      WHEN 'о' THEN 'o'
      WHEN 'п' THEN 'p'
      WHEN 'р' THEN 'r'
      WHEN 'с' THEN 's'
      WHEN 'т' THEN 't'
      WHEN 'у' THEN 'u'
      WHEN 'ф' THEN 'f'
      WHEN 'х' THEN 'kh'
      WHEN 'ц' THEN 'ts'
      WHEN 'ч' THEN 'ch'
      WHEN 'ш' THEN 'sh'
      WHEN 'щ' THEN 'shch'
      WHEN 'ъ' THEN ''
      WHEN 'ы' THEN 'y'
      WHEN 'ь' THEN ''
      WHEN 'э' THEN 'e'
      WHEN 'ю' THEN 'yu'
      WHEN 'я' THEN 'ya'
      ELSE character
    END;
  END LOOP;
  RETURN result;
END;
$function$;

ALTER TABLE "MemorySearchEntry"
  ADD COLUMN "searchVectorEnglish" tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, COALESCE("normalizedSearchText", ''::text))
  ) STORED,
  ADD COLUMN "searchVectorRussian" tsvector GENERATED ALWAYS AS (
    to_tsvector('russian'::regconfig, COALESCE("normalizedSearchText", ''::text))
  ) STORED,
  ADD COLUMN "trigramSearchText" text GENERATED ALWAYS AS (
    left(COALESCE("normalizedSearchText", ''::text), 4000) || ' ' ||
    left(aiqsa_memory_transliterate_ru(
      COALESCE("normalizedSearchText", ''::text)
    ), 16000)
  ) STORED;

CREATE INDEX "MemorySearchEntry_english_gin_idx"
  ON "MemorySearchEntry" USING gin ("searchVectorEnglish");

CREATE INDEX "MemorySearchEntry_russian_gin_idx"
  ON "MemorySearchEntry" USING gin ("searchVectorRussian");

CREATE INDEX "MemorySearchEntry_trigram_gin_idx"
  ON "MemorySearchEntry" USING gin ("trigramSearchText" gin_trgm_ops);
