import type { ProviderConversationMessage, ProviderModelCapabilities } from "../providers/types";
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  type KnowledgeBudgetPolicy
} from "./knowledgeBudget";
import {
  decodeKnowledgePlannerTargetResolution,
  KNOWLEDGE_PLANNER_TARGET_CANDIDATE_MAXIMUM,
  knowledgePlannerMetadataMentions,
  resolveKnowledgePlannerTargets,
  type KnowledgePlannerSourceIdentity,
  type KnowledgePlannerTargetResolution
} from "./plannerTargetResolution";
export type {
  KnowledgePlannerSourceIdentity,
  KnowledgePlannerTargetMatch,
  KnowledgePlannerTargetOutcome,
  KnowledgePlannerTargetResolution
} from "./plannerTargetResolution";

export const KNOWLEDGE_PLANNER_VERSION = 2 as const;
export const KNOWLEDGE_PLANNER_LEGACY_VERSION = 1 as const;
/** Persistence/payload safety bound, not a retrieval tuning default. */
export const KNOWLEDGE_PLANNER_SUBQUERY_SAFETY_MAX = 128;

export const knowledgePlannerIntents = [
  "no_knowledge_needed",
  "fact_lookup",
  "exact_lookup",
  "single_source_summary",
  "multi_source_comparison",
  "exhaustive_corpus_search",
  "corpus_summary",
  "multi_hop_reasoning",
  "structured_data_analysis",
  "source_discovery",
  "follow_up_reference",
  "mixed"
] as const;

export type KnowledgePlannerIntent = typeof knowledgePlannerIntents[number];

export const knowledgePlannerStrategies = [
  "none",
  "focused",
  "full_context",
  "comparison",
  "exhaustive",
  "multi_pass",
  "corpus_summary",
  "structured_data"
] as const;

export type KnowledgePlannerStrategy = typeof knowledgePlannerStrategies[number];
export type KnowledgePlannerLane = "exact" | "lexical" | "metadata" | "semantic";
export const knowledgePlannerOperations = [
  "automatic_search",
  "discover_sources",
  "find_exact",
  "structured_analysis",
  "visual_analysis"
] as const;
export type KnowledgePlannerOperation = typeof knowledgePlannerOperations[number];
export type KnowledgePlannerExactSpecification = Readonly<{
  caseMode: "insensitive" | "sensitive";
  field: "any" | "body" | "filename" | "heading" | "tag" | "title";
  match: "pattern" | "phrase" | "token";
  value: string;
}>;

export type KnowledgePlannerBaseSummary = Readonly<{
  approxTokens: number | null;
  knowledgeBaseId: string;
  passageCount: number | null;
  readySourceCount: number;
  sourceCount: number;
}>;

export type KnowledgePlannerDirectSourceSummary = Readonly<{
  approxTokens: number;
  passageCount: number;
  sourceOrdinal: number;
}>;

export type KnowledgePlannerInput = Readonly<{
  bases: readonly KnowledgePlannerBaseSummary[];
  budgetPolicy?: Pick<KnowledgeBudgetPolicy, "maxSubqueriesPerPhase">;
  conversation: readonly Readonly<{ role: "assistant" | "user"; text: string }>[];
  directSources: readonly KnowledgePlannerDirectSourceSummary[];
  modelCapabilities: Pick<ProviderModelCapabilities, "contextWindow" | "toolCalling">;
  originalQuery: string;
  scopeRequested: boolean;
  /** Canonical, admitted, identity-only Source metadata. Passage/body text is forbidden. */
  sources: readonly KnowledgePlannerSourceIdentity[];
  version: typeof KNOWLEDGE_PLANNER_VERSION;
}>;

export type KnowledgePlannerSubquery = Readonly<{
  /** Present and required on v2 plans; absent only on decoded legacy v1 plans. */
  exact?: KnowledgePlannerExactSpecification | null;
  exactTerms: readonly string[];
  lanes: readonly KnowledgePlannerLane[];
  /** Present and required on v2 plans; absent only on decoded legacy v1 plans. */
  operation?: KnowledgePlannerOperation;
  ordinal: number;
  purpose: "answer" | "compare_target" | "coverage" | "follow_up" | "source_discovery" | "summary";
  query: string;
  targetNames: readonly string[];
  /** Present and required on v2 plans; absent only on decoded legacy v1 plans. */
  targetResolution?: KnowledgePlannerTargetResolution | null;
  /** Present and required on v2 plans; absent only on decoded legacy v1 plans. */
  targetSourceIds?: readonly string[];
}>;

export type KnowledgePlannerSubqueryV2 = Readonly<
  Omit<KnowledgePlannerSubquery, "exact" | "operation" | "targetResolution" | "targetSourceIds"> & {
    exact: KnowledgePlannerExactSpecification | null;
    operation: KnowledgePlannerOperation;
    targetResolution: KnowledgePlannerTargetResolution | null;
    targetSourceIds: readonly string[];
  }
>;

export type KnowledgePlannerPlan = Readonly<{
  automaticRetrieval: boolean;
  coverage: Readonly<{
    expectedPassageCount: number | null;
    mode: "partial" | "verified_only";
    namedTargets: readonly string[];
  }>;
  evidenceMode: "compact" | "fuller";
  failureCode?: "classifier_invalid" | "classifier_unavailable";
  intent: KnowledgePlannerIntent;
  originalQuery: string;
  rewrite: Readonly<{
    exactTerms: readonly string[];
    query: string;
  }>;
  status: "degraded" | "ready";
  strategy: KnowledgePlannerStrategy;
  subqueries: readonly KnowledgePlannerSubquery[];
  /** Present and required on v2 plans; absent only on decoded legacy v1 plans. */
  targetResolution?: KnowledgePlannerTargetResolution | null;
  /** Present and required on v2 plans; absent only on decoded legacy v1 plans. */
  targetSourceIds?: readonly string[];
  version: typeof KNOWLEDGE_PLANNER_LEGACY_VERSION | typeof KNOWLEDGE_PLANNER_VERSION;
}>;

export type KnowledgePlannerPlanV2 = Readonly<
  Omit<KnowledgePlannerPlan, "subqueries" | "targetResolution" | "targetSourceIds" | "version"> & {
    subqueries: readonly KnowledgePlannerSubqueryV2[];
    targetResolution: KnowledgePlannerTargetResolution | null;
    targetSourceIds: readonly string[];
    version: typeof KNOWLEDGE_PLANNER_VERSION;
  }
>;

export type KnowledgePlannerClassifier = Readonly<{
  classify(input: KnowledgePlannerInput): Promise<Readonly<{
    intent: KnowledgePlannerIntent;
    rewrittenQuery?: string;
  }>>;
}>;

const intentSet = new Set<string>(knowledgePlannerIntents);
const strategySet = new Set<string>(knowledgePlannerStrategies);
const laneSet = new Set<string>(["exact", "lexical", "metadata", "semantic"]);
const operationSet = new Set<string>(knowledgePlannerOperations);
const exactCue = /(?:\bexact(?:ly)?\b|\bverbatim\b|\bcode\b|\bidentifier\b|\bquote\b|\bphrase\b|точн(?:о|ую|ая)|дословн|код\b|идентификатор)/iu;
const comparisonCue = /(?:\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b|сравн|разниц|отличи|между)/iu;
const exhaustiveCue = /(?:\ball\b|\bevery\b|\bcomplete list\b|\bexhaustive\b|\bwithout omissions?\b|\bentire corpus\b|\bfind each\b|\blist each\b|\bвсе\b|\bкажд\p{L}*\b|полный список|без исключени|без пропуск|целиком по базе)/iu;
const summaryCue = /(?:\bsummar(?:y|ize|ise)\b|\boverview\b|\bbrief me\b|резюм|кратк(?:о|ий|ое)|обзор|сводк|суммариз)/iu;
const corpusCue = /(?:\bcorpus\b|\bknowledge base\b|\ball (?:documents|sources|files)\b|корпус|баз[аеуы] знани|вс[её] (?:документ|источник|файл))/iu;
const structuredCue = /(?:\bcsv\b|\bxls[x]?\b|\bods\b|\bspreadsheet\b|\btable\b|\bcolumn\b|\baggregate\b|\baverage\b|\bmedian\b|\bsum\b|\btrend\b|\boutliers?\b|\bjoin\b|\bsort\b|\bfilter\b|\bcalculate\b|\bdifference\b|\bratio\b|\bformula(?:s)?\b|таблиц|столбц|средн(?:ее|яя)|медиан|сумм(?:а|ируй)|агрегир|тренд|выброс|аномал|сортир|фильтр|посчитай|рассчитай|разниц|отношени|формул|сопостав|объедин)/iu;
const russianDynamicsCue = /динамик/iu;
const structuredArtifactCue = /(?:\bcsv\b|\bxls[x]?\b|\bods\b|\bspreadsheet\b|\bworkbook\b|\bsheet\b|\btable\b|\bcolumn\b|таблиц|лист(?:е|а|у|ом)?\b|столбц|диапазон)/iu;
const visualCue = /(?:\bchart\b|\bdiagram\b|\bimage\b|\bfigure\b|\bphoto\b|\blayout\b|график|диаграм|изображени|рисунк|фотограф|схем|макет)/iu;
const discoveryCue = /(?:\bwhich (?:document|source|file)s?\b|\bwhere is\b|\bfind the source\b|како(?:й|ие) (?:документ|источник|файл)|где (?:сказано|описано|написано)|найди источник)/iu;
const noKnowledgeCue = /^(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|привет|здравствуй(?:те)?|спасибо|благодарю|ок(?:ей)?|как дела)[\s!.,?]*$/iu;
const conversationOnlyCue = /^(?:(?:please\s+)?(?:rephrase|rewrite|shorten|translate)\s+(?:(?:your|the)\s+)?(?:previous|last)\s+(?:answer|response)|(?:пожалуйста,?\s*)?(?:перефразируй|перепиши|сократи|переведи)\s+(?:свой\s+)?(?:предыдущий|последний)\s+ответ)[\s.!?]*$/iu;
const followUpCue = /^(?:and |also |what about |how about |why |when |where |it\b|that\b|those\b|this\b|а |и |ещ[её] |а что |почему |когда |где |он\b|она\b|они\b|это\b|тот\b|те\b)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bounded(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum).trimEnd();
}

function explicitPattern(query: string): Readonly<{ serialized: string; value: string }> | null {
  if (!/(?:\bregex\b|\bregular expression\b|\bpattern\b|регулярн(?:ое|ому|ым) выражени|шаблон)/iu
    .test(query)) return null;
  const match = query.match(/\/([^/\r\n]{1,200})\/[gimsuy]*/u);
  return match?.[0] && match[1]
    ? { serialized: match[0], value: match[1] }
    : null;
}

function codeTermsFromQuery(query: string): string[] {
  const candidates = query.match(
    /(?<![\p{L}\p{N}._/-])[\p{L}\p{N}._/-]{2,64}(?![\p{L}\p{N}._/-])/gu
  ) ?? [];
  return candidates.filter((candidate) =>
    /^(?=[\p{Lu}\d._/-]*\d)[\p{Lu}\d][\p{Lu}\d._/-]+$/u.test(candidate));
}

function exactTermsFromQuery(query: string): string[] {
  const quoted = [...query.matchAll(/(?:"([^"]{1,200})"|'([^']{1,200})'|`([^`]{1,200})`|“([^”]{1,200})”|«([^»]{1,200})»)/gu)]
    .map((match) => match[0] ?? "");
  const dates = query.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gu) ?? [];
  const codes = codeTermsFromQuery(query);
  const names = query.match(/\b[\p{Lu}][\p{L}\p{M}.-]{1,50}(?:\s+[\p{Lu}][\p{L}\p{M}.-]{1,50})+\b/gu) ?? [];
  const pattern = explicitPattern(query);
  return unique([...quoted, ...(pattern ? [pattern.serialized] : []), ...dates, ...codes, ...names])
    .slice(0, 24);
}

function hasHardExactSignal(
  query: string,
  sources: readonly KnowledgePlannerSourceIdentity[]
): boolean {
  if (exactCue.test(query)) return true;
  const metadataLabels = knowledgePlannerMetadataMentions({ query, sources })
    .map((label) => label.normalize("NFKC").toLocaleLowerCase("und"));
  const candidates = [
    ...(query.match(/(?:"[^"]+"|'[^']+'|`[^`]+`|“[^”]+”|«[^»]+»)/gu) ?? []),
    ...(query.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gu) ?? []),
    ...codeTermsFromQuery(query)
  ];
  return candidates.some((candidate) => {
    const comparable = candidate.replace(/^["'`“«]|["'`”»]$/gu, "")
      .normalize("NFKC").toLocaleLowerCase("und");
    return !metadataLabels.some((label) => label.includes(comparable));
  });
}

type KnowledgePlannerScopeSummary = Readonly<{
  approxTokens: number | null;
  passageCount: number | null;
  readySourceCount: number;
  sourceCount: number;
}>;

function readyScopeSummaries(input: KnowledgePlannerInput): KnowledgePlannerScopeSummary[] {
  const directSources = input.directSources ?? [];
  return [
    ...input.bases.filter((base) => base.readySourceCount > 0),
    ...directSources.map((source) => ({
      approxTokens: source.approxTokens,
      passageCount: source.passageCount,
      readySourceCount: 1,
      sourceCount: 1
    }))
  ];
}

function smallFullContextScope(input: KnowledgePlannerInput): KnowledgePlannerScopeSummary | null {
  const summaries = readyScopeSummaries(input);
  if (summaries.length !== 1) return null;
  const scope = summaries[0]!;
  const contextWindow = input.modelCapabilities.contextWindow;
  const maximumTokens = Math.min(
    12_000,
    Number.isFinite(contextWindow) && Number(contextWindow) > 0
      ? Math.max(1_500, Math.floor(Number(contextWindow) * 0.25))
      : 4_000
  );
  return scope.sourceCount === 1 && scope.readySourceCount === 1 &&
    scope.passageCount !== null && scope.passageCount >= 1 && scope.passageCount <= 8 &&
    scope.approxTokens !== null && scope.approxTokens >= 1 && scope.approxTokens <= maximumTokens
    ? scope
    : null;
}

function deterministicIntent(input: KnowledgePlannerInput): KnowledgePlannerIntent {
  const query = input.originalQuery.trim();
  if (!input.scopeRequested || !query || noKnowledgeCue.test(query)) {
    return "no_knowledge_needed";
  }
  if (input.conversation.length > 0 && conversationOnlyCue.test(query)) {
    return "no_knowledge_needed";
  }
  const comparison = comparisonCue.test(query);
  const exhaustive = exhaustiveCue.test(query);
  const summary = summaryCue.test(query);
  const structured = russianDynamicsCue.test(query)
    ? structuredArtifactCue.test(query)
    : structuredCue.test(query);
  const exact = hasHardExactSignal(query, input.sources ?? []);
  const distinctSignals = [comparison, exhaustive, summary, structured, exact]
    .filter(Boolean).length;
  if (distinctSignals >= 2 && !(summary && exhaustive && corpusCue.test(query))) return "mixed";
  if (comparison) return "multi_source_comparison";
  if (exhaustive) return "exhaustive_corpus_search";
  if (structured) return "structured_data_analysis";
  if (summary) {
    if ((input.sources?.length ?? 0) > 0 && knowledgePlannerMetadataMentions({
      query,
      sources: input.sources ?? []
    }).length === 1) return "single_source_summary";
    const directSources = input.directSources ?? [];
    const sourceCount = input.bases.reduce((total, base) =>
      total + base.readySourceCount, 0) + directSources.length;
    return sourceCount === 1 ? "single_source_summary" : "corpus_summary";
  }
  if (discoveryCue.test(query)) return "source_discovery";
  if (input.conversation.length > 0 && followUpCue.test(query)) {
    return "follow_up_reference";
  }
  if (exact) return "exact_lookup";
  if (input.conversation.length > 0 && query.length <= 24) {
    return "follow_up_reference";
  }
  const clauses = query.split(/(?:[?;]\s*|\b(?:and then|then|after that)\b|\b(?:затем|после этого|и потом)\b)/iu)
    .filter((part) => part.trim().length >= 4);
  if (clauses.length >= 2) return "multi_hop_reasoning";
  return "fact_lookup";
}

function strategyForIntent(
  intent: KnowledgePlannerIntent,
  fullContext: KnowledgePlannerScopeSummary | null
): KnowledgePlannerStrategy {
  if (intent === "no_knowledge_needed") return "none";
  if (intent === "single_source_summary" && fullContext) return "full_context";
  if (intent === "single_source_summary" || intent === "corpus_summary") return "corpus_summary";
  if (intent === "multi_source_comparison") return "comparison";
  if (intent === "exhaustive_corpus_search") return "exhaustive";
  if (intent === "multi_hop_reasoning" || intent === "mixed") return "multi_pass";
  if (intent === "structured_data_analysis") return "structured_data";
  return "focused";
}

function cleanTarget(value: string): string {
  return value
    .replace(/^[\s:,-]+|[\s,;:?.!]+$/gu, "")
    .replace(/\s+(?:by|on|across|using|по|на основе|с точки зрения)\s+.+$/iu, "")
    .trim();
}

function comparisonTargets(query: string, exactTerms: readonly string[]): string[] {
  const withoutCue = query
    .replace(/^.*?(?:compare|comparison of|difference between|differences between|сравни(?:ть|вай)?|сравнение|разниц[ау] между|отличия между)\s+/iu, "")
    .replace(/[?.!]+$/u, "");
  const targetList = cleanTarget(withoutCue);
  const quoted = exactTerms.filter((term) =>
    /^(?:["'`“«])/u.test(term) && targetList.includes(term))
    .map((term) => term.replace(/^["'`“«]|["'`”»]$/gu, ""));
  if (quoted.length >= 2) return unique(quoted).slice(0, 8);
  const parts = targetList.split(/(?:\s+(?:vs\.?|versus|and|и|с)\s+|\s*[,;]\s*)/iu)
    .map(cleanTarget)
    .filter((part) => part.length >= 1 && part.length <= 160);
  if (parts.length >= 2) return unique(parts).slice(0, 8);
  const properNames = query.match(/\b[\p{Lu}][\p{L}\p{M}\d._-]{1,50}(?:\s+[\p{Lu}][\p{L}\p{M}\d._-]{1,50})*\b/gu) ?? [];
  return unique(properNames.filter((name) => !/^(?:Compare|Comparison|Сравни|Сравнение)$/iu.test(name)))
    .slice(0, 8);
}

function targetNamesForRequest(
  input: KnowledgePlannerInput,
  intent: KnowledgePlannerIntent,
  exactTerms: readonly string[]
): string[] {
  if (intent === "source_discovery") return [];
  const sources = input.sources ?? [];
  const currentMentions = sources.length > 0
    ? knowledgePlannerMetadataMentions({ query: input.originalQuery, sources })
    : [];
  const comparison = intent === "multi_source_comparison" ||
    intent === "mixed" && comparisonCue.test(input.originalQuery);
  if (comparison) {
    if (currentMentions.length >= 2) return currentMentions.slice(0, 8);
    const parsed = comparisonTargets(input.originalQuery, exactTerms);
    if (followUpCue.test(input.originalQuery) && sources.length > 0) {
      const priorMentions = input.conversation.slice(-4).reverse().flatMap((message) =>
        knowledgePlannerMetadataMentions({ query: message.text, sources }));
      const contextual = unique([...priorMentions, ...currentMentions]);
      if (contextual.length >= 2) return contextual.slice(0, 8);
    }
    return parsed;
  }
  if (intent === "multi_hop_reasoning" || intent === "mixed") return [];
  if (currentMentions.length > 0) return currentMentions.slice(0, 8);
  if (followUpCue.test(input.originalQuery) && sources.length > 0) {
    for (const message of input.conversation.slice(-4).reverse()) {
      const mentions = knowledgePlannerMetadataMentions({ query: message.text, sources });
      if (mentions.length > 0) return mentions.slice(0, 8);
    }
  }
  return [];
}

function operationRequiresExactSource(intent: KnowledgePlannerIntent, query: string): boolean {
  return intent === "structured_data_analysis" ||
    visualCue.test(query) && !structuredArtifactCue.test(query);
}

function unresolvedScopeTargetResolution(
  sources: readonly KnowledgePlannerSourceIdentity[]
): KnowledgePlannerTargetResolution {
  if (sources.length < 2) {
    return {
      outcome: "not_found",
      targets: [{
        candidateSourceIds: [],
        matchKind: "none",
        outcome: "not_found",
        targetName: "unspecified source"
      }],
      targetSourceIds: []
    };
  }
  return {
    outcome: "ambiguous",
    targets: [{
      candidateSourceIds: sources
        .slice(0, KNOWLEDGE_PLANNER_TARGET_CANDIDATE_MAXIMUM)
        .map((source) => source.sourceId),
      matchKind: "scope",
      outcome: "ambiguous",
      targetName: "unspecified source"
    }],
    targetSourceIds: []
  };
}

function rewrittenQuery(input: KnowledgePlannerInput, intent: KnowledgePlannerIntent): string {
  const original = bounded(input.originalQuery, 4_000);
  if (input.conversation.length === 0 ||
    intent !== "follow_up_reference" && !followUpCue.test(original)) return original;
  const context = input.conversation.slice(-4)
    .map((message) => `${message.role}: ${bounded(message.text, 500)}`)
    .join("\n");
  return bounded(`${original}\nRelevant conversation context:\n${context}`, 8_000);
}

function queryWithTerms(query: string, exactTerms: readonly string[]): string {
  const normalized = query.replace(/\s+/gu, " ").trim();
  const missing = exactTerms.filter((term) => !normalized.includes(term));
  const suffix = missing.length > 0 ? ` ${missing.join(" ")}` : "";
  const maximumPrefix = Math.max(1, 500 - suffix.length);
  return `${normalized.slice(0, maximumPrefix).trimEnd()}${suffix}`.slice(0, 500).trim();
}

function plannerBranchLimit(input: KnowledgePlannerInput): number {
  return Math.max(1, Math.min(
    KNOWLEDGE_PLANNER_SUBQUERY_SAFETY_MAX,
    input.budgetPolicy?.maxSubqueriesPerPhase ??
      DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxSubqueriesPerPhase
  ));
}

function partitionTargets(targets: readonly string[], maximum: number): string[][] {
  // A comparison branch is a Source-local execution unit. Combining multiple
  // targets into one branch lets evidence from one Source satisfy another
  // target and makes per-target coverage impossible to measure. When the
  // accepted subquery budget is smaller than the target set, execute the
  // bounded prefix independently and leave overall comparison coverage
  // partial instead of pretending every target was searched.
  return targets.slice(0, maximum).map((target) => [target]);
}

function exactField(query: string): KnowledgePlannerExactSpecification["field"] {
  if (/(?:\bfile\s*name\b|\bfilename\b|имя файла|названи[ея] файла)/iu.test(query)) {
    return "filename";
  }
  if (/(?:\bheading\b|заголов)/iu.test(query)) return "heading";
  if (/(?:\btitle\b|названи[ея] (?:документа|источника))/iu.test(query)) return "title";
  if (/(?:\btag\b|\bтег)/iu.test(query)) return "tag";
  if (/(?:\bany field\b|\banywhere\b|любое поле|где угодно)/iu.test(query)) return "any";
  return "body";
}

function exactSpecification(
  query: string,
  exactTerms: readonly string[],
  targetNames: readonly string[]
): KnowledgePlannerExactSpecification | null {
  const comparableTargetNames = new Set(targetNames.map((targetName) =>
    targetName.normalize("NFKC").toLocaleLowerCase("und").trim()));
  const searchableTerms = exactTerms.filter((term) => {
    const unquoted = term.replace(/^["'`“«]|["'`”»]$/gu, "");
    return !comparableTargetNames.has(
      unquoted.normalize("NFKC").toLocaleLowerCase("und").trim()
    );
  });
  const pattern = explicitPattern(query);
  const quoted = searchableTerms.filter((term) => /^(?:"[^"]+"|'[^']+'|`[^`]+`|“[^”]+”|«[^»]+»)$/u.test(term));
  let match: KnowledgePlannerExactSpecification["match"];
  let value: string;
  if (pattern) {
    match = "pattern";
    value = pattern.value;
    if (searchableTerms.some((term) => term !== pattern.serialized && term !== pattern.value)) return null;
  } else if (quoted.length === 1) {
    match = "phrase";
    value = quoted[0]!.slice(1, -1);
    if (searchableTerms.some((term) => term !== quoted[0] && term !== value)) return null;
  } else if (searchableTerms.length === 1) {
    match = "token";
    value = searchableTerms[0]!;
  } else {
    return null;
  }
  const normalizedValue = value.normalize("NFKC").trim();
  if (!normalizedValue || normalizedValue.length > 500) return null;
  return {
    caseMode: /(?:\bcase[- ]sensitive\b|\bmatch case\b|с уч[её]том регистра|учитывая регистр)/iu.test(query)
      ? "sensitive"
      : "insensitive",
    field: exactField(query),
    match,
    value: normalizedValue
  };
}

function operationForSubquery(input: Readonly<{
  exact: KnowledgePlannerExactSpecification | null;
  intent: KnowledgePlannerIntent;
  query: string;
}>): KnowledgePlannerOperation {
  if (input.intent === "source_discovery") return "discover_sources";
  if (input.intent === "structured_data_analysis") return "structured_analysis";
  if (visualCue.test(input.query) && !structuredArtifactCue.test(input.query)) {
    return "visual_analysis";
  }
  if (input.intent === "exact_lookup" && input.exact) return "find_exact";
  return "automatic_search";
}

function lanesForOperation(
  operation: KnowledgePlannerOperation,
  intent: KnowledgePlannerIntent
): KnowledgePlannerLane[] {
  if (operation === "discover_sources") return ["metadata"];
  if (operation === "find_exact") return ["exact"];
  if (operation === "structured_analysis" || operation === "visual_analysis") return [];
  return intent === "exact_lookup"
    ? ["exact", "lexical", "semantic"]
    : ["semantic", "lexical", "exact", "metadata"];
}

function unresolvedTargetSubquery(input: Readonly<{
  rewritten: string;
  targetNames: readonly string[];
  targetResolution: KnowledgePlannerTargetResolution;
}>): KnowledgePlannerSubqueryV2 {
  return {
    exact: null,
    exactTerms: [],
    lanes: ["metadata"],
    operation: "discover_sources",
    ordinal: 0,
    purpose: "source_discovery",
    query: queryWithTerms(input.rewritten, []),
    targetNames: input.targetNames,
    targetResolution: input.targetResolution,
    targetSourceIds: []
  };
}

function subqueries(input: Readonly<{
  branchLimit: number;
  exactTerms: readonly string[];
  intent: KnowledgePlannerIntent;
  originalQuery: string;
  rewritten: string;
  sources: readonly KnowledgePlannerSourceIdentity[];
  strategy: KnowledgePlannerStrategy;
  targetNames: readonly string[];
  targetResolution: KnowledgePlannerTargetResolution | null;
}>): KnowledgePlannerSubqueryV2[] {
  if (input.strategy === "none") return [];
  if (input.targetResolution?.outcome === "ambiguous" ||
    input.targetResolution?.outcome === "not_found") {
    return [unresolvedTargetSubquery({
      rewritten: input.rewritten,
      targetNames: input.targetNames,
      targetResolution: input.targetResolution
    })];
  }
  const exact = exactSpecification(input.originalQuery, input.exactTerms, input.targetNames);
  const operation = operationForSubquery({
    exact,
    intent: input.intent,
    query: input.rewritten
  });
  const lanes = lanesForOperation(operation, input.intent);
  if (input.intent === "multi_source_comparison" ||
    input.intent === "mixed" && comparisonCue.test(input.rewritten)) {
    if (input.targetNames.length >= 2) {
      return partitionTargets(input.targetNames, input.branchLimit).map((group, ordinal) => {
        const targetResolution = resolveKnowledgePlannerTargets({
          sources: input.sources,
          targetNames: group
        });
        return {
        exact: operation === "find_exact" ? exact : null,
        exactTerms: operation === "discover_sources"
          ? []
          : unique([...input.exactTerms, ...group]),
        lanes,
        operation,
        ordinal,
        purpose: "compare_target" as const,
        query: queryWithTerms(`${input.rewritten} Target: ${group.join("; ")}`, [
          ...input.exactTerms,
          ...group
        ]),
        targetNames: group,
        targetResolution,
        targetSourceIds: targetResolution?.targetSourceIds ?? []
      };
      });
    }
  }
  if (input.intent === "multi_hop_reasoning" || input.intent === "mixed") {
    const parts = input.rewritten.split(/(?:[?;]\s*|\b(?:and then|then|after that)\b|\b(?:затем|после этого|и потом)\b)/iu)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4)
      .slice(0, input.branchLimit);
    if (parts.length >= 2) {
      return parts.map((part, ordinal) => ({
        exact: null,
        exactTerms: input.exactTerms.filter((term) => part.includes(term)),
        lanes,
        operation,
        ordinal,
        purpose: ordinal === 0 ? "answer" as const : "follow_up" as const,
        query: queryWithTerms(part, input.exactTerms.filter((term) => part.includes(term))),
        targetNames: [],
        targetResolution: null,
        targetSourceIds: []
      }));
    }
  }
  return [{
    exact: operation === "find_exact" ? exact : null,
    exactTerms: input.exactTerms,
    lanes,
    operation,
    ordinal: 0,
    purpose: operation === "discover_sources"
      ? "source_discovery"
      : input.strategy === "full_context" || input.strategy === "corpus_summary"
        ? "summary"
        : input.strategy === "exhaustive" ? "coverage" : "answer",
    query: queryWithTerms(input.rewritten, input.exactTerms),
    targetNames: input.targetNames,
    targetResolution: input.targetResolution,
    targetSourceIds: input.targetResolution?.targetSourceIds ?? []
  }];
}

function deterministicPlan(
  input: KnowledgePlannerInput,
  override?: Readonly<{ intent?: KnowledgePlannerIntent; rewrittenQuery?: string }>
): KnowledgePlannerPlanV2 {
  const intent = override?.intent ?? deterministicIntent(input);
  const exactTerms = exactTermsFromQuery(input.originalQuery);
  let rewritten = bounded(override?.rewrittenQuery ?? rewrittenQuery(input, intent), 8_000);
  const missingExactTerms = exactTerms.filter((term) => !rewritten.includes(term));
  if (missingExactTerms.length > 0) {
    const suffix = missingExactTerms.map((term) => `\nExact term: ${term}`).join("");
    rewritten = `${bounded(rewritten, Math.max(1, 8_000 - suffix.length))}${suffix}`;
  }
  const fullContext = smallFullContextScope(input);
  const strategy = readyScopeSummaries(input).length === 0
    ? "none"
    : strategyForIntent(intent, fullContext);
  const branchLimit = plannerBranchLimit(input);
  const sources = input.sources ?? [];
  const extractedTargetNames = targetNamesForRequest(input, intent, exactTerms);
  const missingTargetNames = extractedTargetNames.filter((target) => !rewritten.includes(target));
  if (missingTargetNames.length > 0) {
    const suffix = missingTargetNames.map((target) => `\nTarget: ${target}`).join("");
    rewritten = `${bounded(rewritten, Math.max(1, 8_000 - suffix.length))}${suffix}`;
  }
  let targetNames = extractedTargetNames;
  if (targetNames.length === 0 && operationRequiresExactSource(intent, input.originalQuery) &&
    sources.length === 1) targetNames = [sources[0]!.sourceAlias];
  let targetResolution = resolveKnowledgePlannerTargets({ sources, targetNames });
  if (targetNames.length === 0 && operationRequiresExactSource(intent, input.originalQuery)) {
    targetNames = ["unspecified source"];
    targetResolution = unresolvedScopeTargetResolution(sources);
  }
  const plannedSubqueries = subqueries({
    branchLimit,
    exactTerms,
    intent,
    originalQuery: input.originalQuery,
    rewritten,
    sources,
    strategy,
    targetNames,
    targetResolution
  }).slice(0, branchLimit);
  const namedTargets = comparisonCue.test(rewritten) &&
    (intent === "multi_source_comparison" || intent === "mixed")
    ? targetNames
    : unique(plannedSubqueries.flatMap((subquery) => subquery.targetNames));
  return {
    automaticRetrieval: strategy !== "none",
    coverage: {
      expectedPassageCount: strategy === "full_context" ? fullContext?.passageCount ?? null : null,
      mode: exhaustiveCue.test(input.originalQuery) || strategy === "full_context"
        ? "verified_only"
        : "partial",
      namedTargets
    },
    evidenceMode: input.modelCapabilities.toolCalling === true ? "compact" : "fuller",
    intent,
    originalQuery: bounded(input.originalQuery, 8_000),
    rewrite: { exactTerms, query: rewritten },
    status: "ready",
    strategy,
    subqueries: plannedSubqueries,
    targetResolution,
    targetSourceIds: targetResolution?.targetSourceIds ?? [],
    version: KNOWLEDGE_PLANNER_VERSION
  };
}

export async function planKnowledgeRequest(
  input: KnowledgePlannerInput,
  options: Readonly<{ classifier?: KnowledgePlannerClassifier }> = {}
): Promise<KnowledgePlannerPlanV2> {
  if (!options.classifier) return deterministicPlan(input);
  try {
    const classified = await options.classifier.classify(input);
    if (!intentSet.has(classified.intent) ||
      classified.rewrittenQuery !== undefined && typeof classified.rewrittenQuery !== "string") {
      return {
        ...deterministicPlan(input),
        failureCode: "classifier_invalid",
        status: "degraded"
      };
    }
    return deterministicPlan(input, {
      intent: classified.intent,
      ...(classified.rewrittenQuery ? { rewrittenQuery: classified.rewrittenQuery } : {})
    });
  } catch {
    return {
      ...deterministicPlan(input),
      failureCode: "classifier_unavailable",
      status: "degraded"
    };
  }
}

export function plannerConversation(
  messages: readonly ProviderConversationMessage[]
): Array<{ role: "assistant" | "user"; text: string }> {
  return messages
    .filter((message) => message.purpose === undefined)
    .slice(-6)
    .map((message) => ({
      role: message.role,
      text: message.content.blocks.flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : []).join("\n").slice(0, 2_000)
    }))
    .filter((message) => message.text.trim().length > 0);
}

export const KNOWLEDGE_PLANNER_AUTOMATIC_RESULT_LIMIT = 50;
export const knowledgePlannerDiscoveryFields = Object.freeze([
  "filename",
  "heading",
  "source_name",
  "tag",
  "title"
] as const);

type KnowledgePlannerAutomaticOperationBase = Readonly<{
  exactTerms: readonly string[];
  lanes: readonly KnowledgePlannerLane[];
  operation: KnowledgePlannerOperation;
  phaseOrdinal: 0;
  plannerVersion: typeof KNOWLEDGE_PLANNER_VERSION;
  purpose: KnowledgePlannerSubqueryV2["purpose"];
  query: string;
  strategy: Exclude<KnowledgePlannerStrategy, "none">;
  subqueryOrdinal: number;
  targetNames: readonly string[];
  targetResolution: KnowledgePlannerTargetResolution | null;
  targetSourceIds: readonly string[];
  coverage: Readonly<{
    expectedPassageCount: number | null;
    mode: "partial" | "verified_only";
  }>;
}>;

export type KnowledgePlannerAutomaticOperation =
  | KnowledgePlannerAutomaticOperationBase & Readonly<{
      operation: "automatic_search";
    }>
  | KnowledgePlannerAutomaticOperationBase & Readonly<{
      exact: KnowledgePlannerExactSpecification & Readonly<{
        cursor: null;
        limit: typeof KNOWLEDGE_PLANNER_AUTOMATIC_RESULT_LIMIT;
      }>;
      operation: "find_exact";
    }>
  | KnowledgePlannerAutomaticOperationBase & Readonly<{
      discovery: Readonly<{
        cursor: null;
        fields: typeof knowledgePlannerDiscoveryFields;
        limit: typeof KNOWLEDGE_PLANNER_AUTOMATIC_RESULT_LIMIT;
        query: string;
      }>;
      operation: "discover_sources";
    }>
  | KnowledgePlannerAutomaticOperationBase & Readonly<{
      operation: "structured_analysis";
      structured: Readonly<{
        query: string;
        selector: Readonly<{
          columns: readonly string[];
          includeHidden: false;
          operation: null;
          range: null;
          sheet: null;
        }>;
        targetSourceIds: readonly string[];
      }>;
    }>
  | KnowledgePlannerAutomaticOperationBase & Readonly<{
      operation: "visual_analysis";
      visual: Readonly<{
        query: string;
        selector: null;
        targetSourceIds: readonly string[];
      }>;
    }>;

function freezeTargetResolution(
  value: KnowledgePlannerTargetResolution | null
): KnowledgePlannerTargetResolution | null {
  if (!value) return null;
  return Object.freeze({
    outcome: value.outcome,
    targets: Object.freeze(value.targets.map((target) => Object.freeze({
      candidateSourceIds: Object.freeze([...target.candidateSourceIds]),
      matchKind: target.matchKind,
      outcome: target.outcome,
      targetName: target.targetName
    }))),
    targetSourceIds: Object.freeze([...value.targetSourceIds])
  });
}

/** Exact, side-effect-free adapter input for the durable automatic operation encoder. */
export function plannerAutomaticOperation(
  plan: KnowledgePlannerPlanV2,
  subquery: KnowledgePlannerSubqueryV2
): KnowledgePlannerAutomaticOperation {
  if (plan.strategy === "none" || plan.subqueries[subquery.ordinal] !== subquery) {
    throw new Error("knowledge_planner_subquery_not_in_plan");
  }
  const common: KnowledgePlannerAutomaticOperationBase = Object.freeze({
    coverage: Object.freeze({
      expectedPassageCount: plan.coverage.expectedPassageCount,
      mode: plan.coverage.mode
    }),
    exactTerms: Object.freeze([...subquery.exactTerms]),
    lanes: Object.freeze([...subquery.lanes]),
    operation: subquery.operation,
    phaseOrdinal: 0,
    plannerVersion: plan.version,
    purpose: subquery.purpose,
    query: subquery.query,
    strategy: plan.strategy,
    subqueryOrdinal: subquery.ordinal,
    targetNames: Object.freeze([...subquery.targetNames]),
    targetResolution: freezeTargetResolution(subquery.targetResolution),
    targetSourceIds: Object.freeze([...subquery.targetSourceIds])
  });
  if (subquery.operation === "find_exact") {
    if (!subquery.exact) throw new Error("knowledge_planner_exact_specification_missing");
    return Object.freeze({
      ...common,
      exact: Object.freeze({
        ...subquery.exact,
        cursor: null,
        limit: KNOWLEDGE_PLANNER_AUTOMATIC_RESULT_LIMIT
      }),
      operation: "find_exact"
    });
  }
  if (subquery.operation === "discover_sources") {
    return Object.freeze({
      ...common,
      discovery: Object.freeze({
        cursor: null,
        fields: knowledgePlannerDiscoveryFields,
        limit: KNOWLEDGE_PLANNER_AUTOMATIC_RESULT_LIMIT,
        query: subquery.query
      }),
      operation: "discover_sources"
    });
  }
  if (subquery.operation === "structured_analysis") {
    return Object.freeze({
      ...common,
      operation: "structured_analysis",
      structured: Object.freeze({
        query: subquery.query,
        selector: Object.freeze({
          columns: Object.freeze([]),
          includeHidden: false,
          operation: null,
          range: null,
          sheet: null
        }),
        targetSourceIds: Object.freeze([...subquery.targetSourceIds])
      })
    });
  }
  if (subquery.operation === "visual_analysis") {
    return Object.freeze({
      ...common,
      operation: "visual_analysis",
      visual: Object.freeze({
        query: subquery.query,
        selector: null,
        targetSourceIds: Object.freeze([...subquery.targetSourceIds])
      })
    });
  }
  return Object.freeze({ ...common, operation: "automatic_search" });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedPlannerText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems &&
    value.every((entry) => boundedPlannerText(entry, maximumLength)) &&
    new Set(value).size === value.length;
}

function decodePlannerExact(value: unknown): KnowledgePlannerExactSpecification | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ["caseMode", "field", "match", "value"]) ||
    value.caseMode !== "insensitive" && value.caseMode !== "sensitive" ||
    value.field !== "any" && value.field !== "body" && value.field !== "filename" &&
      value.field !== "heading" && value.field !== "tag" && value.field !== "title" ||
    value.match !== "pattern" && value.match !== "phrase" && value.match !== "token" ||
    !boundedPlannerText(value.value, 500)) return undefined;
  return value as unknown as KnowledgePlannerExactSpecification;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function exactSpecificationBackedByTerms(
  exact: KnowledgePlannerExactSpecification,
  exactTerms: readonly string[]
): boolean {
  if (exact.match === "token") return exactTerms.includes(exact.value);
  if (exact.match === "phrase") {
    return exactTerms.some((term) =>
      /^(?:"[^"]+"|'[^']+'|`[^`]+`|“[^”]+”|«[^»]+»)$/u.test(term) &&
      term.slice(1, -1) === exact.value);
  }
  return exactTerms.some((term) => term.match(/^\/([^/\r\n]{1,200})\/[gimsuy]*$/u)?.[1] === exact.value);
}

function validCommonSubquery(value: Record<string, unknown>, ordinal: number): boolean {
  return value.ordinal === ordinal &&
    stringArray(value.exactTerms, 24, 200) &&
    Array.isArray(value.lanes) && value.lanes.length <= 4 &&
    value.lanes.every((lane) => typeof lane === "string" && laneSet.has(lane)) &&
    new Set(value.lanes).size === value.lanes.length &&
    (value.purpose === "answer" || value.purpose === "compare_target" ||
      value.purpose === "coverage" || value.purpose === "follow_up" ||
      value.purpose === "source_discovery" || value.purpose === "summary") &&
    boundedPlannerText(value.query, 500) &&
    stringArray(value.targetNames, 8, 160);
}

function validV2Subquery(value: unknown, ordinal: number): value is KnowledgePlannerSubqueryV2 {
  if (!isRecord(value) || !exactKeys(value, [
    "exact",
    "exactTerms",
    "lanes",
    "operation",
    "ordinal",
    "purpose",
    "query",
    "targetNames",
    "targetResolution",
    "targetSourceIds"
  ]) || !validCommonSubquery(value, ordinal) || typeof value.operation !== "string" ||
    !operationSet.has(value.operation) || !Array.isArray(value.targetSourceIds)) return false;
  const exact = decodePlannerExact(value.exact);
  const resolution = decodeKnowledgePlannerTargetResolution(value.targetResolution);
  const exactTerms = value.exactTerms as string[];
  const lanes = value.lanes as string[];
  const targetSourceIds = value.targetSourceIds as string[];
  if (exact === undefined || resolution === undefined ||
    !stringArray(targetSourceIds, 8, 64) ||
    !sameStrings(targetSourceIds, resolution?.targetSourceIds ?? []) ||
    resolution !== null && !sameStrings(
      value.targetNames as string[],
      resolution.targets.map((target) => target.targetName)
    )) return false;
  if (resolution?.outcome === "ambiguous" || resolution?.outcome === "not_found") {
    return value.operation === "discover_sources" && value.purpose === "source_discovery" &&
      targetSourceIds.length === 0 && lanes.length === 1 &&
      lanes[0] === "metadata" && exact === null && exactTerms.length === 0;
  }
  if (value.operation === "discover_sources") {
    return value.purpose === "source_discovery" && targetSourceIds.length === 0 &&
      lanes.length === 1 && lanes[0] === "metadata" && exact === null &&
      exactTerms.length === 0;
  }
  if (value.purpose === "source_discovery") return false;
  if (value.operation === "find_exact") {
    return exact !== null && lanes.length === 1 && lanes[0] === "exact" &&
      exactTerms.length > 0 && exactSpecificationBackedByTerms(exact, exactTerms);
  }
  if (exact !== null) return false;
  if (value.operation === "structured_analysis" || value.operation === "visual_analysis") {
    return lanes.length === 0 && targetSourceIds.length > 0 &&
      (resolution?.outcome === "resolved" || resolution?.outcome === "resolved_many");
  }
  return value.operation === "automatic_search" && lanes.length > 0;
}

function validLegacySubquery(value: unknown, ordinal: number): boolean {
  return isRecord(value) && exactKeys(value, [
    "exactTerms",
    "lanes",
    "ordinal",
    "purpose",
    "query",
    "targetNames"
  ]) && validCommonSubquery(value, ordinal) && Array.isArray(value.lanes) &&
    value.lanes.length > 0 &&
    value.purpose !== "source_discovery";
}

function validPlanEnvelope(value: Record<string, unknown>, v2: boolean): boolean {
  const keys = [
    "automaticRetrieval",
    "coverage",
    "evidenceMode",
    ...(value.status === "degraded" ? ["failureCode"] : []),
    "intent",
    "originalQuery",
    "rewrite",
    "status",
    "strategy",
    "subqueries",
    ...(v2 ? ["targetResolution", "targetSourceIds"] : []),
    "version"
  ];
  if (!exactKeys(value, keys) || typeof value.automaticRetrieval !== "boolean" ||
    !isRecord(value.coverage) || !exactKeys(value.coverage, [
      "expectedPassageCount",
      "mode",
      "namedTargets"
    ]) || value.evidenceMode !== "compact" && value.evidenceMode !== "fuller" ||
    typeof value.intent !== "string" || !intentSet.has(value.intent) ||
    typeof value.originalQuery !== "string" || value.originalQuery.length > 8_000 ||
    !isRecord(value.rewrite) || !exactKeys(value.rewrite, ["exactTerms", "query"]) ||
    value.status !== "ready" && value.status !== "degraded" ||
    typeof value.strategy !== "string" || !strategySet.has(value.strategy) ||
    !Array.isArray(value.subqueries) ||
    value.subqueries.length > KNOWLEDGE_PLANNER_SUBQUERY_SAFETY_MAX) return false;
  if (value.status === "degraded") {
    if (value.failureCode !== "classifier_invalid" && value.failureCode !== "classifier_unavailable") {
      return false;
    }
  }
  const rewrite = value.rewrite;
  const coverage = value.coverage;
  const rewriteQuery = rewrite.query;
  return stringArray(rewrite.exactTerms, 24, 200) &&
    typeof rewriteQuery === "string" && rewriteQuery.length <= 8_000 &&
    rewrite.exactTerms.every((term) => rewriteQuery.includes(term)) &&
    (coverage.expectedPassageCount === null ||
      Number.isSafeInteger(coverage.expectedPassageCount) && Number(coverage.expectedPassageCount) >= 1) &&
    (coverage.mode === "partial" || coverage.mode === "verified_only") &&
    stringArray(coverage.namedTargets, 8, 160);
}

export function decodeKnowledgePlannerPlan(
  value: unknown
): Readonly<{ ok: true; plan: KnowledgePlannerPlan }> | Readonly<{ ok: false }> {
  if (!isRecord(value) || value.version !== KNOWLEDGE_PLANNER_LEGACY_VERSION &&
    value.version !== KNOWLEDGE_PLANNER_VERSION) return { ok: false };
  const v2 = value.version === KNOWLEDGE_PLANNER_VERSION;
  if (!validPlanEnvelope(value, v2)) return { ok: false };
  const persistedSubqueries = value.subqueries as unknown[];
  if (!persistedSubqueries.every((subquery, index) => v2
    ? validV2Subquery(subquery, index)
    : validLegacySubquery(subquery, index))) return { ok: false };
  const coverage = value.coverage as Record<string, unknown>;
  const strategy = value.strategy as KnowledgePlannerStrategy;
  if (value.automaticRetrieval !== (strategy !== "none") ||
    (value.intent === "no_knowledge_needed" && strategy !== "none") ||
    (strategy === "none") !== (persistedSubqueries.length === 0) ||
    (coverage.namedTargets as string[]).some((target) =>
      !persistedSubqueries.some((subquery) => isRecord(subquery) &&
        Array.isArray(subquery.targetNames) && subquery.targetNames.includes(target)))) {
    return { ok: false };
  }
  if (v2) {
    const resolution = decodeKnowledgePlannerTargetResolution(value.targetResolution);
    if (resolution === undefined || !stringArray(value.targetSourceIds, 8, 64) ||
      !sameStrings(value.targetSourceIds, resolution?.targetSourceIds ?? [])) return { ok: false };
    const branchTargetIds = [...new Set(persistedSubqueries.flatMap((subquery) =>
      isRecord(subquery) && Array.isArray(subquery.targetSourceIds)
        ? subquery.targetSourceIds.filter((entry): entry is string => typeof entry === "string")
        : []))];
    if (persistedSubqueries.length > 0 && !sameStringSet(value.targetSourceIds, branchTargetIds)) {
      return { ok: false };
    }
  }
  return { ok: true, plan: value as unknown as KnowledgePlannerPlan };
}
