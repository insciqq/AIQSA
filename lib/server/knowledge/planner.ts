import type { ProviderConversationMessage, ProviderModelCapabilities } from "../providers/types";
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  type KnowledgeBudgetPolicy
} from "./knowledgeBudget";

export const KNOWLEDGE_PLANNER_VERSION = 1 as const;
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

export type KnowledgePlannerBaseSummary = Readonly<{
  approxTokens: number | null;
  knowledgeBaseId: string;
  passageCount: number | null;
  readySourceCount: number;
  sourceCount: number;
}>;

export type KnowledgePlannerInput = Readonly<{
  bases: readonly KnowledgePlannerBaseSummary[];
  budgetPolicy?: Pick<KnowledgeBudgetPolicy, "maxSubqueriesPerPhase">;
  conversation: readonly Readonly<{ role: "assistant" | "user"; text: string }>[];
  modelCapabilities: Pick<ProviderModelCapabilities, "contextWindow" | "toolCalling">;
  originalQuery: string;
  scopeRequested: boolean;
  version: typeof KNOWLEDGE_PLANNER_VERSION;
}>;

export type KnowledgePlannerSubquery = Readonly<{
  exactTerms: readonly string[];
  lanes: readonly KnowledgePlannerLane[];
  ordinal: number;
  purpose: "answer" | "compare_target" | "coverage" | "follow_up" | "summary";
  query: string;
  targetNames: readonly string[];
}>;

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
  version: typeof KNOWLEDGE_PLANNER_VERSION;
}>;

export type KnowledgePlannerClassifier = Readonly<{
  classify(input: KnowledgePlannerInput): Promise<Readonly<{
    intent: KnowledgePlannerIntent;
    rewrittenQuery?: string;
  }>>;
}>;

const intentSet = new Set<string>(knowledgePlannerIntents);
const strategySet = new Set<string>(knowledgePlannerStrategies);
const laneSet = new Set<string>(["exact", "lexical", "metadata", "semantic"]);
const exactCue = /(?:\bexact(?:ly)?\b|\bverbatim\b|\bcode\b|\bidentifier\b|\bquote\b|\bphrase\b|точн(?:о|ую|ая)|дословн|код\b|идентификатор)/iu;
const comparisonCue = /(?:\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b|сравн|разниц|отличи|между)/iu;
const exhaustiveCue = /(?:\ball\b|\bevery\b|\bcomplete list\b|\bexhaustive\b|\bwithout omissions?\b|\bentire corpus\b|\bfind each\b|\blist each\b|\bвсе\b|\bкажд\p{L}*\b|полный список|без исключени|без пропуск|целиком по базе)/iu;
const summaryCue = /(?:\bsummar(?:y|ize|ise)\b|\boverview\b|\bbrief me\b|резюм|кратк(?:о|ий|ое)|обзор|сводк|суммариз)/iu;
const corpusCue = /(?:\bcorpus\b|\bknowledge base\b|\ball (?:documents|sources|files)\b|корпус|баз[аеуы] знани|вс[её] (?:документ|источник|файл))/iu;
const structuredCue = /(?:\bcsv\b|\bxls[x]?\b|\bods\b|\bspreadsheet\b|\btable\b|\bcolumn\b|\baggregate\b|\baverage\b|\bmedian\b|\bsum\b|\btrend\b|\boutliers?\b|\bjoin\b|\bsort\b|\bfilter\b|\bcalculate\b|\bdifference\b|\bratio\b|\bformula(?:s)?\b|таблиц|столбц|средн(?:ее|яя)|медиан|сумм(?:а|ируй)|агрегир|тренд|динамик|выброс|аномал|сортир|фильтр|посчитай|рассчитай|разниц|отношени|формул|сопостав|объедин)/iu;
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

function exactTermsFromQuery(query: string): string[] {
  const quoted = [...query.matchAll(/(?:"([^"]{1,200})"|'([^']{1,200})'|`([^`]{1,200})`|“([^”]{1,200})”|«([^»]{1,200})»)/gu)]
    .map((match) => match[0] ?? "");
  const dates = query.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gu) ?? [];
  const codes = query.match(/\b(?=[\p{L}\p{N}._/-]{2,64}\b)(?=[\p{L}\p{N}._/-]*\d)[\p{Lu}\d][\p{Lu}\d._/-]+\b/gu) ?? [];
  const names = query.match(/\b[\p{Lu}][\p{L}\p{M}.-]{1,50}(?:\s+[\p{Lu}][\p{L}\p{M}.-]{1,50})+\b/gu) ?? [];
  return unique([...quoted, ...dates, ...codes, ...names]).slice(0, 24);
}

function hasHardExactSignal(query: string): boolean {
  return exactCue.test(query) ||
    /(?:"[^"]+"|'[^']+'|`[^`]+`|“[^”]+”|«[^»]+»)/u.test(query) ||
    /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/u.test(query) ||
    /\b(?=[\p{L}\p{N}._/-]{2,64}\b)(?=[\p{L}\p{N}._/-]*\d)[\p{Lu}\d][\p{Lu}\d._/-]+\b/u.test(query);
}

function smallFullContextBase(input: KnowledgePlannerInput): KnowledgePlannerBaseSummary | null {
  if (input.bases.length !== 1) return null;
  const base = input.bases[0]!;
  const contextWindow = input.modelCapabilities.contextWindow;
  const maximumTokens = Math.min(
    12_000,
    Number.isFinite(contextWindow) && Number(contextWindow) > 0
      ? Math.max(1_500, Math.floor(Number(contextWindow) * 0.25))
      : 4_000
  );
  return base.sourceCount === 1 && base.readySourceCount === 1 &&
    base.passageCount !== null && base.passageCount >= 1 && base.passageCount <= 8 &&
    base.approxTokens !== null && base.approxTokens >= 1 && base.approxTokens <= maximumTokens
    ? base
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
  const structured = structuredCue.test(query);
  const exact = hasHardExactSignal(query);
  const distinctSignals = [comparison, exhaustive, summary, structured, exact]
    .filter(Boolean).length;
  if (distinctSignals >= 2 && !(summary && exhaustive && corpusCue.test(query))) return "mixed";
  if (comparison) return "multi_source_comparison";
  if (exhaustive) return "exhaustive_corpus_search";
  if (structured) return "structured_data_analysis";
  if (summary) {
    const sourceCount = input.bases.reduce((total, base) => total + base.sourceCount, 0);
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
  fullContext: KnowledgePlannerBaseSummary | null
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
  const groups = Array.from(
    { length: Math.min(maximum, targets.length) },
    () => [] as string[]
  );
  targets.forEach((target, index) => groups[index % groups.length]!.push(target));
  return groups;
}

function subqueries(input: Readonly<{
  branchLimit: number;
  exactTerms: readonly string[];
  intent: KnowledgePlannerIntent;
  rewritten: string;
  strategy: KnowledgePlannerStrategy;
}>): KnowledgePlannerSubquery[] {
  if (input.strategy === "none") return [];
  const lanes: KnowledgePlannerLane[] = input.intent === "exact_lookup"
    ? ["exact", "lexical", "semantic"]
    : input.intent === "source_discovery"
      ? ["metadata", "lexical", "semantic"]
      : ["semantic", "lexical", "exact", "metadata"];
  if (input.intent === "multi_source_comparison" ||
    input.intent === "mixed" && comparisonCue.test(input.rewritten)) {
    const targets = comparisonTargets(input.rewritten, input.exactTerms);
    if (targets.length >= 2) {
      return partitionTargets(targets, input.branchLimit).map((group, ordinal) => ({
        exactTerms: unique([...input.exactTerms, ...group]),
        lanes,
        ordinal,
        purpose: "compare_target" as const,
        query: queryWithTerms(`${input.rewritten} Target: ${group.join("; ")}`, [
          ...input.exactTerms,
          ...group
        ]),
        targetNames: group
      }));
    }
  }
  if (input.intent === "multi_hop_reasoning" || input.intent === "mixed") {
    const parts = input.rewritten.split(/(?:[?;]\s*|\b(?:and then|then|after that)\b|\b(?:затем|после этого|и потом)\b)/iu)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4)
      .slice(0, input.branchLimit);
    if (parts.length >= 2) {
      return parts.map((part, ordinal) => ({
        exactTerms: input.exactTerms.filter((term) => part.includes(term)),
        lanes,
        ordinal,
        purpose: ordinal === 0 ? "answer" as const : "follow_up" as const,
        query: queryWithTerms(part, input.exactTerms.filter((term) => part.includes(term))),
        targetNames: []
      }));
    }
  }
  return [{
    exactTerms: input.exactTerms,
    lanes,
    ordinal: 0,
    purpose: input.strategy === "full_context" || input.strategy === "corpus_summary"
      ? "summary"
      : input.strategy === "exhaustive" ? "coverage" : "answer",
    query: queryWithTerms(input.rewritten, input.exactTerms),
    targetNames: input.intent === "multi_source_comparison"
      ? comparisonTargets(input.rewritten, input.exactTerms)
      : []
  }];
}

function deterministicPlan(
  input: KnowledgePlannerInput,
  override?: Readonly<{ intent?: KnowledgePlannerIntent; rewrittenQuery?: string }>
): KnowledgePlannerPlan {
  const intent = override?.intent ?? deterministicIntent(input);
  const exactTerms = exactTermsFromQuery(input.originalQuery);
  let rewritten = bounded(override?.rewrittenQuery ?? rewrittenQuery(input, intent), 8_000);
  const missingExactTerms = exactTerms.filter((term) => !rewritten.includes(term));
  if (missingExactTerms.length > 0) {
    const suffix = missingExactTerms.map((term) => `\nExact term: ${term}`).join("");
    rewritten = `${bounded(rewritten, Math.max(1, 8_000 - suffix.length))}${suffix}`;
  }
  const fullContext = smallFullContextBase(input);
  const strategy = input.bases.length === 0
    ? "none"
    : strategyForIntent(intent, fullContext);
  const branchLimit = plannerBranchLimit(input);
  const plannedSubqueries = subqueries({
    branchLimit,
    exactTerms,
    intent,
    rewritten,
    strategy
  }).slice(0, branchLimit);
  const namedTargets = comparisonCue.test(rewritten) &&
    (intent === "multi_source_comparison" || intent === "mixed")
    ? comparisonTargets(rewritten, exactTerms)
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
    version: KNOWLEDGE_PLANNER_VERSION
  };
}

export async function planKnowledgeRequest(
  input: KnowledgePlannerInput,
  options: Readonly<{ classifier?: KnowledgePlannerClassifier }> = {}
): Promise<KnowledgePlannerPlan> {
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

export function decodeKnowledgePlannerPlan(
  value: unknown
): Readonly<{ ok: true; plan: KnowledgePlannerPlan }> | Readonly<{ ok: false }> {
  if (!isRecord(value) || value.version !== KNOWLEDGE_PLANNER_VERSION ||
    typeof value.automaticRetrieval !== "boolean" || !isRecord(value.coverage) ||
    (value.evidenceMode !== "compact" && value.evidenceMode !== "fuller") ||
    typeof value.intent !== "string" || !intentSet.has(value.intent) ||
    typeof value.originalQuery !== "string" || value.originalQuery.length > 8_000 ||
    !isRecord(value.rewrite) ||
    (value.status !== "ready" && value.status !== "degraded") ||
    typeof value.strategy !== "string" || !strategySet.has(value.strategy) ||
    !Array.isArray(value.subqueries)) return { ok: false };
  const coverage = value.coverage;
  const rewrite = value.rewrite;
  const persistedSubqueries = value.subqueries;
  if ((value.status === "degraded") !==
      (value.failureCode === "classifier_invalid" || value.failureCode === "classifier_unavailable") ||
    (value.status === "ready" && value.failureCode !== undefined)) return { ok: false };
  if (!Array.isArray(rewrite.exactTerms) ||
    rewrite.exactTerms.length > 24 ||
    rewrite.exactTerms.some((term) => typeof term !== "string" || term.length > 200) ||
    typeof rewrite.query !== "string" || rewrite.query.length > 8_000) return { ok: false };
  const rewriteQuery = rewrite.query;
  if (rewrite.exactTerms.some((term) => !rewriteQuery.includes(term))) return { ok: false };
  const expectedPassageCount = coverage.expectedPassageCount;
  if ((expectedPassageCount !== null &&
      (!Number.isSafeInteger(expectedPassageCount) || Number(expectedPassageCount) < 1)) ||
    (coverage.mode !== "partial" && coverage.mode !== "verified_only") ||
    !Array.isArray(coverage.namedTargets) || coverage.namedTargets.length > 8 ||
    coverage.namedTargets.some((target) => typeof target !== "string" || target.length > 160) ||
    persistedSubqueries.length > KNOWLEDGE_PLANNER_SUBQUERY_SAFETY_MAX) return { ok: false };
  for (const [index, subquery] of persistedSubqueries.entries()) {
    if (!isRecord(subquery) || subquery.ordinal !== index ||
      !Array.isArray(subquery.exactTerms) || subquery.exactTerms.length > 24 ||
      subquery.exactTerms.some((term) => typeof term !== "string" || term.length > 200) ||
      !Array.isArray(subquery.lanes) || subquery.lanes.length < 1 ||
      subquery.lanes.some((lane) => typeof lane !== "string" || !laneSet.has(lane)) ||
      (subquery.purpose !== "answer" && subquery.purpose !== "compare_target" &&
        subquery.purpose !== "coverage" && subquery.purpose !== "follow_up" &&
        subquery.purpose !== "summary") ||
      typeof subquery.query !== "string" || subquery.query.length < 1 || subquery.query.length > 500 ||
      !Array.isArray(subquery.targetNames) || subquery.targetNames.length > 8 ||
      subquery.targetNames.some((target) => typeof target !== "string" || target.length > 160)) {
      return { ok: false };
    }
  }
  if (value.automaticRetrieval !== (value.strategy !== "none") ||
    (value.intent === "no_knowledge_needed" && value.strategy !== "none") ||
    (value.strategy === "none") !== (persistedSubqueries.length === 0) ||
    coverage.namedTargets.some((target) =>
      !persistedSubqueries.some((subquery) =>
        isRecord(subquery) && Array.isArray(subquery.targetNames) && subquery.targetNames.includes(target)))) {
    return { ok: false };
  }
  return { ok: true, plan: value as unknown as KnowledgePlannerPlan };
}
