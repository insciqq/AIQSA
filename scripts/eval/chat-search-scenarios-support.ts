import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PAST_CHATS_LIMITS, type SearchPastChatsInput } from "../../lib/contracts/pastChats";
import { pastChatDayStart, pastChatTimestamp } from "../../lib/server/chatSearch/search/dates";

/**
 * The past-chat search scenarios (`tests/fixtures/chat-search/`), shared by the
 * deterministic run in the ordinary tests (`lib/server/chatSearch/pastChatScenarios.test.ts`,
 * fake embedder, in-memory stores) and the stand run with real models
 * (`scripts/eval/chat-search-scenarios.ts`). Pure: it reads the fixtures, turns
 * their relative times into instants, and scores what a search returned. The
 * report it builds is content-free: classes, scenario ids, counts, shares,
 * reason codes and latencies, never a query, an excerpt or an id.
 */

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const keySchema = z.string().regex(KEY);
const daySchema = z.strictObject({ daysAgo: z.number().int().min(0).max(365) });

const turnSchema = z.strictObject({
  key: keySchema,
  question: z.string().min(1),
  answer: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  questionFiles: z.array(z.string().min(1).max(255)).optional(),
  answerFiles: z.array(z.string().min(1).max(255)).optional(),
  /** The turn's earlier version, edited away: a sibling branch that is no longer active. */
  replaces: z.strictObject({ question: z.string().min(1), answer: z.string().min(1) }).optional()
});

const chatSchema = z.strictObject({
  key: keySchema,
  title: z.string().min(1).max(300),
  mode: z.enum(["normal", "excluded", "temporary", "deleted", "excluded_after_index"]).default("normal"),
  daysAgo: z.number().int().min(1).max(365).optional(),
  /** Local hour of the first turn when `daysAgo` is set. */
  hour: z.number().int().min(6).max(20).default(11),
  minutesAgo: z.number().int().min(1).max(600).optional(),
  /** Seeded after the rest of the corpus was indexed: a turn that settled minutes ago. */
  arrivesLate: z.boolean().default(false),
  turns: z.array(turnSchema).min(1).max(20)
}).refine((chat) => (chat.daysAgo === undefined) !== (chat.minutesAgo === undefined), "exactly one of daysAgo and minutesAgo");

const userSchema = z.strictObject({
  key: keySchema,
  timeZone: z.string().min(1),
  chats: z.array(chatSchema).min(1)
});

export const chatSearchCorpusSchema = z.strictObject({
  version: z.literal(1),
  about: z.string(),
  fillers: z.array(z.string().min(1)),
  users: z.array(userSchema).min(1)
});

export type ChatSearchCorpus = z.infer<typeof chatSearchCorpusSchema>;

export const CHAT_SEARCH_SCENARIO_CLASSES = [
  "exact_identifier", "paraphrase", "cross_language", "similar_chats", "long_answer_detail", "fresh", "date_bounded",
  "recent_listing", "read_to_message", "edited_branch", "never_returned"
] as const;
export type ChatSearchScenarioClass = (typeof CHAT_SEARCH_SCENARIO_CLASSES)[number];

/** A chat within the scenario's user (`chat`) or another user's (`user/chat`). */
const chatRefSchema = z.string().regex(/^(?:[a-z0-9][a-z0-9-]{0,62}\/)?[a-z0-9][a-z0-9-]{0,62}$/u);

const scenarioSchema = z.strictObject({
  id: keySchema,
  class: z.enum(CHAT_SEARCH_SCENARIO_CLASSES),
  user: keySchema,
  query: z.string().min(1).max(500).optional(),
  after: daySchema.optional(),
  before: daySchema.optional(),
  limit: z.number().int().min(1).max(20).optional(),
  /** The chat the search runs from, never a result; none by default. */
  currentChat: keySchema.optional(),
  expect: z.strictObject({
    chat: keySchema.optional(),
    turn: keySchema.optional(),
    maxRank: z.number().int().min(1).max(20).default(3),
    excerptIncludes: z.array(z.string().min(1)).optional(),
    /** Texts no result's excerpt may hold (an edited-away branch). */
    excerptsExclude: z.array(z.string().min(1)).optional(),
    never: z.array(chatRefSchema).optional(),
    recent: z.literal(true).optional(),
    read: z.strictObject({ turn: keySchema, role: z.enum(["user", "assistant"]), includes: z.string().min(1) }).optional()
  })
});

export const chatSearchScenariosSchema = z.strictObject({
  version: z.literal(1),
  about: z.string(),
  scenarios: z.array(scenarioSchema).min(1)
});

export type ChatSearchScenario = z.infer<typeof scenarioSchema>;

const FIXTURE_DIRECTORY = fileURLToPath(new URL("../../tests/fixtures/chat-search/", import.meta.url));

export function loadChatSearchFixtures(directory: string = FIXTURE_DIRECTORY): Readonly<{
  corpus: ChatSearchCorpus;
  scenarios: readonly ChatSearchScenario[];
}> {
  const read = (name: string) => JSON.parse(readFileSync(`${directory.replace(/\/$/u, "")}/${name}`, "utf8")) as unknown;
  const corpus = chatSearchCorpusSchema.parse(read("corpus.json"));
  const scenarios = chatSearchScenariosSchema.parse(read("scenarios.json")).scenarios;
  validateReferences(corpus, scenarios);
  return { corpus, scenarios };
}

// ---------------------------------------------------------------------------------------------------------------------
// The corpus at a moment: messages with instants, parents and keys.

export type SeedMessage = Readonly<{
  /** `user/chat/turn/q|a`, with `-old` for an edited-away version. */
  key: string;
  role: "user" | "assistant";
  text: string;
  createdAt: Date;
  parentKey: string | null;
  files: readonly string[];
}>;

export type SeedChat = Readonly<{
  /** `user/chat`. */
  key: string;
  userKey: string;
  title: string;
  mode: ChatSearchCorpus["users"][number]["chats"][number]["mode"];
  arrivesLate: boolean;
  createdAt: Date;
  /** In creation order, parents first. */
  messages: readonly SeedMessage[];
  activeLeafKey: string;
}>;

export type SeedUser = Readonly<{ key: string; timeZone: string; chats: readonly SeedChat[] }>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TURN_SPACING = 3 * MINUTE;

/** The local day (`YYYY-MM-DD`) of an instant in a zone. */
export function localDay(instant: Date, timeZone: string): string {
  return pastChatTimestamp(instant, timeZone).slice(0, 10);
}

function answerText(answer: string | readonly string[], fillers: readonly string[]): string {
  if (typeof answer === "string") return answer;
  return answer.map((part) => {
    const filler = /^@filler:(\d+)$/u.exec(part);
    if (!filler) return part;
    const text = fillers[Number(filler[1])];
    if (text === undefined) throw new Error("chat_search_fixture_filler_missing");
    return text;
  }).join("\n\n");
}

export function materializeChatSearchCorpus(corpus: ChatSearchCorpus, now: Date): readonly SeedUser[] {
  return corpus.users.map((user) => {
    const starts = new Set<number>();
    const chats = user.chats.map((chat): SeedChat => {
      const start = chat.daysAgo !== undefined
        ? new Date(pastChatDayStart(localDay(new Date(now.getTime() - chat.daysAgo * DAY), user.timeZone), user.timeZone).getTime() +
          chat.hour * 60 * MINUTE)
        : new Date(now.getTime() - chat.minutesAgo! * MINUTE - (chat.turns.length - 1) * TURN_SPACING - 2 * MINUTE);
      // Distinct times keep the recent listing's order defined.
      if (starts.has(start.getTime())) throw new Error("chat_search_fixture_start_not_unique");
      starts.add(start.getTime());
      const key = `${user.key}/${chat.key}`;
      const messages: SeedMessage[] = [];
      let parentKey: string | null = null;
      for (const [index, turn] of chat.turns.entries()) {
        const at = start.getTime() + index * TURN_SPACING;
        const turnKey = `${key}/${turn.key}`;
        if (turn.replaces) {
          messages.push({ createdAt: new Date(at), files: [], key: `${turnKey}/q-old`, parentKey, role: "user", text: turn.replaces.question });
          messages.push({ createdAt: new Date(at + 20_000), files: [], key: `${turnKey}/a-old`, parentKey: `${turnKey}/q-old`, role: "assistant",
            text: turn.replaces.answer });
        }
        const askedAt = turn.replaces ? at + MINUTE : at;
        messages.push({ createdAt: new Date(askedAt), files: turn.questionFiles ?? [], key: `${turnKey}/q`, parentKey, role: "user",
          text: turn.question });
        messages.push({ createdAt: new Date(askedAt + 40_000), files: turn.answerFiles ?? [], key: `${turnKey}/a`, parentKey: `${turnKey}/q`,
          role: "assistant", text: answerText(turn.answer, corpus.fillers) });
        parentKey = `${turnKey}/a`;
      }
      if (parentKey === null) throw new Error("chat_search_fixture_chat_empty");
      return { activeLeafKey: parentKey, arrivesLate: chat.arrivesLate, createdAt: new Date(start.getTime() - MINUTE), key, messages,
        mode: chat.mode, title: chat.title, userKey: user.key };
    });
    return { chats, key: user.key, timeZone: user.timeZone };
  });
}

/** The active branch of a seeded chat, root first. */
export function seedActivePath(chat: SeedChat): readonly SeedMessage[] {
  const byKey = new Map(chat.messages.map((message) => [message.key, message]));
  const path: SeedMessage[] = [];
  for (let cursor: string | null = chat.activeLeafKey; cursor !== null;) {
    const message = byKey.get(cursor);
    if (!message) break;
    path.push(message);
    cursor = message.parentKey;
  }
  return path.reverse();
}

/** The chat key a result id maps back to, the turn key of a user message key (`user/chat/turn`). */
export function turnKeyOf(messageKey: string): string {
  return messageKey.split("/").slice(0, 3).join("/");
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios: inputs and scores.

function chatRef(ref: string, userKey: string): string {
  return ref.includes("/") ? ref : `${userKey}/${ref}`;
}

function validateReferences(corpus: ChatSearchCorpus, scenarios: readonly ChatSearchScenario[]): void {
  const chats = new Map(corpus.users.flatMap((user) => user.chats.map((chat) => [`${user.key}/${chat.key}` as string, chat] as const)));
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`chat_search_scenario_duplicate:${scenario.id}`);
    ids.add(scenario.id);
    if (!corpus.users.some((user) => user.key === scenario.user)) throw new Error(`chat_search_scenario_user_unknown:${scenario.id}`);
    const { expect } = scenario;
    const refs = [expect.chat, scenario.currentChat, ...(expect.never ?? [])].flatMap((ref) => ref ? [chatRef(ref, scenario.user)] : []);
    for (const ref of refs) if (!chats.has(ref)) throw new Error(`chat_search_scenario_chat_unknown:${scenario.id}`);
    const target = expect.chat ? chats.get(chatRef(expect.chat, scenario.user))! : null;
    for (const turn of [expect.turn, expect.read?.turn]) {
      if (turn && !target?.turns.some((entry) => entry.key === turn)) throw new Error(`chat_search_scenario_turn_unknown:${scenario.id}`);
    }
    if (expect.recent && scenario.query) throw new Error(`chat_search_scenario_recent_with_query:${scenario.id}`);
    if (!expect.chat && !expect.never && !expect.recent && !expect.excerptsExclude) {
      throw new Error(`chat_search_scenario_expects_nothing:${scenario.id}`);
    }
  }
}

export function scenarioTimeZone(users: readonly SeedUser[], scenario: ChatSearchScenario): string {
  return users.find((user) => user.key === scenario.user)!.timeZone;
}

export function scenarioSearchInput(scenario: ChatSearchScenario, now: Date, timeZone: string): SearchPastChatsInput {
  const day = (value: { daysAgo: number } | undefined) => value ? localDay(new Date(now.getTime() - value.daysAgo * DAY), timeZone) : null;
  return { after: day(scenario.after), before: day(scenario.before), limit: scenario.limit ?? null, query: scenario.query ?? null };
}

export function scenarioCurrentChatKey(scenario: ChatSearchScenario): string | null {
  return scenario.currentChat ? `${scenario.user}/${scenario.currentChat}` : null;
}

/** Chats a search may return once the corpus is indexed and its later changes (deletion, exclusion) are applied. */
export function searchableChatKeys(users: readonly SeedUser[]): ReadonlySet<string> {
  return new Set(users.flatMap((user) => user.chats.filter((chat) => chat.mode === "normal").map((chat) => chat.key)));
}

/** The listing the corpus implies: the user's searchable chats by their latest turn in the range, newest first. */
export function expectedRecentChatKeys(users: readonly SeedUser[], scenario: ChatSearchScenario, input: SearchPastChatsInput,
  timeZone: string): string[] {
  const from = input.after ? pastChatDayStart(input.after, timeZone).getTime() : Number.NEGATIVE_INFINITY;
  const until = input.before ? pastChatDayStart(input.before, timeZone).getTime() : Number.POSITIVE_INFINITY;
  const current = scenarioCurrentChatKey(scenario);
  const user = users.find((entry) => entry.key === scenario.user)!;
  return user.chats.filter((chat) => chat.mode === "normal" && chat.key !== current).flatMap((chat) => {
    const asked = seedActivePath(chat).filter((message) => message.role === "user").map((message) => message.createdAt.getTime())
      .filter((at) => at >= from && at < until);
    return asked.length ? [{ at: Math.max(...asked), key: chat.key }] : [];
  }).sort((left, right) => right.at - left.at).slice(0, input.limit ?? PAST_CHATS_LIMITS.searchResultsDefault).map((entry) => entry.key);
}

/** What one search (and its read, when the scenario reads) gave, with ids mapped back to fixture keys. */
export type ScenarioObservation = Readonly<{
  outcome: "searched" | "disabled" | "query_unusable" | "failed";
  degraded: string | null;
  rerank: string | null;
  latencyMs: number;
  /** In result order; a key is null when the id is none of the corpus's. */
  results: ReadonlyArray<Readonly<{ chatKey: string | null; messageKey: string | null; excerpt: string }>>;
  read?: Readonly<{ outcome: string; messages: ReadonlyArray<Readonly<{ messageKey: string | null; text: string }>> }>;
}>;

export type ScenarioScore = Readonly<{
  id: string;
  class: ChatSearchScenarioClass;
  /** The scenario names a chat that must be found, so it counts toward the class's hit rates. */
  expectsChat: boolean;
  /** 1-based rank of the expected chat (and turn), null when not returned or not expected. */
  rank: number | null;
  passed: boolean;
  /** Content-free reason codes, empty when passed. */
  reasons: readonly string[];
  /** Results that broke a never rule: another user's, an ineligible or the current chat, a listed one or edited-away text. */
  violations: number;
  latencyMs: number;
  outcome: ScenarioObservation["outcome"];
  degraded: string | null;
  rerank: string | null;
}>;

export function scoreChatSearchScenario(input: Readonly<{
  scenario: ChatSearchScenario;
  users: readonly SeedUser[];
  searchInput: SearchPastChatsInput;
  observation: ScenarioObservation;
}>): ScenarioScore {
  const { observation, scenario } = input;
  const { expect } = scenario;
  const reasons: string[] = [];
  let violations = 0;
  const searchable = searchableChatKeys(input.users);
  const current = scenarioCurrentChatKey(scenario);
  const userPrefix = `${scenario.user}/`;

  if (observation.outcome !== "searched") reasons.push(`outcome_${observation.outcome}`);
  for (const result of observation.results) {
    const key = result.chatKey;
    if (key === null) {
      violations += 1;
      reasons.push("unknown_chat_returned");
    } else if (!key.startsWith(userPrefix)) {
      violations += 1;
      reasons.push("foreign_chat_returned");
    } else if (!searchable.has(key)) {
      violations += 1;
      reasons.push("ineligible_chat_returned");
    } else if (key === current) {
      violations += 1;
      reasons.push("current_chat_returned");
    }
  }
  const never = new Set((expect.never ?? []).map((ref) => chatRef(ref, scenario.user)));
  for (const result of observation.results) {
    if (result.chatKey !== null && never.has(result.chatKey)) {
      violations += 1;
      reasons.push("never_chat_returned");
    }
  }
  for (const banned of expect.excerptsExclude ?? []) {
    if (observation.results.some((result) => result.excerpt.includes(banned))) {
      violations += 1;
      reasons.push("excluded_text_returned");
    }
  }

  let rank: number | null = null;
  if (expect.chat) {
    const chatKey = chatRef(expect.chat, scenario.user);
    const turnKey = expect.turn ? `${chatKey}/${expect.turn}` : null;
    const index = observation.results.findIndex((result) => result.chatKey === chatKey &&
      (turnKey === null || (result.messageKey !== null && turnKeyOf(result.messageKey) === turnKey)));
    rank = index >= 0 ? index + 1 : null;
    if (rank === null) reasons.push("not_found");
    else if (rank > expect.maxRank) reasons.push("ranked_too_low");
    const hit = index >= 0 ? observation.results[index]! : null;
    if (hit && expect.excerptIncludes?.some((text) => !hit.excerpt.includes(text))) reasons.push("excerpt_missing_detail");
    if (expect.read) {
      const wanted = `${chatKey}/${expect.read.turn}/${expect.read.role === "user" ? "q" : "a"}`;
      const message = observation.read?.messages.find((entry) => entry.messageKey === wanted);
      if (!observation.read) reasons.push("read_not_run");
      else if (observation.read.outcome !== "read") reasons.push(`read_${observation.read.outcome}`);
      else if (!message) reasons.push("read_message_missing");
      else if (!message.text.includes(expect.read.includes)) reasons.push("read_text_missing");
    }
  }
  if (expect.recent) {
    const expected = expectedRecentChatKeys(input.users, scenario, input.searchInput, scenarioTimeZone(input.users, scenario));
    const got = observation.results.map((result) => result.chatKey);
    if (got.length !== expected.length || got.some((key, index) => key !== expected[index])) reasons.push("recent_order_mismatch");
  }
  return { class: scenario.class, degraded: observation.degraded, expectsChat: Boolean(expect.chat), id: scenario.id, latencyMs: observation.latencyMs,
    outcome: observation.outcome, passed: reasons.length === 0, rank, reasons: [...new Set(reasons)], rerank: observation.rerank, violations };
}

// ---------------------------------------------------------------------------------------------------------------------
// The report.

/**
 * Thresholds for the stand run with real models. THE FIRST REAL RUN SETS THEM: until then every value is null and
 * only the never rules (which hold without exception) fail a run. Record the measured values here and in the task;
 * a later run below them fails. Shares are of a class's scenarios that expect a chat.
 */
export const CHAT_SEARCH_SCENARIO_THRESHOLDS: Readonly<{
  hitAt3: Partial<Record<ChatSearchScenarioClass, number | null>>;
  hitAt5: Partial<Record<ChatSearchScenarioClass, number | null>>;
  /** Search latency, without reads, over every scenario. */
  latencyP95Ms: number | null;
}> = Object.freeze({
  hitAt3: {},
  hitAt5: {},
  latencyP95Ms: null
});

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

const share = (count: number, total: number) => (total === 0 ? null : Math.round((count / total) * 1000) / 1000);

function counts(values: readonly (string | null)[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value ?? "none"] = (result[value ?? "none"] ?? 0) + 1;
  return result;
}

export type ChatSearchScenarioReport = ReturnType<typeof chatSearchScenarioReport>;

export function chatSearchScenarioReport(scores: readonly ScenarioScore[]) {
  const classes: Record<string, unknown> = {};
  for (const name of CHAT_SEARCH_SCENARIO_CLASSES) {
    const all = scores.filter((score) => score.class === name);
    if (all.length === 0) continue;
    const ranked = all.filter((score) => score.expectsChat);
    const within = (k: number) => ranked.filter((score) => score.rank !== null && score.rank <= k).length;
    classes[name] = {
      scenarios: all.length,
      passed: all.filter((score) => score.passed).length,
      ...(ranked.length ? { ranked: ranked.length, hitAt1: share(within(1), ranked.length), hitAt3: share(within(3), ranked.length),
        hitAt5: share(within(5), ranked.length) } : {}),
      violations: all.reduce((sum, score) => sum + score.violations, 0)
    };
  }
  const latencies = scores.map((score) => score.latencyMs);
  return {
    scenarios: scores.length,
    passed: scores.filter((score) => score.passed).length,
    violations: scores.reduce((sum, score) => sum + score.violations, 0),
    classes,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 1) },
    outcomes: counts(scores.map((score) => score.outcome)),
    degraded: counts(scores.map((score) => score.degraded)),
    rerank: counts(scores.map((score) => score.rerank)),
    failures: scores.filter((score) => !score.passed).map((score) => ({ id: score.id, rank: score.rank, reasons: score.reasons }))
  };
}

/** Threshold breaches of a report, as content-free codes; never rules are not thresholds and always count. */
export function chatSearchThresholdBreaches(report: ChatSearchScenarioReport,
  thresholds: typeof CHAT_SEARCH_SCENARIO_THRESHOLDS = CHAT_SEARCH_SCENARIO_THRESHOLDS): string[] {
  const breaches: string[] = [];
  if (report.violations > 0) breaches.push("never_rule_violated");
  for (const [name, entry] of Object.entries(report.classes) as Array<[ChatSearchScenarioClass, { hitAt3?: number | null; hitAt5?: number | null }]>) {
    const at3 = thresholds.hitAt3[name];
    const at5 = thresholds.hitAt5[name];
    if (typeof at3 === "number" && (entry.hitAt3 ?? 0) < at3) breaches.push(`hit_at_3_below:${name}`);
    if (typeof at5 === "number" && (entry.hitAt5 ?? 0) < at5) breaches.push(`hit_at_5_below:${name}`);
  }
  if (thresholds.latencyP95Ms !== null && (report.latencyMs.p95 ?? 0) > thresholds.latencyP95Ms) breaches.push("latency_p95_above");
  return breaches;
}
