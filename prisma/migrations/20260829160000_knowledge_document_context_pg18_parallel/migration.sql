-- These validators catch malformed payload errors through PL/pgSQL exception
-- blocks. They must run in the leader because exception blocks use a
-- subtransaction. Their helper lookup must also survive pg_dump's empty
-- search_path while restored rows are checked.
ALTER FUNCTION public.knowledge_document_context_valid(JSONB)
  PARALLEL RESTRICTED;
ALTER FUNCTION public.knowledge_document_context_valid(JSONB)
  SET search_path TO pg_catalog, public;

ALTER FUNCTION public.knowledge_exact_receipt_valid(TEXT, JSONB)
  PARALLEL RESTRICTED;
ALTER FUNCTION public.knowledge_exact_receipt_valid(TEXT, JSONB)
  SET search_path TO pg_catalog, public;

ALTER FUNCTION public.knowledge_discovery_receipt_valid(TEXT, JSONB)
  PARALLEL RESTRICTED;
ALTER FUNCTION public.knowledge_discovery_receipt_valid(TEXT, JSONB)
  SET search_path TO pg_catalog, public;

-- These two validators do not open exception blocks and remain parallel-safe,
-- but they resolve the same public helper and therefore need a fixed path for
-- logical restore as well.
ALTER FUNCTION public.knowledge_structured_receipt_valid(JSONB)
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.knowledge_visual_receipt_valid(JSONB)
  SET search_path TO pg_catalog, public;
