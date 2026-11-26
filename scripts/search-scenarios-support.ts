/**
 * The pure side of the paid Search scenarios (`scripts/smoke-search-paid.ts`): scenario and engine selection, the
 * Admin Search catalog as the harness reads it, which source each engine step uses, the prompts, and the oracles
 * over the content-free evidence a chat's rows give. Nothing here calls a stand or a provider.
 */
import { OPENROUTER_WEB_SEARCH_TECHNICAL_MODELS } from "../lib/domain/catalog";
import { SEARCH_ENGINE_DEFAULT_ORDER, searchEngineDefaultRank } from "../lib/domain/search";

export const SEARCH_SCENARIO_IDS = ["A", "B", "C", "D", "E"] as const;
export type SearchScenarioId = (typeof SEARCH_SCENARIO_IDS)[number];
/** E (Deep research) runs only when named: it takes tens of minutes and many requests. */
export const DEFAULT_SEARCH_SCENARIOS: readonly SearchScenarioId[] = Object.freeze(["A", "B", "C", "D"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

function selection<T extends string>(raw: string | undefined, all: readonly T[], fallback: readonly T[], code: string): T[] {
  if (raw === undefined || raw.trim() === "") return [...fallback];
  const named = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (named.length === 0 || named.some((entry) => !(all as readonly string[]).includes(entry)) || new Set(named).size !== named.length) {
    throw new Error(code);
  }
  // Always in the catalog's order, so a scenario that changes the policy runs where the harness expects it.
  return all.filter((id) => named.includes(id));
}

/** AIQSA_SEARCH_SELECT: a comma list of scenario ids; default A,B,C,D. */
export function selectedSearchScenarios(raw: string | undefined): SearchScenarioId[] {
  return selection(raw, SEARCH_SCENARIO_IDS, DEFAULT_SEARCH_SCENARIOS, "search_select_invalid");
}

/** The engine steps of scenario C, in the default order's sequence after the automatic one. */
export const ENGINE_STEPS = Object.freeze([
  Object.freeze({ label: "automatic", protocol: null, openRouterEngine: null }),
  Object.freeze({ label: "openrouter_perplexity", protocol: "openrouter_web_search", openRouterEngine: "perplexity" }),
  Object.freeze({ label: "deepseek", protocol: "deepseek_search_api", openRouterEngine: null }),
  Object.freeze({ label: "gemini", protocol: "gemini_google_search", openRouterEngine: null })
] as const);
export type EngineStep = (typeof ENGINE_STEPS)[number];
export type EngineStepLabel = EngineStep["label"];
const ENGINE_STEP_LABELS: readonly EngineStepLabel[] = ENGINE_STEPS.map((step) => step.label);

/** AIQSA_SEARCH_C_ENGINES: a comma list of C's engine steps; default all four. */
export function selectedEngineSteps(raw: string | undefined): EngineStep[] {
  const labels = selection(raw, ENGINE_STEP_LABELS, ENGINE_STEP_LABELS, "search_c_engines_invalid");
  return ENGINE_STEPS.filter((step) => labels.includes(step.label));
}

/** CODEX_LB_ROOT (https, without /v1, as the eval scripts take it) as the Responses API root the connection uses. */
export function codexLbApiRoot(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") throw new Error("codex_lb_root_required");
  const root = raw.trim().replace(/\/+$/u, "");
  if (!/^https:\/\/[^/\s?#]+(?:\/[^?#\s]*)?$/u.test(root) || /\/v1$/u.test(root)) throw new Error("codex_lb_root_invalid");
  return `${root}/v1`;
}

/** An upstream model id from the environment, or the default. */
export function modelIdSetting(raw: string | undefined, fallback: string, code: string): string {
  const value = raw?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) throw new Error(code);
  return value;
}

// The Admin Search catalog ---------------------------------------------------------

export type SearchIntegrationView = Readonly<{
  adapterKind: string | null;
  archived: boolean;
  enabled: boolean;
  /** Whether the source's client route can search now: Admin's own test for an engine or a backup. */
  engineReady: boolean;
  id: string;
  kind: string;
  openRouterEngine: string | null;
  optionId: string;
  /** The client route's protocol (the source's editable configuration). */
  protocol: string | null;
  providerModelId: string | null;
  sourceConnectionId: string | null;
}>;

export type AdminSearchPolicy = Readonly<{
  backupOptionId: string | null;
  engineOptionId: string | null;
  inAnswerSearch: boolean;
  resolved: Readonly<{ automatic: boolean; backupOptionId: string | null; engineOptionId: string | null; reason: string | null }>;
  version: number;
}>;

export type AdminSearchCatalog = Readonly<{ integrations: readonly SearchIntegrationView[]; policy: AdminSearchPolicy }>;

const optionalId = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : typeof value === "string" && value.length > 0 ? value : undefined;

/** `GET /api/admin/search` (and a PATCH's answer, which is the same catalog), or null when it is not that shape. */
export function decodeAdminSearch(value: unknown): AdminSearchCatalog | null {
  const search = isRecord(value) && isRecord(value.search) ? value.search : null;
  const policy = search && isRecord(search.policy) ? search.policy : null;
  const resolved = policy && isRecord(policy.resolved) ? policy.resolved : null;
  if (!search || !policy || !resolved || !Array.isArray(search.integrations) || !Number.isSafeInteger(policy.version) ||
    typeof policy.inAnswerSearch !== "boolean" || typeof resolved.automatic !== "boolean") return null;
  const engineOptionId = optionalId(policy.engineOptionId);
  const backupOptionId = optionalId(policy.backupOptionId);
  const resolvedEngine = optionalId(resolved.engineOptionId);
  const resolvedBackup = optionalId(resolved.backupOptionId);
  if (engineOptionId === undefined || backupOptionId === undefined || resolvedEngine === undefined || resolvedBackup === undefined ||
    (resolved.reason !== null && typeof resolved.reason !== "string")) return null;
  const integrations: SearchIntegrationView[] = [];
  for (const entry of search.integrations) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.strategyId !== "string" || typeof entry.kind !== "string") return null;
    const configuration = isRecord(entry.configuration) ? entry.configuration : null;
    const openRouter = configuration && isRecord(configuration.openRouterWebSearch) ? configuration.openRouterWebSearch : null;
    const modes = Array.isArray(entry.executionModes) ? entry.executionModes : [];
    integrations.push({
      adapterKind: text(configuration?.adapterKind),
      archived: entry.archivedAt !== null && entry.archivedAt !== undefined,
      enabled: entry.enabled === true,
      engineReady: entry.enabled === true && (entry.archivedAt === null || entry.archivedAt === undefined) && modes.includes("all_selected"),
      id: entry.id,
      kind: entry.kind,
      openRouterEngine: text(openRouter?.engine),
      optionId: entry.strategyId,
      protocol: text(configuration?.protocol),
      providerModelId: text(configuration?.providerModelId),
      sourceConnectionId: text(entry.sourceConnectionId)
    });
  }
  return {
    integrations,
    policy: {
      backupOptionId,
      engineOptionId,
      inAnswerSearch: policy.inAnswerSearch,
      resolved: { automatic: resolved.automatic, backupOptionId: resolvedBackup, engineOptionId: resolvedEngine,
        reason: typeof resolved.reason === "string" ? resolved.reason : null },
      version: Number(policy.version)
    }
  };
}

/** The engine label of a protocol and OpenRouter engine, as every line reports which engine ran. */
export function engineLabel(engine: Readonly<{ openRouterEngine: string | null; protocol: string | null }>): string {
  switch (engine.protocol) {
    case "openai_responses_web_search": return "openai_client";
    case "openrouter_web_search": return `openrouter_${engine.openRouterEngine && /^[a-z0-9_]{1,32}$/u.test(engine.openRouterEngine) ? engine.openRouterEngine : "other"}`;
    case "openrouter_perplexity_chat": return "perplexity_sonar";
    case "deepseek_search_api": return "deepseek";
    case "gemini_google_search": return "gemini";
    case "anthropic_web_search": return "anthropic";
    case null: return "none";
    default: return "other";
  }
}

function stepMatches(step: EngineStep, integration: SearchIntegrationView): boolean {
  if (step.protocol === null || integration.archived) return false;
  if (step.protocol === "openrouter_web_search") {
    return integration.kind === "web_search" && integration.protocol === "openrouter_web_search" &&
      integration.openRouterEngine === step.openRouterEngine;
  }
  if (step.protocol === "deepseek_search_api") return integration.kind === "deepseek_search_api" && integration.protocol === "deepseek_search_api";
  return integration.kind === "gemini_google_search" && integration.protocol === "gemini_google_search";
}

export type EngineSource = Readonly<{ integration: SearchIntegrationView; status: "ready" }> |
  Readonly<{ reason: "source_disabled" | "source_missing" | "source_not_ready"; status: "not_configured" }>;

/** The source a non-automatic engine step sets as the engine: the first ready one of its kind, else why there is none. */
export function engineSourceFor(step: EngineStep, integrations: readonly SearchIntegrationView[]): EngineSource {
  const matching = integrations.filter((integration) => stepMatches(step, integration));
  const ready = matching.find((integration) => integration.engineReady);
  if (ready) return { integration: ready, status: "ready" };
  if (matching.length === 0) return { reason: "source_missing", status: "not_configured" };
  return { reason: matching.some((integration) => integration.enabled) ? "source_not_ready" : "source_disabled", status: "not_configured" };
}

/**
 * The engine the default order picks among the ready sources, as a label: the first ready source in
 * `SEARCH_ENGINE_DEFAULT_ORDER`; null when none of them is ready. Ties between sources of one kind do not change the label.
 */
export function expectedDefaultEngine(integrations: readonly SearchIntegrationView[]): string | null {
  let best: { label: string; rank: number } | null = null;
  for (const integration of integrations) {
    if (!integration.engineReady || integration.protocol === null) continue;
    const rank = searchEngineDefaultRank({ openRouterEngine: integration.openRouterEngine, protocol: integration.protocol });
    if (rank === null || (best && best.rank <= rank)) continue;
    best = { label: engineLabel(integration), rank };
  }
  return best?.label ?? null;
}

/**
 * The only OpenRouter models this harness lets search (operator constraint 2026-11-26: OpenRouter only for its search
 * technical model, never a chat model): the template's DeepSeek V4.1 Flash technical models.
 */
export const OPENROUTER_ALLOWED_SEARCH_MODELS: readonly string[] = Object.freeze(OPENROUTER_WEB_SEARCH_TECHNICAL_MODELS
  .map((model) => model.upstreamModelId).filter((id) => id.startsWith("deepseek/deepseek-v4.1-flash")));

/** The default order's labels, for the header and the ready line. */
export const DEFAULT_ENGINE_ORDER_LABELS: readonly string[] = Object.freeze(SEARCH_ENGINE_DEFAULT_ORDER.map((entry) =>
  engineLabel({ openRouterEngine: entry.openRouterEngine ?? null, protocol: entry.protocol })));

// Prompts ----------------------------------------------------------------------------

/** One current-events question that needs the web; paid search prompts demand exactly one search, as models fan out otherwise. */
const QUESTION = "Какая самая свежая стабильная версия Node.js вышла на сегодняшний день и когда она вышла?";
const ONE_SEARCH = "Сделай ровно один веб-поиск (один вызов поиска), страницы не открывай, Workspace и браузер не используй, " +
  "ответ возьми из результатов поиска.";
const ANSWER_FORM = "Ответь двумя короткими строками: версия и дата, и укажи источник ссылкой в формате markdown [название](https://...).";

export const SUBAGENT_SEARCHER = "s-searcher";

export const SEARCH_PROMPTS = Object.freeze({
  /** A, B, C: the answer model searches itself, inside its answer or through `web_search`. */
  direct: () => [QUESTION, ONE_SEARCH, ANSWER_FORM].join("\n\n"),
  /** D: the parent hands the search to one foreground sub-agent on the named model and does not search itself. */
  subagent: (model: string) => [
    `Поручи этот поиск ровно одному суб-агенту с именем ${SUBAGENT_SEARCHER} (это его имя, name; type не указывай), ` +
      `с моделью ${model} (параметр model), не в фоне, и дождись его отчёта. Сам не ищи.`,
    `Вопрос: ${QUESTION}`,
    `Скажи ${SUBAGENT_SEARCHER}, что ему хватит ровно одного веб-поиска: не больше одного поиска, страницы не открывать, ` +
      "ответ взять из результатов поиска и привести ссылку на источник.",
    `Когда получишь его отчёт, ${ANSWER_FORM.charAt(0).toLowerCase()}${ANSWER_FORM.slice(1)}`
  ].join("\n\n"),
  /** E: a small knowledge question for Deep research, so the plan stays short. */
  research: () => "Какие основные версии PostgreSQL сейчас поддерживаются и до какой даты поддерживается каждая из них? " +
    "Нужна короткая таблица: версия и дата окончания поддержки, со ссылками на источники."
});

// Evidence and oracles -----------------------------------------------------------------

/** One option of the run's frozen Search plan (`normalizedRequest.searchPlan`), read only for the oracle. */
export type FrozenSearchOption = Readonly<{ adapterKind: string | null; openRouterEngine: string | null; optionId: string; protocol: string | null; use: string | null }>;

/** One engine call a `web_search` result records (`rawPreview.searchExecutions`): never its query, sources or text. */
export type SearchExecutionRow = Readonly<{ failureCode: string | null; optionId: string | null; sources: number; status: string | null; subagent: boolean }>;

/** A chat's content-free evidence: matched and counted inside SQL, ids kept in memory for the comparisons. */
export type SearchRunEvidence = Readonly<{
  answerLink: boolean;
  errorCode: string | null;
  executions: readonly SearchExecutionRow[];
  /** Main-agent transcript items whose hosted search recorded at least one source. */
  hostedSourceItems: number;
  mainCalls: number;
  options: readonly FrozenSearchOption[];
  planMode: string | null;
  planUnavailable: string | null;
  researchStarts: number;
  runSeconds: number | null;
  status: string;
  subagentCalls: number;
  subagentThreads: number;
  subagentTurns: number;
  /** Sub-agent turns on the model the scenario asked for (D); 0 when none was asked. */
  subagentTurnsOnModel: number;
}>;

const count = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const textOrNull = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;

/** The evidence query's row (`scripts/smoke-search-paid.ts`), or null when it is not that shape. */
export function decodeSearchEvidence(row: unknown): SearchRunEvidence | null {
  if (!isRecord(row) || typeof row.status !== "string" || !Array.isArray(row.options) || !Array.isArray(row.executions)) return null;
  const options: FrozenSearchOption[] = [];
  for (const option of row.options) {
    if (!isRecord(option) || typeof option.optionId !== "string") return null;
    options.push({ adapterKind: textOrNull(option.adapterKind), openRouterEngine: textOrNull(option.openRouterEngine), optionId: option.optionId,
      protocol: textOrNull(option.protocol), use: textOrNull(option.use) });
  }
  const executions: SearchExecutionRow[] = [];
  for (const execution of row.executions) {
    if (!isRecord(execution) || typeof execution.subagent !== "boolean") return null;
    executions.push({ failureCode: textOrNull(execution.failureCode), optionId: textOrNull(execution.optionId), sources: count(execution.sources),
      status: textOrNull(execution.status), subagent: execution.subagent });
  }
  return {
    answerLink: row.answerLink === true,
    errorCode: textOrNull(row.errorCode),
    executions,
    hostedSourceItems: count(row.hostedSourceItems),
    mainCalls: count(row.mainCalls),
    options,
    planMode: textOrNull(row.planMode),
    planUnavailable: textOrNull(row.planUnavailable),
    researchStarts: count(row.researchStarts),
    runSeconds: typeof row.runSeconds === "number" && Number.isFinite(row.runSeconds) ? row.runSeconds : null,
    status: row.status,
    subagentCalls: count(row.subagentCalls),
    subagentThreads: count(row.subagentThreads),
    subagentTurns: count(row.subagentTurns),
    subagentTurnsOnModel: count(row.subagentTurnsOnModel)
  };
}

export type SearchFacts = Readonly<{
  backup: FrozenSearchOption | null;
  engine: FrozenSearchOption | null;
  engineLabel: string;
  inAnswer: FrozenSearchOption | null;
  /** Main-agent engine calls (engine or backup) that completed with at least one source. */
  mainEngineSearches: number;
  subagentEngineSearches: number;
  /** Executions the first failure code of a call that found nothing, if any; a stable code only. */
  failureCode: string | null;
}>;

const SAFE_CODE = /^[a-z0-9_]{1,64}$/u;

export function searchFacts(evidence: SearchRunEvidence): SearchFacts {
  const byUse = (use: string) => evidence.options.find((option) => option.use === use) ?? null;
  const engine = byUse("engine");
  const backup = byUse("backup");
  const clientIds = new Set([engine?.optionId, backup?.optionId].filter((id): id is string => typeof id === "string"));
  const found = (row: SearchExecutionRow) => row.status === "complete" && row.sources > 0 && row.optionId !== null && clientIds.has(row.optionId);
  const failure = evidence.executions.find((row) => row.status !== "complete" && row.failureCode !== null && SAFE_CODE.test(row.failureCode));
  return {
    backup,
    engine,
    engineLabel: engineLabel(engine ?? { openRouterEngine: null, protocol: null }),
    failureCode: failure?.failureCode ?? null,
    inAnswer: byUse("in_answer"),
    mainEngineSearches: evidence.executions.filter((row) => !row.subagent && found(row)).length,
    subagentEngineSearches: evidence.executions.filter((row) => row.subagent && found(row)).length
  };
}

function runFailures(evidence: SearchRunEvidence): string[] {
  return evidence.status === "complete" ? [] : [`run_${SAFE_CODE.test(evidence.status) ? evidence.status : "unknown"}`];
}

/** A: the GPT answer model searched inside its own answer, so its request carried no `web_search`. */
export function oracleInAnswer(evidence: SearchRunEvidence): string[] {
  const facts = searchFacts(evidence);
  return [
    ...runFailures(evidence),
    ...(facts.inAnswer?.adapterKind === "answer_provider_hosted" && facts.inAnswer.protocol === "openai_responses_web_search" ? [] : ["in_answer_not_bound"]),
    ...(evidence.mainCalls === 0 ? [] : ["web_search_called"]),
    ...(evidence.hostedSourceItems > 0 ? [] : ["hosted_sources_missing"]),
    ...(evidence.answerLink ? [] : ["answer_link_missing"])
  ];
}

/**
 * B and C: the answer model searched through `web_search` with the installation's engine, the one Admin resolved
 * (`expectedEngineOptionId`); C also names the engine's label it must be (null: any).
 */
export function oracleClientEngine(evidence: SearchRunEvidence, expected: Readonly<{ engineOptionId: string | null; label: string | null }>): string[] {
  const facts = searchFacts(evidence);
  return [
    ...runFailures(evidence),
    ...(facts.inAnswer === null ? [] : ["in_answer_bound"]),
    ...(facts.engine === null ? [`engine_missing${evidence.planUnavailable && SAFE_CODE.test(evidence.planUnavailable) ? `_${evidence.planUnavailable}` : ""}`] : []),
    ...(facts.engine !== null && (expected.engineOptionId === null || facts.engine.optionId !== expected.engineOptionId) ? ["engine_not_as_resolved"] : []),
    ...(facts.engine !== null && expected.label !== null && facts.engineLabel !== expected.label ? ["engine_kind_mismatch"] : []),
    ...(facts.mainEngineSearches > 0 ? [] : ["engine_search_missing"]),
    ...(evidence.answerLink ? [] : ["answer_link_missing"])
  ];
}

/** D: under a parent that searches inside its answer, the sub-agent on the asked model searched through `web_search`. */
export function oracleSubagent(evidence: SearchRunEvidence): string[] {
  const facts = searchFacts(evidence);
  return [
    ...runFailures(evidence),
    ...(facts.inAnswer === null ? ["in_answer_not_bound"] : []),
    ...(facts.engine === null ? ["engine_missing"] : []),
    // The parent's own request carries no `web_search` while it searches inside its answer.
    ...(evidence.mainCalls === 0 ? [] : ["parent_web_search_offered"]),
    ...(evidence.subagentTurns > 0 ? [] : ["subagent_missing"]),
    ...(evidence.subagentTurns === 0 || evidence.subagentTurnsOnModel > 0 ? [] : ["subagent_model_mismatch"]),
    ...(facts.subagentEngineSearches > 0 ? [] : ["subagent_search_missing"])
  ];
}

/** E: Deep research started and its researchers searched through `web_search` with the engine. */
export function oracleResearch(evidence: SearchRunEvidence): string[] {
  const facts = searchFacts(evidence);
  return [
    ...runFailures(evidence),
    ...(evidence.researchStarts > 0 ? [] : ["research_not_started"]),
    ...(facts.engine === null ? ["engine_missing"] : []),
    ...(evidence.subagentThreads > 0 ? [] : ["researchers_missing"]),
    ...(facts.subagentEngineSearches > 0 ? [] : ["researcher_search_missing"])
  ];
}

/** The line's evidence fields: codes, booleans and counts only. */
export function evidenceLine(evidence: SearchRunEvidence): Record<string, unknown> {
  const facts = searchFacts(evidence);
  return {
    answerLink: evidence.answerLink,
    backup: facts.backup ? engineLabel(facts.backup) : null,
    engine: facts.engineLabel,
    errorCode: evidence.errorCode !== null && SAFE_CODE.test(evidence.errorCode) ? evidence.errorCode : null,
    failureCode: facts.failureCode,
    hostedSourceItems: evidence.hostedSourceItems,
    inAnswer: facts.inAnswer !== null,
    mainEngineSearches: facts.mainEngineSearches,
    mainWebSearchCalls: evidence.mainCalls,
    planMode: evidence.planMode !== null && SAFE_CODE.test(evidence.planMode) ? evidence.planMode : null,
    planUnavailable: evidence.planUnavailable !== null && SAFE_CODE.test(evidence.planUnavailable) ? evidence.planUnavailable : null,
    runSeconds: evidence.runSeconds,
    status: SAFE_CODE.test(evidence.status) ? evidence.status : "unknown",
    subagentEngineSearches: facts.subagentEngineSearches,
    subagentWebSearchCalls: evidence.subagentCalls
  };
}
