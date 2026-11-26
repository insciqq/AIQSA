/**
 * Builds the web search quality eval's question set (method of the
 * 2026-11-25/26 prototype): questions the answer model cannot answer from its
 * own knowledge, so each one needs search.
 *
 * - SimpleQA Verified and FRAMES rows (Hugging Face datasets-server), kept
 *   only when the model answering without search is not graded CORRECT.
 * - Russian long-tail questions the generator model writes from random
 *   Russian Wikipedia articles (`wikimedia/wikipedia`, config `20231101.ru`),
 *   the article's fact as gold, kept by the same no-search filter.
 * - Fresh Russian questions with official gold, not filtered: Bank of Russia
 *   rates (`XML_daily.asp`) and software versions (endoflife.date).
 * - Hand-written questions from `--extra` (for example the key rate), as is.
 *
 * Downloads, generated questions and no-search verdicts are cached under
 * `<out>/build/`, so an interrupted build resumes. Only counts are printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendJsonl,
  failureCode,
  mapPool,
  parseQuestions,
  questionHash,
  readJsonl,
  responseText,
  serializeQuestion,
  type Grader,
  type Question,
  type ResponsesModel
} from "./web-search-quality-support";

export type BuildOptions = Readonly<{
  /** The date fresh version questions ask "as of", YYYY-MM-DD. */
  asOf: string;
  concurrency: number;
  /** Bank of Russia currency codes the rate questions draw from. */
  currencies: readonly string[];
  effort: string;
  /** endoflife.date products and how many of their newest release lines to ask about. */
  eol: readonly Readonly<{ cycles: number; product: string }>[];
  extra?: string;
  frames: number;
  freshDates: readonly string[];
  freshRates: number;
  generatorModel: string;
  nosearchModel: string;
  out: string;
  /** Candidates drawn per kept question, before the no-search filter. */
  poolFactor: number;
  ruwiki: number;
  seed: number;
  simpleqa: number;
}>;

export type BuildPorts = Readonly<{
  /** GET a URL; the body as bytes. Throws on a failed request. */
  fetchBytes(url: string): Promise<Uint8Array>;
  grade: Grader;
  log(line: string): void;
  model: ResponsesModel;
}>;

// ------------------------------------------------------------------ helpers

/** mulberry32: a small seeded generator, so a build draws the same candidates again. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** `2026-11-25` → `25 ноября 2026 года`. */
export function russianDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month! - 1]} ${year} года`;
}

function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export type CbrRate = Readonly<{ code: string; name: string; nominal: number; value: string }>;

/** The rates of one `XML_daily.asp` answer (windows-1251 XML, decoded by the caller). */
export function parseCbrRates(xml: string): CbrRate[] {
  const rates: CbrRate[] = [];
  for (const match of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/gu)) {
    const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`, "u").exec(match[1]!)?.[1]?.trim();
    const code = field("CharCode");
    const nominal = Number(field("Nominal"));
    const name = field("Name");
    const value = field("Value");
    if (code && name && value && Number.isSafeInteger(nominal) && nominal > 0) rates.push({ code, name, nominal, value });
  }
  return rates;
}

/** Currency names in the genitive case for the rate question; others fall back to the Bank's own name. */
const CURRENCY_GENITIVE: Readonly<Record<string, string>> = {
  AED: "дирхама ОАЭ", BYN: "белорусского рубля", CNY: "китайского юаня", EUR: "евро", GBP: "фунта стерлингов",
  JPY: "японской иены", KZT: "казахстанского тенге", TRY: "турецкой лиры", USD: "доллара США"
};

export function cbrQuestion(date: string, rate: CbrRate): Question {
  const currency = CURRENCY_GENITIVE[rate.code] ?? `валюты ${rate.code}`;
  const per = rate.nominal > 1 ? ` за ${rate.nominal} ${rate.name.toLowerCase()}` : "";
  return {
    gold: `${rate.value} руб.${per}`,
    id: `cbr-${date.replaceAll("-", "")}-${rate.code.toLowerCase()}`,
    q: `Какой официальный курс ${currency} установил ЦБ РФ на ${russianDate(date)}${rate.nominal > 1 ? ` (${per.trim()})` : ""}?`,
    russian: true,
    set: "fresh_ru"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The newest `cycles` release lines of an endoflife.date product (`/api/v1/products/<name>`) whose latest release is not after `asOf`. */
export function eolQuestions(payload: unknown, product: string, cycles: number, asOf: string): Question[] {
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
  const label = typeof result?.label === "string" ? result.label : product;
  const releases = Array.isArray(result?.releases) ? result.releases.filter(isRecord) : [];
  return releases.flatMap((release): Question[] => {
    const latest = isRecord(release.latest) ? release.latest : null;
    if (typeof release.name !== "string" || typeof latest?.name !== "string" || typeof latest.date !== "string" || latest.date > asOf) {
      return [];
    }
    return [{
      gold: latest.name,
      id: `eol-${product}-${release.name}`.replace(/[^\w.-]/gu, "_"),
      q: `Какая последняя версия ${label} в ветке ${release.name} вышла по состоянию на ${russianDate(asOf)}?`,
      russian: true,
      set: "fresh_ru"
    }];
  }).slice(0, cycles);
}

/** The generator's answer: one question and its gold, or null when it skipped the article. */
export function parseGeneratedQuestion(text: string): Readonly<{ gold: string; q: string }> | null {
  const match = /\{[\s\S]*\}/u.exec(text);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[0]);
    if (!isRecord(value) || value.skip === true || typeof value.question !== "string" || typeof value.answer !== "string") return null;
    const q = value.question.trim();
    const gold = value.answer.trim();
    return q && gold && q.length <= 1_000 && gold.length <= 500 ? { gold, q } : null;
  } catch {
    return null;
  }
}

const RUWIKI_INSTRUCTIONS = "Ты составляешь вопросы для проверки веб-поиска. По тексту статьи Википедии составь ОДИН конкретный " +
  "фактический вопрос на русском языке, на который в статье есть однозначный короткий ответ (число, дата, имя, название). Вопрос " +
  "должен быть самодостаточным: назови предмет полностью и добавь уточнение, чтобы его нельзя было спутать с другим (страна, годы, " +
  "род занятий). Не спрашивай об очевидном из названия статьи. Ответ должен быть устойчивым фактом, а не тем, что меняется со " +
  "временем. Если статья не подходит (список, тема без конкретных фактов), верни skip. Ответь только JSON: " +
  "{\"question\": \"...\", \"answer\": \"...\"} или {\"skip\": true}.";

const NOSEARCH_INSTRUCTIONS = "Answer the question from your own knowledge in one short sentence. If you do not know, say so.";

// ------------------------------------------------------------------ sources

const DATASETS_SERVER = "https://datasets-server.huggingface.co";

type DatasetRows = Readonly<{ rows: readonly Readonly<{ row: Record<string, unknown>; rowIndex: number }>[]; total: number }>;

async function fetchJson(ports: BuildPorts, url: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await ports.fetchBytes(url))) as unknown;
}

async function datasetRows(ports: BuildPorts, dataset: string, config: string, split: string, offset: number, length: number):
  Promise<DatasetRows> {
  const url = `${DATASETS_SERVER}/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}` +
    `&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`;
  const value = await fetchJson(ports, url);
  if (!isRecord(value) || !Array.isArray(value.rows) || typeof value.num_rows_total !== "number") throw new Error("dataset_rows_invalid");
  return {
    rows: value.rows.flatMap((entry) => isRecord(entry) && isRecord(entry.row) && typeof entry.row_idx === "number"
      ? [{ row: entry.row, rowIndex: entry.row_idx }] : []),
    total: value.num_rows_total
  };
}

/** Every row of a small dataset, cached in `file`. */
async function wholeDataset(ports: BuildPorts, file: string, dataset: string, config: string, split: string):
  Promise<DatasetRows["rows"]> {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as DatasetRows["rows"];
  const first = await datasetRows(ports, dataset, config, split, 0, 100);
  const rows = [...first.rows];
  for (let offset = 100; offset < first.total; offset += 100) rows.push(...(await datasetRows(ports, dataset, config, split, offset, 100)).rows);
  writeFileSync(file, JSON.stringify(rows));
  ports.log(`downloaded ${dataset}: ${rows.length} rows`);
  return rows;
}

type Article = Readonly<{ rowIndex: number; text: string; title: string }>;

/** Random Russian Wikipedia articles of some substance, cached in `file`. */
async function ruwikiArticles(ports: BuildPorts, file: string, wanted: number, random: () => number): Promise<Article[]> {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Article[];
  const dataset = ["wikimedia/wikipedia", "20231101.ru", "train"] as const;
  const { total } = await datasetRows(ports, ...dataset, 0, 1);
  const articles = new Map<number, Article>();
  for (let page = 0; articles.size < wanted && page < wanted; page += 1) {
    const { rows } = await datasetRows(ports, ...dataset, Math.floor(random() * Math.max(1, total - 10)), 10);
    for (const { row, rowIndex } of rows) {
      const title = typeof row.title === "string" ? row.title : "";
      const text = typeof row.text === "string" ? row.text : "";
      if (title && text.length >= 1_500 && !/^Список\b/u.test(title)) articles.set(rowIndex, { rowIndex, text: text.slice(0, 6_000), title });
    }
  }
  const list = [...articles.values()].slice(0, wanted);
  writeFileSync(file, JSON.stringify(list));
  ports.log(`downloaded ruwiki: ${list.length} articles`);
  return list;
}

/** One question per article, by the generator model; appended per article so a build resumes. */
async function ruwikiQuestions(ports: BuildPorts, options: BuildOptions, file: string, articles: readonly Article[]): Promise<Question[]> {
  const done = new Map<number, Question | null>();
  for (const value of readJsonl(file)) {
    if (!isRecord(value) || typeof value.rowIndex !== "number") continue;
    done.set(value.rowIndex, typeof value.q === "string" && typeof value.gold === "string"
      ? { gold: value.gold, id: `rw${value.rowIndex}`, q: value.q, russian: true, set: "ruwiki" } : null);
  }
  const signal = new AbortController().signal;
  await mapPool(articles.filter((article) => !done.has(article.rowIndex)), options.concurrency, async (article) => {
    try {
      const response = await ports.model({ input: [{ content: `Статья «${article.title}»:\n\n${article.text}`, role: "user" }],
        instructions: RUWIKI_INSTRUCTIONS, model: options.generatorModel, reasoning: { effort: "low" }, store: false, stream: false }, signal);
      const generated = parseGeneratedQuestion(responseText(response));
      appendJsonl(file, { rowIndex: article.rowIndex, ...generated ?? { skip: true } });
      done.set(article.rowIndex, generated ? { ...generated, id: `rw${article.rowIndex}`, russian: true, set: "ruwiki" } : null);
    } catch (error) {
      ports.log(`ruwiki generation failed: ${failureCode(error)}`);
    }
  });
  return articles.flatMap((article) => done.get(article.rowIndex) ? [done.get(article.rowIndex)!] : []);
}

/** Whether the model fails each question without search; verdicts appended per question, so a build resumes. */
async function noSearchFailures(ports: BuildPorts, options: BuildOptions, file: string, pool: readonly Question[]): Promise<Set<string>> {
  const verdicts = new Map<string, string>();
  for (const value of readJsonl(file)) {
    if (isRecord(value) && typeof value.key === "string" && typeof value.grade === "string") verdicts.set(value.key, value.grade);
  }
  const key = (question: Question) => `${question.id}:${questionHash(question)}:${options.nosearchModel}`;
  const signal = new AbortController().signal;
  await mapPool(pool.filter((question) => !verdicts.has(key(question))), options.concurrency, async (question) => {
    try {
      const response = await ports.model({ input: [{ content: question.q, role: "user" }], instructions: NOSEARCH_INSTRUCTIONS,
        model: options.nosearchModel, reasoning: { effort: options.effort }, store: false, stream: false }, signal);
      const grade = await ports.grade(question, responseText(response), signal);
      if (!grade) return;
      appendJsonl(file, { grade, key: key(question) });
      verdicts.set(key(question), grade);
    } catch (error) {
      ports.log(`no-search check failed: ${failureCode(error)}`);
    }
  });
  return new Set(pool.filter((question) => {
    const grade = verdicts.get(key(question));
    return grade !== undefined && grade !== "CORRECT";
  }).map((question) => question.id));
}

function windows1251(bytes: Uint8Array): string {
  return new TextDecoder("windows-1251").decode(bytes);
}

async function freshQuestions(ports: BuildPorts, options: BuildOptions, random: () => number): Promise<Question[]> {
  const pairs: Array<Readonly<{ date: string; rate: CbrRate }>> = [];
  for (const date of options.freshDates) {
    const [year, month, day] = date.split("-");
    const xml = windows1251(await ports.fetchBytes(`https://www.cbr.ru/scripts/XML_daily.asp?date_req=${day}/${month}/${year}`));
    const rates = parseCbrRates(xml).filter((rate) => options.currencies.includes(rate.code));
    pairs.push(...rates.map((rate) => ({ date, rate })));
  }
  const rateQuestions = shuffled(pairs, random).slice(0, options.freshRates).map(({ date, rate }) => cbrQuestion(date, rate));
  const versionQuestions: Question[] = [];
  for (const { cycles, product } of options.eol) {
    const payload = await fetchJson(ports, `https://endoflife.date/api/v1/products/${encodeURIComponent(product)}`);
    versionQuestions.push(...eolQuestions(payload, product, cycles, options.asOf));
  }
  return [...rateQuestions, ...versionQuestions];
}

// ------------------------------------------------------------------- build

/** Builds `<out>/questions.jsonl`; returns the number of questions per set. */
export async function buildQuestionSet(options: BuildOptions, ports: BuildPorts): Promise<Record<string, number>> {
  const cache = join(options.out, "build");
  mkdirSync(cache, { recursive: true });
  const random = seededRandom(options.seed);
  const pool: Question[] = [];
  if (options.simpleqa > 0) {
    const rows = await wholeDataset(ports, join(cache, "simpleqa-rows.json"), "google/simpleqa-verified", "simpleqa_verified", "eval");
    pool.push(...shuffled(rows, random).slice(0, options.simpleqa * options.poolFactor).flatMap(({ row, rowIndex }): Question[] =>
      typeof row.problem === "string" && typeof row.answer === "string"
        ? [{ gold: row.answer, id: `sqa${rowIndex}`, q: row.problem, russian: false, set: "simpleqa" }] : []));
  }
  if (options.frames > 0) {
    const rows = await wholeDataset(ports, join(cache, "frames-rows.json"), "google/frames-benchmark", "default", "test");
    pool.push(...shuffled(rows, random).slice(0, options.frames * options.poolFactor).flatMap(({ row, rowIndex }): Question[] =>
      typeof row.Prompt === "string" && typeof row.Answer === "string"
        ? [{ gold: row.Answer, id: `frm${rowIndex}`, q: row.Prompt, russian: false, set: "frames" }] : []));
  }
  if (options.ruwiki > 0) {
    const articles = await ruwikiArticles(ports, join(cache, "ruwiki-articles.json"), Math.ceil(options.ruwiki * options.poolFactor * 1.5), random);
    pool.push(...await ruwikiQuestions(ports, options, join(cache, "ruwiki-generated.jsonl"), articles));
  }
  const failing = await noSearchFailures(ports, options, join(cache, "nosearch.jsonl"), pool);
  const kept: Question[] = [];
  for (const [set, count] of [["simpleqa", options.simpleqa], ["frames", options.frames], ["ruwiki", options.ruwiki]] as const) {
    const candidates = pool.filter((question) => question.set === set && failing.has(question.id));
    if (candidates.length < count) ports.log(`${set}: only ${candidates.length} of ${count} wanted fail without search`);
    kept.push(...shuffled(candidates, random).slice(0, count));
  }
  if (options.freshDates.length > 0 || options.eol.length > 0) kept.push(...await freshQuestions(ports, options, random));
  if (options.extra) kept.push(...parseQuestions(readFileSync(options.extra, "utf8")));
  const ids = new Set<string>();
  const unique = kept.filter((question) => !ids.has(question.id) && ids.add(question.id));
  writeFileSync(join(options.out, "questions.jsonl"), `${unique.map(serializeQuestion).join("\n")}\n`);
  const counts: Record<string, number> = {};
  for (const question of unique) counts[question.set] = (counts[question.set] ?? 0) + 1;
  return counts;
}

export function validBuildDates(values: readonly string[]): boolean {
  return values.every(isoDate);
}
