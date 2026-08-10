import {
  MEMORY_TEMPORAL_RESOLVER_VERSION
} from "./config";
import {
  STANDARD_CHAT_FALLBACK_TIME_ZONE,
  validateIanaTimeZone
} from "../../promptTemplates";
import type {
  MemoryRetrievalIntent,
  MemoryRetrievalLanguage,
  MemoryRetrievalPlan,
  MemoryRetrievalPlannerInput,
  MemoryTemporalQuery
} from "./contracts";

export const MEMORY_RETRIEVAL_PLANNER_VERSION = "memory-retrieval-planner-v1";
export const MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS = 2_000;
export const MEMORY_RETRIEVAL_PRIOR_USER_TURN_LIMIT = 2;

const genericGreeting = /^(?:hi|hello|hey|thanks|thank you|привет|здравствуй(?:те)?|спасибо|добрый (?:день|вечер|вечерок))[!.?\s]*$/iu;
const memoryManagement = /(?:что (?:ты )?(?:помнишь|знаешь) обо мне|покажи (?:мою )?память|забудь|запомни|what do you remember about me|show (?:my )?memor(?:y|ies)|forget (?:that|what)|remember that)/iu;
const pastHistory = /(?:когда мы|что мы (?:обсуждали|решили)|в прошл(?:ом|ых) чат(?:е|ах)|раньше мы|предыдущ(?:ий|ем) разговор|when did we|what did we discuss|previous (?:chat|conversation)|last time we|earlier we)/iu;
const personalSignal = /(?:\b(?:i|me|my|mine|for me)\b|(?:^|[^\p{L}\p{N}_])(?:я|мне|меня|мой|моя|моё|мои|для меня)(?=$|[^\p{L}\p{N}_]))/iu;
const currentStateSignal = /(?:предпочита|люблю|нравит|обычно|всегда|сейчас|теперь|мой текущ|my (?:current|preferred|favorite)|i (?:prefer|like|usually|always)|currently)/iu;
const personalizationSignal = /(?:учитывая (?:мои|то,? что я)|подходит мне|для меня лучше|based on (?:my|what i)|given my|suit me|for me)/iu;
const anaphoraSignal = /^(?:а )?(?:это|тот|та|то|те|он|она|они|такое|that|it|this|those|they)(?=$|[^\p{L}\p{N}_])/iu;
const genericKnowledgeQuestion = /^(?:что такое|кто такой|кто такая|объясни|расскажи о|what is|who is|explain|tell me about)\b/iu;
const currentTemporalSignal = /(?:\b(?:now|currently|today|at present)\b|(?:^|[^\p{L}\p{N}_])(?:сейчас|теперь|сегодня)(?=$|[^\p{L}\p{N}_]))/iu;
const historicalTemporalSignal = /(?:\b(?:previously|before|formerly|yesterday|last (?:week|month|year)|in the past)\b|(?:^|[^\p{L}\p{N}_])(?:раньше|прежде|вчера|на прошлой неделе|в прошлом месяце|в прошлом году)(?=$|[^\p{L}\p{N}_]))/iu;

const stopWords = new Set([
  "about", "and", "are", "but", "can", "could", "did", "does", "for", "from", "have",
  "how", "into", "mine", "that", "the", "this", "what", "when", "where", "which", "with",
  "you", "your", "а", "без", "бы", "был", "была", "были", "в", "во", "вот", "для", "до",
  "где", "же", "за", "и", "из", "или", "как", "какая", "какие", "какой", "какое", "когда",
  "кто", "ли", "мне", "мой", "моя", "моё", "мои",
  "мы", "на", "над", "но", "о", "об", "он", "она", "они", "от", "по", "про", "с", "со",
  "то", "у", "что", "это", "я"
]);

const monthNumbers: Readonly<Record<string, number>> = Object.freeze({
  april: 3,
  august: 7,
  december: 11,
  february: 1,
  january: 0,
  july: 6,
  june: 5,
  march: 2,
  may: 4,
  november: 10,
  october: 9,
  september: 8,
  август: 7,
  августе: 7,
  апрель: 3,
  апреле: 3,
  декабрь: 11,
  декабре: 11,
  июль: 6,
  июле: 6,
  июнь: 5,
  июне: 5,
  май: 4,
  мае: 4,
  март: 2,
  марте: 2,
  ноябрь: 10,
  ноябре: 10,
  октябрь: 9,
  октябре: 9,
  сентябрь: 8,
  сентябре: 8,
  февраль: 1,
  феврале: 1,
  январь: 0,
  январе: 0
});

function boundedNormalized(value: string, maxCharacters = MEMORY_RETRIEVAL_QUERY_MAX_CHARACTERS): string {
  return Array.from(value.normalize("NFKC").trim().replace(/\s+/gu, " "))
    .slice(0, maxCharacters)
    .join("")
    .toLocaleLowerCase("und");
}

function languageFor(value: string): MemoryRetrievalLanguage {
  const cyrillic = value.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = value.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillic > 0 && latin > 0) return "MIXED";
  if (cyrillic > 0) return "RU";
  if (latin > 0) return "EN";
  return "OTHER";
}

function termsFor(value: string): readonly string[] {
  const terms = value.match(/[\p{L}\p{N}][\p{L}\p{N}_.:+#-]*/gu) ?? [];
  return [...new Set(terms
    .map((term) => term.replace(/^[-_.:+#]+|[-_.:+#]+$/gu, ""))
    .filter((term) => term.length >= 2 && term.length <= 64 && !stopWords.has(term)))]
    .slice(0, 24);
}

function entitiesFor(original: string, terms: readonly string[]): readonly string[] {
  const quoted = [...original.matchAll(/["“”«»']([^"“”«»']{2,80})["“”«»']/gu)]
    .map((match) => boundedNormalized(match[1] ?? "", 80));
  const modelLike = original.match(/\b(?:[A-ZА-ЯЁ][\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)+|[A-Za-zА-Яа-яЁё]+\d+[A-Za-z0-9._-]*)\b/gu) ?? [];
  const normalized = modelLike.map((value) => boundedNormalized(value, 80));
  const capitalized = [...original.matchAll(/(?:^|[^\p{L}\p{N}_])([A-ZА-ЯЁ][\p{L}\p{N}]{2,79})(?=$|[^\p{L}\p{N}_])/gu)]
    .map((match) => boundedNormalized(match[1] ?? "", 80));
  const numericTerms = terms.filter((term) => /\d/u.test(term));
  const source = boundedNormalized(original);
  const aliases: string[] = [];
  if (/макбук\p{L}*/u.test(source) || /\bmacbook\b/u.test(source)) {
    aliases.push("макбук", "macbook");
  }
  return [...new Set([...quoted, ...normalized, ...capitalized, ...numericTerms, ...aliases])]
    .filter((value) => Boolean(value) && !stopWords.has(value))
    .slice(0, 12);
}

function canonicalHintsFor(query: string, terms: readonly string[]): readonly string[] {
  const hints = new Set<string>();
  const conceptRules: readonly [RegExp, readonly string[]][] = [
    [/(?:редактор|editor|ide)/iu, ["profile.preferred_editor", "preference.editor", "workflow.editor"]],
    [/(?:цвет|color|colour)/iu, ["profile.favorite_color", "preference.color"]],
    [/(?:язык|language)/iu, ["profile.preferred_language", "preference.language"]],
    [/(?:часов(?:ой|ого) пояс|timezone|time zone)/iu, ["profile.timezone", "constraint.timezone"]],
    [/(?:диет|аллерг|diet|allerg)/iu, ["constraint.diet", "constraint.allergy"]],
    [/(?:имя|name)/iu, ["profile.name"]]
  ];
  for (const [pattern, keys] of conceptRules) {
    if (pattern.test(query)) keys.forEach((key) => hints.add(key));
  }
  const safeTerms = terms
    .map((term) => term.replace(/[^a-z0-9_-]/gu, ""))
    .filter((term) => /^[a-z][a-z0-9_-]{1,40}$/u.test(term));
  for (const term of safeTerms.slice(0, 4)) {
    hints.add(`profile.${term}`);
    hints.add(`preference.${term}`);
    hints.add(`constraint.${term}`);
  }
  return [...hints].slice(0, 16);
}

type CalendarDate = Readonly<{ day: number; month: number; year: number }>;

function calendarDateAt(value: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    calendar: "gregory",
    day: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    timeZone,
    year: "numeric"
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return { day: part("day"), month: part("month"), year: part("year") };
}

function shiftCalendarDate(value: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(value.year, value.month - 1, value.day + days, 12));
  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear()
  };
}

function zonedMidnight(value: CalendarDate, timeZone: string): Date {
  const desired = Date.UTC(value.year, value.month - 1, value.day);
  let estimate = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    calendar: "gregory",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    second: "2-digit",
    timeZone,
    year: "numeric"
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(estimate));
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const observed = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second")
    );
    const adjustment = desired - observed;
    estimate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(estimate);
}

function calendarRange(
  from: CalendarDate,
  to: CalendarDate,
  timeZone: string
): Readonly<{ from: Date; to: Date }> {
  return { from: zonedMidnight(from, timeZone), to: zonedMidnight(to, timeZone) };
}

function localDayRange(
  now: Date,
  offsetDays: number,
  timeZone: string
): Readonly<{ from: Date; to: Date }> {
  const date = shiftCalendarDate(calendarDateAt(now, timeZone), offsetDays);
  return calendarRange(date, shiftCalendarDate(date, 1), timeZone);
}

function temporalFor(query: string, now: Date, timeZone: string): MemoryTemporalQuery {
  const expressions: string[] = [];
  const iso = query.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/u);
  if (iso) {
    const date = { day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) };
    const normalized = shiftCalendarDate(date, 0);
    if (
      normalized.day === date.day && normalized.month === date.month &&
      normalized.year === date.year
    ) {
      expressions.push(iso[0]);
      return {
        ...calendarRange(date, shiftCalendarDate(date, 1), timeZone),
        mode: "RANGE",
        rawExpressions: expressions,
        resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION
      };
    }
    expressions.push(iso[0]);
    return {
      from: null,
      mode: "AMBIGUOUS",
      rawExpressions: expressions,
      resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
      to: null
    };
  }
  const monthNames = Object.keys(monthNumbers).join("|");
  const month = query.match(new RegExp(`(?:^|\\s)(${monthNames})(?:\\s+(20\\d{2}))?(?=$|[\\s,.!?])`, "iu"));
  if (month) {
    const raw = month[0].trim();
    expressions.push(raw);
    const monthNumber = monthNumbers[(month[1] ?? "").toLocaleLowerCase("und")];
    const year = month[2] ? Number(month[2]) : null;
    if (monthNumber !== undefined && year !== null) {
      return {
        ...calendarRange(
          { day: 1, month: monthNumber + 1, year },
          shiftCalendarDate({ day: 1, month: monthNumber + 2, year }, 0),
          timeZone
        ),
        mode: "RANGE",
        rawExpressions: expressions,
        resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION
      };
    }
    return {
      from: null,
      mode: "AMBIGUOUS",
      rawExpressions: expressions,
      resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
      to: null
    };
  }
  const year = query.match(/(?:^|\D)(20\d{2})(?=\D|$)/u)?.[1];
  if (year) {
    expressions.push(year);
    return {
      ...calendarRange(
        { day: 1, month: 1, year: Number(year) },
        { day: 1, month: 1, year: Number(year) + 1 },
        timeZone
      ),
      mode: "RANGE",
      rawExpressions: expressions,
      resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION
    };
  }
  if (/(?:\byesterday\b|(?:^|\s)вчера(?=$|\s|[,.!?]))/iu.test(query)) {
    expressions.push(query.match(/\byesterday\b|вчера/iu)?.[0] ?? "yesterday");
    const range = localDayRange(now, -1, timeZone);
    return { ...range, mode: "RANGE", rawExpressions: expressions, resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION };
  }
  if (currentTemporalSignal.test(query)) {
    expressions.push(query.match(currentTemporalSignal)?.[0] ?? "current");
    return {
      from: null,
      mode: "CURRENT",
      rawExpressions: expressions,
      resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
      to: null
    };
  }
  if (historicalTemporalSignal.test(query) || pastHistory.test(query)) {
    expressions.push(query.match(historicalTemporalSignal)?.[0] ?? "historical");
    return {
      from: null,
      mode: "HISTORICAL",
      rawExpressions: expressions,
      resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
      to: null
    };
  }
  return {
    from: null,
    mode: "CURRENT",
    rawExpressions: [],
    resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
    to: null
  };
}

function intentFor(query: string, explicitManagement: boolean, temporal: MemoryTemporalQuery): MemoryRetrievalIntent {
  if (explicitManagement || memoryManagement.test(query)) return "MEMORY_MANAGEMENT";
  if (pastHistory.test(query)) return "PAST_HISTORY";
  if (temporal.mode === "RANGE" || temporal.mode === "AMBIGUOUS" || temporal.mode === "HISTORICAL") {
    return "TEMPORAL";
  }
  if (personalSignal.test(query) && currentStateSignal.test(query)) return "CURRENT_STATE";
  if (personalSignal.test(query) && personalizationSignal.test(query)) return "PERSONALIZE";
  if (personalSignal.test(query) && /\?/u.test(query)) return "CURRENT_STATE";
  return "NONE";
}

export function planMemoryRetrieval(input: MemoryRetrievalPlannerInput): MemoryRetrievalPlan {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("memory_retrieval_plan_invalid");
  }
  const current = boundedNormalized(input.currentUserText);
  const prior = (input.priorDirectUserTexts ?? [])
    .slice(-MEMORY_RETRIEVAL_PRIOR_USER_TURN_LIMIT)
    .map((value) => boundedNormalized(value, 1_000))
    .filter(Boolean);
  const usePrior = current.length > 0 && anaphoraSignal.test(current) ? prior : [];
  const query = boundedNormalized([...usePrior, current].join(" "));
  const timeZone = validateIanaTimeZone(input.timeZone) ?? STANDARD_CHAT_FALLBACK_TIME_ZONE;
  const temporal = temporalFor(current, input.now, timeZone);
  let intent = intentFor(current, input.explicitMemoryManagement === true, temporal);
  if (
    !current || genericGreeting.test(current) ||
    (genericKnowledgeQuestion.test(current) && !personalSignal.test(current) && !pastHistory.test(current))
  ) intent = "NONE";
  const queryTerms = termsFor(query);
  const retrievalAllowed = intent !== "NONE" && queryTerms.length > 0;
  return {
    canonicalKeyHints: retrievalAllowed ? canonicalHintsFor(query, queryTerms) : [],
    entityHints: retrievalAllowed ? entitiesFor(input.currentUserText, queryTerms) : [],
    intent,
    language: languageFor(query),
    normalizedQuery: query,
    normalizedYoQuery: query.replace(/ё/gu, "е"),
    plannerVersion: MEMORY_RETRIEVAL_PLANNER_VERSION,
    queryTerms,
    retrievalAllowed,
    temporal,
    usedPriorUserTurns: usePrior.length
  };
}
