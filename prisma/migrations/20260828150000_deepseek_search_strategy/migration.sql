ALTER TABLE "SearchStrategy"
  DROP CONSTRAINT "SearchStrategy_provider_model_check";

ALTER TABLE "SearchStrategy"
  ADD CONSTRAINT "SearchStrategy_provider_model_check" CHECK (
    (kind = ANY (ARRAY['perplexity_tool_search'::text, 'provider_model_web_search'::text]))
      AND "providerModelId" IS NOT NULL
    OR kind = 'gemini_google_search'::text
      AND (
        "adapterKind" = 'answer_provider_hosted'::text
          AND "credentialMode" = 'answer_provider'::text
          AND "providerModelId" IS NULL
        OR "adapterKind" = 'provider_model_client'::text
          AND "credentialMode" = 'provider_model'::text
          AND "providerModelId" IS NOT NULL
      )
    OR (kind = ANY (ARRAY['anthropic_native_web_search'::text, 'deepseek_native_web_search'::text]))
      AND "adapterKind" = 'answer_provider_hosted'::text
      AND "credentialMode" = 'answer_provider'::text
      AND "providerModelId" IS NULL
    OR (kind = ANY (ARRAY['none'::text, 'openai_native_web_search'::text]))
      AND "providerModelId" IS NULL
  );
