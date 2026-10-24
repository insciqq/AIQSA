/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const SEARCH_ON_FOR_EVERYONE_MIGRATION = "20261024120000_search_on_for_everyone";

const AVATAR = '{"kind":"generated","recipeVersion":1,"paletteId":"ember","backgroundShape":"circle","foregroundShape":"ring","rotations":[0,0],"accents":[]}';

/** A DeepSeek connection with its retired hosted Search and the Search API,
 * working or with its key-carrying model disabled, plus every kind of stored
 * plan that names the hosted one. */
function fixture(apiWorking: boolean): string {
  return `
INSERT INTO "ProviderConnection" (id, "displayName", family, enabled, "activeVersion", "updatedAt")
VALUES ('sofe-deepseek', 'Synthetic DeepSeek', 'deepseek', true, 1, now()),
  ('sofe-openrouter', 'Synthetic OpenRouter', 'openrouter', true, 1, now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", enabled,
  "activeVersion", "updatedAt")
VALUES ('sofe-deepseek-model', 'sofe-deepseek', 'deepseek', 'deepseek-v4-pro', 'Synthetic DeepSeek model', '{}', '{}', ${apiWorking},
  1, now());
INSERT INTO "SearchOption" (id, "optionId", "displayName", description, kind, "sourceConnectionId", enabled, "updatedAt")
VALUES ('sofe-hosted', 'deepseek-native-web-search', 'DeepSeek Search', 'Synthetic hosted', 'web_search', 'sofe-deepseek', true, now()),
  ('sofe-api', 'deepseek-search-api', 'DeepSeek Search API', 'Synthetic API', 'deepseek_search_api', 'sofe-deepseek', true, now()),
  ('sofe-perplexity', 'perplexity-x', 'Perplexity', 'Synthetic Perplexity', 'perplexity_search', 'sofe-openrouter', true, now());
INSERT INTO "SearchStrategy" (id, "searchOptionId", "strategyId", provider, "modelId", "providerModelId",
  "displayName", kind, description, config, "adapterKind", "credentialMode", "updatedAt")
VALUES ('sofe-hosted-client', 'sofe-hosted', 'deepseek-search-client:sofe', 'deepseek', 'deepseek-v4-pro', 'sofe-deepseek-model',
    'Synthetic hosted route', 'provider_model_web_search', 'Synthetic route', '{}', 'provider_model_client', 'provider_model', now()),
  ('sofe-api-client', 'sofe-api', 'deepseek-search-api:client', 'deepseek', 'deepseek-search-api', 'sofe-deepseek-model',
    'Synthetic API route', 'provider_model_web_search', 'Synthetic route', '{}', 'provider_model_client', 'provider_model', now());
INSERT INTO "SearchIntegrationRevision" (id, "searchStrategyId", "revisionNumber", "adapterKind", "credentialMode",
  configuration, "providerModelId", "validationEvidence", "draftHash", "validationFingerprint")
VALUES ('sofe-api-revision', 'sofe-api-client', 1, 'provider_model_client', 'provider_model',
  '{"protocol":"deepseek_search_api","providerModelId":"sofe-deepseek-model"}', 'sofe-deepseek-model',
  '{"verified":true}', 'synthetic-draft-hash', 'synthetic-validation');
UPDATE "SearchStrategy" SET "activeRevisionId" = 'sofe-api-revision', "activatedAt" = now() WHERE id = 'sofe-api-client';

INSERT INTO "User" (id, "displayName", status, "updatedAt")
SELECT 'sofe-user-' || value, 'Synthetic user', 'active', now() FROM generate_series(1, 7) AS value;
INSERT INTO "UserSettings" (id, "userId", "defaultSearchPlan", "updatedAt") VALUES
  ('sofe-off', 'sofe-user-1', '{"mode":"all_selected","optionIds":[]}', now()),
  ('sofe-mixed', 'sofe-user-2', '{"mode":"model_choice","optionIds":["deepseek-native-web-search","perplexity-x"]}', now()),
  ('sofe-both', 'sofe-user-3', '{"mode":"model_choice","optionIds":["deepseek-native-web-search","deepseek-search-api"]}', now()),
  ('sofe-inherit', 'sofe-user-4', NULL, now()),
  ('sofe-kept', 'sofe-user-5', '{"mode":"all_selected","optionIds":["perplexity-x"]}', now()),
  ('sofe-broken', 'sofe-user-6', '{"broken":true}', now()),
  ('sofe-only-hosted', 'sofe-user-7', '{"mode":"model_choice","optionIds":["deepseek-native-web-search"]}', now());
UPDATE "SearchPolicy" SET "defaultPlan" = '{"mode":"model_choice","optionIds":["deepseek-native-web-search"]}', version = 3
WHERE id = 'installation';

INSERT INTO "Group" (id, name, "updatedAt") VALUES ('sofe-group', 'Synthetic group', now());
INSERT INTO "AccessGrant" (id, "groupId", "userId", "searchStrategy", enabled, "updatedAt") VALUES
  ('sofe-grant-group', 'sofe-group', NULL, 'deepseek-native-web-search', true, now()),
  ('sofe-grant-user', NULL, 'sofe-user-1', 'deepseek-native-web-search', true, now()),
  ('sofe-grant-off', NULL, 'sofe-user-2', 'deepseek-native-web-search', false, now()),
  ('sofe-grant-user-3', NULL, 'sofe-user-3', 'deepseek-native-web-search', true, now()),
  ('sofe-grant-api-disabled', NULL, 'sofe-user-3', 'deepseek-search-api', false, now());

INSERT INTO "TelegramLink" (id, "userId", "botId", "telegramUserId", "telegramChatId", "searchEnabled") VALUES
  ('sofe-telegram-off', 'sofe-user-1', 1, 101, 101, false),
  ('sofe-telegram-on', 'sofe-user-2', 1, 102, 102, true);

INSERT INTO "AssistantDefinition" (id, "ownerUserId", name, avatar, "systemPrompt", "searchPlan", "searchPolicy",
  "modelPolicy", version, "updatedAt")
VALUES ('sofe-assistant-fixed', 'sofe-user-1', 'Synthetic fixed', '${AVATAR}', 'Synthetic instructions',
    '{"mode":"model_choice","optionIds":["deepseek-native-web-search"]}', 'fixed', 'adjustable', 4, now()),
  ('sofe-assistant-mixed', 'sofe-user-1', 'Synthetic mixed', '${AVATAR}', 'Synthetic instructions',
    '{"mode":"model_choice","optionIds":["perplexity-x","deepseek-native-web-search"]}', 'adjustable', 'adjustable', 2, now()),
  ('sofe-assistant-off', 'sofe-user-1', 'Synthetic off', '${AVATAR}', 'Synthetic instructions',
    '{"mode":"off"}', 'fixed', 'adjustable', 7, now());

INSERT INTO "Chat" (id, "userId", title, "memoryMode", "assistantOverrides", "updatedAt") VALUES
  ('sofe-chat-mixed', 'sofe-user-1', 'Synthetic chat', 'EXCLUDED',
    '{"search":{"mode":"all_selected","optionIds":["deepseek-native-web-search","perplexity-x"]},"tools":{"mode":"off"}}', now()),
  ('sofe-chat-only', 'sofe-user-1', 'Synthetic chat', 'EXCLUDED',
    '{"search":{"mode":"model_choice","optionIds":["deepseek-native-web-search"]}}', now()),
  ('sofe-chat-off', 'sofe-user-1', 'Synthetic chat', 'EXCLUDED', '{"search":{"mode":"off"}}', now());
`;
}

function proof(apiWorking: boolean): string {
  const replaced = apiWorking ? '["deepseek-search-api"]' : "[]";
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SearchOption" WHERE id = 'sofe-hosted' AND NOT enabled AND "archivedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "SearchStrategy" WHERE id = 'sofe-hosted-client' AND enabled)
  THEN RAISE EXCEPTION 'hosted_deepseek_search_still_offered'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "SearchOption" WHERE id = 'sofe-api' AND "archivedAt" IS NULL AND enabled)
    OR NOT EXISTS (SELECT 1 FROM "SearchStrategy" WHERE id = 'sofe-api-client' AND enabled)
  THEN RAISE EXCEPTION 'search_api_changed'; END IF;

  IF (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-off') IS NOT NULL
    OR (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-inherit') IS NOT NULL
    OR (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-broken') IS NOT NULL
  THEN RAISE EXCEPTION 'personal_search_still_off'; END IF;
  IF (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-mixed') IS DISTINCT FROM
      ('{"mode":"all_selected","optionIds":' || ${apiWorking ? `'["deepseek-search-api","perplexity-x"]'` : `'["perplexity-x"]'`} || '}')::jsonb
    OR (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-kept') IS DISTINCT FROM
      '{"mode":"all_selected","optionIds":["perplexity-x"]}'::jsonb
  THEN RAISE EXCEPTION 'personal_search_sources_changed'; END IF;
  IF ${apiWorking} AND ((SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-both') IS DISTINCT FROM
      '{"mode":"all_selected","optionIds":["deepseek-search-api"]}'::jsonb
    OR (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-only-hosted') IS DISTINCT FROM
      '{"mode":"all_selected","optionIds":["deepseek-search-api"]}'::jsonb)
  THEN RAISE EXCEPTION 'personal_search_not_moved_to_api'; END IF;
  IF NOT ${apiWorking} AND (SELECT "defaultSearchPlan" FROM "UserSettings" WHERE id = 'sofe-only-hosted') IS NOT NULL
  THEN RAISE EXCEPTION 'personal_search_left_without_source'; END IF;

  IF NOT EXISTS (SELECT 1 FROM "SearchPolicy" WHERE id = 'installation' AND version = 4
      AND "defaultPlan" = '{"mode":"all_selected","optionIds":${replaced}}'::jsonb)
  THEN RAISE EXCEPTION 'organization_default_not_moved'; END IF;

  IF ${apiWorking} AND (
      NOT EXISTS (SELECT 1 FROM "AccessGrant" WHERE "groupId" = 'sofe-group' AND "searchStrategy" = 'deepseek-search-api' AND enabled)
      OR NOT EXISTS (SELECT 1 FROM "AccessGrant" WHERE "userId" = 'sofe-user-1' AND "searchStrategy" = 'deepseek-search-api' AND enabled))
  THEN RAISE EXCEPTION 'grant_not_carried_to_api'; END IF;
  IF EXISTS (SELECT 1 FROM "AccessGrant" WHERE "userId" = 'sofe-user-2' AND "searchStrategy" = 'deepseek-search-api')
    OR EXISTS (SELECT 1 FROM "AccessGrant" WHERE "userId" = 'sofe-user-3' AND "searchStrategy" = 'deepseek-search-api' AND enabled)
    OR (SELECT count(*) FROM "AccessGrant" WHERE "searchStrategy" = 'deepseek-search-api') <> ${apiWorking ? 3 : 1}
  THEN RAISE EXCEPTION 'grant_widened_beyond_hosted_holders'; END IF;

  IF EXISTS (SELECT 1 FROM "TelegramLink" WHERE NOT "searchEnabled")
  THEN RAISE EXCEPTION 'telegram_search_still_off'; END IF;

  IF NOT EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE id = 'sofe-assistant-fixed' AND version = 4 AND
      ${apiWorking
        ? `"searchPolicy" = 'fixed' AND "searchPlan" = '{"mode":"model_choice","optionIds":["deepseek-search-api"]}'::jsonb`
        : `"searchPolicy" = 'adjustable' AND "searchPlan" = '{"mode":"inherit"}'::jsonb`})
    OR NOT EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE id = 'sofe-assistant-mixed' AND version = 2 AND
      "searchPolicy" = 'adjustable' AND "searchPlan" = ('{"mode":"model_choice","optionIds":' ||
        ${apiWorking ? `'["perplexity-x","deepseek-search-api"]'` : `'["perplexity-x"]'`} || '}')::jsonb)
    OR NOT EXISTS (SELECT 1 FROM "AssistantDefinition" WHERE id = 'sofe-assistant-off' AND version = 7 AND
      "searchPlan" = '{"mode":"off"}'::jsonb)
  THEN RAISE EXCEPTION 'assistant_search_or_version_changed'; END IF;

  IF (SELECT "assistantOverrides" FROM "Chat" WHERE id = 'sofe-chat-mixed') IS DISTINCT FROM
      ('{"search":{"mode":"all_selected","optionIds":' || ${apiWorking ? `'["deepseek-search-api","perplexity-x"]'` : `'["perplexity-x"]'`} ||
        '},"tools":{"mode":"off"}}')::jsonb
    OR (SELECT "assistantOverrides" FROM "Chat" WHERE id = 'sofe-chat-only') IS DISTINCT FROM
      ${apiWorking ? `'{"search":{"mode":"model_choice","optionIds":["deepseek-search-api"]}}'` : `'{}'`}::jsonb
    OR (SELECT "assistantOverrides" FROM "Chat" WHERE id = 'sofe-chat-off') IS DISTINCT FROM '{"search":{"mode":"off"}}'::jsonb
  THEN RAISE EXCEPTION 'assistant_chat_override_not_moved'; END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'aiqsa_search_plan_without_retired')
  THEN RAISE EXCEPTION 'migration_helper_left_behind'; END IF;
END $$;
`;
}

export const searchOnForEveryoneFixtureSql = fixture(true);
export const searchOnForEveryoneProofSql = proof(true);
export const searchOnForEveryoneWithoutApiFixtureSql = fixture(false);
export const searchOnForEveryoneWithoutApiProofSql = proof(false);
