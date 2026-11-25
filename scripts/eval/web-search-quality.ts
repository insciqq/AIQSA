/**
 * Web search quality eval (queue `search-v2`): engines × answer models on
 * questions that need search, judged SimpleQA-style. Opt-in paid tooling,
 * never part of CI.
 *
 *   build   writes <out>/questions.jsonl (see web-search-quality-build.ts)
 *   run     answers every chosen question with every engine × model, appending
 *           to <out>/answers.jsonl; rerun the same command to resume
 *   report  judges answers without a verdict (<out>/judgments.jsonl), then
 *           prints the table and paired comparisons and writes <out>/report.txt
 *
 * The answer loop drives the product's own Search adapters, Search tool
 * router and tool-result excerpts (`web-search-quality-support.ts`), so the
 * model reads what users' models read. Answer models, the judge, the
 * question generator and the OpenAI client engine run on Codex LB only.
 *
 * Environment (keys are read from the environment, never from .env, and never
 * printed): CODEX_LB_API_KEY and CODEX_LB_ROOT (or --root, without /v1) for
 * every paid command; DEEPSEEK_API_KEY (and optionally DEEPSEEK_API_ROOT) for
 * the deepseek engine. The output directory must lie outside the repository.
 * Progress lines and the report go to stderr (the report also to
 * <out>/report.txt); the product's content-free event lines go to stdout, so
 * `>/dev/null` hides them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import { buildQuestionSet, validBuildDates, type BuildOptions } from "./web-search-quality-build";
import {
  clientEngine,
  codexLbClient,
  codexLbResponsesModel,
  DEFAULT_ENGINES,
  ENGINES,
  PENDING_ENGINES,
  type EngineDefinition,
  type EngineSetup
} from "./web-search-quality-engines";
import {
  answerQuestion,
  buildReport,
  DEFAULT_ANSWER_INSTRUCTIONS,
  dryRunModel,
  judgePending,
  latestAnswers,
  modelGrader,
  parseQuestions,
  readJsonl,
  readJudgments,
  runEvaluation,
  selectQuestions,
  type PreparedEngine,
  type QuestionSelection,
  type ResponsesModel,
  type RunConfig
} from "./web-search-quality-support";

export const USAGE = `Usage: npx tsx scripts/eval/web-search-quality.ts <build|run|report> [flags]

Environment: CODEX_LB_API_KEY and CODEX_LB_ROOT (or --root) for every paid command;
  DEEPSEEK_API_KEY (DEEPSEEK_API_ROOT optional) for the deepseek engine. Nothing is read from .env.

build --out DIR             writes DIR/questions.jsonl, caching downloads and verdicts in DIR/build/
  --simpleqa N --frames N --ruwiki N   questions kept per set (default 40, 40, 50)
  --pool-factor N           candidates drawn per kept question (default 3)
  --fresh-dates d,d         Bank of Russia rate dates, YYYY-MM-DD (default: 1, 8 and 15 days before --as-of)
  --fresh-rates N           rate questions drawn from dates × currencies (default 10)
  --currencies A,B          (default USD,EUR,CNY,KZT,TRY,BYN,AED)
  --eol p[:n],..            endoflife.date products and newest release lines
                            (default python:2,nodejs,linux,postgresql,kotlin)
  --as-of YYYY-MM-DD        date of the version questions (default today, UTC)
  --extra FILE              hand-written questions in the same format, appended as is
  --generator-model id      (default gpt-6.2-sol)   --nosearch-model id (default gpt-6.2-sol)
  --nosearch-effort e       (default low)           --seed N (default 20261126)

run --questions FILE --out DIR
  --engines a,b             ${Object.keys(ENGINES).join(", ")} (default: ${DEFAULT_ENGINES.join(", ")}; engines
                            still pending: ${Object.keys(PENDING_ENGINES).join(", ")})
  --models a,b              answer models (default gpt-6.2-sol,gpt-6.1-terra)
  --effort e                answer reasoning effort (default medium)
  --today YYYY-MM-DD        the date the answer instructions give (default today, UTC)
  --client-search-model id  technical model of openai-client (default gpt-6-luna)
  --max-rounds N            model requests per answer, the last without tools (default 12)
  --search-timeout-ms N     each engine call's deadline (default 120000)

report --questions FILE --out DIR
  --judge-model id          (default gpt-6.2-sol)   --judge-effort e (default low)

Shared: --ids a,b  --sets a,b  --limit N (round-robin across sets)  --concurrency N (default 4)
  --timeout-ms N (per model request, default 600000)  --root URL (Codex LB, without /v1)
  --dry-run (fake engines and model, no network; build is not available dry)`;

const EFFORT = /^(?:none|minimal|low|medium|high|xhigh)$/u;
const MODEL = /^[A-Za-z0-9][\w.:/-]{0,127}$/u;
const COMMANDS = ["build", "run", "report"] as const;
type Command = (typeof COMMANDS)[number];

const KNOWN_FLAGS: Readonly<Record<Command, readonly string[]>> = {
  build: ["out", "simpleqa", "frames", "ruwiki", "pool-factor", "fresh-dates", "fresh-rates", "currencies", "eol", "as-of", "extra",
    "generator-model", "nosearch-model", "nosearch-effort", "seed", "concurrency", "timeout-ms", "root"],
  report: ["questions", "out", "judge-model", "judge-effort", "ids", "sets", "limit", "concurrency", "timeout-ms", "root"],
  run: ["questions", "out", "engines", "models", "effort", "today", "client-search-model", "max-rounds", "search-timeout-ms", "ids", "sets",
    "limit", "concurrency", "timeout-ms", "root"]
};

function invalid(flag: string): never {
  throw new Error(`eval_argument_invalid:${flag.replace(/[^a-z-]/gu, "")}`);
}

export type ParsedArguments = Readonly<{ command: Command; dryRun: boolean; values: ReadonlyMap<string, string> }>;

export function parseArguments(argv: readonly string[]): ParsedArguments | Readonly<{ help: true }> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") return { help: true };
  if (!(COMMANDS as readonly string[]).includes(command)) invalid("command");
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = rest[index + 1];
    if (!flag.startsWith("--") || value === undefined || !KNOWN_FLAGS[command as Command].includes(flag.slice(2))) invalid(flag);
    values.set(flag.slice(2), value);
    index += 1;
  }
  if (dryRun && command === "build") invalid("--dry-run");
  return { command: command as Command, dryRun, values };
}

function count(values: ReadonlyMap<string, string>, flag: string, fallback: number, minimum: number, maximum: number): number {
  const raw = values.get(flag) ?? String(fallback);
  const parsed = Number(raw);
  if (!/^\d+$/u.test(raw) || parsed < minimum || parsed > maximum) invalid(`--${flag}`);
  return parsed;
}

function list(values: ReadonlyMap<string, string>, flag: string, fallback: readonly string[], pattern: RegExp): string[] {
  const raw = values.get(flag);
  if (raw === undefined) return [...fallback];
  const entries = [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (entries.length === 0 || !entries.every((entry) => pattern.test(entry))) invalid(`--${flag}`);
  return entries;
}

function word(values: ReadonlyMap<string, string>, flag: string, fallback: string, pattern: RegExp): string {
  const value = values.get(flag) ?? fallback;
  if (!pattern.test(value)) invalid(`--${flag}`);
  return value;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The output directory, created; never inside the repository (which holds `.aiqsa/` too). */
export function outputDirectory(values: ReadonlyMap<string, string>, repository = REPOSITORY): string {
  const raw = values.get("out");
  if (!raw) invalid("--out");
  const out = resolve(raw);
  const path = relative(repository, out);
  if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) throw new Error("eval_output_inside_repository");
  mkdirSync(out, { recursive: true });
  return out;
}

function codexLbRoot(values: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv): string | null {
  const raw = values.get("root") ?? env.CODEX_LB_ROOT;
  if (raw === undefined) return null;
  const root = raw.replace(/\/+$/u, "");
  if (!/^https:\/\/[^/\s]+(?:\/[^?#\s]*)?$/u.test(root) || /\/v1$/u.test(root)) invalid("--root");
  return root;
}

function selection(values: ReadonlyMap<string, string>): QuestionSelection {
  return {
    ...(values.has("ids") ? { ids: list(values, "ids", [], /^[\w.-]{1,80}$/u) } : {}),
    ...(values.has("sets") ? { sets: list(values, "sets", [], /^[\w-]{1,40}$/u) } : {}),
    ...(values.has("limit") ? { limit: count(values, "limit", 0, 1, 100_000) } : {})
  };
}

function questionsFile(values: ReadonlyMap<string, string>) {
  const file = values.get("questions");
  if (!file) invalid("--questions");
  return parseQuestions(readFileSync(file, "utf8"));
}

/** The paid Codex LB model; a missing key or root refuses the command. */
function codexLbModel(values: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv): ResponsesModel {
  const root = codexLbRoot(values, env);
  const apiKey = env.CODEX_LB_API_KEY?.trim();
  if (!root) throw new Error("eval_argument_invalid:--root");
  if (!apiKey) throw new Error("eval_env_missing:CODEX_LB_API_KEY");
  const timeoutMs = count(values, "timeout-ms", 600_000, 10_000, 3_600_000);
  return codexLbResponsesModel(codexLbClient({ apiKey, root, timeoutMs }), timeoutMs);
}

export type CliPorts = Readonly<{
  engines?: Readonly<Record<string, EngineDefinition>>;
  env: NodeJS.ProcessEnv;
  model?: ResponsesModel;
  now: () => number;
  print(line: string): void;
}>;

/** Fake client engines for `--dry-run`: the product router over an adapter that returns one source. */
export function dryRunEngine(id: string): PreparedEngine {
  if (id === "none") return { kind: "none" };
  if (id === "openai-in-answer") return { kind: "in_answer" };
  return clientEngine({
    adapter: {
      buildRequestPreview: () => ({ provider: "dry-run" }),
      search: (request) => Promise.resolve({ artifacts: [], costUsd: 0, finalProviderResponsePreview: {},
        findings: `[1] Dry run result for a ${request.query.length}-character query`, requestPreview: {}, sourceAttribution: "available",
        sources: [{ citation: 1, title: "Dry run", url: "https://example.com/dry-run" }], usage: normalizeTokenUsage({}) })
    },
    config: { maxOutputTokens: 16, queryMaxCharacters: 1_000, reasoningPolicy: "provider_default", timeoutMs: 10_000 },
    displayName: "Dry run",
    modelId: "dry-run",
    protocol: "deepseek_search_api",
    provider: "deepseek"
  });
}

async function runCommand(parsed: ParsedArguments, ports: CliPorts): Promise<number> {
  const { values } = parsed;
  const out = outputDirectory(values);
  const questions = selectQuestions(questionsFile(values), selection(values));
  const registry = ports.engines ?? ENGINES;
  // The default comparison runs the engines whose adapters have landed and names the others.
  const defaults = parsed.dryRun ? ["none", "openai-in-answer", "deepseek"] : DEFAULT_ENGINES.filter((id) => registry[id]);
  if (!values.has("engines")) {
    for (const id of DEFAULT_ENGINES) if (!registry[id]) ports.print(`engine ${id} left out: waiting for ${PENDING_ENGINES[id] ?? "its adapter"}`);
  }
  const engineIds = list(values, "engines", defaults, /^[a-z][\w-]{0,39}$/u);
  for (const id of engineIds) {
    if (PENDING_ENGINES[id] && !registry[id]) throw new Error(`eval_engine_pending:${id}`);
    if (!registry[id]) invalid("--engines");
  }
  const models = list(values, "models", ["gpt-6.2-sol", "gpt-6.1-terra"], MODEL);
  const effort = word(values, "effort", "medium", EFFORT);
  const date = word(values, "today", today(), /^\d{4}-\d{2}-\d{2}$/u);
  const setup: EngineSetup = {
    clientSearchModel: word(values, "client-search-model", "gpt-6-luna", MODEL),
    codexLbRoot: codexLbRoot(values, ports.env),
    env: ports.env,
    timeoutMs: count(values, "search-timeout-ms", 120_000, 5_000, 900_000)
  };
  const engines = new Map<string, PreparedEngine>();
  for (const id of engineIds) {
    if (parsed.dryRun) {
      engines.set(id, dryRunEngine(id));
      continue;
    }
    const definition = registry[id]!;
    for (const name of definition.env) if (!ports.env[name]?.trim()) throw new Error(`eval_env_missing:${name}`);
    engines.set(id, definition.prepare(setup));
  }
  const model = ports.model ?? (parsed.dryRun ? dryRunModel() : codexLbModel(values, ports.env));
  const configs: RunConfig[] = models.flatMap((modelId) => engineIds.map((engine) => ({ effort, engine, model: modelId })));
  const maxRounds = count(values, "max-rounds", 12, 1, 100);
  const summary = await runEvaluation({
    answer: (question, config, signal) => answerQuestion({ effort: config.effort, engine: engines.get(config.engine)!,
      instructions: DEFAULT_ANSWER_INSTRUCTIONS(date), maxRounds, model, modelId: config.model, now: ports.now, question, signal }),
    answersPath: resolve(out, "answers.jsonl"),
    concurrency: count(values, "concurrency", 4, 1, 32),
    configs,
    now: ports.now,
    progress: (event) => ports.print(`${event.status} ${event.config} ${event.id} ${event.seconds}s${event.code ? ` ${event.code}` : ""}`),
    questions
  });
  ports.print(`run: ${summary.answered} answered, ${summary.failed} failed (rerun to retry), ${summary.skipped} already answered`);
  return summary.failed > 0 ? 1 : 0;
}

async function reportCommand(parsed: ParsedArguments, ports: CliPorts): Promise<number> {
  const { values } = parsed;
  const out = outputDirectory(values);
  const questions = selectQuestions(questionsFile(values), selection(values));
  const answers = latestAnswers(readJsonl(resolve(out, "answers.jsonl")));
  const model = ports.model ?? (parsed.dryRun ? dryRunModel() : codexLbModel(values, ports.env));
  const judgmentsPath = resolve(out, "judgments.jsonl");
  const judged = await judgePending({
    answers,
    concurrency: count(values, "concurrency", 4, 1, 32),
    grade: modelGrader({ effort: word(values, "judge-effort", "low", EFFORT), model, modelId: word(values, "judge-model", "gpt-6.2-sol", MODEL) }),
    judgmentsPath,
    questions
  });
  if (judged.failed > 0) ports.print(`judge: ${judged.failed} answers left ungraded (rerun to retry)`);
  const report = buildReport({ answers, grades: readJudgments(judgmentsPath), questions });
  writeFileSync(resolve(out, "report.txt"), `${report}\n`);
  ports.print(report);
  return 0;
}

async function buildCommand(parsed: ParsedArguments, ports: CliPorts): Promise<number> {
  const { values } = parsed;
  const out = outputDirectory(values);
  const asOf = word(values, "as-of", today(), /^\d{4}-\d{2}-\d{2}$/u);
  const freshDates = list(values, "fresh-dates", [daysBefore(asOf, 1), daysBefore(asOf, 8), daysBefore(asOf, 15)], /^\d{4}-\d{2}-\d{2}$/u);
  if (!validBuildDates([asOf, ...freshDates])) invalid("--fresh-dates");
  const eol = list(values, "eol", ["python:2", "nodejs", "linux", "postgresql", "kotlin"], /^[a-z0-9-]{1,40}(?::\d{1,2})?$/u)
    .map((entry) => {
      const [product, cycles] = entry.split(":");
      return { cycles: cycles ? Number(cycles) : 1, product: product! };
    });
  const model = ports.model ?? codexLbModel(values, ports.env);
  const options: BuildOptions = {
    asOf,
    concurrency: count(values, "concurrency", 4, 1, 32),
    currencies: list(values, "currencies", ["USD", "EUR", "CNY", "KZT", "TRY", "BYN", "AED"], /^[A-Z]{3}$/u),
    effort: word(values, "nosearch-effort", "low", EFFORT),
    eol,
    ...(values.has("extra") ? { extra: values.get("extra")! } : {}),
    frames: count(values, "frames", 40, 0, 10_000),
    freshDates,
    freshRates: count(values, "fresh-rates", 10, 0, 1_000),
    generatorModel: word(values, "generator-model", "gpt-6.2-sol", MODEL),
    nosearchModel: word(values, "nosearch-model", "gpt-6.2-sol", MODEL),
    out,
    poolFactor: count(values, "pool-factor", 3, 1, 20),
    ruwiki: count(values, "ruwiki", 50, 0, 10_000),
    seed: count(values, "seed", 20_261_126, 0, 2 ** 31),
    simpleqa: count(values, "simpleqa", 40, 0, 10_000)
  };
  const counts = await buildQuestionSet(options, {
    fetchBytes: publicDownload,
    grade: modelGrader({ effort: "low", model, modelId: "gpt-6.2-sol" }),
    log: ports.print,
    model
  });
  ports.print(`build: ${Object.entries(counts).map(([set, n]) => `${set} ${n}`).join(", ")} -> ${resolve(out, "questions.jsonl")}`);
  return 0;
}

/** Public, keyless downloads (datasets-server, the Bank of Russia, endoflife.date), sent again on 429 and 5xx. */
async function publicDownload(url: string): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": "web-search-quality-eval" }, signal: AbortSignal.timeout(60_000) });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (attempt >= 4 || !(response.status === 429 || response.status >= 500)) throw new Error(`download_failed:${response.status}`);
    await new Promise((done) => setTimeout(done, 2_000 * 2 ** attempt));
  }
}

export async function main(argv: readonly string[], ports: CliPorts): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    ports.print(`${error instanceof Error ? error.message : "eval_argument_invalid"}\n${USAGE}`);
    return 2;
  }
  if ("help" in parsed) {
    ports.print(USAGE);
    return 0;
  }
  try {
    switch (parsed.command) {
      case "build": return await buildCommand(parsed, ports);
      case "run": return await runCommand(parsed, ports);
      case "report": return await reportCommand(parsed, ports);
    }
  } catch (error) {
    // A refused argument, a missing key or an engine still pending: say which, before any paid call.
    if (error instanceof Error && /^eval_(?:argument_invalid|env_missing|engine_pending|output_inside_repository)\b/u.test(error.message)) {
      ports.print(`${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), { env: process.env, now: () => performance.now(), print: (line) => process.stderr.write(`${line}\n`) })
    .then((code) => { process.exitCode = code; }, (error: unknown) => {
      // Only our own codes carry a message; anything else prints its class name.
      const code = error instanceof Error && /^(?:eval|download|question|dataset)_[\w:.-]+$/u.test(error.message) ? error.message
        : error instanceof Error ? error.name : "unknown";
      process.stderr.write(`web_search_quality_failed:${code}\n`);
      process.exitCode = 1;
    });
}
