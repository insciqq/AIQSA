/**
 * Pure parts of the opt-in paid context-compaction journey smoke
 * (`smoke-context-compaction-journey.ts`): configuration, the deterministic
 * Russian journey text, run parameters, bounded readers of the Admin and Chat
 * projections, per-round evidence and the verdict. Nothing here performs I/O,
 * and nothing here ever returns prompt or answer text as evidence.
 */
import type { AdminProviderModelConfiguration } from "../lib/contracts/adminProviders";
import type { CatalogModel } from "../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../lib/contracts/chats";
import type { ContextCompactionStatus } from "../lib/contracts/contextCompaction";
import { sessionContextCapacity, type SessionContextStatus } from "../lib/contracts/sessionStatus";
import { textFromContentBlocks } from "../lib/domain/modelRunEvents";
import { CONTEXT_COMPACTION_LIMITS } from "../lib/server/runs/contextCompactionContract";

export const JOURNEY_ROUTES = ["anthropic", "codex-lb"] as const;
export type JourneyRoute = (typeof JOURNEY_ROUTES)[number];

export const JOURNEY_LIMITS = Object.freeze({
  defaultContextWindow: 32_768,
  /** Below this the fixed request overhead leaves too little journey room. */
  minContextWindow: 16_384,
  /** Above this the byte bounds below cannot reach the trigger in 12 turns. */
  maxContextWindow: 65_536,
  defaultMaxTurns: 12,
  /** Brief, two corrections, the rule, one filler and the probe. */
  minTurns: 6,
  maxTurns: 12,
  answerMaxOutputTokens: 2_048,
  /** Share of the estimated budget the opening brief occupies. */
  briefBudgetShare: 0.22,
  /** Largest filler step, so one turn never jumps past the pass window. */
  fillerMaxBudgetShare: 0.12,
  /** Where a filler aims the next request once the trigger is near. */
  fillerTargetShare: 0.86,
  fillerMinTokens: 256,
  triggerShare: CONTEXT_COMPACTION_LIMITS.triggerRatio,
  passMinShare: 0.6,
  passMaxShare: 0.95,
  maxMessageBytes: 160 * 1024,
  maxRouteRequestBytes: 1024 * 1024
});

/** The bootstrap token of a test-mode stand, as tests/e2e/support/localAuth.ts uses it. */
export const JOURNEY_TEST_AUTH_TOKEN = "aiqsa-test-token";

export type JourneyStage =
  | "auth"
  | "catalog"
  | "chat"
  | "cleanup"
  | "config"
  | "evidence"
  | "provider_setup"
  | "turn";

const CODE_PATTERN = /^[a-z0-9_]{1,80}$/u;

/** A stable, content-free failure; any other code collapses to one generic value. */
export class JourneyFailure extends Error {
  readonly code: string;
  readonly stage: JourneyStage;

  constructor(stage: JourneyStage, code: string) {
    const safe = CODE_PATTERN.test(code) ? code : "journey_failed";
    super(safe);
    this.name = "JourneyFailure";
    this.code = safe;
    this.stage = stage;
  }
}

function fail(stage: JourneyStage, code: string): never {
  throw new JourneyFailure(stage, code);
}

// Configuration ---------------------------------------------------------------

export type JourneyRouteConfig =
  | Readonly<{ route: "anthropic"; apiKey: string; model: string }>
  | Readonly<{ route: "codex-lb"; apiKey: string; apiRoot: string; model: string }>;

export type JourneyRouteSkip = Readonly<{ route: JourneyRoute; skipped: "api_key_missing" | "base_url_missing" }>;

export type JourneyConfig = Readonly<{
  baseUrl: URL;
  cleanupProviders: boolean;
  contextWindow: number;
  /** True when AIQSA_JOURNEY_ROUTES named the routes explicitly. */
  explicitRoutes: boolean;
  maxTurns: number;
  routes: readonly (JourneyRouteConfig | JourneyRouteSkip)[];
}>;

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function envValue(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

function integerSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = envValue(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value : fail("config", `${name.toLowerCase()}_invalid`);
}

/** The stand origin. Keys travel to it, so plain HTTP is accepted only on loopback. */
export function journeyBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("config", "base_url_invalid");
  }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))) {
    return fail("config", "base_url_invalid");
  }
  return new URL(url.origin);
}

/** A compatible endpoint root without credentials, query or trailing slash. */
export function journeyApiRoot(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("config", "codex_lb_base_url_invalid");
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return fail("config", "codex_lb_base_url_invalid");
  }
  return url.toString().replace(/\/+$/u, "");
}

function modelSetting(env: Env, name: string, fallback: string): string {
  const value = envValue(env, name) || fallback;
  return MODEL_ID.test(value) ? value : fail("config", `${name.toLowerCase()}_invalid`);
}

/**
 * The journey configuration. `codexApiRootFallback` supplies the codex-lb root
 * of the operator's Codex profile when CODEX_LB_BASE_URL is absent.
 */
export function journeyConfig(env: Env, codexApiRootFallback: () => string | null = () => null): JourneyConfig {
  const routeList = envValue(env, "AIQSA_JOURNEY_ROUTES");
  const requested = routeList ? routeList.split(",").map((value) => value.trim()).filter(Boolean) : [...JOURNEY_ROUTES];
  if (requested.length === 0 || requested.some((value) => !(JOURNEY_ROUTES as readonly string[]).includes(value))) {
    fail("config", "routes_invalid");
  }
  const routes = [...new Set(requested as JourneyRoute[])].map((route): JourneyRouteConfig | JourneyRouteSkip => {
    if (route === "anthropic") {
      const apiKey = envValue(env, "ANTHROPIC_API_KEY");
      return apiKey
        ? { apiKey, model: modelSetting(env, "AIQSA_JOURNEY_ANTHROPIC_MODEL", "claude-sonnet-5"), route }
        : { route, skipped: "api_key_missing" };
    }
    const apiKey = envValue(env, "CODEX_LB_API_KEY");
    if (!apiKey) return { route, skipped: "api_key_missing" };
    const rawRoot = envValue(env, "CODEX_LB_BASE_URL") || codexApiRootFallback() || "";
    if (!rawRoot) return { route, skipped: "base_url_missing" };
    return { apiKey, apiRoot: journeyApiRoot(rawRoot), model: modelSetting(env, "AIQSA_JOURNEY_CODEX_MODEL", "gpt-5.5"), route };
  });
  return {
    baseUrl: journeyBaseUrl(envValue(env, "AIQSA_JOURNEY_BASE_URL") || "http://127.0.0.1:3000"),
    cleanupProviders: envValue(env, "AIQSA_JOURNEY_CLEANUP_PROVIDERS") === "1",
    contextWindow: integerSetting(env, "AIQSA_JOURNEY_CONTEXT_WINDOW", JOURNEY_LIMITS.defaultContextWindow,
      JOURNEY_LIMITS.minContextWindow, JOURNEY_LIMITS.maxContextWindow),
    explicitRoutes: Boolean(routeList),
    maxTurns: integerSetting(env, "AIQSA_JOURNEY_MAX_TURNS", JOURNEY_LIMITS.defaultMaxTurns,
      JOURNEY_LIMITS.minTurns, JOURNEY_LIMITS.maxTurns),
    routes
  };
}

// Deterministic Russian journey text -----------------------------------------

/** Estimated tokens of one text, as the stand measures it for the route. */
export type TokenEstimate = (text: string) => number;

const SUBJECTS = [
  "Команда поддержки", "Отдел аналитики", "Мобильное приложение", "Служба доставки",
  "Руководитель направления", "Платформа уведомлений", "Система отчётности", "Партнёрская сеть",
  "Группа дизайна", "Сервис оплаты", "Каталог изданий", "Центр обработки заявок"
];
const VERBS = [
  "уточняет", "проверяет", "описывает", "согласует", "обновляет", "собирает",
  "анализирует", "готовит", "сравнивает", "поддерживает", "документирует", "пересматривает"
];
const OBJECTS = [
  "требования к интерфейсу", "сценарии регистрации читателей", "правила хранения данных", "план тестирования",
  "журнал изменений", "карту пользовательских путей", "список открытых вопросов", "критерии приёмки",
  "схему интеграции с учётными системами", "модель уведомлений", "порядок эскалации обращений", "набор метрик качества"
];
const DETAILS = [
  "с учётом отзывов первых пользователей", "перед очередной демонстрацией заказчику",
  "в тесной связке с юридической службой", "без изменения согласованных параметров",
  "чтобы снизить нагрузку на операторов", "на основе прошлогодних наблюдений",
  "для региональных филиалов", "с акцентом на доступность для людей с нарушениями зрения",
  "в рамках пилотного запуска", "по итогам внутреннего аудита",
  "при участии внешних консультантов", "с прицелом на дальнейшее масштабирование"
];

/** mulberry32: a small deterministic generator, never a security primitive. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

/** Digit-free prose of about `targetTokens` estimated tokens, stable for a seed. */
export function journeyProse(seed: number, targetTokens: number, estimate: TokenEstimate): string {
  const random = seededRandom(seed);
  const paragraphs: string[] = [];
  let tokens = 0;
  // The iteration ceiling guarantees termination even for a degenerate estimate.
  for (let index = 0; tokens < targetTokens && index < 4_096; index += 1) {
    const sentences = Array.from({ length: 6 }, () =>
      `${pick(random, SUBJECTS)} ${pick(random, VERBS)} ${pick(random, OBJECTS)} ${pick(random, DETAILS)}.`);
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    tokens += Math.max(1, estimate(paragraph));
  }
  return paragraphs.join("\n\n");
}

export function journeyBrief(targetTokens: number, estimate: TokenEstimate): string {
  const header = [
    "Продуктовый бриф проекта «Лазурный маяк».",
    "Ключевые параметры (исходная версия): срок реализации проекта — 3 недели; бюджет проекта — 120 тысяч евро; " +
      "заказчик — сеть городских библиотек.",
    "Ниже приведено подробное описание контекста проекта. Прочитай бриф и кратко подтверди, что понял ключевые параметры."
  ].join("\n");
  return `${header}\n\n${journeyProse(0x4c41, Math.max(0, targetTokens - estimate(header)), estimate)}`;
}

export function journeyFiller(index: number, targetTokens: number, estimate: TokenEstimate): string {
  const header = "Дополнительные материалы к брифу «Лазурный маяк» (справочный текст, ключевые параметры здесь не меняются). " +
    "Прочитай и ответь кратко.";
  return `${header}\n\n${journeyProse(0x1000 + index, Math.max(0, targetTokens - estimate(header)), estimate)}`;
}

export const JOURNEY_CORRECTIONS = [
  "Исправь: срок реализации проекта не 3, а 5 недель. Запомни это исправление и кратко подтверди.",
  "Исправь ещё: бюджет проекта не 120, а 175 тысяч евро. Запомни это исправление и кратко подтверди."
] as const;

export const JOURNEY_RULE = "Новое постоянное правило: всегда отвечай списком ровно из трёх пунктов, " +
  "без вступления и без заключения. Соблюдай его во всех следующих ответах. Подтверди правило.";

export const JOURNEY_PROBE = "Каков итоговый срок реализации проекта «Лазурный маяк» в неделях и каков его итоговый " +
  "бюджет в тысячах евро? Учти все исправления и постоянное правило ответа.";

/** Estimated tokens of the next filler, or null once the request would cross the trigger. */
export function nextFillerTokens(input: Readonly<{ approximateInputTokens: number; budgetTokens: number }>): number | null {
  const { approximateInputTokens, budgetTokens } = input;
  if (approximateInputTokens >= budgetTokens * JOURNEY_LIMITS.triggerShare) return null;
  const step = Math.floor(budgetTokens * JOURNEY_LIMITS.fillerMaxBudgetShare);
  const toTarget = Math.ceil(budgetTokens * JOURNEY_LIMITS.fillerTargetShare - approximateInputTokens);
  return Math.max(JOURNEY_LIMITS.fillerMinTokens, Math.min(step, toTarget));
}

// Probe answer check (in memory only) -----------------------------------------

const LIST_ITEM = /^([ \t]*)(?:[-*•–—]|\d{1,2}[.)])[ \t]+\S/u;

/** Top-level list items: markers at the shallowest indentation present. */
export function listItemCount(text: string): number {
  const indents = text.split(/\r?\n/u).flatMap((line) => {
    const match = LIST_ITEM.exec(line);
    return match ? [match[1]!.replace(/\t/gu, "    ").length] : [];
  });
  if (indents.length === 0) return 0;
  const top = Math.min(...indents);
  return indents.filter((indent) => indent === top).length;
}

/** The corrected deadline (5 weeks) and budget (175 thousand) in a three-item list. */
export function probeAnswerCarriesCorrections(text: string): boolean {
  const deadline = /(?<!\d)5(?!\d)[\s -]*(?:ти[\s ]*)?недел/iu.test(text) || /пят[ьи][\s ]+недел/iu.test(text);
  const budget = /(?<!\d)175(?:[\s ]?000)?(?![\d])/u.test(text);
  return deadline && budget && listItemCount(text) === 3;
}

// Run parameters ----------------------------------------------------------------

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The cheapest offered effort: none, then minimal, then low, else the default. */
export function lowestReasoningEffort(model: Pick<CatalogModel, "parameterControls">): string {
  const control = model.parameterControls.reasoningEffort;
  return ["none", "minimal", "low"].find((effort) => control.options.includes(effort)) ?? control.defaultValue;
}

/**
 * The run parameters the composer would send for this model with the smallest
 * reasoning setting and the journey's answer ceiling (see buildParams in
 * components/app-shell/runControlsActions.ts).
 */
export function journeyRunParams(model: CatalogModel, maxOutputTokens: number): Record<string, unknown> {
  const controls = model.parameterControls;
  const base = { ...model.defaultParams };
  const effort = lowestReasoningEffort(model);
  const tokens = Math.min(maxOutputTokens, controls.maxOutputTokens.maxValue ?? maxOutputTokens);
  const family = model.providerFamily ?? "";
  if (family === "anthropic") {
    const params: Record<string, unknown> = {
      ...base,
      maxTokens: tokens,
      outputConfig: { ...(record(base.outputConfig) ? base.outputConfig : {}), effort },
      thinking: {
        ...(record(base.thinking) ? base.thinking : {}),
        budgetTokens: 0,
        enabled: controls.reasoningEffort.supported && effort !== "none",
        type: "adaptive"
      }
    };
    if (controls.temperature.supported) params.temperature = controls.temperature.defaultValue;
    else delete params.temperature;
    delete params.reasoning;
    return params;
  }
  if (family === "openai" || family === "openai_compatible") {
    const reasoning: Record<string, unknown> = { ...(record(base.reasoning) ? base.reasoning : {}), effort };
    if (controls.reasoningMode?.supported) reasoning.mode = controls.reasoningMode.defaultValue;
    else delete reasoning.mode;
    const params: Record<string, unknown> = {
      ...base,
      maxOutputTokens: tokens,
      reasoning,
      temperature: controls.temperature.defaultValue
    };
    if (controls.background.supported) params.background = false;
    else delete params.background;
    if (controls.stream.supported) params.stream = controls.stream.defaultValue;
    else delete params.stream;
    return params;
  }
  return fail("catalog", "model_family_unsupported");
}

// Admin provider projection -------------------------------------------------------

export type JourneyProviderModel = Readonly<{
  activeConfig: AdminProviderModelConfiguration | null;
  activeVersion: number;
  displayName: string;
  draftConfig: AdminProviderModelConfiguration;
  draftVersion: number;
  enabled: boolean;
  id: string;
  updatedAt: string;
}>;

export type JourneyConnection = Readonly<{
  apiRoot: string | null;
  checkRunning: boolean;
  enabled: boolean;
  family: string;
  id: string;
  models: readonly JourneyProviderModel[];
}>;

function modelConfiguration(value: unknown): AdminProviderModelConfiguration | null {
  return record(value) && typeof value.upstreamModelId === "string" && typeof value.adapterKind === "string" &&
    record(value.capabilities) ? value as AdminProviderModelConfiguration : null;
}

function readModel(value: unknown): JourneyProviderModel | null {
  if (!record(value) || typeof value.id !== "string" || typeof value.displayName !== "string" ||
    typeof value.enabled !== "boolean" || typeof value.updatedAt !== "string" ||
    !Number.isSafeInteger(value.activeVersion) || !Number.isSafeInteger(value.draftVersion)) return null;
  const draftConfig = modelConfiguration(value.draftConfig);
  const activeConfig = value.activeConfig === null ? null : modelConfiguration(value.activeConfig);
  if (!draftConfig || (value.activeConfig !== null && !activeConfig)) return null;
  return {
    activeConfig, activeVersion: Number(value.activeVersion), displayName: value.displayName, draftConfig,
    draftVersion: Number(value.draftVersion), enabled: value.enabled, id: value.id, updatedAt: value.updatedAt
  };
}

/** The fields of `GET /api/admin/providers` the journey needs, or null for an unexpected shape. */
export function readConnections(value: unknown): JourneyConnection[] | null {
  if (!record(value) || !Array.isArray(value.connections)) return null;
  const connections: JourneyConnection[] = [];
  for (const entry of value.connections) {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.family !== "string" ||
      typeof entry.enabled !== "boolean" || !Array.isArray(entry.models)) return null;
    const models = entry.models.map(readModel);
    if (models.some((model) => model === null)) return null;
    const config = record(entry.activeConfig) ? entry.activeConfig : record(entry.draftConfig) ? entry.draftConfig : null;
    connections.push({
      apiRoot: typeof config?.apiRoot === "string" ? config.apiRoot.replace(/\/+$/u, "") : null,
      checkRunning: record(entry.checkRun) && entry.checkRun.state === "running",
      enabled: entry.enabled,
      family: entry.family,
      id: entry.id,
      models: models as JourneyProviderModel[]
    });
  }
  return connections;
}

/** An existing deployment of the route's model, preferring enabled ones. */
export function findJourneyModel(
  connections: readonly JourneyConnection[],
  target: Readonly<{ apiRoot?: string; family: "anthropic" | "openai_compatible"; upstreamModelId: string }>
): Readonly<{ connection: JourneyConnection; model: JourneyProviderModel }> | null {
  const matches = connections.flatMap((connection) =>
    connection.family !== target.family || (target.apiRoot !== undefined && connection.apiRoot !== target.apiRoot)
      ? []
      : connection.models
        .filter((model) => (model.activeConfig ?? model.draftConfig).upstreamModelId === target.upstreamModelId)
        .map((model) => ({ connection, model })));
  return matches.find(({ connection, model }) => connection.enabled && model.enabled) ?? matches[0] ?? null;
}

/**
 * The Admin model update that publishes the journey window as the
 * administrator-set `capabilities.contextWindow`, or null when the active
 * configuration already carries it.
 */
export function contextWindowUpdate(model: JourneyProviderModel, contextWindow: number): Record<string, unknown> | null {
  if (model.activeConfig?.capabilities.contextWindow === contextWindow &&
    model.draftConfig.capabilities.contextWindow === contextWindow) return null;
  return {
    action: "update",
    activate: true,
    configuration: { ...model.draftConfig, capabilities: { ...model.draftConfig.capabilities, contextWindow } },
    displayName: model.displayName,
    expectedActiveVersion: model.activeVersion,
    expectedDisplayName: model.displayName,
    expectedDraftVersion: model.draftVersion,
    expectedUpdatedAt: model.updatedAt
  };
}

/** The quick-setup candidate naming the requested model, else the policy's first choice. */
export function quickSetupCandidate(value: unknown, model: string): Readonly<{ candidateId: string; policyVersion: number }> | null {
  if (!record(value) || !Array.isArray(value.candidates) || !Number.isSafeInteger(value.policyVersion)) return null;
  const candidates = value.candidates.filter((entry): entry is { candidateId: string; displayName: string } =>
    record(entry) && typeof entry.candidateId === "string" && typeof entry.displayName === "string");
  const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const chosen = candidates.find((entry) => entry.candidateId === model) ??
    candidates.find((entry) => normalized(entry.candidateId).includes(normalized(model)) ||
      normalized(entry.displayName) === normalized(model)) ?? candidates[0];
  return chosen ? { candidateId: chosen.candidateId, policyVersion: Number(value.policyVersion) } : null;
}

/** The custom-setup request for the codex-lb compatible Responses endpoint. */
export function codexLbSetupBody(input: Readonly<{
  apiRoot: string;
  catalogProof?: string;
  contextWindow: number;
  model: string;
  secret: string;
}>): Record<string, unknown> {
  return {
    allowPrivateNetwork: true,
    apiRoot: input.apiRoot,
    authenticationMode: "bearer",
    // Hybrid compaction freezes only for tool-capable models; setup verifies the declaration.
    capabilities: {
      contextWindow: input.contextWindow, defaultMaxOutputTokens: 4096, streaming: true, toolCalling: true,
      parallelToolCalls: false, reasoning: true, reasoningEfforts: ["low"], defaultReasoningEffort: "low",
      nativePdfInput: false, nativeImageGeneration: false, nativeSearch: false, pdf: true, vision: false
    },
    confirmPaidRequest: true,
    connectionDisplayName: "Context journey codex-lb",
    modelDisplayName: "Context journey model",
    protocol: "responses",
    responseTimeoutSeconds: 180,
    secret: input.secret,
    ...(input.catalogProof ? { catalogProof: input.catalogProof, modelIds: [input.model] } : { modelId: input.model })
  };
}

// Usage ledger ---------------------------------------------------------------------

/**
 * Provider-reported input tokens the Admin usage ledger (`GET /api/admin`)
 * holds for this user and model, or null when the shape is unexpected. Rows
 * are keyed by the run's provider and model identity; either spelling counts.
 */
export function ledgerInputTokens(
  dashboard: unknown,
  userId: string,
  keys: Readonly<{ modelIds: readonly string[]; providers: readonly string[] }>
): number | null {
  if (!record(dashboard) || !record(dashboard.usage) || !Array.isArray(dashboard.usage.byUser)) return null;
  const user = dashboard.usage.byUser.find((entry) => record(entry) && entry.userId === userId);
  if (!user) return 0;
  if (!record(user) || !Array.isArray(user.providerModels)) return null;
  let total = 0;
  for (const row of user.providerModels) {
    if (!record(row) || typeof row.provider !== "string" || typeof row.modelId !== "string") return null;
    if (!keys.providers.includes(row.provider) || !keys.modelIds.includes(row.modelId)) continue;
    if (row.inputTokens !== null && !(Number.isSafeInteger(row.inputTokens) && Number(row.inputTokens) >= 0)) return null;
    total += Number(row.inputTokens ?? 0);
  }
  return total;
}

// Chat projection --------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["cancelled", "complete", "error"]);

/** The assistant answering the user message sent after `previousLeafId`, once terminal. */
export function settledTurn(detail: ChatDetailWire, previousLeafId: string | null): Readonly<{
  assistant: ChatMessageWire;
  user: ChatMessageWire;
}> | null {
  const newestFirst = [...detail.messages].reverse();
  const user = newestFirst.find((message) => message.role === "user" && message.parentMessageId === previousLeafId);
  const assistant = user && newestFirst.find((message) => message.role === "assistant" && message.parentMessageId === user.id);
  return user && assistant && TERMINAL_STATUSES.has(assistant.status) ? { assistant, user } : null;
}

export function messageText(message: Pick<ChatMessageWire, "content">): string {
  if (typeof message.content === "string") return message.content;
  return record(message.content) ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

// Evidence and verdict ---------------------------------------------------------------

export type JourneyTurnKind = "brief" | "correction" | "filler" | "probe" | "rule";

export type JourneyRound = Readonly<{
  budgetShare: number | null;
  compactionOutcome: ContextCompactionStatus["outcome"] | null;
  estimatedInputTokens: number | null;
  kind: JourneyTurnKind;
  ratio: number | null;
  reportedInputTokens: number | null;
  summaryAtBudgetShare: number | null;
  turn: number;
}>;

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * One turn's content-free evidence. The estimate is the stand's own session
 * measurement of the final request (its after-answer phase minus the answer's
 * estimate). The ratio compares it with the provider-reported input only for a
 * single-round turn: summary calls and tool rounds add input the final request
 * estimate does not describe.
 */
export function journeyRound(input: Readonly<{
  answerTokens: number;
  compaction: ContextCompactionStatus | null;
  kind: JourneyTurnKind;
  reportedInputTokens: number | null;
  session: SessionContextStatus | null;
  toolCalls: number;
  turn: number;
}>): JourneyRound {
  const { session } = input;
  const estimated = session
    ? Math.max(0, session.approximateInputTokens - (session.phase === "after_answer" ? input.answerTokens : 0))
    : null;
  const budget = session ? sessionContextCapacity(session).budgetTokens : null;
  const share = (tokens: number | null) => tokens !== null && budget ? rounded(tokens / budget) : null;
  const reported = input.reportedInputTokens;
  return {
    budgetShare: share(estimated),
    compactionOutcome: input.compaction?.outcome ?? null,
    estimatedInputTokens: estimated,
    kind: input.kind,
    ratio: estimated && reported && input.compaction === null && input.toolCalls === 0 ? rounded(reported / estimated) : null,
    reportedInputTokens: reported,
    summaryAtBudgetShare: input.compaction?.outcome === "summary_applied" ? share(input.compaction.beforeTokens) : null,
    turn: input.turn
  };
}

export type JourneyVerdict = Readonly<{
  code: string | null;
  compactionTriggered: boolean;
  firstSummaryAtBudgetShare: number | null;
  passed: boolean;
}>;

export function journeyVerdict(rounds: readonly JourneyRound[], probeAnswerCarriesCorrections: boolean): JourneyVerdict {
  const compactionTriggered = rounds.some((round) => round.compactionOutcome !== null);
  const firstSummaryAtBudgetShare = rounds.find((round) => round.summaryAtBudgetShare !== null)?.summaryAtBudgetShare ?? null;
  const code = !compactionTriggered ? "compaction_not_triggered"
    : firstSummaryAtBudgetShare === null ? "summary_not_bought"
      : firstSummaryAtBudgetShare < JOURNEY_LIMITS.passMinShare || firstSummaryAtBudgetShare > JOURNEY_LIMITS.passMaxShare
        ? "summary_share_out_of_range"
        : !probeAnswerCarriesCorrections ? "probe_answer_missing_corrections" : null;
  return { code, compactionTriggered, firstSummaryAtBudgetShare, passed: code === null };
}

/** Exit 0 needs at least one executed route and every executed route passing;
 * an explicitly requested route that had to be skipped also fails the run. */
export function journeyExitCode(
  results: readonly Readonly<{ status: "failed" | "passed" | "skipped" }>[],
  explicitRoutes: boolean
): 0 | 1 {
  const executed = results.filter((result) => result.status !== "skipped");
  if (executed.length === 0 || executed.some((result) => result.status !== "passed")) return 1;
  return explicitRoutes && results.some((result) => result.status === "skipped") ? 1 : 0;
}
