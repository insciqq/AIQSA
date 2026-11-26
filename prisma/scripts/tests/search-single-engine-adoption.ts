/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const SEARCH_SINGLE_ENGINE_MIGRATION = "20261126120000_search_single_engine";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const BEFORE = "2026-11-20 07:00:00";
const POLICY_VERSION = 4;

/** One digest of a table's rows, so a proof can show the migration left them as they were. */
const rowsDigest = (table: string): string =>
  `(SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY to_jsonb(r)::text), '')) FROM "${table}" AS r)`;

/** What the migration must not rewrite: the previous release still reads every one of these rows as stored. */
const keptDigest = `md5(concat_ws('|', ${[
  "User", "UserSettings", "Group", "AccessGrant", "ProviderConnection", "ProviderModel", "SearchOption", "SearchStrategy",
  "AssistantDefinition", "Chat"
].map(rowsDigest).join(", ")}))`;

type Connection = Readonly<{ family: string; id: string }>;
type Route = Readonly<{
  adapterKind: "answer_provider_hosted" | "provider_model_client";
  kind: string;
  providerModelId?: string;
}>;
type Source = Readonly<{
  archived?: true;
  connectionId: string;
  createdAt: string;
  kind: string;
  optionId: string;
  routes: readonly Route[];
}>;

const CONNECTIONS: Readonly<Record<string, Connection>> = {
  codex: { family: "openai_compatible", id: "sse-codex" },
  deepseek: { family: "deepseek", id: "sse-deepseek" },
  gemini: { family: "gemini", id: "sse-gemini" },
  openai: { family: "openai", id: "sse-openai" },
  openrouter: { family: "openrouter", id: "sse-openrouter" }
};

/** Every source an installation of these shapes may hold, each with the routes its setup writes. */
const SOURCES: Readonly<Record<string, Source>> = {
  // OpenAI web search on Codex LB: hosted search in the answer, and a client route with a technical model.
  codexOpenAi: {
    connectionId: "sse-codex", createdAt: "2026-10-01 07:00:00", kind: "web_search", optionId: "sse-codex-web",
    routes: [
      { adapterKind: "answer_provider_hosted", kind: "openai_native_web_search" },
      { adapterKind: "provider_model_client", kind: "provider_model_web_search", providerModelId: "sse-codex-luna" }
    ]
  },
  // OpenAI hosted search alone: no client route, so it can never be the engine.
  hostedOnly: {
    connectionId: "sse-openai", createdAt: "2026-10-02 07:00:00", kind: "web_search", optionId: "sse-openai-hosted",
    routes: [{ adapterKind: "answer_provider_hosted", kind: "openai_native_web_search" }]
  },
  openRouterPerplexity: {
    connectionId: "sse-openrouter", createdAt: "2026-10-03 07:00:00", kind: "web_search", optionId: "sse-openrouter-web",
    routes: [{ adapterKind: "provider_model_client", kind: "provider_model_web_search", providerModelId: "sse-openrouter-flash" }]
  },
  sonar: {
    connectionId: "sse-openrouter", createdAt: "2026-10-04 07:00:00", kind: "perplexity_search", optionId: "sse-sonar",
    routes: [{ adapterKind: "provider_model_client", kind: "perplexity_tool_search", providerModelId: "sse-sonar-model" }]
  },
  deepSeek: {
    connectionId: "sse-deepseek", createdAt: "2026-10-05 07:00:00", kind: "deepseek_search_api", optionId: "sse-deepseek-api",
    routes: [{ adapterKind: "provider_model_client", kind: "provider_model_web_search", providerModelId: "sse-deepseek-flash" }]
  },
  gemini: {
    connectionId: "sse-gemini", createdAt: "2026-10-06 07:00:00", kind: "gemini_google_search", optionId: "sse-gemini-search",
    routes: [{ adapterKind: "provider_model_client", kind: "gemini_google_search", providerModelId: "sse-gemini-flash" }]
  },
  archivedGemini: {
    archived: true, connectionId: "sse-gemini", createdAt: "2026-10-07 07:00:00", kind: "web_search",
    optionId: "sse-gemini-archived",
    routes: [{ adapterKind: "provider_model_client", kind: "provider_model_web_search", providerModelId: "sse-gemini-flash" }]
  }
};

export type SearchSingleEngineShape = Readonly<{
  /** What the migration makes of the organization default. */
  backup: string | null;
  connections: readonly (keyof typeof CONNECTIONS)[];
  /** The organization default, as the previous release stored it. */
  defaultPlan: string;
  engine: string | null;
  name: string;
  sources: readonly (keyof typeof SOURCES)[];
}>;

/**
 * The installations to keep working (search-v2): two run GPT through Codex LB, one of them with OpenRouter and
 * DeepSeek beside it, and one searches mainly with Gemini; plus an OpenRouter-only and a DeepSeek-only one. Each
 * proof starts from its own database, since the policy is a singleton.
 */
export const SEARCH_SINGLE_ENGINE_SHAPES: readonly SearchSingleEngineShape[] = [
  {
    // Several sources: the hosted-only one cannot be the engine, so the next two are the engine and the backup.
    backup: "sse-openrouter-web",
    connections: ["codex", "openai", "openrouter", "deepseek"],
    defaultPlan: '{"mode":"all_selected","optionIds":["sse-openai-hosted","sse-deepseek-api","sse-openrouter-web"]}',
    engine: "sse-deepseek-api",
    name: "codex_openrouter_deepseek",
    sources: ["codexOpenAi", "hostedOnly", "openRouterPerplexity", "sonar", "deepSeek"]
  },
  {
    // One source: the Gemini installation keeps Gemini as its chosen engine.
    backup: null,
    connections: ["gemini"],
    defaultPlan: '{"mode":"model_choice","optionIds":["sse-gemini-search"]}',
    engine: "sse-gemini-search",
    name: "gemini_only",
    sources: ["gemini"]
  },
  {
    // No source chosen: the default order picks the engine at run time (OpenAI's client route first).
    backup: null,
    connections: ["codex"],
    defaultPlan: '{"mode":"all_selected","optionIds":[]}',
    engine: null,
    name: "codex_only",
    sources: ["codexOpenAi"]
  },
  {
    // Perplexity Sonar stays the chosen engine until its own retirement moves it.
    backup: null,
    connections: ["openrouter"],
    defaultPlan: '{"mode":"all_selected","optionIds":["sse-sonar"]}',
    engine: "sse-sonar",
    name: "openrouter_only",
    sources: ["openRouterPerplexity", "sonar"]
  },
  {
    // An archived source is left out, and a default that repeats a source names it once.
    backup: null,
    connections: ["deepseek", "gemini"],
    defaultPlan: '{"mode":"all_selected","optionIds":["sse-gemini-archived","sse-deepseek-api","sse-deepseek-api"]}',
    engine: "sse-deepseek-api",
    name: "deepseek_only",
    sources: ["deepSeek", "archivedGemini"]
  }
];

function connectionRows(shape: SearchSingleEngineShape): string {
  return shape.connections.map((key) => {
    const connection = CONNECTIONS[key]!;
    return `(${quote(connection.id)}, ${quote(`Synthetic ${connection.family}`)}, ${quote(connection.family)}, now())`;
  }).join(",\n  ");
}

function modelRows(shape: SearchSingleEngineShape): string {
  const models = new Map<string, string>();
  for (const key of shape.sources) {
    const source = SOURCES[key]!;
    for (const route of source.routes) {
      if (route.providerModelId) models.set(route.providerModelId, source.connectionId);
    }
  }
  // The answer model of the Assistants.
  models.set("sse-answer", shape.sources.length ? SOURCES[shape.sources[0]!]!.connectionId : "sse-codex");
  return [...models].map(([id, connectionId]) =>
    `(${quote(id)}, ${quote(connectionId)}, 'synthetic', ${quote(id)}, ${quote(`Synthetic ${id}`)}, 'answer', '{}', '{}', now())`
  ).join(",\n  ");
}

function sourceRows(shape: SearchSingleEngineShape): Readonly<{ options: string; routes: string }> {
  const options: string[] = [];
  const routes: string[] = [];
  for (const key of shape.sources) {
    const source = SOURCES[key]!;
    options.push(`(${quote(`${source.optionId}-row`)}, ${quote(source.optionId)}, ${quote(`Synthetic ${key}`)}, ` +
      `'Synthetic source.', ${quote(source.kind)}, ${quote(source.connectionId)}, ${source.archived ? "false" : "true"}, ` +
      `${source.archived ? quote(BEFORE) : "NULL"}, ${quote(source.createdAt)}, ${quote(BEFORE)})`);
    source.routes.forEach((route, index) => {
      const id = `${source.optionId}-route-${index}`;
      routes.push(`(${quote(id)}, ${quote(`${source.optionId}-row`)}, ${quote(id)}, 'synthetic', ` +
        `${route.providerModelId ? quote(route.providerModelId) : "NULL"}, 'Synthetic route', ${quote(route.kind)}, ` +
        `'Synthetic route.', '{}', ${quote(route.adapterKind)}, ` +
        `${route.adapterKind === "provider_model_client" ? "'provider_model'" : "'answer_provider'"}, ${quote(BEFORE)})`);
    });
  }
  return { options: options.join(",\n  "), routes: routes.join(",\n  ") };
}

/** The first source of the shape, which the personal plans, Assistants, chats and grants name. */
function firstOption(shape: SearchSingleEngineShape): string {
  return SOURCES[shape.sources[0]!]!.optionId;
}

/**
 * An installation of the shape before the migration: its connections, models and sources with their routes, the
 * organization default, and the stored plans the new release reads as on or off: personal defaults with one source,
 * several sources, none (Off) and no plan; Assistants with a fixed plan, an adjustable plan, a fixed Off and an
 * adjustable Inherit; chats whose overrides name a source or say Off; and a user's and a group's Search grants.
 */
export function searchSingleEngineFixtureSql(shape: SearchSingleEngineShape): string {
  const sources = sourceRows(shape);
  const option = firstOption(shape);
  const plan = (mode: string, ids: readonly string[]) => quote(JSON.stringify({ mode, optionIds: ids }));
  const allOptions = shape.sources.map((key) => SOURCES[key]!.optionId);
  return `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt") VALUES
  ${connectionRows(shape)};
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities, "defaultParams", "updatedAt") VALUES
  ${modelRows(shape)};
INSERT INTO "SearchOption" (id, "optionId", "displayName", description, kind, "sourceConnectionId", enabled, "archivedAt", "createdAt", "updatedAt") VALUES
  ${sources.options};
INSERT INTO "SearchStrategy" (id, "searchOptionId", "strategyId", provider, "providerModelId", "displayName", kind, description, config, "adapterKind", "credentialMode", "updatedAt") VALUES
  ${sources.routes};
UPDATE "SearchPolicy" SET "defaultPlan" = ${quote(shape.defaultPlan)}::jsonb, version = ${POLICY_VERSION}, "updatedAt" = ${quote(BEFORE)}
WHERE id = 'installation';

INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
  ('sse-one', 'Synthetic one source', 'active', ${quote(BEFORE)}),
  ('sse-several', 'Synthetic several sources', 'active', ${quote(BEFORE)}),
  ('sse-off', 'Synthetic off', 'active', ${quote(BEFORE)}),
  ('sse-default', 'Synthetic default', 'active', ${quote(BEFORE)});
INSERT INTO "UserSettings" (id, "userId", "defaultSearchPlan", "updatedAt") VALUES
  ('sse-one-settings', 'sse-one', ${plan("all_selected", [option])}, ${quote(BEFORE)}),
  ('sse-several-settings', 'sse-several', ${plan("model_choice", allOptions.slice(0, 3))}, ${quote(BEFORE)}),
  ('sse-off-settings', 'sse-off', ${plan("all_selected", [])}, ${quote(BEFORE)}),
  ('sse-default-settings', 'sse-default', NULL, ${quote(BEFORE)});
INSERT INTO "Group" (id, name, "updatedAt") VALUES ('sse-group', 'Synthetic group', ${quote(BEFORE)});
INSERT INTO "AccessGrant" (id, "userId", "groupId", "searchStrategy", enabled, "updatedAt") VALUES
  ('sse-grant-user', 'sse-one', NULL, ${quote(option)}, true, ${quote(BEFORE)}),
  ('sse-grant-group', NULL, 'sse-group', ${quote(allOptions.at(-1)!)}, true, ${quote(BEFORE)});

INSERT INTO "AssistantDefinition" (id, "ownerUserId", name, avatar, "providerModelId", "systemPrompt", "searchPlan", "searchPolicy", "updatedAt") VALUES
  ('sse-assistant-fixed', 'sse-one', 'Synthetic fixed', '{}', 'sse-answer', 'Synthetic instructions.', ${plan("all_selected", allOptions.slice(0, 2))}, 'fixed', ${quote(BEFORE)}),
  ('sse-assistant-adjustable', 'sse-one', 'Synthetic adjustable', '{}', 'sse-answer', 'Synthetic instructions.', ${plan("model_choice", [option])}, 'adjustable', ${quote(BEFORE)}),
  ('sse-assistant-off', 'sse-one', 'Synthetic off', '{}', 'sse-answer', 'Synthetic instructions.', '{"mode":"off"}', 'fixed', ${quote(BEFORE)}),
  ('sse-assistant-inherit', 'sse-one', 'Synthetic inherit', '{}', 'sse-answer', 'Synthetic instructions.', '{"mode":"inherit"}', 'adjustable', ${quote(BEFORE)});
INSERT INTO "Chat" (id, "userId", title, "assistantId", "assistantOverrides", "createdAt", "updatedAt") VALUES
  ('sse-chat-sources', 'sse-several', 'Synthetic chat', 'sse-assistant-adjustable', ${quote(JSON.stringify({ search: { mode: "all_selected", optionIds: [option] } }))}, ${quote(BEFORE)}, ${quote(BEFORE)}),
  ('sse-chat-off', 'sse-several', 'Synthetic chat', 'sse-assistant-adjustable', '{"search":{"mode":"off"}}', ${quote(BEFORE)}, ${quote(BEFORE)});
COMMIT;
CREATE TABLE "_SearchSingleEngineFixture" AS SELECT ${keptDigest} AS kept;
`;
}

/**
 * The organization default became the engine and backup the shape names, the in-answer switch is on, the version
 * moved on so an Admin › Search page opened before the upgrade cannot write over it, the stored plan stays for the
 * previous release, and every personal plan, grant, source, Assistant and chat override is exactly as it was.
 */
export function searchSingleEngineProofSql(shape: SearchSingleEngineShape): string {
  const nullable = (value: string | null) => value === null ? "NULL" : quote(value);
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SearchPolicy" WHERE id = 'installation'
      AND "engineOptionId" IS NOT DISTINCT FROM ${nullable(shape.engine)}
      AND "backupOptionId" IS NOT DISTINCT FROM ${nullable(shape.backup)}
      AND "inAnswerSearch" = true
      AND version = ${POLICY_VERSION + 1}
      AND "defaultPlan" = ${quote(shape.defaultPlan)}::jsonb)
  THEN RAISE EXCEPTION 'search_single_engine_policy_${shape.name}'; END IF;
  IF (SELECT kept FROM "_SearchSingleEngineFixture") IS DISTINCT FROM ${keptDigest}
  THEN RAISE EXCEPTION 'search_single_engine_changed_stored_plans_${shape.name}'; END IF;
END $$;
`;
}
