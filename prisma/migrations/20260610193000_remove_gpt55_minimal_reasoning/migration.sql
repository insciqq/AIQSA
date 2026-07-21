UPDATE "UserSettings"
SET "defaultControlValues" = jsonb_set(
  "defaultControlValues",
  '{openai:gpt-5.5,reasoningEffort}',
  '"low"',
  false
)
WHERE "defaultControlValues" #>> '{openai:gpt-5.5,reasoningEffort}' = 'minimal';
