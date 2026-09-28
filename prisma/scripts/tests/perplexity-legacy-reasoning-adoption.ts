import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const PERPLEXITY_LEGACY_REASONING_MIGRATION = "20260928220000_perplexity_legacy_reasoning";

// `migrate deploy` never replays an applied migration, so idempotency is proven
// by executing the committed body again inside the proof.
const migrationBody = readFileSync(join(dirname(fileURLToPath(import.meta.url)),
  "../../migrations", PERPLEXITY_LEGACY_REASONING_MIGRATION, "migration.sql"), "utf8");

const SEARCH_MODEL = "perplexity/sonar-pro-search";
const LEGACY = `{"effort":"medium","enabled":false,"exclude":true,"maxTokens":0}`;
const FIXED = `{"exclude":true}`;
// An explicit Off with another effort is a deliberate operator choice, not the template.
const EXPLICIT_OFF = `{"effort":"low","enabled":false,"exclude":true,"maxTokens":0}`;
const ENABLED = `{"effort":"high","enabled":true,"exclude":true,"maxTokens":0}`;
const NEAR_LEGACY = `{"effort":"medium","enabled":false,"exclude":true,"maxTokens":1024}`;
const LEGACY_UPDATED_AT = "2026-09-01 00:00:00";

type Place = "column" | "active" | "draft";
type Scenario = Readonly<{
  /** Reasoning object of the active configuration; null omits it, undefined leaves no active configuration. */
  active?: string | null;
  upstream?: string;
  adoptionPending?: boolean;
  changes: readonly Place[];
  column: string | null;
  /** Reasoning object of the draft configuration; undefined stores the empty default draft. */
  draft?: string;
  draftTemperature?: number;
  modelId?: string;
  name: string;
  provider?: string;
  templateKey?: string;
}>;

const scenarios: readonly Scenario[] = [
  // (в) An unedited quick-setup model: the draft equals the active configuration.
  { active: LEGACY, changes: ["column", "active", "draft"], column: LEGACY, draft: LEGACY, name: "template",
    templateKey: `openrouter:${SEARCH_MODEL}` },
  { active: EXPLICIT_OFF, changes: [], column: EXPLICIT_OFF, draft: EXPLICIT_OFF, name: "custom" },
  // (а) Active legacy with a pending custom draft: the draft is not the template value.
  { active: LEGACY, changes: ["column", "active"], column: LEGACY, draft: ENABLED, draftTemperature: 0.5,
    name: "active_legacy_draft_custom" },
  // (а) Active legacy with a pending draft that still carries its own exact legacy reasoning.
  { active: LEGACY, changes: ["column", "active", "draft"], column: LEGACY, draft: LEGACY, draftTemperature: 0.5,
    name: "active_legacy_draft_legacy" },
  // (б) Custom active reasoning with a pending draft that still carries the legacy value.
  { active: ENABLED, changes: ["draft"], column: ENABLED, draft: LEGACY, draftTemperature: 0.5,
    name: "active_custom_draft_legacy" },
  { active: FIXED, changes: [], column: FIXED, draft: FIXED, name: "already_fixed" },
  { active: null, changes: [], column: null, name: "absent" },
  { changes: ["column", "draft"], column: LEGACY, draft: LEGACY, name: "never_activated" },
  { active: LEGACY, upstream: "perplexity/sonar", changes: [], column: LEGACY, draft: LEGACY,
    modelId: "perplexity/sonar", name: "other_model" },
  { active: LEGACY, changes: [], column: LEGACY, draft: LEGACY, name: "other_provider", provider: "openai_compatible" },
  // Configurations whose own upstream is another model are not the template.
  { active: LEGACY, upstream: "perplexity/sonar-pro", changes: ["column"], column: LEGACY, draft: LEGACY,
    name: "other_upstream" },
  { active: NEAR_LEGACY, changes: [], column: NEAR_LEGACY, draft: NEAR_LEGACY, name: "near_legacy" },
  // A pre-v0.2.13 row whose native-routing adoption still runs at the next app start.
  { active: LEGACY, adoptionPending: true, changes: ["column", "active", "draft"], column: LEGACY, draft: LEGACY,
    name: "adoption_pending" }
];

const rowId = (name: string) => `perplexity-reasoning-${name}`;
const scenarioIds = scenarios.map(({ name }) => `'${rowId(name)}'`).join(", ");

function params(reasoning: string | null, temperature = 1): string {
  return `{"maxTokens":8192,"provider":{"allowFallbacks":true,"dataCollection":"deny","order":["perplexity"],` +
    `"sort":"throughput"},${reasoning === null ? "" : `"reasoning":${reasoning},`}"stream":true,` +
    `"temperature":${temperature}}`;
}

function configuration(upstream: string, reasoning: string | null, temperature?: number): string {
  return `{"adapterKind":"openrouter_chat_completions","answerSelectable":false,"capabilities":{"nativeSearch":true},` +
    `"defaultParams":${params(reasoning, temperature)},"modelClass":"answer",` +
    `"openRouterRouting":{"mode":"automatic","providers":[]},"upstreamModelId":"${upstream}"}`;
}

function modelRow(scenario: Scenario): string {
  const modelId = scenario.modelId ?? SEARCH_MODEL;
  const upstream = scenario.upstream ?? modelId;
  const provider = scenario.provider ?? "openrouter";
  const active = scenario.active === undefined ? null : configuration(upstream, scenario.active);
  const pending = scenario.draftTemperature !== undefined;
  const draft = scenario.draft === undefined ? "{}" : configuration(upstream, scenario.draft, scenario.draftTemperature);
  const activeVersion = active === null ? 0 : 3;
  const draftVersion = active === null ? 1 : pending ? 4 : 3;
  return `('${rowId(scenario.name)}', 'perplexity-reasoning-${provider}', ` +
    `${scenario.templateKey ? `'${scenario.templateKey}'` : "NULL"}, '${provider}', '${modelId}', ` +
    `'Synthetic ${scenario.name}', '{"nativeSearch":true}', '${params(scenario.column)}', '${draft}', ${draftVersion}, ` +
    `${active === null ? "NULL" : `'${active}'`}, ${activeVersion}, ` +
    `${active === null ? "NULL" : `TIMESTAMP '${LEGACY_UPDATED_AT}'`}, ${scenario.adoptionPending ? 0 : 1}, ` +
    `TIMESTAMP '${LEGACY_UPDATED_AT}')`;
}

const acceptedRequest = `{"searchPlan":{"mode":"all_selected","options":[{"config":` +
  `{"modelDefaultParams":{"reasoning":${LEGACY}}},"optionId":"perplexity-reasoning-search",` +
  `"protocol":"openrouter_perplexity_chat"}]}}`;

const relatedStateSql = `SELECT jsonb_build_object(
  'connections', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ProviderConnection" row_value),
  'credentials', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ProviderCredential" row_value),
  'credentialVersions', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ProviderCredentialVersion" row_value),
  'credentialChecks', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ProviderModelCredentialCheck" row_value),
  'draftChecks', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ProviderDraftCheck" row_value),
  'searchOptions', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "SearchOption" row_value),
  'searchStrategies', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "SearchStrategy" row_value),
  'searchRevisions', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "SearchIntegrationRevision" row_value),
  'runs', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ModelRun" row_value),
  'bindings', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id) FROM "ProviderRunBinding" row_value)
)`;

function modelsUnchangedSince(phase: string): string {
  return `(SELECT count(*) FROM "ProviderModel") <> (SELECT count(*) FROM "PerplexityReasoningFixture"
      WHERE phase = '${phase}') OR EXISTS (SELECT 1 FROM "PerplexityReasoningFixture" f
      LEFT JOIN "ProviderModel" m ON m.id = f.id WHERE f.phase = '${phase}' AND to_jsonb(m) IS DISTINCT FROM f.snapshot)`;
}

function expected(place: Place, changed: boolean): string {
  const source = place === "column" ? "defaultParams" : place === "active" ? "activeConfig" : "draftConfig";
  if (!changed) return `f.snapshot -> '${source}'`;
  return place === "column"
    ? `jsonb_set(f.snapshot -> 'defaultParams', '{reasoning}', '${FIXED}'::jsonb)`
    : `jsonb_set(f.snapshot -> '${source}', '{defaultParams,reasoning}', '${FIXED}'::jsonb)`;
}

function scenarioProof(scenario: Scenario): string {
  const changes = new Set(scenario.changes);
  return `
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" m
    JOIN "PerplexityReasoningFixture" f ON f.phase = 'before' AND f.id = m.id
    WHERE m.id = '${rowId(scenario.name)}'
      AND to_jsonb(m) -> 'defaultParams' = ${expected("column", changes.has("column"))}
      AND to_jsonb(m) -> 'activeConfig' = ${expected("active", changes.has("active"))}
      AND to_jsonb(m) -> 'draftConfig' = ${expected("draft", changes.has("draft"))}
      AND m."updatedAt" ${changes.size > 0 ? ">" : "="} (f.snapshot ->> 'updatedAt')::timestamp
      AND (to_jsonb(m) - ARRAY['defaultParams', 'activeConfig', 'draftConfig', 'updatedAt']) =
        (f.snapshot - ARRAY['defaultParams', 'activeConfig', 'draftConfig', 'updatedAt']))
    THEN RAISE EXCEPTION 'perplexity_reasoning_${scenario.name}_diff_wrong'; END IF;`;
}

export const perplexityLegacyReasoningFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('perplexity-reasoning-openrouter', 'Synthetic OpenRouter', 'openrouter', now()),
  ('perplexity-reasoning-openai_compatible', 'Synthetic compatible', 'openai_compatible', now());
INSERT INTO "ProviderModel" (id, "connectionId", "templateKey", provider, "modelId", "displayName", capabilities,
  "defaultParams", "draftConfig", "draftVersion", "activeConfig", "activeVersion", "activatedAt",
  "nativeRoutingAdoptionVersion", "updatedAt")
VALUES ${scenarios.map(modelRow).join(",\n  ")};
INSERT INTO "ProviderCredential" (id, "connectionId", label, enabled, "updatedAt")
VALUES ('perplexity-reasoning-credential', 'perplexity-reasoning-openrouter', 'Synthetic key', true, now());
INSERT INTO "ProviderCredentialVersion" (id, "credentialId", version, "testEvidence", "testedAt", "activatedAt")
VALUES ('perplexity-reasoning-credential-v1', 'perplexity-reasoning-credential', 1,
  '{"authenticationMode":"none"}', now(), now());
UPDATE "ProviderCredential" SET "activeVersionId" = 'perplexity-reasoning-credential-v1', "activatedAt" = now()
WHERE id = 'perplexity-reasoning-credential';
-- Active credential checks and draft checks are fenced by versions, never by reasoning.
INSERT INTO "ProviderModelCredentialCheck" (id, "connectionId", "providerModelId", "credentialId",
  "credentialVersionId", "connectionVersion", "modelVersion", status, evidence, "checkedAt", "updatedAt")
SELECT 'perplexity-reasoning-check-' || id, "connectionId", id, 'perplexity-reasoning-credential',
  'perplexity-reasoning-credential-v1', 1, "activeVersion", 'available'::"ProviderCredentialCheckStatus",
  '{"searchProbe":{"verified":true}}'::jsonb, TIMESTAMP '${LEGACY_UPDATED_AT}', TIMESTAMP '${LEGACY_UPDATED_AT}'
FROM "ProviderModel" WHERE "connectionId" = 'perplexity-reasoning-openrouter' AND "activeVersion" > 0;
INSERT INTO "ProviderDraftCheck" (id, fingerprint, "connectionId", "providerModelId", "credentialId",
  "credentialVersionId", "connectionDraftVersion", "modelDraftVersion", status, evidence, "checkedAt")
SELECT 'perplexity-reasoning-draft-check-' || id, 'perplexity-reasoning-fingerprint-' || id, "connectionId", id,
  'perplexity-reasoning-credential', 'perplexity-reasoning-credential-v1', 1, "draftVersion",
  'available'::"ProviderCredentialCheckStatus", '{}'::jsonb, TIMESTAMP '${LEGACY_UPDATED_AT}'
FROM "ProviderModel" WHERE "connectionId" = 'perplexity-reasoning-openrouter';
-- The accepted Search revision validated the model's active version.
INSERT INTO "SearchOption" (id, "optionId", "displayName", description, kind, "sourceConnectionId", "updatedAt")
VALUES ('perplexity-reasoning-option', 'perplexity-reasoning-search', 'Synthetic Perplexity',
  'Synthetic Search source', 'perplexity_search', 'perplexity-reasoning-openrouter', now());
INSERT INTO "SearchStrategy" (id, "searchOptionId", "strategyId", provider, "modelId", "providerModelId",
  "displayName", kind, description, config, "adapterKind", "credentialMode", "updatedAt")
VALUES ('perplexity-reasoning-strategy', 'perplexity-reasoning-option', 'perplexity-reasoning-route', 'openrouter',
  '${SEARCH_MODEL}', '${rowId("template")}', 'Synthetic Perplexity route', 'perplexity_tool_search',
  'Synthetic Search route', '{}', 'provider_model_client', 'provider_model', now());
INSERT INTO "SearchIntegrationRevision" (id, "searchStrategyId", "revisionNumber", "adapterKind", "credentialMode",
  configuration, "providerModelId", "validationEvidence", "draftHash", "validationFingerprint")
VALUES ('perplexity-reasoning-revision', 'perplexity-reasoning-strategy', 1, 'provider_model_client', 'provider_model',
  '{"maxOutputTokens":1024,"protocol":"openrouter_perplexity_chat","providerModelId":"${rowId("template")}"}',
  '${rowId("template")}', '{"modelVersion":3,"verified":true}', 'synthetic-draft-hash', 'synthetic-validation');
UPDATE "SearchStrategy" SET "activeRevisionId" = 'perplexity-reasoning-revision', "activatedAt" = now()
WHERE id = 'perplexity-reasoning-strategy';
-- An accepted run keeps its frozen Search configuration and binding snapshot.
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('perplexity-reasoning-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('perplexity-reasoning-chat', 'perplexity-reasoning-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
VALUES ('perplexity-reasoning-question', 'perplexity-reasoning-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
  ('perplexity-reasoning-answer', 'perplexity-reasoning-chat', 'assistant', 'streaming', '{"text":""}',
    'perplexity-reasoning-question', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider,
  "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('perplexity-reasoning-run', 'perplexity-reasoning-chat', 'perplexity-reasoning-owner',
  'perplexity-reasoning-question', 'perplexity-reasoning-answer', 'fake', 'synthetic-model', 'streaming',
  '${acceptedRequest}', now());
INSERT INTO "ProviderRunBinding" (id, "modelRunId", "bindingKey", role, "connectionId", "providerModelId",
  "credentialId", "credentialVersionId", "credentialSource", "executionSnapshot")
VALUES ('perplexity-reasoning-binding', 'perplexity-reasoning-run', 'search:perplexity-reasoning-search', 'search',
  'perplexity-reasoning-openrouter', '${rowId("template")}', 'perplexity-reasoning-credential',
  'perplexity-reasoning-credential-v1', 'default', '{"modelDefaultParams":{"reasoning":${LEGACY}},"modelVersion":3}');
CREATE TABLE "PerplexityReasoningFixture" (phase text NOT NULL, id text NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY (phase, id));
INSERT INTO "PerplexityReasoningFixture" SELECT 'before', id, to_jsonb(m) FROM "ProviderModel" m;
INSERT INTO "PerplexityReasoningFixture" VALUES ('related', 'state', (${relatedStateSql}));
`;

export const perplexityLegacyReasoningProofSql = `
DO $$ BEGIN${scenarios.map(scenarioProof).join("")}
  IF (SELECT count(*) FROM "ProviderModel") <> (SELECT count(*) FROM "PerplexityReasoningFixture" WHERE phase = 'before')
    OR EXISTS (SELECT 1 FROM "PerplexityReasoningFixture" f LEFT JOIN "ProviderModel" m ON m.id = f.id
      WHERE f.phase = 'before' AND f.id NOT IN (${scenarioIds}) AND to_jsonb(m) IS DISTINCT FROM f.snapshot)
    THEN RAISE EXCEPTION 'perplexity_reasoning_changed_unrelated_models'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = '${rowId("adoption_pending")}'
    AND "nativeRoutingAdoptionVersion" = 0 AND "nativeRoutingAdoptionReason" IS NULL
    AND "nativeRoutingAdoptionEvidence" IS NULL)
    THEN RAISE EXCEPTION 'perplexity_reasoning_closed_native_routing_adoption'; END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = '"ProviderModel"'::regclass
    AND tgname = 'ProviderModel_preserve_native_route_operator_edit') IS DISTINCT FROM 'O'
    THEN RAISE EXCEPTION 'perplexity_reasoning_left_adoption_trigger_disabled'; END IF;
  IF (${relatedStateSql}) IS DISTINCT FROM (SELECT snapshot FROM "PerplexityReasoningFixture" WHERE phase = 'related')
    THEN RAISE EXCEPTION 'perplexity_reasoning_changed_checks_search_or_accepted_runs'; END IF;
END $$;
INSERT INTO "PerplexityReasoningFixture" SELECT 'migrated', id, to_jsonb(m) FROM "ProviderModel" m;
${migrationBody}
DO $$ BEGIN
  IF ${modelsUnchangedSince("migrated")}
    THEN RAISE EXCEPTION 'perplexity_reasoning_body_not_idempotent'; END IF;
END $$;
-- A previous-release writer that re-pastes the old value closes pending adoption and is not re-migrated.
UPDATE "ProviderModel" SET "draftConfig" = jsonb_set("draftConfig", '{defaultParams,reasoning}', '${LEGACY}'::jsonb),
  "draftVersion" = "draftVersion" + 1, "updatedAt" = now()
WHERE id = '${rowId("adoption_pending")}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = '${rowId("adoption_pending")}'
    AND "nativeRoutingAdoptionVersion" = 1 AND "nativeRoutingAdoptionReason" = 'preserved')
    THEN RAISE EXCEPTION 'perplexity_reasoning_adoption_trigger_not_restored'; END IF;
END $$;
INSERT INTO "PerplexityReasoningFixture" SELECT 'after', id, to_jsonb(m) FROM "ProviderModel" m;
`;

export const perplexityLegacyReasoningRepeatProofSql = `
DO $$ BEGIN
  IF ${modelsUnchangedSince("after")}
    THEN RAISE EXCEPTION 'perplexity_reasoning_redeploy_replayed_migration'; END IF;
END $$;
`;
