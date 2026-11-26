/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const SEARCH_SONAR_RETIRED_MIGRATION = "20261126130000_search_sonar_retired";

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const BEFORE = "2026-11-20 07:00:00";
const POLICY_VERSION = 7;

/** One digest of a table's rows (those `where` keeps), so a proof can show the migration left them as they were. */
const rowsDigest = (table: string, where = "true"): string =>
  `(SELECT md5(COALESCE(string_agg(to_jsonb(r)::text, ',' ORDER BY to_jsonb(r)::text), '')) FROM "${table}" AS r WHERE ${where})`;

/** What the migration must not rewrite: everything but the Sonar sources, their routes and the policy. */
const keptDigest = `md5(concat_ws('|', ${[
  rowsDigest("User"), rowsDigest("UserSettings"), rowsDigest("Group"), rowsDigest("AccessGrant"),
  rowsDigest("ProviderConnection"), rowsDigest("ProviderModel"), rowsDigest("SearchIntegrationRevision"),
  rowsDigest("AssistantDefinition"), rowsDigest("Chat"),
  rowsDigest("SearchOption", `r.kind <> 'perplexity_search'`),
  rowsDigest("SearchStrategy", `r.kind <> 'perplexity_tool_search'`)
].join(", ")}))`;

type Source = Readonly<{
  connectionId: string;
  createdAt: string;
  /** False: the administrator turned the source off. */
  enabled?: false;
  kind: "deepseek_search_api" | "perplexity_search" | "web_search";
  optionId: string;
  /** The client route's protocol and, for OpenRouter's web search, its engine. */
  protocol: "deepseek_search_api" | "openrouter_perplexity_chat" | "openrouter_web_search";
  openRouterEngine?: "parallel" | "perplexity";
}>;

/** Every source an installation of these shapes may hold, each with the client route its setup writes. */
const SOURCES: Readonly<Record<string, Source>> = {
  orWeb: {
    connectionId: "ssr-openrouter", createdAt: "2026-10-01 07:00:00", kind: "web_search", openRouterEngine: "perplexity",
    optionId: "ssr-openrouter-web", protocol: "openrouter_web_search"
  },
  orWebParallel: {
    connectionId: "ssr-openrouter", createdAt: "2026-10-01 07:00:00", kind: "web_search", openRouterEngine: "parallel",
    optionId: "ssr-openrouter-web", protocol: "openrouter_web_search"
  },
  sonar: {
    connectionId: "ssr-openrouter", createdAt: "2026-10-02 07:00:00", kind: "perplexity_search", optionId: "ssr-sonar",
    protocol: "openrouter_perplexity_chat"
  },
  // A second OpenRouter connection whose Perplexity web search is live: never the replacement of another one's Sonar.
  orWebOther: {
    connectionId: "ssr-openrouter-2", createdAt: "2026-10-03 07:00:00", kind: "web_search", openRouterEngine: "perplexity",
    optionId: "ssr-openrouter-2-web", protocol: "openrouter_web_search"
  },
  sonarOther: {
    connectionId: "ssr-openrouter-2", createdAt: "2026-10-04 07:00:00", kind: "perplexity_search", optionId: "ssr-sonar-2",
    protocol: "openrouter_perplexity_chat"
  },
  // A third one whose Perplexity web search is switched off: no replacement either.
  orWebOff: {
    connectionId: "ssr-openrouter-3", createdAt: "2026-10-05 07:00:00", enabled: false, kind: "web_search",
    openRouterEngine: "perplexity", optionId: "ssr-openrouter-3-web", protocol: "openrouter_web_search"
  },
  sonarOff: {
    connectionId: "ssr-openrouter-3", createdAt: "2026-10-06 07:00:00", kind: "perplexity_search", optionId: "ssr-sonar-3",
    protocol: "openrouter_perplexity_chat"
  },
  deepSeek: {
    connectionId: "ssr-deepseek", createdAt: "2026-10-07 07:00:00", kind: "deepseek_search_api",
    optionId: "ssr-deepseek-api", protocol: "deepseek_search_api"
  }
};

export type SearchSonarRetiredShape = Readonly<{
  /** The policy as the previous migration left it. */
  before: Readonly<{ backup: string | null; defaultPlan: string; engine: string | null }>;
  /** What the migration makes of it; null: the policy stays exactly as it was. */
  after: Readonly<{ backup: string | null; defaultPlan: string; engine: string | null }> | null;
  name: string;
  sources: readonly (keyof typeof SOURCES)[];
}>;

const plan = (...ids: string[]) => JSON.stringify({ mode: "all_selected", optionIds: ids });

/** Each proof starts from its own database, since the policy is a singleton. */
export const SEARCH_SONAR_RETIRED_SHAPES: readonly SearchSonarRetiredShape[] = [
  {
    // Sonar is the engine: OpenRouter's Perplexity web search on its connection takes over; the backup stays.
    after: { backup: "ssr-deepseek-api", defaultPlan: plan("ssr-openrouter-web", "ssr-deepseek-api"), engine: "ssr-openrouter-web" },
    before: { backup: "ssr-deepseek-api", defaultPlan: plan("ssr-sonar", "ssr-deepseek-api"), engine: "ssr-sonar" },
    name: "sonar_engine",
    sources: ["orWeb", "sonar", "deepSeek"]
  },
  {
    // No live Perplexity web search on the Sonar sources' own connections (Parallel there, Perplexity switched off
    // there), only on another connection: both become Automatic, and the plan is empty.
    after: { backup: null, defaultPlan: plan(), engine: null },
    before: { backup: "ssr-sonar-3", defaultPlan: plan("ssr-sonar", "ssr-sonar-3"), engine: "ssr-sonar" },
    name: "sonar_engine_without_perplexity",
    sources: ["orWebParallel", "sonar", "orWebOther", "sonarOther", "orWebOff", "sonarOff", "deepSeek"]
  },
  {
    // Sonar is the backup: the Perplexity web search becomes the backup.
    after: { backup: "ssr-openrouter-web", defaultPlan: plan("ssr-deepseek-api", "ssr-openrouter-web"), engine: "ssr-deepseek-api" },
    before: { backup: "ssr-sonar", defaultPlan: plan("ssr-deepseek-api", "ssr-sonar"), engine: "ssr-deepseek-api" },
    name: "sonar_backup",
    sources: ["orWeb", "sonar", "deepSeek"]
  },
  {
    // Sonar backs up the Perplexity web search that replaces it: the backup would equal the engine, so it goes.
    after: { backup: null, defaultPlan: plan("ssr-openrouter-web"), engine: "ssr-openrouter-web" },
    before: { backup: "ssr-sonar", defaultPlan: plan("ssr-openrouter-web", "ssr-sonar"), engine: "ssr-openrouter-web" },
    name: "sonar_backup_of_its_replacement",
    sources: ["orWeb", "sonar"]
  },
  {
    // Sonar is there but neither engine nor backup: the policy stays as it is.
    after: null,
    before: { backup: "ssr-openrouter-web", defaultPlan: plan("ssr-deepseek-api", "ssr-openrouter-web"), engine: "ssr-deepseek-api" },
    name: "sonar_not_chosen",
    sources: ["orWeb", "sonar", "deepSeek"]
  },
  {
    // No Sonar at all: nothing changes.
    after: null,
    before: { backup: null, defaultPlan: plan(), engine: null },
    name: "no_sonar",
    sources: ["orWeb", "deepSeek"]
  }
];

function routeConfiguration(source: Source, modelId: string): string {
  return JSON.stringify({
    adapterKind: "provider_model_client",
    credentialMode: "provider_model",
    maxOutputTokens: 1024,
    ...(source.openRouterEngine
      ? { openRouterWebSearch: { engine: source.openRouterEngine, mode: source.openRouterEngine === "parallel" ? "fast" : null } }
      : {}),
    protocol: source.protocol,
    providerModelId: modelId,
    queryMaxCharacters: 128,
    reasoningPolicy: "lowest_supported",
    timeoutMs: 60000
  });
}

function shapeSources(shape: SearchSonarRetiredShape): readonly Source[] {
  return shape.sources.map((key) => SOURCES[key]!);
}

/**
 * An installation of the shape before the migration: its connections, technical models and sources with their live
 * client routes, the engine policy, and the stored plans, grants, Assistant and chat override that name a Sonar source
 * where the shape has one.
 */
export function searchSonarRetiredFixtureSql(shape: SearchSonarRetiredShape): string {
  const sources = shapeSources(shape);
  const connections = [...new Set(sources.map((source) => source.connectionId))];
  const named = sources.find((source) => source.kind === "perplexity_search")?.optionId ?? sources[0]!.optionId;
  const nullable = (value: string | null) => value === null ? "NULL" : quote(value);
  const options: string[] = [];
  const routes: string[] = [];
  const revisions: string[] = [];
  const models: string[] = [];
  for (const source of sources) {
    const row = `${source.optionId}-row`;
    const route = `${source.optionId}-route`;
    const revision = `${source.optionId}-revision`;
    const model = `${source.optionId}-model`;
    const kind = source.kind === "perplexity_search" ? "perplexity_tool_search" : "provider_model_web_search";
    const enabled = source.enabled === false ? "false" : "true";
    models.push(`(${quote(model)}, ${quote(source.connectionId)}, 'synthetic', ${quote(model)}, ${quote(`Synthetic ${model}`)}, ` +
      `'answer', '{}', '{}', now())`);
    options.push(`(${quote(row)}, ${quote(source.optionId)}, ${quote(`Synthetic ${source.optionId}`)}, 'Synthetic source.', ` +
      `${quote(source.kind)}, ${quote(source.connectionId)}, ${enabled}, NULL, ${quote(source.createdAt)}, ${quote(BEFORE)})`);
    routes.push(`(${quote(route)}, ${quote(row)}, ${quote(route)}, 'openrouter', ${quote(model)}, 'Synthetic route', ` +
      `${quote(kind)}, 'Synthetic route.', '{}', 'provider_model_client', 'provider_model', true, ${quote(revision)}, ` +
      `${quote(BEFORE)}, ${quote(BEFORE)})`);
    revisions.push(`(${quote(revision)}, ${quote(route)}, 1, 'provider_model_client', 'provider_model', ` +
      `${quote(routeConfiguration(source, model))}::jsonb, ${quote(model)}, '{"status":"available"}', ` +
      `${quote(`${revision}-hash`)}, ${quote(`${revision}-fingerprint`)}, ${quote(BEFORE)})`);
  }
  const off = JSON.stringify({ mode: "all_selected", optionIds: [] });
  const on = JSON.stringify({ mode: "all_selected", optionIds: [named] });
  return `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt") VALUES
  ${connections.map((id) => `(${quote(id)}, ${quote(`Synthetic ${id}`)}, ${id.includes("deepseek") ? "'deepseek'" : "'openrouter'"}, now())`).join(",\n  ")};
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", "modelClass", capabilities, "defaultParams", "updatedAt") VALUES
  ${models.join(",\n  ")};
INSERT INTO "SearchOption" (id, "optionId", "displayName", description, kind, "sourceConnectionId", enabled, "archivedAt", "createdAt", "updatedAt") VALUES
  ${options.join(",\n  ")};
INSERT INTO "SearchStrategy" (id, "searchOptionId", "strategyId", provider, "providerModelId", "displayName", kind, description, config, "adapterKind", "credentialMode", enabled, "activeRevisionId", "activatedAt", "updatedAt") VALUES
  ${routes.join(",\n  ")};
INSERT INTO "SearchIntegrationRevision" (id, "searchStrategyId", "revisionNumber", "adapterKind", "credentialMode", configuration, "providerModelId", "validationEvidence", "draftHash", "validationFingerprint", "createdAt") VALUES
  ${revisions.join(",\n  ")};
UPDATE "SearchPolicy" SET "engineOptionId" = ${nullable(shape.before.engine)}, "backupOptionId" = ${nullable(shape.before.backup)},
  "defaultPlan" = ${quote(shape.before.defaultPlan)}::jsonb, "inAnswerSearch" = false, version = ${POLICY_VERSION},
  "updatedAt" = ${quote(BEFORE)}
WHERE id = 'installation';

INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES
  ('ssr-user', 'Synthetic user', 'active', ${quote(BEFORE)}),
  ('ssr-off', 'Synthetic off', 'active', ${quote(BEFORE)});
INSERT INTO "UserSettings" (id, "userId", "defaultSearchPlan", "updatedAt") VALUES
  ('ssr-user-settings', 'ssr-user', ${quote(on)}, ${quote(BEFORE)}),
  ('ssr-off-settings', 'ssr-off', ${quote(off)}, ${quote(BEFORE)});
INSERT INTO "Group" (id, name, "updatedAt") VALUES ('ssr-group', 'Synthetic group', ${quote(BEFORE)});
INSERT INTO "AccessGrant" (id, "userId", "groupId", "searchStrategy", enabled, "updatedAt") VALUES
  ('ssr-grant-user', 'ssr-user', NULL, ${quote(named)}, true, ${quote(BEFORE)}),
  ('ssr-grant-group', NULL, 'ssr-group', ${quote(named)}, true, ${quote(BEFORE)});
INSERT INTO "AssistantDefinition" (id, "ownerUserId", name, avatar, "providerModelId", "systemPrompt", "searchPlan", "searchPolicy", "updatedAt") VALUES
  ('ssr-assistant', 'ssr-user', 'Synthetic assistant', '{}', ${quote(`${sources[0]!.optionId}-model`)}, 'Synthetic instructions.', ${quote(on)}, 'adjustable', ${quote(BEFORE)});
INSERT INTO "Chat" (id, "userId", title, "assistantId", "assistantOverrides", "createdAt", "updatedAt") VALUES
  ('ssr-chat', 'ssr-user', 'Synthetic chat', 'ssr-assistant', ${quote(JSON.stringify({ search: JSON.parse(on) }))}, ${quote(BEFORE)}, ${quote(BEFORE)});
COMMIT;
CREATE TABLE "_SearchSonarRetiredFixture" AS SELECT ${keptDigest} AS kept;
`;
}

/**
 * The policy became what the shape names, with a new version, or stayed exactly as it was; the in-answer switch kept
 * its value; every Sonar source and route is archived and off; and every other row, revisions included, is unchanged.
 */
export function searchSonarRetiredProofSql(shape: SearchSonarRetiredShape): string {
  const nullable = (value: string | null) => value === null ? "NULL" : quote(value);
  const expected = shape.after ?? shape.before;
  const version = shape.after ? POLICY_VERSION + 1 : POLICY_VERSION;
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SearchPolicy" WHERE id = 'installation'
      AND "engineOptionId" IS NOT DISTINCT FROM ${nullable(expected.engine)}
      AND "backupOptionId" IS NOT DISTINCT FROM ${nullable(expected.backup)}
      AND "defaultPlan" = ${quote(expected.defaultPlan)}::jsonb
      AND "inAnswerSearch" = false
      AND version = ${version}
      AND ${shape.after ? `"updatedAt" > ${quote(BEFORE)}` : `"updatedAt" = ${quote(BEFORE)}`})
  THEN RAISE EXCEPTION 'search_sonar_retired_policy_${shape.name}'; END IF;
  IF EXISTS (SELECT 1 FROM "SearchOption" WHERE kind = 'perplexity_search' AND (enabled OR "archivedAt" IS NULL))
    OR EXISTS (SELECT 1 FROM "SearchStrategy" WHERE kind = 'perplexity_tool_search' AND (enabled OR "archivedAt" IS NULL))
  THEN RAISE EXCEPTION 'search_sonar_retired_source_live_${shape.name}'; END IF;
  IF (SELECT kept FROM "_SearchSonarRetiredFixture") IS DISTINCT FROM ${keptDigest}
  THEN RAISE EXCEPTION 'search_sonar_retired_changed_other_rows_${shape.name}'; END IF;
END $$;
`;
}
