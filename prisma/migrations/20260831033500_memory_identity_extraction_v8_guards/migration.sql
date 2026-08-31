-- Extend every existing database-owned vNext extraction fence to the exact
-- pipeline that captures the selected identity profile in its input/job ID.
DO $migration$
DECLARE
  function_identity regprocedure;
  function_definition text;
BEGIN
  FOREACH function_identity IN ARRAY ARRAY[
    'aiqsa_memory_fact_extraction_execution_guard()'::regprocedure,
    'aiqsa_memory_auxiliary_semantic_call_guard()'::regprocedure,
    'aiqsa_memory_fact_extraction_binding_guard()'::regprocedure,
    'aiqsa_memory_job_source_message_guard()'::regprocedure
  ]
  LOOP
    function_definition := pg_get_functiondef(function_identity);
    IF position('memory-fact-extraction-vnext-v8' IN function_definition) = 0 THEN
      function_definition := replace(
        function_definition,
        '''memory-fact-extraction-vnext-v7''',
        '''memory-fact-extraction-vnext-v7'', ''memory-fact-extraction-vnext-v8'''
      );
      IF position('memory-fact-extraction-vnext-v8' IN function_definition) = 0 THEN
        RAISE EXCEPTION 'Memory extraction guard v8 extension failed for %',
          function_identity;
      END IF;
      EXECUTE function_definition;
    END IF;
  END LOOP;
END;
$migration$;
