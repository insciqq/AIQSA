/**
 * Spike 2 of the native-agent engine spikes: compaction at scale on Codex LB.
 * A measurement script, never part of a test run or of the product.
 *
 * It builds a deterministic synthetic work session (Responses `input` items:
 * Russian and English messages, function_call/function_call_output pairs with
 * tables, logs and code) of about `--tokens` estimated tokens (characters / 4)
 * with planted probes in its first 80 %, then measures, per path:
 *
 * - native: POST {root}/v1/responses/compact over the session minus its last
 *   ~20k tokens (`--native-input full` compacts everything instead), then a
 *   streamed recall call over [compacted output + verbatim tail + question].
 * - summary: a streamed handoff summary (max_output_tokens 4096) over the
 *   session minus its tail with tool arguments and outputs trimmed head+tail
 *   to ~2k characters, then the same recall call over [summary + tail +
 *   question].
 * - inline (opt-in): one streamed /v1/responses call over the whole session
 *   plus the question with `context_management: [{type: "compaction",
 *   compact_threshold}]`, so the server compacts in the stream and answers.
 * - trigger (opt-in): a streamed /v1/responses call over the session minus its
 *   tail ending with a `compaction_trigger` input item, then the recall call
 *   over [its output items + tail + question].
 *
 * Output is content-free JSON lines on stdout (and `--out <file>`): sizes,
 * timings, usage, item kinds, HTTP statuses, error codes and one boolean per
 * probe. The key, prompts, answers and transcript text are never printed.
 *
 * Run: CODEX_LB_API_KEY=... npx tsx scripts/spikes/compaction-scale.ts
 *   [--model gpt-6.1-sol] [--tokens 400000] [--paths native,summary[,inline,trigger]]
 *   [--repeat 1] [--root https://codex-lb.psaux.info] [--out results.jsonl]
 *   [--seed 1] [--tail-tokens 20000] [--native-input head|full]
 *   [--inline-threshold N] [--effort low|medium|high|none] [--summary-effort low|default|...]
 *   [--summary-max-output 4096] [--idle-timeout-ms 120000] [--overall-timeout-ms 600000]
 *   [--estimator o200k|chars4] [--dry-run] [--verbose]
 * Sizes use the o200k encoding by default (`--estimator chars4` sizes by
 * characters / 4, which undercounts this number-heavy transcript ~1.5x and
 * would push a "400k" transcript past the 500k published window); the
 * transcript line reports both. `--dry-run` builds the transcript, prints
 * that line and makes no request, so the size can be checked before paying.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type InputItem = Record<string, unknown>;
export type ProbeRegion = "assistant" | "tool" | "user";
export type PathName = "inline" | "native" | "summary" | "trigger";

export type ProbeDefinition = Readonly<{
  at: number;
  fields: Readonly<Record<string, Readonly<{ expected: string; question: string }>>>;
  id: string;
  region: ProbeRegion;
}>;

export type PlantedProbe = Readonly<{ id: string; position: number; region: ProbeRegion }>;

export type Transcript = Readonly<{
  /** The counter the transcript was sized with; records use it too. */
  count: (text: string) => number;
  estimatedTokens: number;
  items: readonly InputItem[];
  probes: readonly PlantedProbe[];
}>;

export const DEFAULT_ROOT = "https://codex-lb.psaux.info";
export const DEFAULT_MODEL = "gpt-6.1-sol";
export const DEFAULT_TOKENS = 400_000;
export const DEFAULT_TAIL_TOKENS = 20_000;
export const TOOL_TRIM_CHARS = 2_000;
export const SUMMARY_MAX_OUTPUT_TOKENS = 4_096;
const MAX_STREAM_TEXT_CHARS = 1_000_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ITEM_OVERHEAD_TOKENS = 4;
const PROBE_REGION_LIMIT = 0.8;

// ---------------------------------------------------------------------------
// Probes. The planted values are unique in the transcript; distractors use
// other id ranges (warehouses W-200..W-999, random job ids, other paths).

export const PROBES: readonly ProbeDefinition[] = [
  {
    at: 0.02,
    fields: { reportTimezone: { expected: "Asia/Yekaterinburg", question: "the IANA time zone the user required for every report" } },
    id: "constraint",
    region: "user"
  },
  {
    at: 0.3,
    fields: { archiveBucket: { expected: "aiqsa-archive-teal-07", question: "the archive bucket name currently in force, after any correction" } },
    id: "correction",
    region: "user"
  },
  {
    at: 0.4,
    fields: { w17NetMargin: { expected: "48213.75", question: "the exact net_margin value of warehouse W-17 in the northern margin table tool output" } },
    id: "toolNumber",
    region: "tool"
  },
  {
    at: 0.5,
    fields: { dedupFilePath: { expected: "/srv/etl/pipelines/reconcile_v3/stage_04_merge.py", question: "the full path of the file edited to add the deduplication step" } },
    id: "filePath",
    region: "tool"
  },
  {
    at: 0.58,
    fields: { failedJobId: { expected: "JOB-7Q4M-2291", question: "the identifier of the export job that failed with an upstream timeout" } },
    id: "identifier",
    region: "tool"
  },
  {
    at: 0.65,
    fields: {
      mergeStrategy: { expected: "window_dedup", question: "the merge strategy that was chosen" },
      rejectedStrategyOomGb: { expected: "14", question: "the memory in GB at which the rejected merge strategy ran out of memory, number only" }
    },
    id: "decision",
    region: "assistant"
  },
  {
    at: 0.72,
    fields: {
      schemaErrorCode: { expected: "ERR_SCHEMA_DRIFT_0x3F2", question: "the exact error code of the schema drift error" },
      schemaFixType: { expected: "TIMESTAMPTZ", question: "the SQL type the settled_at column was cast to in the fix" }
    },
    id: "errorFix",
    region: "tool"
  },
  {
    at: 0.78,
    fields: {
      pendingPartition: { expected: "2026-W11", question: "the partition that still waits to be backfilled" },
      pendingTable: { expected: "ledger_events_v2", question: "the table whose partition still waits to be backfilled" }
    },
    id: "pending",
    region: "assistant"
  }
];

/** The superseded value of the correction probe, planted before it. */
const SUPERSEDED_BUCKET = "aiqsa-archive-blue";
const SUPERSEDED_AT = 0.12;

// ---------------------------------------------------------------------------
// Deterministic text generation.

type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function integer(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TABLES = ["ledger_events_v1", "settlements", "warehouse_stock", "fx_rates", "invoices_q1", "returns", "shipments"];
const REGIONS = ["north", "south", "ural", "volga", "siberia", "far-east", "central"];
const MONTHS = ["2026-01", "2026-02", "2026-04", "2026-05"];
const STAGES = ["extract", "normalize", "join", "aggregate", "validate", "export", "publish"];

function warehouse(rng: Rng): string {
  return `W-${integer(rng, 200, 999)}`;
}

function jobId(rng: Rng): string {
  let suffix = "";
  for (let index = 0; index < 4; index += 1) suffix += pick(rng, [...ALNUM]);
  return `JOB-${suffix}-${integer(rng, 3000, 9999)}`;
}

function filePath(rng: Rng): string {
  return `/srv/etl/pipelines/${pick(rng, ["ingest_v2", "reports", "fx_sync", "stock_v5"])}/stage_${String(integer(rng, 10, 99))}_${pick(rng, STAGES)}.py`;
}

function money(rng: Rng): string {
  return (rng() * 90_000 - 5_000).toFixed(2);
}

function fill(template: string, rng: Rng): string {
  return template.replace(/\{(\w+)\}/gu, (_match, slot: string) => {
    switch (slot) {
      case "w": return warehouse(rng);
      case "table": return pick(rng, TABLES);
      case "region": return pick(rng, REGIONS);
      case "month": return pick(rng, MONTHS);
      case "stage": return pick(rng, STAGES);
      case "job": return jobId(rng);
      case "path": return filePath(rng);
      case "n": return String(integer(rng, 120, 98_000));
      case "k": return String(integer(rng, 1, 40));
      case "s": return String(integer(rng, 3, 900));
      case "x": return money(rng);
      default: return slot;
    }
  });
}

const USER_EN = [
  "Check the {table} numbers for warehouse {w} again and tell me whether the totals match the ledger.",
  "Next, load the {month} extract from {path} and compare it with yesterday's run.",
  "Run the reconciliation for region {region} and flag anything above {n} units.",
  "Can you look at the logs of job {job} and find out why it slowed down?",
  "Please keep going with the {stage} stage; I will be back in an hour and want a short status.",
  "Compare the {table} totals for {month} with the previous export and list the differences."
];
const USER_RU = [
  "Проверь, пожалуйста, итоги по складу {w} за {month}, там что-то не сходится с бухгалтерией.",
  "Загрузи выгрузку {path} и сравни её с прошлой версией, интересуют только расхождения.",
  "Посмотри логи задачи {job}: почему она шла так долго и что можно ускорить?",
  "Давай дальше по плану, следующий этап — сверка по региону {region}.",
  "Сделай короткую сводку по таблице {table}, только цифры и без лишнего текста.",
  "Пересчитай остатки по складу {w}, порог расхождения {k} процентов."
];
const ASSISTANT_EN = [
  "I compared {n} rows of {table}; {k} of them differ by less than half a percent, which is within tolerance.",
  "The extract from {path} loaded in {s} seconds and contains {n} rows, with no duplicates on the key.",
  "Job {job} spent most of its time waiting on the {table} lock; I will retry it after the current stage.",
  "Region {region} looks consistent: the largest deviation is {x} on warehouse {w}.",
  "Next I will move on to the {stage} stage and report the totals when it finishes.",
  "The totals for {month} match the ledger except for warehouse {w}, which is off by {x}; I noted it for review."
];
const ASSISTANT_RU = [
  "Сверил {n} строк в {table}: расхождений выше порога нет, максимум {x} по складу {w}.",
  "Выгрузка {path} загружена за {s} с, в ней {n} строк, дублей по ключу нет.",
  "Задача {job} большую часть времени ждала блокировку на {table}; перезапущу её после текущего этапа.",
  "Регион {region} в порядке, перехожу к этапу {stage}.",
  "Промежуточный итог: обработано {n} записей, замечаний {k}, все они в пределах допуска.",
  "Итоги за {month} совпадают с учётом, кроме склада {w}: расхождение {x}, отметил для проверки."
];

function prose(rng: Rng, templates: readonly string[], sentences: number): string {
  return Array.from({ length: sentences }, () => fill(pick(rng, templates), rng)).join(" ");
}

function message(role: "assistant" | "user", text: string): InputItem {
  return {
    content: [{ text, type: role === "assistant" ? "output_text" : "input_text" }],
    role,
    type: "message"
  };
}

function functionCall(callId: string, name: string, args: Record<string, unknown>): InputItem {
  return { arguments: JSON.stringify(args), call_id: callId, name, type: "function_call" };
}

function functionOutput(callId: string, output: string): InputItem {
  return { call_id: callId, output, type: "function_call_output" };
}

function marginTable(rng: Rng, rows: number, planted?: Readonly<{ row: number; line: string }>): string {
  const lines = ["| warehouse | region | gross | net_margin | units | share |", "|---|---|---|---|---|---|"];
  for (let row = 0; row < rows; row += 1) {
    if (planted && row === planted.row) lines.push(planted.line);
    lines.push(`| ${warehouse(rng)} | ${pick(rng, REGIONS)} | ${money(rng)} | ${money(rng)} | ${integer(rng, 10, 99_999)} | ${(rng() * 100).toFixed(3)} |`);
  }
  return lines.join("\n");
}

function logLines(rng: Rng, lines: number, planted?: Readonly<{ line: string; row: number }>): string {
  const output: string[] = [];
  for (let row = 0; row < lines; row += 1) {
    if (planted && row === planted.row) output.push(planted.line);
    const minute = String(integer(rng, 0, 59)).padStart(2, "0");
    const second = String(integer(rng, 0, 59)).padStart(2, "0");
    output.push(`2026-04-${String(integer(rng, 1, 28)).padStart(2, "0")}T${String(integer(rng, 0, 23)).padStart(2, "0")}:${minute}:${second}Z ${pick(rng, ["INFO", "INFO", "INFO", "WARN"])} job=${jobId(rng)} stage=${pick(rng, STAGES)} rows=${integer(rng, 0, 500_000)} elapsed_ms=${integer(rng, 5, 90_000)}`);
  }
  return output.join("\n");
}

function codeFile(rng: Rng, lines: number): string {
  const output = ["import polars as pl", "", "def run(frame: pl.DataFrame) -> pl.DataFrame:"];
  for (let line = 0; line < lines; line += 1) {
    output.push(`    frame = frame.with_columns(pl.col("${pick(rng, ["amount", "units", "fx_rate", "net", "gross"])}").${pick(rng, ["round(2)", "fill_null(0)", "cast(pl.Float64)", "abs()"])}.alias("c${integer(rng, 0, 999)}"))  # ${pick(rng, STAGES)}`);
  }
  output.push("    return frame");
  return output.join("\n");
}

function toolRound(rng: Rng, callId: string): InputItem[] {
  switch (integer(rng, 0, 3)) {
    case 0: {
      const table = pick(rng, TABLES);
      return [
        functionCall(callId, "run_sql", { query: `SELECT warehouse, region, gross, net_margin, units, share FROM ${table} WHERE region = '${pick(rng, REGIONS)}' AND month = '${pick(rng, MONTHS)}'` }),
        functionOutput(callId, marginTable(rng, integer(rng, 20, 120)))
      ];
    }
    case 1: {
      const path = filePath(rng);
      return [functionCall(callId, "read_file", { path }), functionOutput(callId, codeFile(rng, integer(rng, 30, 140)))];
    }
    case 2:
      return [
        functionCall(callId, "run_pipeline", { job_id: jobId(rng), stage: pick(rng, STAGES) }),
        functionOutput(callId, logLines(rng, integer(rng, 20, 110)))
      ];
    default:
      return [
        functionCall(callId, "search_logs", { query: `stage=${pick(rng, STAGES)} WARN`, since: `2026-04-${String(integer(rng, 1, 28)).padStart(2, "0")}` }),
        functionOutput(callId, logLines(rng, integer(rng, 10, 60)))
      ];
  }
}

function fillerTurn(rng: Rng, nextCallId: () => string): InputItem[] {
  const russian = rng() < 0.5;
  const items: InputItem[] = [message("user", prose(rng, russian ? USER_RU : USER_EN, integer(rng, 1, 3)))];
  if (rng() < 0.4) items.push(message("assistant", prose(rng, russian ? ASSISTANT_RU : ASSISTANT_EN, 1)));
  const rounds = integer(rng, 1, 3);
  for (let round = 0; round < rounds; round += 1) items.push(...toolRound(rng, nextCallId()));
  items.push(message("assistant", prose(rng, russian ? ASSISTANT_RU : ASSISTANT_EN, integer(rng, 2, 6))));
  return items;
}

function goalTurn(): InputItem[] {
  return [
    message("user", "We are reconciling the Q1 ledger exports for every warehouse and preparing the monthly reports. Work through the stages with me: extract, normalize, join, aggregate, validate, export, publish. Report numbers exactly as the tools return them."),
    message("assistant", "Understood. I will go stage by stage, keep the numbers exactly as the tools return them, and report after each stage.")
  ];
}

type Plant = Readonly<{ at: number; build: (rng: Rng) => InputItem[]; probeId?: string; region: ProbeRegion }>;

const PLANTS: readonly Plant[] = [
  {
    at: PROBES[0]!.at,
    build: () => [
      message("user", "Прежде чем продолжим: жёсткое требование для всего проекта — во всех отчётах время указываем в часовом поясе Asia/Yekaterinburg, не в UTC и не по Москве. Остальное на твоё усмотрение."),
      message("assistant", "Принято: все отчёты будут во времени Asia/Yekaterinburg.")
    ],
    probeId: "constraint",
    region: "user"
  },
  {
    at: SUPERSEDED_AT,
    build: () => [
      message("user", `When a stage is done, archive its finished batches to the bucket ${SUPERSEDED_BUCKET}.`),
      message("assistant", "Noted, finished batches go to the archive bucket after each stage.")
    ],
    region: "user"
  },
  {
    at: PROBES[1]!.at,
    build: () => [
      message("user", `Поправка по архиву: не ${SUPERSEDED_BUCKET}, а aiqsa-archive-teal-07. Старый бакет больше не используем.`),
      message("assistant", "Понял, архив переключён на новый бакет.")
    ],
    probeId: "correction",
    region: "user"
  },
  {
    at: PROBES[2]!.at,
    build: (rng) => [
      message("user", "Pull the margin table for the northern warehouses."),
      functionCall("call_probe_margin", "run_sql", { query: "SELECT warehouse, region, gross, net_margin, units, share FROM settlements WHERE region = 'north' AND month = '2026-03'" }),
      functionOutput("call_probe_margin", marginTable(rng, 40, { line: "| W-17 | north | 91877.20 | 48213.75 | 18342 | 7.214 |", row: 23 })),
      message("assistant", "Margins pulled; nothing unusual except two warehouses below zero, which I will check later.")
    ],
    probeId: "toolNumber",
    region: "tool"
  },
  {
    at: PROBES[3]!.at,
    build: (rng) => {
      const path = "/srv/etl/pipelines/reconcile_v3/stage_04_merge.py";
      return [
        message("user", "Add a deduplication step to the merge stage before the join."),
        functionCall("call_probe_read", "read_file", { path }),
        functionOutput("call_probe_read", codeFile(rng, 60)),
        functionCall("call_probe_write", "write_file", { content: `${codeFile(rng, 20)}\n    frame = frame.unique(subset=["invoice_id", "line_no"], keep="last")`, path }),
        functionOutput("call_probe_write", "ok: file written, 2 hunks applied"),
        message("assistant", "Added the deduplication step to the merge stage; the stage tests pass.")
      ];
    },
    probeId: "filePath",
    region: "tool"
  },
  {
    at: PROBES[4]!.at,
    build: (rng) => [
      message("user", "Run the export stage for March."),
      functionCall("call_probe_export", "run_pipeline", { stage: "export", month: "2026-03" }),
      functionOutput("call_probe_export", logLines(rng, 50, { line: "2026-04-11T03:17:44Z ERROR job=JOB-7Q4M-2291 stage=export failed: upstream timeout after 900 s", row: 31 })),
      message("assistant", "The export job failed on an upstream timeout; I will rerun it after the validation stage.")
    ],
    probeId: "identifier",
    region: "tool"
  },
  {
    at: PROBES[5]!.at,
    build: () => [
      message("user", "Which merge strategy do we keep for the remaining months?"),
      message("assistant", "Decision: we keep merge_strategy = window_dedup. The alternative hash_dedup ran out of memory at 14 GB on the March batch, while window_dedup peaks at 3.1 GB and gives identical row counts.")
    ],
    probeId: "decision",
    region: "assistant"
  },
  {
    at: PROBES[6]!.at,
    build: (rng) => [
      message("user", "Прогони валидацию схемы перед публикацией."),
      functionCall("call_probe_validate", "run_pipeline", { stage: "validate", month: "2026-03" }),
      functionOutput("call_probe_validate", logLines(rng, 30, { line: "2026-04-12T09:02:13Z ERROR stage=validate ERR_SCHEMA_DRIFT_0x3F2: column settled_at type mismatch (text vs timestamp)", row: 17 })),
      functionCall("call_probe_fix", "write_file", { content: "ALTER TABLE settlements ALTER COLUMN settled_at TYPE TIMESTAMPTZ USING settled_at::timestamptz;", path: "/srv/etl/migrations/0042_settled_at.sql" }),
      functionOutput("call_probe_fix", "ok: file written, migration applied"),
      message("assistant", "Ошибку схемы исправил приведением settled_at к TIMESTAMPTZ, повторная валидация проходит.")
    ],
    probeId: "errorFix",
    region: "tool"
  },
  {
    at: PROBES[7]!.at,
    build: () => [
      message("user", "Что у нас осталось незакрытым?"),
      message("assistant", "Осталось одно: дозаполнить партицию 2026-W11 таблицы ledger_events_v2, когда поставщик подтвердит выгрузку. Остальные партиции готовы.")
    ],
    probeId: "pending",
    region: "assistant"
  }
];

export function itemText(item: InputItem): string {
  if (item.type === "message" && Array.isArray(item.content)) {
    return item.content.map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  }
  if (item.type === "function_call") return `${String(item.name ?? "")}${String(item.arguments ?? "")}`;
  if (item.type === "function_call_output") return typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
  return JSON.stringify(item);
}

/** Counts the tokens of one text. `chars4` is characters / 4; the CLI sizes
 * real runs with the o200k encoding (exact for the GPT family behind Codex
 * LB) by default, because tables of numbers and code make characters / 4
 * undercount this transcript by about 1.5x. */
export type TokenCounter = (text: string) => number;

export const chars4: TokenCounter = (text) => Math.ceil(text.length / 4);

/** The counter's tokens plus a small per-item overhead. */
export function estimateItemTokens(item: InputItem, count: TokenCounter = chars4): number {
  return count(itemText(item)) + ITEM_OVERHEAD_TOKENS;
}

export function estimateTokens(items: readonly InputItem[], count: TokenCounter = chars4): number {
  return items.reduce((sum, item) => sum + estimateItemTokens(item, count), 0);
}

export function buildTranscript(options: Readonly<{ count?: TokenCounter; seed: number; targetTokens: number }>): Transcript {
  const count = options.count ?? chars4;
  const estimate = (items: readonly InputItem[]) => estimateTokens(items, count);
  const rng = mulberry32(options.seed);
  let callSequence = 0;
  const nextCallId = () => `call_${String(++callSequence).padStart(5, "0")}`;
  const plants = PLANTS.map((plant) => ({ ...plant, items: plant.build(mulberry32(options.seed + Math.round(plant.at * 1000))) }));
  const plantTokens = plants.reduce((sum, plant) => sum + estimate(plant.items), 0);
  const goal = goalTurn();
  const fillers: InputItem[][] = [];
  let fillerTokens = estimate(goal);
  while (fillerTokens + plantTokens < options.targetTokens) {
    const turn = fillerTurn(rng, nextCallId);
    fillers.push(turn);
    fillerTokens += estimate(turn);
  }
  const total = fillerTokens + plantTokens;
  const items: InputItem[] = [...goal];
  const probes: PlantedProbe[] = [];
  let position = estimate(goal);
  let next = 0;
  const placeDue = () => {
    while (next < plants.length && position >= plants[next]!.at * total) {
      const plant = plants[next]!;
      if (plant.probeId) probes.push({ id: plant.probeId, position: position / total, region: plant.region });
      items.push(...plant.items);
      position += estimate(plant.items);
      next += 1;
    }
  };
  for (const turn of fillers) {
    placeDue();
    items.push(...turn);
    position += estimate(turn);
  }
  placeDue();
  if (next < plants.length) throw new Error("transcript_too_small_for_probes");
  return { count, estimatedTokens: total, items, probes };
}

/** Splits off the last ~`tailTokens` tokens, cutting only before a user or
 * assistant message so no function_call is separated from its output. */
export function splitTail(items: readonly InputItem[], tailTokens: number, count: TokenCounter = chars4): Readonly<{ head: InputItem[]; tail: InputItem[] }> {
  let index = items.length;
  let tokens = 0;
  while (index > 0 && tokens < tailTokens) {
    index -= 1;
    tokens += estimateItemTokens(items[index]!, count);
  }
  while (index > 0 && items[index]!.type !== "message") index -= 1;
  return { head: items.slice(0, index), tail: items.slice(index) };
}

export function trimHeadTail(text: string, maxChars = TOOL_TRIM_CHARS): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor(maxChars / 2);
  return `${text.slice(0, keep)}\n…[${text.length - keep * 2} characters omitted]…\n${text.slice(-keep)}`;
}

// ---------------------------------------------------------------------------
// Requests.

export const SESSION_INSTRUCTIONS = "You are a data engineering agent working in a long session with one user. Use the tools to inspect and change the pipelines, report numbers exactly as tools return them, and follow the user's constraints.";

export const TOOLS = [
  { name: "run_sql", parameters: { properties: { query: { type: "string" } }, required: ["query"], type: "object" } },
  { name: "read_file", parameters: { properties: { path: { type: "string" } }, required: ["path"], type: "object" } },
  { name: "write_file", parameters: { properties: { content: { type: "string" }, path: { type: "string" } }, required: ["path", "content"], type: "object" } },
  { name: "run_pipeline", parameters: { properties: { job_id: { type: "string" }, month: { type: "string" }, stage: { type: "string" } }, required: ["stage"], type: "object" } },
  { name: "search_logs", parameters: { properties: { query: { type: "string" }, since: { type: "string" } }, required: ["query"], type: "object" } }
].map((tool) => ({ ...tool, description: `Synthetic ${tool.name} tool.`, type: "function" }));

export const HANDOFF_SUMMARY_PROMPT = [
  "Context checkpoint. Stop the work and write a handoff summary for another agent that will resume this session without seeing any of the messages above.",
  "Write it in the language the user mostly writes in, as plain text (no JSON) with exactly these sections in this order:",
  "## Goal",
  "## User constraints, preferences and corrections — the latest version wins; name earlier, superseded values as superseded.",
  "## Done and key decisions — each decision with its reason.",
  "## Current state",
  "## Open items and next steps",
  "## Critical data — exact numbers, identifiers, file paths, URLs, error codes and messages and how each error was resolved. Copy values character for character; never round or paraphrase them.",
  "Be dense and concrete; stay well under 3,000 words. Do not call tools."
].join("\n");

export const SUMMARY_PREFIX = "Handoff summary of the earlier part of this session, written at a context checkpoint:\n\n";

export function recallFields(): Array<Readonly<{ expected: string; key: string; probeId: string; question: string }>> {
  return PROBES.flatMap((probe) => Object.entries(probe.fields).map(([key, field]) => ({ ...field, key, probeId: probe.id })));
}

export function recallQuestion(): InputItem {
  const keys = recallFields().map((field) => `- "${field.key}": ${field.question}`).join("\n");
  return message("user", [
    "Pause the work and answer a check question about this session, using only what the conversation above (including any summary) says.",
    "Reply with exactly one JSON object and nothing else — no prose, no code fence — with exactly these keys:",
    keys,
    "Use each value exactly as written in the session (same spelling, digits and case), as a string. Use null for a value you do not know."
  ].join("\n"));
}

type RequestOptions = Readonly<{ effort?: string; model: string }>;

function reasoning(effort: string | undefined): Record<string, unknown> {
  return effort && effort !== "default" ? { reasoning: { effort } } : {};
}

export function compactRequest(options: RequestOptions, input: readonly InputItem[]): Record<string, unknown> {
  return { input, instructions: SESSION_INSTRUCTIONS, model: options.model };
}

export function recallRequest(options: RequestOptions, prefix: readonly InputItem[], tail: readonly InputItem[]): Record<string, unknown> {
  return {
    input: [...prefix, ...tail, recallQuestion()],
    instructions: SESSION_INSTRUCTIONS,
    model: options.model,
    ...reasoning(options.effort),
    store: false,
    stream: true,
    tool_choice: "none",
    tools: TOOLS
  };
}

export function summaryInput(head: readonly InputItem[]): InputItem[] {
  return head.map((item) => {
    if (item.type === "function_call" && typeof item.arguments === "string") return { ...item, arguments: trimHeadTail(item.arguments) };
    if (item.type === "function_call_output" && typeof item.output === "string") return { ...item, output: trimHeadTail(item.output) };
    return item;
  });
}

export function summaryRequest(options: RequestOptions & Readonly<{ maxOutputTokens: number }>, head: readonly InputItem[]): Record<string, unknown> {
  return {
    input: [...summaryInput(head), message("user", HANDOFF_SUMMARY_PROMPT)],
    instructions: SESSION_INSTRUCTIONS,
    max_output_tokens: options.maxOutputTokens,
    model: options.model,
    ...reasoning(options.effort),
    store: false,
    stream: true,
    tool_choice: "none",
    tools: TOOLS
  };
}

export function inlineRequest(options: RequestOptions & Readonly<{ threshold: number }>, items: readonly InputItem[]): Record<string, unknown> {
  return {
    context_management: [{ compact_threshold: options.threshold, type: "compaction" }],
    input: [...items, recallQuestion()],
    instructions: SESSION_INSTRUCTIONS,
    model: options.model,
    ...reasoning(options.effort),
    store: false,
    stream: true,
    tool_choice: "none",
    tools: TOOLS
  };
}

export function triggerRequest(options: RequestOptions, head: readonly InputItem[]): Record<string, unknown> {
  return {
    input: [...head, { type: "compaction_trigger" }],
    instructions: SESSION_INSTRUCTIONS,
    model: options.model,
    store: false,
    stream: true,
    tool_choice: "none",
    tools: TOOLS
  };
}

// ---------------------------------------------------------------------------
// Scoring.

function normalizeAnswer(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  return value.trim().replace(/^[`"'«]+|[`"'».]+$/gu, "").replace(/\s+/gu, " ").toLowerCase();
}

export type RecallScore = Readonly<{
  parsed: boolean;
  probes: Readonly<Record<string, boolean>>;
  probesLoose: Readonly<Record<string, boolean>>;
  recalled: number;
  total: number;
}>;

export function parseAnswerObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function scoreRecall(text: string): RecallScore {
  const answer = parseAnswerObject(text);
  const probes: Record<string, boolean> = {};
  const probesLoose: Record<string, boolean> = {};
  for (const probe of PROBES) {
    const results = Object.entries(probe.fields).map(([key, field]) => {
      const got = normalizeAnswer(answer?.[key]);
      const expected = field.expected.toLowerCase();
      return { exact: got === expected, loose: got !== null && got.includes(expected) };
    });
    probes[probe.id] = results.every((result) => result.exact);
    probesLoose[probe.id] = results.every((result) => result.loose);
  }
  return { parsed: answer !== null, probes, probesLoose, recalled: Object.values(probes).filter(Boolean).length, total: PROBES.length };
}

// ---------------------------------------------------------------------------
// Transport: plain fetch with bounded bodies and progress-based deadlines.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CallDeps = Readonly<{
  apiKey: string;
  fetch: FetchLike;
  idleTimeoutMs: number;
  now: () => number;
  overallTimeoutMs: number;
  root: string;
}>;

export type Usage = Readonly<{ cachedInputTokens?: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; totalTokens?: number }>;

export type CallResult = {
  completedItems: InputItem[];
  errorCode?: string;
  firstByteMs?: number;
  firstCompactionMs?: number;
  firstTokenMs?: number;
  httpStatus?: number;
  incompleteReason?: string;
  itemKinds: Record<string, number>;
  status?: string;
  text: string;
  usage?: Usage;
  wallMs: number;
};

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/u;

function numberAt(value: unknown, ...path: string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

export function extractUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    cachedInputTokens: numberAt(usage, "input_tokens_details", "cached_tokens"),
    inputTokens: numberAt(usage, "input_tokens"),
    outputTokens: numberAt(usage, "output_tokens"),
    reasoningTokens: numberAt(usage, "output_tokens_details", "reasoning_tokens"),
    totalTokens: numberAt(usage, "total_tokens")
  };
}

/** A code-like identifier from an error payload, never its message. */
export function errorCodeOf(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : record;
  for (const candidate of [error.code, error.type, record.code]) {
    if (typeof candidate === "string" && ERROR_CODE.test(candidate)) return candidate;
  }
  return fallback;
}

function itemKind(item: InputItem): string {
  return item.type === "message" && typeof item.role === "string" ? `message:${item.role}` : String(item.type ?? "unknown");
}

export function countKinds(items: readonly InputItem[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const item of items) kinds[itemKind(item)] = (kinds[itemKind(item)] ?? 0) + 1;
  return kinds;
}

class Deadline {
  readonly controller = new AbortController();
  reason: string | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly overall: ReturnType<typeof setTimeout>;

  constructor(private readonly idleTimeoutMs: number | undefined, overallTimeoutMs: number) {
    this.overall = setTimeout(() => this.abort("overall_timeout"), overallTimeoutMs);
    this.touch();
  }

  touch(): void {
    if (this.idleTimeoutMs === undefined) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.abort("stream_idle_timeout"), this.idleTimeoutMs);
  }

  abort(reason: string): void {
    this.reason ??= reason;
    this.controller.abort();
  }

  clear(): void {
    clearTimeout(this.overall);
    if (this.idle) clearTimeout(this.idle);
  }
}

async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number, onChunk?: () => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function failureCode(error: unknown, deadline: Deadline): string {
  if (deadline.reason) return deadline.reason;
  // Only this script's own snake_case codes pass; transport messages do not.
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message)) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof cause === "string" && /^[A-Z0-9_]{1,64}$/u.test(cause) ? `network_${cause}` : "network_error";
}

async function send(deps: CallDeps, path: string, body: unknown, deadline: Deadline, accept: string): Promise<Response> {
  return deps.fetch(`${deps.root}${path}`, {
    body: JSON.stringify(body),
    headers: { accept, authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
    method: "POST",
    redirect: "error",
    signal: deadline.controller.signal
  });
}

async function httpFailure(response: Response, result: CallResult): Promise<void> {
  let payload: unknown = null;
  try {
    payload = response.body ? JSON.parse(await readBounded(response.body, MAX_ERROR_BODY_BYTES)) : null;
  } catch {
    payload = null;
  }
  result.errorCode = errorCodeOf(payload, `http_${response.status}`);
}

/** Non-streamed JSON POST (the compact endpoint): only the overall cap applies. */
export async function postJson(deps: CallDeps, path: string, body: unknown): Promise<CallResult & { json?: Record<string, unknown> }> {
  const started = deps.now();
  const deadline = new Deadline(undefined, deps.overallTimeoutMs);
  const result: CallResult & { json?: Record<string, unknown> } = { completedItems: [], itemKinds: {}, text: "", wallMs: 0 };
  try {
    const response = await send(deps, path, body, deadline, "application/json");
    result.httpStatus = response.status;
    if (!response.ok) {
      await httpFailure(response, result);
    } else if (!response.body) {
      result.errorCode = "response_body_missing";
    } else {
      const raw = await readBounded(response.body, MAX_RESPONSE_BYTES, () => { result.firstByteMs ??= deps.now() - started; });
      const json: unknown = JSON.parse(raw);
      if (!json || typeof json !== "object") throw new Error("response_not_object");
      result.json = json as Record<string, unknown>;
      const output = Array.isArray(result.json.output) ? result.json.output.filter((item): item is InputItem => !!item && typeof item === "object") : [];
      result.completedItems = output;
      result.itemKinds = countKinds(output);
      result.usage = extractUsage(result.json.usage);
      result.status = typeof result.json.status === "string" ? result.json.status : undefined;
      if (result.json.error) result.errorCode = errorCodeOf(result.json, "response_error");
    }
  } catch (error) {
    result.errorCode = error instanceof SyntaxError ? "response_not_json" : failureCode(error, deadline);
  } finally {
    deadline.clear();
    result.wallMs = deps.now() - started;
  }
  return result;
}

function* sseEvents(buffer: { text: string }): Generator<string> {
  for (;;) {
    const match = /\r?\n\r?\n/u.exec(buffer.text);
    if (!match) return;
    const chunk = buffer.text.slice(0, match.index);
    buffer.text = buffer.text.slice(match.index + match[0].length);
    const data = chunk.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
    if (data) yield data;
  }
}

/** Streamed Responses call: idle timeout resets on every byte, overall cap. */
export async function streamResponses(deps: CallDeps, body: unknown): Promise<CallResult> {
  const started = deps.now();
  const deadline = new Deadline(deps.idleTimeoutMs, deps.overallTimeoutMs);
  const result: CallResult = { completedItems: [], itemKinds: {}, text: "", wallMs: 0 };
  const doneItems: InputItem[] = [];
  let terminal = false;
  try {
    const response = await send(deps, "/v1/responses", body, deadline, "text/event-stream");
    result.httpStatus = response.status;
    deadline.touch();
    if (!response.ok) {
      await httpFailure(response, result);
      return result;
    }
    if (!response.body) {
      result.errorCode = "response_body_missing";
      return result;
    }
    const reader = response.body.getReader();
    // A deadline ends a pending read even where the body ignores the signal.
    deadline.controller.signal.addEventListener("abort", () => { void reader.cancel().catch(() => undefined); }, { once: true });
    const decoder = new TextDecoder();
    const buffer = { text: "" };
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (deadline.reason) throw new Error(deadline.reason);
      if (done) break;
      deadline.touch();
      result.firstByteMs ??= deps.now() - started;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      buffer.text += decoder.decode(value, { stream: true });
      for (const data of sseEvents(buffer)) {
        if (data === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          throw new Error("stream_event_not_json");
        }
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          result.firstTokenMs ??= deps.now() - started;
          if (result.text.length < MAX_STREAM_TEXT_CHARS) result.text += event.delta;
        } else if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as InputItem;
          if (item.type === "compaction") result.firstCompactionMs ??= deps.now() - started;
          doneItems.push(item);
        } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
          terminal = true;
          const final = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : {};
          result.status = typeof final.status === "string" ? final.status : type.slice("response.".length);
          result.usage = extractUsage(final.usage);
          const details = final.incomplete_details as Record<string, unknown> | undefined;
          if (details && typeof details.reason === "string" && ERROR_CODE.test(details.reason)) result.incompleteReason = details.reason;
          if (type === "response.failed") result.errorCode = errorCodeOf(final, "response_failed");
          const finalOutput = Array.isArray(final.output) ? final.output.filter((item): item is InputItem => !!item && typeof item === "object") : [];
          result.completedItems = finalOutput.length > 0 ? finalOutput : doneItems;
        } else if (type === "error") {
          result.errorCode = errorCodeOf(event, "stream_error");
        }
      }
    }
    if (!terminal) {
      result.completedItems = doneItems;
      result.errorCode ??= "stream_ended_without_terminal";
    }
  } catch (error) {
    result.completedItems = doneItems;
    result.errorCode = failureCode(error, deadline);
  } finally {
    deadline.clear();
    result.wallMs = deps.now() - started;
    result.itemKinds = countKinds(result.completedItems);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Paths. Every record is content-free.

export type RunConfig = Readonly<{
  effort?: string;
  inlineThreshold: number;
  model: string;
  nativeInput: "full" | "head";
  summaryEffort?: string;
  summaryMaxOutputTokens: number;
  tailTokens: number;
}>;

function callRecord(result: CallResult, estimatedInputTokens: number): Record<string, unknown> {
  return {
    errorCode: result.errorCode ?? null,
    estimatedInputTokens,
    firstByteMs: result.firstByteMs ?? null,
    firstTokenMs: result.firstTokenMs ?? null,
    httpStatus: result.httpStatus ?? null,
    incompleteReason: result.incompleteReason ?? null,
    itemKinds: result.itemKinds,
    status: result.status ?? null,
    usage: result.usage ?? null,
    wallMs: result.wallMs
  };
}

function compactedRecord(items: readonly InputItem[]): Record<string, unknown> {
  const compaction = items.filter((item) => item.type === "compaction");
  return {
    compactedBytes: JSON.stringify(items).length,
    compactedItemCount: items.length,
    compactionItemCount: compaction.length,
    encryptedContentChars: compaction.reduce((sum, item) => sum + (typeof item.encrypted_content === "string" ? item.encrypted_content.length : 0), 0)
  };
}

function completed(result: CallResult): boolean {
  return !result.errorCode && result.status === "completed";
}

async function recall(
  deps: CallDeps,
  config: RunConfig,
  transcript: Transcript,
  prefix: readonly InputItem[],
  tail: readonly InputItem[]
): Promise<Record<string, unknown>> {
  const request = recallRequest({ effort: config.effort, model: config.model }, prefix, tail);
  const result = await streamResponses(deps, request);
  return {
    ...callRecord(result, estimateTokens(request.input as InputItem[], transcript.count)),
    completed: completed(result),
    ...scoreRecall(completed(result) ? result.text : "")
  };
}

export async function runNative(deps: CallDeps, config: RunConfig, transcript: Transcript): Promise<Record<string, unknown>> {
  const { head, tail } = splitTail(transcript.items, config.tailTokens, transcript.count);
  const compactInput = config.nativeInput === "full" ? transcript.items : head;
  const compact = await postJson(deps, "/v1/responses/compact", compactRequest({ model: config.model }, compactInput));
  const compaction = { ...callRecord(compact, estimateTokens(compactInput, transcript.count)), ...compactedRecord(compact.completedItems) };
  const usable = !compact.errorCode && compact.completedItems.some((item) => item.type === "compaction");
  if (!usable) return { compaction: { ...compaction, errorCode: compact.errorCode ?? "no_compaction_item" }, ok: false };
  const recallRecord = await recall(deps, config, transcript, compact.completedItems, config.nativeInput === "full" ? [] : tail);
  return { compaction, ok: recallRecord.completed === true, recall: recallRecord, transcriptTokensReported: compact.usage?.inputTokens ?? null };
}

export async function runSummary(deps: CallDeps, config: RunConfig, transcript: Transcript): Promise<Record<string, unknown>> {
  const { head, tail } = splitTail(transcript.items, config.tailTokens, transcript.count);
  const request = summaryRequest({ effort: config.summaryEffort, maxOutputTokens: config.summaryMaxOutputTokens, model: config.model }, head);
  const result = await streamResponses(deps, request);
  const summary = {
    ...callRecord(result, estimateTokens(request.input as InputItem[], transcript.count)),
    summaryChars: result.text.length,
    summaryEstimatedTokens: transcript.count(result.text)
  };
  // An incomplete summary (max_output_tokens) is still measured for recall.
  const usable = !result.errorCode && (result.status === "completed" || result.status === "incomplete") && result.text.trim().length > 0;
  if (!usable) return { ok: false, summary: { ...summary, errorCode: result.errorCode ?? "summary_empty" } };
  const recallRecord = await recall(deps, config, transcript, [message("user", `${SUMMARY_PREFIX}${result.text}`)], tail);
  return { ok: result.status === "completed" && recallRecord.completed === true, recall: recallRecord, summary };
}

export async function runInline(deps: CallDeps, config: RunConfig, transcript: Transcript): Promise<Record<string, unknown>> {
  const request = inlineRequest({ effort: config.effort, model: config.model, threshold: config.inlineThreshold }, transcript.items);
  const result = await streamResponses(deps, request);
  const compacted = (result.itemKinds.compaction ?? 0) > 0;
  const call = {
    ...callRecord(result, estimateTokens(request.input as InputItem[], transcript.count)),
    ...compactedRecord(result.completedItems),
    compactionAtMs: result.firstCompactionMs ?? null,
    threshold: config.inlineThreshold
  };
  const ok = completed(result) && compacted;
  return {
    inline: { ...call, errorCode: result.errorCode ?? (compacted ? null : "no_compaction_item") },
    ok,
    recall: scoreRecall(completed(result) ? result.text : "")
  };
}

export async function runTrigger(deps: CallDeps, config: RunConfig, transcript: Transcript): Promise<Record<string, unknown>> {
  const { head, tail } = splitTail(transcript.items, config.tailTokens, transcript.count);
  const result = await streamResponses(deps, triggerRequest({ model: config.model }, head));
  const compaction = {
    ...callRecord(result, estimateTokens(head, transcript.count)),
    ...compactedRecord(result.completedItems),
    compactionAtMs: result.firstCompactionMs ?? null
  };
  const usable = !result.errorCode && result.completedItems.some((item) => item.type === "compaction");
  if (!usable) return { compaction: { ...compaction, errorCode: result.errorCode ?? "no_compaction_item" }, ok: false };
  // Reasoning items of a store:false response carry no replayable state.
  const replay = result.completedItems.filter((item) => item.type !== "reasoning");
  const recallRecord = await recall(deps, config, transcript, replay, tail);
  return { compaction, ok: recallRecord.completed === true, recall: recallRecord };
}

const RUNNERS: Readonly<Record<PathName, typeof runNative>> = { inline: runInline, native: runNative, summary: runSummary, trigger: runTrigger };

export async function runPath(path: PathName, deps: CallDeps, config: RunConfig, transcript: Transcript): Promise<Record<string, unknown>> {
  return RUNNERS[path](deps, config, transcript);
}

// ---------------------------------------------------------------------------
// CLI.

export type CliOptions = RunConfig & Readonly<{
  dryRun: boolean;
  estimator: "chars4" | "o200k";
  idleTimeoutMs: number;
  out?: string;
  overallTimeoutMs: number;
  paths: readonly PathName[];
  repeat: number;
  root: string;
  seed: number;
  tokens: number;
  verbose: boolean;
}>;

const PATH_NAMES: readonly PathName[] = ["native", "summary", "inline", "trigger"];
const EFFORT = /^(?:default|none|minimal|low|medium|high|xhigh)$/u;

function positiveInteger(flag: string, value: string | undefined, min = 1): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed < min) throw new Error(`invalid_${flag}`);
  return parsed;
}

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): CliOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run" || arg === "--verbose") {
      switches.add(arg.slice(2));
      continue;
    }
    if (!arg.startsWith("--") || index + 1 >= argv.length) throw new Error(`invalid_argument:${arg.replace(/[^a-z-]/gu, "")}`);
    values.set(arg.slice(2), argv[index + 1]!);
    index += 1;
  }
  const known = new Set(["model", "tokens", "paths", "repeat", "root", "out", "seed", "tail-tokens", "native-input", "inline-threshold", "effort", "summary-effort", "summary-max-output", "idle-timeout-ms", "overall-timeout-ms", "estimator"]);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`unknown_flag:${key.replace(/[^a-z-]/gu, "")}`);
  const tokens = positiveInteger("tokens", values.get("tokens") ?? String(DEFAULT_TOKENS), 1_000);
  const paths = (values.get("paths") ?? "native,summary").split(",").map((path) => path.trim());
  for (const path of paths) if (!PATH_NAMES.includes(path as PathName)) throw new Error("invalid_paths");
  const root = (values.get("root") ?? env.CODEX_LB_ROOT ?? DEFAULT_ROOT).replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+(?:\/[^?#]*)?$/u.test(root) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(root)) throw new Error("invalid_root");
  if (/\/v1$/u.test(root)) throw new Error("root_must_not_include_v1");
  const nativeInput = values.get("native-input") ?? "head";
  if (nativeInput !== "head" && nativeInput !== "full") throw new Error("invalid_native_input");
  const effort = values.get("effort");
  const summaryEffort = values.get("summary-effort") ?? "low";
  for (const value of [effort, summaryEffort]) if (value !== undefined && !EFFORT.test(value)) throw new Error("invalid_effort");
  const model = values.get("model") ?? DEFAULT_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) throw new Error("invalid_model");
  const estimator = values.get("estimator") ?? "o200k";
  if (estimator !== "o200k" && estimator !== "chars4") throw new Error("invalid_estimator");
  return {
    dryRun: switches.has("dry-run"),
    effort,
    estimator,
    idleTimeoutMs: positiveInteger("idle_timeout_ms", values.get("idle-timeout-ms") ?? "120000"),
    inlineThreshold: positiveInteger("inline_threshold", values.get("inline-threshold") ?? String(Math.floor(tokens / 2))),
    model,
    nativeInput,
    out: values.get("out"),
    overallTimeoutMs: positiveInteger("overall_timeout_ms", values.get("overall-timeout-ms") ?? "600000"),
    paths: [...new Set(paths as PathName[])],
    repeat: positiveInteger("repeat", values.get("repeat") ?? "1"),
    root,
    seed: positiveInteger("seed", values.get("seed") ?? "1", 0),
    summaryEffort,
    summaryMaxOutputTokens: positiveInteger("summary_max_output", values.get("summary-max-output") ?? String(SUMMARY_MAX_OUTPUT_TOKENS)),
    tailTokens: positiveInteger("tail_tokens", values.get("tail-tokens") ?? String(DEFAULT_TAIL_TOKENS)),
    tokens,
    verbose: switches.has("verbose")
  };
}

export function transcriptRecord(
  transcript: Transcript,
  options: Pick<CliOptions, "estimator" | "seed" | "tailTokens" | "tokens">,
  o200kTokens: number | null
): Record<string, unknown> {
  const { head, tail } = splitTail(transcript.items, options.tailTokens, transcript.count);
  return {
    chars4Tokens: estimateTokens(transcript.items, chars4),
    estimatedTokens: transcript.estimatedTokens,
    estimator: options.estimator,
    event: "transcript",
    headEstimatedTokens: estimateTokens(head, transcript.count),
    headItems: head.length,
    itemKinds: countKinds(transcript.items),
    items: transcript.items.length,
    o200kTokens,
    probes: transcript.probes.map((probe) => ({ ...probe, position: Number(probe.position.toFixed(4)) })),
    seed: options.seed,
    serializedChars: JSON.stringify(transcript.items).length,
    tailEstimatedTokens: estimateTokens(tail, transcript.count),
    tailItems: tail.length,
    targetTokens: options.tokens
  };
}

async function loadO200k(): Promise<TokenCounter | null> {
  try {
    const { countTokens } = await import("gpt-tokenizer/encoding/o200k_base");
    return (text) => countTokens(text);
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ code: error instanceof Error ? error.message : "invalid_arguments", event: "error" })}\n`);
    return 2;
  }
  const emit = (line: Record<string, unknown>) => {
    const text = `${JSON.stringify(line)}\n`;
    process.stdout.write(text);
    if (options.out) appendFileSync(options.out, text);
  };
  if (options.out) writeFileSync(options.out, "");
  const apiKey = process.env.CODEX_LB_API_KEY?.trim();
  if (!options.dryRun && !apiKey) {
    emit({ code: "missing_api_key", event: "error" });
    return 2;
  }
  const o200k = await loadO200k();
  if (options.estimator === "o200k" && !o200k) {
    emit({ code: "o200k_unavailable", event: "error" });
    return 2;
  }
  const transcript = buildTranscript({ count: options.estimator === "o200k" ? o200k! : chars4, seed: options.seed, targetTokens: options.tokens });
  emit(transcriptRecord(transcript, options, o200k ? estimateTokens(transcript.items, o200k) : null));
  if (options.dryRun) return 0;
  const deps: CallDeps = {
    apiKey: apiKey!,
    fetch: (url, init) => fetch(url, init),
    idleTimeoutMs: options.idleTimeoutMs,
    now: () => performance.now(),
    overallTimeoutMs: options.overallTimeoutMs,
    root: options.root
  };
  for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
    for (const path of options.paths) {
      if (options.verbose) process.stderr.write(`compaction-scale: ${path} repeat ${repeat} started\n`);
      const startedAt = new Date().toISOString();
      const record = await runPath(path, deps, options, transcript);
      emit({ event: "result", model: options.model, path, repeat, startedAt, ...(path === "native" ? { nativeInput: options.nativeInput } : {}), ...record });
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, () => {
    process.stdout.write(`${JSON.stringify({ code: "unexpected_failure", event: "error" })}\n`);
    process.exitCode = 1;
  });
}
