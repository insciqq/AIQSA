import { createHash } from "node:crypto";
import type { CompactionToolClassifier } from "../../lib/server/engine/compaction";
import { defaultCompactionToolKind } from "../../lib/server/engine/compaction";
import { APPROVAL_PENDING_TEXT } from "../../lib/server/engine/compaction/items";
import { TOOL_RESULT_LIMITS, toolOutputExcerpt } from "../../lib/server/engine/toolResults";
import type { TranscriptItem } from "../../lib/server/engine/transcript";
import { namespacedMcpToolName } from "../../lib/server/mcp/runPlan";
import { namespacedWorkspaceToolName } from "../../lib/server/workspace/toolCatalog";
import { mulberry32 } from "../spikes/compaction-scale";

/**
 * Synthetic working sessions for the compaction quality evaluation
 * (`compaction-quality.ts`): deterministic transcripts in the engine's
 * `TranscriptItem` form, Russian and English, with planted probes (an early
 * constraint, a later correction, exact numbers from tool output, paths and
 * identifiers, a decision with its reason, an error and its fix, finished
 * versus remaining work, and a call waiting for approval at the end), plus
 * the continuation each one checks. Tool results are stored the way the
 * engine stores them (`lib/server/engine/toolResults.ts`): a result longer
 * than the engine shows inline is saved whole with a handle and appears as
 * head and tail; with `handles: "all"` every result is saved with a handle,
 * the alternative where any earlier result can be read again. A call that
 * waits for approval carries the engine's placeholder result.
 */

type Rng = () => number;

export const SCENARIO_IDS = ["coding", "analysis", "research", "requirements", "sequential", "switch"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export type EvalTool = Readonly<{ description: string; name: string; parameters: Readonly<Record<string, unknown>> }>;

/** `constraint`, `correction` and `pending` target 100 %; `fact` targets 90 %. */
export type ProbeCategory = "constraint" | "correction" | "fact" | "pending";

export type ProbeField = Readonly<{
  /** Other spellings that count as exact (formatting only). */
  accept?: readonly string[];
  expected: string;
  key: string;
  question: string;
  /** Earlier values the answer must not give. */
  superseded?: readonly string[];
}>;

export type Probe = Readonly<{ category: ProbeCategory; fields: readonly ProbeField[]; id: string; phase: number }>;

/** A continuation expectation over the agent's tool calls (name and JSON arguments) and final text. */
export type ContinuationCheck = Readonly<{
  id: string;
  /** `next`: some call (or the text) shows the expected next step. `forbidden`: nothing may match. */
  kind: "forbidden" | "next";
  pattern: RegExp;
  /** Calls to tools whose name matches; absent: calls and the final text. */
  tool?: RegExp;
}>;

export type Continuation = Readonly<{
  checks: readonly ContinuationCheck[];
  prompt: string;
  /** Calls that would redo finished work. */
  repeated: readonly Readonly<{ id: string; pattern: RegExp; tool: RegExp }>[];
}>;

/** Which results are saved with a handle: the engine's long results only, or all of them. */
export type HandlePolicy = "all" | "large";

export type BuiltScenario = Readonly<{
  /** callId → the handle `read_tool_result` reads it by. */
  handles: ReadonlyMap<string, string>;
  items: readonly TranscriptItem[];
  nextId: () => string;
  /** Item counts at the end of each phase (one phase except `sequential`). */
  phaseEnds: readonly number[];
  /** Where each probe was planted, as a share of the transcript's tokens. */
  planted: readonly Readonly<{ id: string; position: number }>[];
  /** handle → the full result. */
  store: ReadonlyMap<string, string>;
}>;

export type EvalScenario = Readonly<{
  build(options: Readonly<{
    handles?: HandlePolicy; seed: number; targetTokens: number; weigh: (item: TranscriptItem) => number;
  }>): BuiltScenario;
  classify: CompactionToolClassifier;
  continuation: Continuation;
  id: ScenarioId;
  instructions: string;
  language: "en" | "mixed" | "ru";
  probes: readonly Probe[];
  tools: readonly EvalTool[];
}>;

// ------------------------------------------------------------------ builder

export function evalHandle(scenario: string, callId: string): string {
  return `tor1_${createHash("sha256").update(`${scenario}:${callId}`).digest("hex").slice(0, 32)}`;
}

export class EvalTranscript {
  readonly handles = new Map<string, string>();
  readonly items: TranscriptItem[] = [];
  readonly store = new Map<string, string>();
  tokens = 0;
  private calls = 0;
  private next = 0;

  constructor(private readonly scenario: string, private readonly weigh: (item: TranscriptItem) => number,
    private readonly policy: HandlePolicy = "large") {}

  readonly nextId = (): string => `t${++this.next}`;

  private push(item: TranscriptItem): void {
    this.items.push(item);
    this.tokens += this.weigh(item);
  }

  user(text: string, followup = false): void {
    this.push({ ...(followup ? { followup: true as const } : {}), id: this.nextId(), kind: "user", text });
  }

  answer(text: string): void {
    this.push({ id: this.nextId(), kind: "assistant_text", text });
  }

  call(name: string, args: Readonly<Record<string, unknown>>): string {
    const callId = `call_${this.scenario}_${++this.calls}`;
    this.push({ arguments: JSON.stringify(args), callId, id: this.nextId(), kind: "tool_call", name });
    return callId;
  }

  result(callId: string, name: string, output: string, outcome: "complete" | "error" | "unknown" = "complete"): void {
    const saved = this.policy === "all" || output.length > TOOL_RESULT_LIMITS.inlineChars;
    const handle = saved ? evalHandle(this.scenario, callId) : null;
    if (handle) {
      this.handles.set(callId, handle);
      this.store.set(handle, output);
    }
    this.push({ callId, ...(handle ? { handle } : {}), id: this.nextId(), kind: "tool_result", name, outcome,
      output: toolOutputExcerpt(output, handle ? { handle } : null).output });
  }

  /** A call that waits for the user's approval, as the engine records it. */
  awaitingApproval(name: string, args: Readonly<Record<string, unknown>>): void {
    this.result(this.call(name, args), name, APPROVAL_PENDING_TEXT, "error");
  }

  tool(name: string, args: Readonly<Record<string, unknown>>, output: string, outcome: "complete" | "error" | "unknown" = "complete"): void {
    this.result(this.call(name, args), name, output, outcome);
  }
}

type State = Record<string, string>;
type Plant = Readonly<{ at: number; build: (t: EvalTranscript, rng: Rng, state: State) => void; probe?: string | readonly string[] }>;

type ScenarioSpec = Omit<EvalScenario, "build"> & Readonly<{
  closing: (t: EvalTranscript, state: State) => void;
  filler: (t: EvalTranscript, rng: Rng, state: State, phase: number) => void;
  initialState: State;
  opening: (t: EvalTranscript, state: State) => void;
  /** Shares of the target where phases end (the last is 1). */
  phases?: readonly number[];
  plants: readonly Plant[];
}>;

function scenario(spec: ScenarioSpec): EvalScenario {
  const { closing, filler, initialState, opening, phases, plants, ...rest } = spec;
  return {
    ...rest,
    build({ handles = "large", seed, targetTokens, weigh }) {
      const transcript = new EvalTranscript(spec.id, weigh, handles);
      const state: State = { ...initialState };
      const rng = mulberry32(seed);
      const ends = phases ?? [1];
      const phaseEnds: number[] = [];
      const planted: { id: string; position: number }[] = [];
      let plant = 0;
      let phase = 0;
      const place = (entry: Plant) => {
        for (const id of typeof entry.probe === "string" ? [entry.probe] : entry.probe ?? []) {
          planted.push({ id, position: transcript.tokens / Math.max(1, targetTokens) });
        }
        entry.build(transcript, mulberry32(seed * 1_009 + Math.round(entry.at * 10_000)), state);
      };
      opening(transcript, state);
      for (;;) {
        while (plant < plants.length && transcript.tokens >= plants[plant]!.at * targetTokens) place(plants[plant++]!);
        if (phase < ends.length - 1 && transcript.tokens >= ends[phase]! * targetTokens) {
          phaseEnds.push(transcript.items.length);
          phase += 1;
          continue;
        }
        if (transcript.tokens >= targetTokens) break;
        filler(transcript, rng, state, phase);
      }
      while (plant < plants.length) place(plants[plant++]!);
      closing(transcript, state);
      phaseEnds.push(transcript.items.length);
      return { handles: transcript.handles, items: transcript.items, nextId: transcript.nextId, phaseEnds, planted, store: transcript.store };
    }
  };
}

// --------------------------------------------------------------- generators

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function money(rng: Rng): string {
  return (rng() * 90_000 - 5_000).toFixed(2);
}

function fill(template: string, rng: Rng, slots: Readonly<Record<string, (rng: Rng) => string>>): string {
  return template.replace(/\{(\w+)\}/gu, (match, slot: string) => slots[slot]?.(rng) ?? match);
}

const STAGES = ["extract", "normalize", "join", "aggregate", "validate", "export", "publish"];
const REGIONS = ["north", "south", "ural", "volga", "siberia", "far-east", "central"];

function warehouse(rng: Rng): string {
  return `W-${int(rng, 200, 999)}`;
}

function jobId(rng: Rng): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let index = 0; index < 4; index += 1) suffix += pick(rng, [...alphabet]);
  return `JOB-${suffix}-${int(rng, 3000, 9999)}`;
}

function codeFile(rng: Rng, lines: number, module: string): string {
  const out = ["import polars as pl", "from dataclasses import dataclass", "", `def ${module}(frame: pl.DataFrame) -> pl.DataFrame:`];
  for (let line = 0; line < lines; line += 1) {
    const column = pick(rng, ["amount", "units", "fx_rate", "net", "gross", "settled_at", "invoice_id", "line_no"]);
    const operation = pick(rng, ["round(2)", "fill_null(0)", "cast(pl.Float64)", "abs()", "str.strip_chars()", "is_not_null()"]);
    out.push(`    frame = frame.with_columns(pl.col("${column}").${operation}.alias("c${int(rng, 0, 999)}"))  # ${pick(rng, STAGES)}`);
  }
  out.push("    return frame");
  return out.join("\n");
}

function pytestOutput(rng: Rng, passed: number, seconds: string, extra: readonly string[] = []): string {
  const lines = ["============================= test session starts ==============================",
    "platform linux -- Python 3.11.9, pytest-8.3.2, pluggy-1.5.0", "rootdir: /workspace/project", "collected tests"];
  for (let index = 0; index < int(rng, 8, 30); index += 1) {
    lines.push(`tests/test_${pick(rng, STAGES)}_${int(rng, 1, 40)}.py ${".".repeat(int(rng, 3, 30))}${" ".repeat(4)}[${int(rng, 1, 99)}%]`);
  }
  lines.push(...extra, `============================== ${passed} passed in ${seconds}s ==============================`);
  return lines.join("\n");
}

function shell(stdout: string, exitCode = 0): string {
  return JSON.stringify({ exit_code: exitCode, stderr: "", stdout });
}

function marginTable(rng: Rng, rows: number, planted?: Readonly<{ line: string; row: number }>): string {
  const lines = ["| warehouse | region | gross | net_margin | units | share |", "|---|---|---|---|---|---|"];
  for (let row = 0; row < rows; row += 1) {
    if (planted && row === planted.row) lines.push(planted.line);
    lines.push(`| ${warehouse(rng)} | ${pick(rng, REGIONS)} | ${money(rng)} | ${money(rng)} | ${int(rng, 10, 99_999)} | ${(rng() * 100).toFixed(3)} |`);
  }
  return lines.join("\n");
}

function logLines(rng: Rng, lines: number, planted?: Readonly<{ line: string; row: number }>): string {
  const out: string[] = [];
  for (let row = 0; row < lines; row += 1) {
    if (planted && row === planted.row) out.push(planted.line);
    const day = String(int(rng, 1, 28)).padStart(2, "0");
    const time = [int(rng, 0, 23), int(rng, 0, 59), int(rng, 0, 59)].map((value) => String(value).padStart(2, "0")).join(":");
    out.push(`2026-04-${day}T${time}Z ${pick(rng, ["INFO", "INFO", "INFO", "WARN"])} job=${jobId(rng)} stage=${pick(rng, STAGES)} ` +
      `rows=${int(rng, 0, 500_000)} elapsed_ms=${int(rng, 5, 90_000)}`);
  }
  return out.join("\n");
}

function prose(rng: Rng, templates: readonly string[], sentences: number, slots: Readonly<Record<string, (rng: Rng) => string>>): string {
  return Array.from({ length: sentences }, () => fill(pick(rng, templates), rng, slots)).join(" ");
}

function classifyBy(kinds: Readonly<Record<string, ReturnType<CompactionToolClassifier>>>): CompactionToolClassifier {
  return (call) => kinds[call.name] ?? defaultCompactionToolKind(call);
}

function tool(name: string, description: string, properties: Readonly<Record<string, unknown>>, required: readonly string[]): EvalTool {
  return { description, name, parameters: { additionalProperties: false, properties, required, type: "object" } };
}

const STRING = { type: "string" };

// ------------------------------------------------- coding (and the switch)

const WS_READ = namespacedWorkspaceToolName("sandbox_fs_read");
const WS_WRITE = namespacedWorkspaceToolName("sandbox_fs_write");
const WS_SHELL = namespacedWorkspaceToolName("sandbox_shell");
const JIRA_TRANSITION = namespacedMcpToolName("jira", "transition_issue");

type CodingValues = Readonly<{
  benchCommand: string; ciImage: string; commit: string; importError: string; importModule: string; issue: string;
  mergePath: string; newTest: string; oldTest: string; oomGb: string; p95: string; package: string; python: string;
  rejected: string; remainingFile: string; strategy: string;
}>;

const CODING_VALUES: CodingValues = {
  benchCommand: "python bench/merge_bench.py --rows 12000", ciImage: "python:3.11-slim", commit: "7f3c9e1",
  importError: "StrEnum", importModule: "enum", issue: "ETL-482", mergePath: "/workspace/project/etl/reconcile/stage_04_merge.py",
  newTest: "pytest -q --maxfail=3", oldTest: "pytest -x", oomGb: "14", p95: "187.4", package: "etl/reconcile", python: "3.11",
  rejected: "hash_dedup", remainingFile: "stage_06_publish.py", strategy: "window_dedup"
};

const SWITCH_VALUES: CodingValues = {
  benchCommand: "python bench/join_bench.py --rows 50000", ciImage: "python:3.12-slim", commit: "c41d0a8",
  importError: "TaskGroup", importModule: "asyncio", issue: "BILL-219", mergePath: "/workspace/project/billing/ingest/step_03_join.py",
  newTest: "pytest -q -n 4", oldTest: "pytest --lf", oomGb: "22", p95: "243.9", package: "billing/ingest", python: "3.12",
  rejected: "broadcast_join", remainingFile: "step_05_export.py", strategy: "sorted_merge"
};

const CODING_USER = [
  "Show me what {module} does before we touch it.",
  "Refactor {function} in {module} so it no longer copies the whole frame.",
  "Where else is {function} used? I want to know what breaks if we rename it.",
  "Run the linter on {module} and fix what it finds.",
  "The {stage} stage got slower after yesterday's change; check why.",
  "Add type hints to {module} and keep the behaviour identical."
];
const CODING_ANSWER = [
  "{module} reads the {stage} frame, normalizes {column} and hands it to the next stage; nothing else depends on its internals.",
  "Done: {function} now works on a lazy frame and the {stage} tests still pass.",
  "{function} is used in {count} places, all inside the {stage} stage, so the rename is safe.",
  "The linter found {count} issues in {module}; I fixed them without changing behaviour.",
  "The slowdown came from an eager collect in {function}; removing it brings the {stage} stage back to {seconds} s."
];

function codingScenario(id: "coding" | "switch", values: CodingValues): EvalScenario {
  const modules = (rng: Rng) => `${values.package}/stage_0${int(rng, 1, 5)}_${pick(rng, STAGES)}.py`;
  const slots = {
    column: (rng: Rng) => pick(rng, ["amount", "units", "fx_rate", "settled_at", "invoice_id"]),
    count: (rng: Rng) => String(int(rng, 2, 19)),
    function: (rng: Rng) => pick(rng, ["normalize_amounts", "join_ledgers", "drop_duplicates", "cast_types", "apply_fx", "split_batches"]),
    module: modules,
    seconds: (rng: Rng) => (rng() * 40 + 3).toFixed(1),
    stage: (rng: Rng) => pick(rng, STAGES)
  };
  return scenario({
    classify: classifyBy({ [JIRA_TRANSITION]: "external_write" }),
    closing(t) {
      t.user(`Move ${values.issue} to In Review in Jira.`);
      t.awaitingApproval(JIRA_TRANSITION, { issue: values.issue, status: "In Review" });
    },
    continuation: {
      checks: [
        { id: "remainingFile", kind: "next", pattern: new RegExp(values.remainingFile.replace(/\./gu, "\\."), "u") },
        { id: "supersededTestCommand", kind: "forbidden", pattern: new RegExp(`\\b${values.oldTest.replace(/ /gu, "\\s+")}(?![\\w-])`, "u"),
          tool: /sandbox_shell/u },
        { id: "noNewDependencies", kind: "forbidden", pattern: /\b(?:pip3? install|poetry add|uv add|uv pip install)\b/u, tool: /sandbox_shell/u }
      ],
      prompt: `While the ${values.issue} transition waits for my approval, continue with the remaining refactoring work.`,
      repeated: [
        { id: "rewriteFinishedStage", pattern: new RegExp(values.mergePath.replace(/[./]/gu, "\\$&"), "u"), tool: /sandbox_fs_write/u },
        { id: "rerunBenchmark", pattern: new RegExp(values.benchCommand.split(" ")[1]!.replace(/[./]/gu, "\\$&"), "u"), tool: /sandbox_shell/u }
      ]
    },
    filler(t, rng, state) {
      const file = modules(rng);
      t.user(prose(rng, CODING_USER, int(rng, 1, 2), slots));
      switch (int(rng, 0, 3)) {
        case 0:
          t.tool(WS_READ, { path: `/workspace/project/${file}` }, codeFile(rng, rng() < 0.12 ? int(rng, 300, 420) : int(rng, 40, 140),
            pick(rng, ["run", "transform", "stage"])));
          break;
        case 1:
          t.tool(WS_READ, { path: `/workspace/project/${file}` }, codeFile(rng, int(rng, 30, 90), "run"));
          t.tool(WS_WRITE, { content: codeFile(rng, int(rng, 20, 60), "run"), path: `/workspace/project/${file}` }, "{\"ok\":true}");
          t.tool(WS_SHELL, { command: state.testCommand! }, shell(pytestOutput(rng, int(rng, 40, 400), (rng() * 60 + 5).toFixed(2))));
          break;
        case 2:
          t.tool(WS_SHELL, { command: `grep -rn "${slots.function(rng)}" ${values.package}/` },
            shell(Array.from({ length: int(rng, 3, 25) }, () => `${modules(rng)}:${int(rng, 10, 300)}:    frame = ${slots.function(rng)}(frame)`).join("\n")));
          break;
        default:
          t.tool(WS_SHELL, { command: `ruff check ${file}` },
            shell(Array.from({ length: int(rng, 1, 12) }, () => `${file}:${int(rng, 1, 200)}:${int(rng, 1, 80)}: E${int(rng, 100, 999)} line too long`).join("\n"), 1));
          break;
      }
      t.answer(prose(rng, CODING_ANSWER, int(rng, 2, 4), slots));
    },
    id,
    initialState: { testCommand: values.oldTest },
    instructions: "You are a coding agent working in the user's Workspace, a Linux VM with the project in /workspace/project. Use the " +
      "tools to read, change and test the code, follow the user's constraints exactly and report results as the tools return them.",
    language: "en",
    opening(t) {
      t.user(`We are refactoring the ${values.package} package stage by stage: stages 01 to 06. Keep me posted after each stage.`);
      t.answer(`Understood. I will go through the ${values.package} stages in order and report after each one.`);
    },
    plants: [
      { at: 0.02, build(t) {
        t.user(`Ground rules for this refactor: target Python ${values.python} only, and do not add any new third-party dependency — ` +
          "the standard library plus polars is all we have.");
        t.answer(`Agreed: Python ${values.python} only and no new dependencies.`);
      }, probe: "constraint" },
      { at: 0.10, build(t) {
        t.user(`Run the test suite with \`${values.oldTest}\` after each change.`);
        t.answer("Will do.");
      } },
      { at: 0.30, build(t, _rng, state) {
        t.user(`Correction on testing: not \`${values.oldTest}\` — from now on run the suite as \`${values.newTest}\`.`);
        t.answer(`Switched to \`${values.newTest}\`.`);
        state.testCommand = values.newTest;
      }, probe: "correction" },
      { at: 0.38, build(t, rng) {
        t.user("Benchmark the merge stage on the March sample.");
        const rows = Array.from({ length: 40 }, (_, index) => `run ${String(index + 1).padStart(2, "0")}: ${(rng() * 300 + 20).toFixed(1)} ms`);
        t.tool(WS_SHELL, { command: values.benchCommand }, shell([...rows.slice(0, 22), "percentiles over 12000 rows:",
          `p50 ${(rng() * 40 + 40).toFixed(1)} ms`, `p90 ${(rng() * 40 + 120).toFixed(1)} ms`, `p95 ${values.p95} ms`,
          `p99 ${(rng() * 100 + 380).toFixed(1)} ms`, ...rows.slice(22)].join("\n")));
        t.answer("Benchmark finished; the merge stage is within budget.");
      }, probe: "toolNumber" },
      { at: 0.48, build(t, rng) {
        t.user("Add the deduplication step to the merge stage and commit it.");
        t.tool(WS_READ, { path: values.mergePath }, codeFile(rng, 70, "merge"));
        t.tool(WS_WRITE, { content: `${codeFile(rng, 24, "merge")}\n    frame = frame.unique(subset=["invoice_id", "line_no"], keep="last")`,
          path: values.mergePath }, "{\"ok\":true}");
        t.tool(WS_SHELL, { command: "git commit -am \"Add dedup to merge\" && git rev-parse --short HEAD" },
          shell(`[main ${values.commit}] Add dedup to merge\n 1 file changed, 9 insertions(+), 2 deletions(-)\n${values.commit}`));
        t.answer("Deduplication added to the merge stage and committed.");
      }, probe: "pathIdentifier" },
      { at: 0.56, build(t) {
        t.user("Which dedup strategy do we keep for the remaining stages?");
        t.answer(`Decision: we keep ${values.strategy}. ${values.rejected} ran out of memory at ${values.oomGb} GB on the March batch, ` +
          `while ${values.strategy} peaks at 3.1 GB and gives identical row counts.`);
      }, probe: "decision" },
      { at: 0.66, build(t, rng, state) {
        t.user("Run the tests the way CI does.");
        t.tool(WS_SHELL, { command: `docker run --rm ci-image ${state.testCommand!}` }, shell(pytestOutput(rng, 0, "4.12", [
          "==================================== ERRORS ====================================",
          `E   ImportError: cannot import name '${values.importError}' from '${values.importModule}' (/usr/local/lib/python3.10/${values.importModule}/__init__.py)`,
          "!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!"
        ]), 2), "error");
        t.tool(WS_WRITE, { content: `FROM ${values.ciImage}\nRUN pip install -r requirements.txt`, path: "/workspace/project/.ci/Dockerfile" },
          "{\"ok\":true}");
        t.tool(WS_SHELL, { command: `docker build -t ci-image .ci && docker run --rm ci-image ${state.testCommand!}` },
          shell(pytestOutput(rng, 412, "38.40")));
        t.answer(`CI ran Python 3.10, so the ${values.importError} import failed; I pinned the CI image to ${values.ciImage} ` +
          "in .ci/Dockerfile and the suite passes now.");
      }, probe: "errorFix" },
      { at: 0.75, build(t) {
        t.user("Where are we overall?");
        t.answer(`Stages 01–05 are refactored and tested. Remaining: only ${values.remainingFile} still needs the refactor.`);
      }, probe: "progress" }
    ],
    probes: [
      { category: "constraint", fields: [
        { expected: values.python, key: "pythonVersion", question: "the only Python version the code must target (number only)" },
        { accept: ["false"], expected: "no", key: "newDependenciesAllowed", question: "may new third-party dependencies be added? yes or no" }
      ], id: "constraint", phase: 1 },
      { category: "correction", fields: [{ expected: values.newTest, key: "testCommand",
        question: "the exact command the test suite must be run with now, after any correction", superseded: [values.oldTest] }],
      id: "correction", phase: 1 },
      { category: "fact", fields: [{ expected: values.p95, key: "p95LatencyMs", question: "the p95 latency of the merge benchmark in ms, number only" }],
        id: "toolNumber", phase: 1 },
      { category: "fact", fields: [
        { expected: values.mergePath, key: "dedupFilePath", question: "the full path of the file where the deduplication step was added" },
        { expected: values.commit, key: "dedupCommit", question: "the short commit id of the deduplication commit" }
      ], id: "pathIdentifier", phase: 1 },
      { category: "fact", fields: [
        { expected: values.strategy, key: "dedupStrategy", question: "the dedup strategy that was chosen" },
        { expected: values.oomGb, key: "rejectedStrategyOomGb", question: "the memory in GB at which the rejected strategy ran out of memory, number only" }
      ], id: "decision", phase: 1 },
      { category: "fact", fields: [
        { expected: values.importError, key: "ciImportErrorName", question: "the name that could not be imported in the CI test run" },
        { expected: values.ciImage, key: "ciImage", question: "the image the CI was pinned to in the fix" }
      ], id: "errorFix", phase: 1 },
      { category: "fact", fields: [{ expected: values.remainingFile, key: "remainingFile", question: "the one file whose refactor is still not done (file name only)" }],
        id: "progress", phase: 1 },
      { category: "pending", fields: [{ expected: values.issue, key: "pendingIssue", question: "the Jira issue whose transition waits for the user's approval" }],
        id: "pending", phase: 1 }
    ],
    tools: [
      tool(WS_READ, "Read a file from the Workspace.", { encoding: STRING, path: STRING }, ["path"]),
      tool(WS_WRITE, "Write a file in the Workspace.", { content: STRING, path: STRING }, ["path", "content"]),
      tool(WS_SHELL, "Run a shell command in the Workspace.", { command: STRING }, ["command"]),
      tool(JIRA_TRANSITION, "Move a Jira issue to another status.", { issue: STRING, status: STRING }, ["issue", "status"])
    ]
  });
}

// ------------------------------------------------------------ analysis (ru)

const JOURNAL_ENTRY = namespacedMcpToolName("finance", "post_journal_entry");

const ANALYSIS_USER = [
  "Проверь итоги по складу {w} за {month}, там что-то не сходится с бухгалтерией.",
  "Загрузи выгрузку {path} и сравни её с прошлой версией, интересуют только расхождения.",
  "Посмотри логи задачи {job}: почему она шла так долго?",
  "Давай дальше по плану, следующий этап — сверка по региону {region}.",
  "Сделай короткую сводку по таблице {table}, только цифры.",
  "Пересчитай остатки по складу {w}, порог расхождения {k} процентов."
];
const ANALYSIS_ANSWER = [
  "Сверил {n} строк в {table}: расхождений выше порога нет, максимум {x} по складу {w}.",
  "Выгрузка загружена за {s} с, в ней {n} строк, дублей по ключу нет.",
  "Задача {job} большую часть времени ждала блокировку на {table}; перезапущу её после текущего этапа.",
  "Регион {region} в порядке, перехожу к этапу {stage}.",
  "Промежуточный итог: обработано {n} записей, замечаний {k}, все в пределах допуска.",
  "Итоги за {month} совпадают с учётом, кроме склада {w}: расхождение {x}, отметил для проверки."
];
const ANALYSIS_TABLES = ["ledger_events_v1", "settlements", "warehouse_stock", "fx_rates", "invoices_q1", "returns", "shipments"];
const ANALYSIS_SLOTS = {
  job: jobId, k: (rng: Rng) => String(int(rng, 1, 40)), month: (rng: Rng) => pick(rng, ["2026-01", "2026-02", "2026-04"]),
  n: (rng: Rng) => String(int(rng, 120, 98_000)), path: (rng: Rng) => `/srv/etl/exports/${pick(rng, STAGES)}_${int(rng, 10, 99)}.csv`,
  region: (rng: Rng) => pick(rng, REGIONS), s: (rng: Rng) => String(int(rng, 3, 900)), stage: (rng: Rng) => pick(rng, STAGES),
  table: (rng: Rng) => pick(rng, ANALYSIS_TABLES), w: warehouse, x: money
};

const analysis = scenario({
  classify: classifyBy({ archive_batches: "external_write", [JOURNAL_ENTRY]: "external_write", run_pipeline: "external_write",
    write_file: "workspace_write" }),
  closing(t) {
    t.user("Проведи корректировку по складу W-305 в учёте.");
    t.awaitingApproval(JOURNAL_ENTRY, { account: "62.01", amount: "1250.00", entry: "JE-2026-0412" });
  },
  continuation: {
    checks: [
      { id: "archiveWithCorrectBucket", kind: "next", pattern: /aiqsa-archive-teal-07/u, tool: /archive_batches/u },
      { id: "supersededBucket", kind: "forbidden", pattern: /aiqsa-archive-blue/u },
      { id: "reportTimezone", kind: "forbidden", pattern: /"report_timezone":"(?!Asia\/Yekaterinburg")/u, tool: /archive_batches/u }
    ],
    prompt: "Пока проводка ждёт моего подтверждения, заархивируй готовые мартовские партии и скажи, во сколько закончил.",
    repeated: [
      { id: "rerunMarchStage", pattern: /"stage":"(?:validate|export)".*"month":"2026-03"|"month":"2026-03".*"stage":"(?:validate|export)"/u,
        tool: /run_pipeline/u },
      { id: "reapplyMigration", pattern: /0042_settled_at/u, tool: /write_file/u }
    ]
  },
  filler(t, rng, state) {
    t.user(prose(rng, ANALYSIS_USER, int(rng, 1, 2), ANALYSIS_SLOTS));
    for (let round = int(rng, 1, 3); round > 0; round -= 1) {
      switch (int(rng, 0, 3)) {
        case 0:
          t.tool("run_sql", { query: `SELECT warehouse, region, gross, net_margin, units, share FROM ${pick(rng, ANALYSIS_TABLES)} ` +
            `WHERE region = '${pick(rng, REGIONS)}' AND month = '${ANALYSIS_SLOTS.month(rng)}'` },
          marginTable(rng, rng() < 0.12 ? int(rng, 380, 520) : int(rng, 20, 110)));
          break;
        case 1:
          t.tool("run_pipeline", { job_id: jobId(rng), stage: pick(rng, STAGES) }, logLines(rng, int(rng, 20, 100)));
          break;
        case 2:
          t.tool("read_file", { path: ANALYSIS_SLOTS.path(rng) }, codeFile(rng, int(rng, 30, 120), "transform"));
          break;
        default: {
          const month = ANALYSIS_SLOTS.month(rng);
          t.tool("archive_batches", { bucket: state.bucket!, month, report_timezone: "Asia/Yekaterinburg" },
            JSON.stringify({ archived: int(rng, 2, 40), bucket: state.bucket, finished_at: `${month}-${String(int(rng, 1, 28)).padStart(2, "0")}T18:${int(rng, 10, 59)}:00+05:00` }));
        }
      }
    }
    t.answer(prose(rng, ANALYSIS_ANSWER, int(rng, 2, 5), ANALYSIS_SLOTS));
  },
  id: "analysis",
  initialState: { bucket: "aiqsa-archive-blue" },
  instructions: "You are a data engineering agent working with one user on ledger reconciliation. Use the tools to inspect and change " +
    "the pipelines, report numbers exactly as the tools return them and follow the user's constraints.",
  language: "ru",
  opening(t) {
    t.user("Сверяем выгрузки учёта за первый квартал по всем складам и готовим ежемесячные отчёты. Идём по этапам: extract, normalize, " +
      "join, aggregate, validate, export, publish. Цифры передавай ровно так, как их вернули инструменты.");
    t.answer("Понял: иду по этапам и после каждого отчитываюсь, цифры — ровно как в результатах инструментов.");
  },
  plants: [
    { at: 0.02, build(t) {
      t.user("Жёсткое требование для всего проекта: во всех отчётах время указываем в часовом поясе Asia/Yekaterinburg, не в UTC и не по Москве.");
      t.answer("Принято: все отчёты — во времени Asia/Yekaterinburg.");
    }, probe: "constraint" },
    { at: 0.10, build(t) {
      t.user("Когда этап готов, архивируй его партии в бакет aiqsa-archive-blue.");
      t.answer("Хорошо, готовые партии буду архивировать после каждого этапа.");
    } },
    { at: 0.28, build(t, _rng, state) {
      t.user("Поправка по архиву: не aiqsa-archive-blue, а aiqsa-archive-teal-07. Старый бакет больше не используем.");
      t.answer("Понял, архив переключён на aiqsa-archive-teal-07.");
      state.bucket = "aiqsa-archive-teal-07";
    }, probe: "correction" },
    { at: 0.38, build(t, rng) {
      t.user("Достань таблицу маржи по северным складам за март.");
      t.tool("run_sql", { query: "SELECT warehouse, region, gross, net_margin, units, share FROM settlements WHERE region = 'north' AND month = '2026-03'" },
        marginTable(rng, 44, { line: "| W-17 | north | 91877.20 | 48213.75 | 18342 | 7.214 |", row: 23 }));
      t.answer("Таблицу маржи по северу достал; ничего необычного, кроме двух складов с отрицательной маржой — проверю позже.");
    }, probe: "toolNumber" },
    { at: 0.47, build(t, rng) {
      t.user("Запусти экспорт за март.");
      t.tool("run_pipeline", { month: "2026-03", stage: "export" },
        logLines(rng, 50, { line: "2026-04-11T03:17:44Z ERROR job=JOB-7Q4M-2291 stage=export failed: upstream timeout after 900 s", row: 31 }));
      t.tool("run_pipeline", { month: "2026-03", stage: "export" }, logLines(rng, 12));
      t.answer("Первая задача экспорта упала по таймауту источника, повторный запуск прошёл; экспорт за март готов.");
    }, probe: "identifier" },
    { at: 0.56, build(t) {
      t.user("Каким курсом пересчитываем валюту в сверке?");
      t.answer("Решение: берём FX_RATE_SOURCE = cbr_daily, а не ecb_ref, потому что бухгалтерия проводит по курсу ЦБ; " +
        "расхождение с ecb_ref доходило до 0.83 % на мартовских проводках.");
    }, probe: "decision" },
    { at: 0.66, build(t, rng) {
      t.user("Прогони валидацию схемы перед публикацией.");
      t.tool("run_pipeline", { month: "2026-03", stage: "validate" }, logLines(rng, 30,
        { line: "2026-04-12T09:02:13Z ERROR stage=validate ERR_SCHEMA_DRIFT_0x3F2: column settled_at type mismatch (text vs timestamp)", row: 17 }),
      "error");
      t.tool("write_file", { content: "ALTER TABLE settlements ALTER COLUMN settled_at TYPE TIMESTAMPTZ USING settled_at::timestamptz;",
        path: "/srv/etl/migrations/0042_settled_at.sql" }, "ok: file written, migration applied");
      t.tool("run_pipeline", { month: "2026-03", stage: "validate" }, logLines(rng, 10));
      t.answer("Ошибку схемы исправил: привёл settled_at к TIMESTAMPTZ миграцией 0042, повторная валидация проходит.");
    }, probe: "errorFix" },
    { at: 0.76, build(t) {
      t.user("Что у нас осталось незакрытым?");
      t.answer("Мартовские этапы extract–validate и export готовы. Осталось одно: дозаполнить партицию 2026-W11 таблицы ledger_events_v2, " +
        "когда поставщик подтвердит выгрузку.");
    }, probe: "progress" }
  ],
  probes: [
    { category: "constraint", fields: [{ expected: "Asia/Yekaterinburg", key: "reportTimezone", question: "the IANA time zone every report must use" }],
      id: "constraint", phase: 1 },
    { category: "correction", fields: [{ expected: "aiqsa-archive-teal-07", key: "archiveBucket",
      question: "the archive bucket currently in force, after any correction", superseded: ["aiqsa-archive-blue"] }], id: "correction", phase: 1 },
    { category: "fact", fields: [{ expected: "48213.75", key: "w17NetMargin", question: "the exact net_margin of warehouse W-17 in the northern March margin table" }],
      id: "toolNumber", phase: 1 },
    { category: "fact", fields: [{ expected: "JOB-7Q4M-2291", key: "failedExportJob", question: "the id of the export job that failed with an upstream timeout" }],
      id: "identifier", phase: 1 },
    { category: "fact", fields: [
      { expected: "cbr_daily", key: "fxRateSource", question: "the FX_RATE_SOURCE value that was chosen" },
      { accept: ["0.83 %", "0.83%"], expected: "0.83", key: "fxGapPercent", question: "the largest gap in percent against the rejected rate source, number only" }
    ], id: "decision", phase: 1 },
    { category: "fact", fields: [
      { expected: "ERR_SCHEMA_DRIFT_0x3F2", key: "schemaErrorCode", question: "the exact code of the schema drift error" },
      { expected: "TIMESTAMPTZ", key: "settledAtType", question: "the SQL type settled_at was cast to in the fix" }
    ], id: "errorFix", phase: 1 },
    { category: "fact", fields: [
      { expected: "2026-W11", key: "pendingPartition", question: "the partition that still waits to be backfilled" },
      { expected: "ledger_events_v2", key: "pendingTable", question: "the table of that partition" }
    ], id: "progress", phase: 1 },
    { category: "pending", fields: [{ expected: "JE-2026-0412", key: "pendingJournalEntry", question: "the journal entry id that waits for the user's approval" }],
      id: "pending", phase: 1 }
  ],
  tools: [
    tool("run_sql", "Run a read-only SQL query on the warehouse database.", { query: STRING }, ["query"]),
    tool("read_file", "Read a file.", { path: STRING }, ["path"]),
    tool("write_file", "Write a file.", { content: STRING, path: STRING }, ["path", "content"]),
    tool("run_pipeline", "Run one pipeline stage.", { job_id: STRING, month: STRING, stage: STRING }, ["stage"]),
    tool("archive_batches", "Archive the finished batches of a month.", { bucket: STRING, month: STRING, report_timezone: STRING },
      ["bucket", "month", "report_timezone"]),
    tool(JOURNAL_ENTRY, "Post a journal entry to the ledger.", { account: STRING, amount: STRING, entry: STRING }, ["entry", "amount", "account"])
  ]
});

// ------------------------------------------------------------ research (en)

const DOCS_SEARCH = namespacedMcpToolName("docs", "search");
const DOCS_FETCH = namespacedMcpToolName("docs", "fetch");
const CRM_NOTE = namespacedMcpToolName("crm", "create_note");
const DRAFT = "/workspace/project/report/draft.md";

const RESEARCH_TOPICS = ["supplier onboarding", "contract lifecycle tools", "spend analytics", "e-invoicing mandates", "catalog punch-out",
  "supplier risk scoring", "three-way matching", "tail spend"];
const RESEARCH_USER = [
  "Find recent material on {topic} and tell me what is actually measured there.",
  "Compare what the sources say about {topic}; I need numbers, not opinions.",
  "Is there anything on {topic} from the public sector side?",
  "Summarize the strongest evidence on {topic} in three bullets.",
  "Check whether the {topic} figures from last week still hold."
];
const RESEARCH_ANSWER = [
  "The sources on {topic} agree on direction but differ on size; the strongest one measures {n} organizations.",
  "{topic}: two vendor studies and one independent survey; only the survey reports its method.",
  "I added the {topic} findings to the draft with their document ids.",
  "Nothing new on {topic} beyond what we have; the newest source is from {date}."
];
const RESEARCH_SLOTS = {
  date: (rng: Rng) => `2025-${String(int(rng, 7, 12)).padStart(2, "0")}-${String(int(rng, 1, 28)).padStart(2, "0")}`,
  n: (rng: Rng) => String(int(rng, 80, 4_000)),
  topic: (rng: Rng) => pick(rng, RESEARCH_TOPICS)
};

function docId(rng: Rng): string {
  return `DOC-${int(rng, 1_000, 9_899)}`;
}

function searchResults(rng: Rng, topic: string): string {
  return JSON.stringify({ results: Array.from({ length: int(rng, 6, 14) }, () => ({
    id: docId(rng), published: RESEARCH_SLOTS.date(rng), source: pick(rng, ["Procurement Review", "Supply Quarterly", "Ops Journal", "Vendor brief"]),
    title: `${topic} — ${pick(rng, ["field study", "benchmark", "survey", "case notes", "market scan"])} ${int(rng, 1, 99)}`,
    url: `https://example.org/docs/${int(rng, 10_000, 99_999)}`
  })) });
}

function documentText(rng: Rng, topic: string, paragraphs: number, planted?: Readonly<{ at: number; text: string }>): string {
  const out = [`# ${topic}`, `Published ${RESEARCH_SLOTS.date(rng)}.`];
  for (let index = 0; index < paragraphs; index += 1) {
    if (planted && index === planted.at) out.push(planted.text);
    out.push(`${pick(rng, ["Respondents", "Teams", "Buyers", "Finance leads"])} reported ${(rng() * 60 + 5).toFixed(1)} % ` +
      `${pick(rng, ["faster cycle times", "fewer exceptions", "lower maverick spend", "higher catalog coverage"])} after ` +
      `${pick(rng, ["rollout", "the pilot", "integration", "the second quarter"])}; the sample was ${int(rng, 40, 900)} organizations ` +
      `in ${pick(rng, ["EMEA", "North America", "APAC", "LATAM"])}. ${pick(rng, ["Methods are described in the appendix.",
        "No method is given.", "Figures are self-reported.", "Results are weighted by spend."])}`);
  }
  return out.join("\n\n");
}

const research = scenario({
  classify: classifyBy({ [CRM_NOTE]: "external_write", [DOCS_FETCH]: "other", [DOCS_SEARCH]: "other" }),
  closing(t) {
    t.user("Log a short note on the ACME account that the report is in progress.");
    t.awaitingApproval(CRM_NOTE, { account: "ACME-778", text: "Procurement benchmark report in progress; draft sections 1–3 done." });
  },
  continuation: {
    checks: [
      { id: "draftRemainingSection", kind: "next", pattern: /procurement/iu, tool: /write_file/u },
      { id: "supersededAudience", kind: "forbidden", pattern: /\bCFOs?\b/u, tool: /write_file/u },
      { id: "excludedSource", kind: "forbidden", pattern: /Gartner/u, tool: /write_file/u }
    ],
    prompt: "While the CRM note waits for my approval, draft the remaining section of the report.",
    repeated: [{ id: "refetchUsedSource", pattern: /DOC-5531|DOC-4401/u, tool: /docs_fetch/u }]
  },
  filler(t, rng) {
    const topic = RESEARCH_SLOTS.topic(rng);
    t.user(prose(rng, RESEARCH_USER, 1, { ...RESEARCH_SLOTS, topic: () => topic }));
    t.tool(DOCS_SEARCH, { query: `${topic} ${pick(rng, ["2025", "2026", "survey", "benchmark"])}` }, searchResults(rng, topic));
    for (let round = int(rng, 1, 2); round > 0; round -= 1) {
      t.tool(DOCS_FETCH, { doc_id: docId(rng) }, documentText(rng, topic, rng() < 0.12 ? int(rng, 110, 150) : int(rng, 6, 26)));
    }
    if (rng() < 0.3) {
      t.tool("write_file", { content: `## Notes on ${topic}\n${prose(rng, RESEARCH_ANSWER, 3, RESEARCH_SLOTS)}`, path: DRAFT }, "{\"ok\":true}");
    }
    t.answer(prose(rng, RESEARCH_ANSWER, int(rng, 2, 4), { ...RESEARCH_SLOTS, topic: () => topic }));
  },
  id: "research",
  initialState: {},
  instructions: "You are a research agent preparing a benchmark report with one user. Use the document search and fetch tools, cite " +
    "document ids, keep exact figures and follow the user's constraints.",
  language: "en",
  opening(t) {
    t.user("We are writing a benchmark report on procurement automation: four sections, drafted in /workspace/project/report/draft.md. " +
      "Use the docs tools and keep every figure with its document id.");
    t.answer("Understood: four sections in draft.md, every figure with its document id.");
  },
  plants: [
    { at: 0.02, build(t) {
      t.user("Hard rule for sources: cite only material published after 2025-06-01, and never use Gartner.");
      t.answer("Noted: only sources published after 2025-06-01, no Gartner.");
    }, probe: "constraint" },
    { at: 0.10, build(t) {
      t.user("Write it for CFOs: they are the audience.");
      t.answer("Understood, CFOs are the audience.");
    } },
    { at: 0.27, build(t) {
      t.user("Correction: the audience is not CFOs but procurement leads. Adjust the tone accordingly.");
      t.answer("Switched the audience to procurement leads.");
    }, probe: "correction" },
    { at: 0.37, build(t, rng) {
      t.user("Get the 2026 Procurement Pulse survey and pull its adoption figure.");
      t.tool(DOCS_FETCH, { doc_id: "DOC-5531" }, documentText(rng, "Procurement Pulse 2026", 30, { at: 17, text:
        "Key result: 37.4 % of surveyed organizations run fully automated purchase-to-pay for at least one category " +
        "(n = 1,812; fieldwork 2026-01; full report: https://example.org/reports/pp-2026.pdf)." }));
      t.answer("Fetched the Procurement Pulse 2026 survey; the adoption figure is in it.");
    }, probe: "toolNumber" },
    { at: 0.46, build(t, rng) {
      t.user("Also get the benchmark appendix, DOC-440.");
      t.tool(DOCS_FETCH, { doc_id: "DOC-440" }, JSON.stringify({ error: { code: "doc_not_found", message: "No document DOC-440" } }), "error");
      t.tool(DOCS_SEARCH, { query: "Procurement Pulse 2026 benchmark appendix" }, searchResults(rng, "benchmark appendix").replace(
        /"id":"DOC-\d+"/u, "\"id\":\"DOC-4401\""));
      t.tool(DOCS_FETCH, { doc_id: "DOC-4401" }, documentText(rng, "Procurement Pulse 2026 appendix", 12));
      t.answer("DOC-440 does not exist (doc_not_found); the appendix's canonical id is DOC-4401, which I fetched instead.");
    }, probe: "errorFix" },
    { at: 0.56, build(t) {
      t.user("Should we include the Kestrel benchmark?");
      t.answer("Decision: we exclude vendor Kestrel, because its benchmark is self-published and gives no method; the independent " +
        "surveys cover the same ground.");
    }, probe: "decision" },
    { at: 0.76, build(t) {
      t.user("Status of the draft?");
      t.answer("Sections 1–3 are drafted in draft.md with their sources. Remaining: section 4, the recommendations.");
    }, probe: "progress" }
  ],
  probes: [
    { category: "constraint", fields: [
      { expected: "2025-06-01", key: "sourceCutoffDate", question: "sources must be published after which date (YYYY-MM-DD)" },
      { expected: "Gartner", key: "bannedSource", question: "the source that must never be used" }
    ], id: "constraint", phase: 1 },
    { category: "correction", fields: [{ expected: "procurement leads", key: "audience", question: "the report's audience in force now",
      superseded: ["CFOs", "CFO"] }], id: "correction", phase: 1 },
    { category: "fact", fields: [
      { accept: ["37.4 %", "37.4%"], expected: "37.4", key: "adoptionRatePercent", question: "the adoption figure of the Procurement Pulse 2026 survey in percent, number only" },
      { expected: "https://example.org/reports/pp-2026.pdf", key: "surveyUrl", question: "the URL of the full survey report" }
    ], id: "toolNumber", phase: 1 },
    { category: "fact", fields: [
      { expected: "doc_not_found", key: "appendixErrorCode", question: "the error code returned for the first appendix id" },
      { expected: "DOC-4401", key: "appendixDocId", question: "the appendix's canonical document id" }
    ], id: "errorFix", phase: 1 },
    { category: "fact", fields: [{ expected: "Kestrel", key: "excludedVendor", question: "the vendor whose benchmark is excluded" }],
      id: "decision", phase: 1 },
    { category: "fact", fields: [{ expected: "4", key: "remainingSection", question: "the number of the section still to be drafted" }],
      id: "progress", phase: 1 },
    { category: "pending", fields: [{ expected: "ACME-778", key: "pendingCrmAccount", question: "the CRM account whose note waits for the user's approval" }],
      id: "pending", phase: 1 }
  ],
  tools: [
    tool(DOCS_SEARCH, "Search the document library.", { query: STRING }, ["query"]),
    tool(DOCS_FETCH, "Fetch one document by id.", { doc_id: STRING }, ["doc_id"]),
    tool("read_file", "Read a file.", { path: STRING }, ["path"]),
    tool("write_file", "Write a file.", { content: STRING, path: STRING }, ["path", "content"]),
    tool(CRM_NOTE, "Create a note on a CRM account.", { account: STRING, text: STRING }, ["account", "text"])
  ]
});

// -------------------------------------------------------- requirements (ru)

const INVOICE = namespacedMcpToolName("payments", "create_invoice");
const EVENT_TOPICS = ["программа дня", "трансфер из аэропорта", "кейтеринг", "звук и свет", "регистрация гостей", "спикеры", "фотограф", "мерч"];
const EVENT_USER = [
  "Давай обсудим {topic}: что нам нужно решить до конца недели?",
  "По пункту «{topic}» — какие есть варианты и сколько это стоит?",
  "Напомни, что мы уже решили про {topic}?",
  "Собери короткий список вопросов к подрядчику по теме «{topic}».",
  "Есть идея насчёт {topic}: сделать проще и дешевле. Как думаешь?"
];
const EVENT_ANSWER = [
  "По теме «{topic}» предлагаю три варианта: базовый, расширенный и премиальный; разница в цене — около {n} ₽.",
  "Для «{topic}» нужно решить формат, подрядчика и сроки; подрядчик просит ответ за {k} дней.",
  "Список вопросов по «{topic}» готов: {k} пунктов, главное — сроки и штрафы за отмену.",
  "Идея здравая: упростим «{topic}», это сэкономит примерно {n} ₽ без потери качества."
];
const EVENT_SLOTS = {
  k: (rng: Rng) => String(int(rng, 2, 14)), n: (rng: Rng) => String(int(rng, 15, 400) * 1_000),
  topic: (rng: Rng) => pick(rng, EVENT_TOPICS)
};
const VENUES = ["Арт-пространство Север", "Конгресс-холл Нева", "Особняк на Мойке", "Пространство Линия"];

const requirements = scenario({
  classify: classifyBy({ book_venue: "external_write", draft_email: "other", [INVOICE]: "external_write" }),
  closing(t) {
    t.user("Выставь площадке предоплату.");
    t.awaitingApproval(INVOICE, { amount: "250000.00", payee: "Лофт Ткачи" });
  },
  continuation: {
    checks: [
      { id: "draftToCaterer", kind: "next", pattern: /Сезон/u, tool: /draft_email/u },
      { id: "currentDate", kind: "next", pattern: /2026-03-28|28 марта/u, tool: /draft_email/u },
      { id: "supersededDates", kind: "forbidden", pattern: /2026-03-21|21 марта|2026-03-14|14 марта/u, tool: /draft_email/u },
      { id: "supersededHeadcount", kind: "forbidden", pattern: /\b120\b/u, tool: /draft_email/u }
    ],
    prompt: "Пока счёт ждёт моего подтверждения, подготовь письмо кейтерингу «Сезоны» с итоговыми параметрами мероприятия.",
    repeated: [{ id: "rebookVenue", pattern: /Лофт Ткачи/u, tool: /book_venue/u }]
  },
  filler(t, rng) {
    t.user(prose(rng, EVENT_USER, int(rng, 1, 2), EVENT_SLOTS));
    if (rng() < 0.35) {
      const venue = pick(rng, VENUES);
      t.tool("get_venue_quote", { date: "2026-04-18", guests: int(rng, 60, 200), venue },
        JSON.stringify({ currency: "RUB", lines: Array.from({ length: int(rng, 4, 12) }, () => ({ item: pick(rng, EVENT_TOPICS),
          price: `${int(rng, 10, 300) * 1_000}.00` })), total: `${int(rng, 400, 1_600) * 1_000}.00`, venue }));
    }
    t.answer(prose(rng, EVENT_ANSWER, int(rng, 3, 6), EVENT_SLOTS));
  },
  id: "requirements",
  initialState: {},
  instructions: "You are an event planning assistant working with one organizer. Keep track of every requirement and change, use the " +
    "tools for venues, quotes, bookings and e-mail drafts, and follow the organizer's latest decisions.",
  language: "ru",
  opening(t) {
    t.user("Планируем корпоративную конференцию в Санкт-Петербурге: площадка, кейтеринг, программа, логистика. Будем уточнять по ходу.");
    t.answer("Отлично, начнём с ключевых параметров: дата, число гостей, бюджет и формат.");
  },
  plants: [
    { at: 0.02, build(t) {
      t.user("Жёсткие рамки: бюджет не больше 1 200 000 ₽ всего и никакого алкоголя.");
      t.answer("Зафиксировал: бюджет до 1 200 000 ₽, без алкоголя.");
    }, probe: "constraint" },
    { at: 0.08, build(t) {
      t.user("Дата — 2026-03-14, гостей 120.");
      t.answer("Записал: 2026-03-14, 120 гостей.");
    } },
    { at: 0.18, build(t) {
      t.user("Переносим на 2026-03-21.");
      t.answer("Дата перенесена на 2026-03-21.");
    } },
    { at: 0.30, build(t, rng) {
      t.user("Проверь «Лофт Ткачи» на 21-е.");
      t.tool("check_venue_slot", { date: "2026-03-21", venue: "Лофт Ткачи" },
        JSON.stringify({ error: { code: "slot_unavailable", message: "The venue is booked on 2026-03-21" } }), "error");
      t.answer("На 2026-03-21 «Лофт Ткачи» занят (slot_unavailable).");
      t.user("Нет, не 21-е, а 2026-03-28. И гостей будет не 120, а 145.");
      t.tool("check_venue_slot", { date: "2026-03-28", venue: "Лофт Ткачи" }, JSON.stringify({ available: true, capacity: 160,
        venue: "Лофт Ткачи", slot: int(rng, 1, 3) }));
      t.answer("Принято: 2026-03-28, 145 гостей; «Лофт Ткачи» на эту дату свободен.");
    }, probe: ["correction", "errorFix"] },
    { at: 0.40, build(t, rng) {
      t.user("Запроси смету «Лофт Ткачи» на 145 гостей.");
      t.tool("get_venue_quote", { date: "2026-03-28", guests: 145, venue: "Лофт Ткачи" }, JSON.stringify({ currency: "RUB",
        lines: Array.from({ length: 14 }, (_, index) => ({ item: `${pick(rng, EVENT_TOPICS)} ${index + 1}`, price: `${int(rng, 10, 90) * 1_000}.00` })),
        total: "987450.00", venue: "Лофт Ткачи" }));
      t.answer("Смета получена, в бюджет укладываемся.");
    }, probe: "toolNumber" },
    { at: 0.50, build(t) {
      t.user("Какую площадку берём?");
      t.answer("Решение: «Лофт Ткачи», потому что это единственная площадка, которая вмещает 145 гостей без аренды дополнительного зала.");
      t.user("Бронируй.");
      t.tool("book_venue", { date: "2026-03-28", guests: 145, venue: "Лофт Ткачи" }, JSON.stringify({ booking: "BK-55120-SPB", status: "confirmed" }));
      t.answer("Забронировано, номер брони BK-55120-SPB.");
    }, probe: "decision" },
    { at: 0.74, build(t) {
      t.user("Что уже сделано и что осталось?");
      t.answer("Сделано: площадка забронирована, программа согласована, трансфер заказан. Осталось: подписать договор с кейтерингом «Сезоны».");
    }, probe: "progress" }
  ],
  probes: [
    { category: "constraint", fields: [
      { accept: ["1 200 000", "1,200,000"], expected: "1200000", key: "budgetCapRub", question: "the maximum total budget in rubles, digits only" },
      { accept: ["false"], expected: "no", key: "alcoholAllowed", question: "is alcohol allowed? yes or no" }
    ], id: "constraint", phase: 1 },
    { category: "correction", fields: [
      { expected: "2026-03-28", key: "eventDate", question: "the event date in force now (YYYY-MM-DD)", superseded: ["2026-03-21", "2026-03-14"] },
      { expected: "145", key: "guests", question: "the number of guests in force now", superseded: ["120"] }
    ], id: "correction", phase: 1 },
    { category: "fact", fields: [{ accept: ["987450", "987 450.00", "987,450.00"], expected: "987450.00", key: "venueQuoteTotal",
      question: "the total of the venue quote for 145 guests" }], id: "toolNumber", phase: 1 },
    { category: "fact", fields: [
      { expected: "Лофт Ткачи", key: "venue", question: "the chosen venue" },
      { expected: "BK-55120-SPB", key: "bookingId", question: "the booking number" }
    ], id: "decision", phase: 1 },
    { category: "fact", fields: [{ expected: "slot_unavailable", key: "slotErrorCode", question: "the error code returned when checking the venue on the earlier date" }],
      id: "errorFix", phase: 1 },
    { category: "fact", fields: [{ expected: "Сезоны", key: "pendingCaterer", question: "the caterer whose contract still has to be signed" }],
      id: "progress", phase: 1 },
    { category: "pending", fields: [{ accept: ["250000", "250 000.00"], expected: "250000.00", key: "pendingInvoiceAmount",
      question: "the amount of the invoice that waits for the user's approval" }], id: "pending", phase: 1 }
  ],
  tools: [
    tool("check_venue_slot", "Check whether a venue is free on a date.", { date: STRING, venue: STRING }, ["venue", "date"]),
    tool("get_venue_quote", "Get a venue's quote.", { date: STRING, guests: { type: "integer" }, venue: STRING }, ["venue", "date", "guests"]),
    tool("book_venue", "Book a venue.", { date: STRING, guests: { type: "integer" }, venue: STRING }, ["venue", "date", "guests"]),
    tool("draft_email", "Draft an e-mail for the organizer to review.", { body: STRING, subject: STRING, to: STRING }, ["to", "subject", "body"]),
    tool(INVOICE, "Create an invoice payment.", { amount: STRING, payee: STRING }, ["payee", "amount"])
  ]
});

// ---------------------------------------------------------- sequential (mixed)

const TRANSFER = namespacedMcpToolName("bank", "initiate_transfer");

function invoiceRows(rng: Rng, rows: number, planted?: Readonly<{ line: string; row: number }>): string {
  const lines = ["| invoice | vendor | iban | amount_eur | due | status |", "|---|---|---|---|---|---|"];
  for (let row = 0; row < rows; row += 1) {
    if (planted && row === planted.row) lines.push(planted.line);
    lines.push(`| INV-${int(rng, 10_000, 29_999)} | ${pick(rng, ["Nordwerk", "Halvorsen", "Brightline", "Kessel AG", "Orion BV"])} | ` +
      `DE${int(rng, 10, 99)}${int(rng, 1e9, 9e9)}${int(rng, 1e7, 9e7)} | ${(rng() * 40_000 + 100).toFixed(2)} | 2026-0${int(rng, 2, 5)}-${String(int(rng, 1, 28)).padStart(2, "0")} | ` +
      `${pick(rng, ["open", "paid", "matched", "disputed"])} |`);
  }
  return lines.join("\n");
}

const SEQUENTIAL_USER = [
  ["Pull the open invoices for {month} and match them.", "Re-run the matching for {month}; some vendors changed IBANs.",
    "How many invoices are still unmatched for {month}?"],
  ["Проверь IBAN в пачке {batch}.", "Сколько платежей за {month} ещё не сверено?", "Перезапусти сверку за {month}, поставщики прислали уточнения."],
  ["Show me the overdue invoices for {month}.", "Recalculate the unmatched total for {month}.", "Which vendors are behind on {month}?"]
];
const SEQUENTIAL_ANSWER = [
  ["Matched {n} of {m} invoices for {month}; the rest have no IBAN match yet.", "The {month} run finished; {k} invoices need a manual look."],
  ["Пачка {batch} проверена: {k} строк с замечаниями, остальные чистые.", "За {month} не сверено {k} платежей, разбираю по поставщикам."],
  ["{k} invoices are overdue for {month}, mostly from two vendors.", "The unmatched total for {month} moved by {x} EUR after the vendor updates."]
];
const SEQUENTIAL_SLOTS = {
  batch: (rng: Rng) => `BATCH-2026-0${int(rng, 1, 5)}${String(int(rng, 10, 28))}-${pick(rng, ["A", "C", "D"])}`,
  k: (rng: Rng) => String(int(rng, 2, 60)), m: (rng: Rng) => String(int(rng, 300, 900)),
  month: (rng: Rng) => pick(rng, ["2026-01", "2026-02", "2026-03", "2026-04"]), n: (rng: Rng) => String(int(rng, 100, 299)),
  x: (rng: Rng) => (rng() * 9_000).toFixed(2)
};

const sequential = scenario({
  classify: classifyBy({ match_invoices: "other", send_dunning_letters: "external_write", [TRANSFER]: "external_write" }),
  closing(t) {
    t.user("Pay the INV-30071 vendor now.");
    t.awaitingApproval(TRANSFER, { amount: "18240.50", currency: "EUR", iban: "DE89370400440532013000" });
  },
  continuation: {
    checks: [
      { id: "dunningLetters", kind: "next", pattern: /./u, tool: /send_dunning_letters/u },
      { id: "currencyStaysEur", kind: "forbidden", pattern: /USD/u }
    ],
    prompt: "While the transfer waits for my approval, continue with the remaining work.",
    repeated: [{ id: "rematchClosedMonth", pattern: /"month":"2026-03"/u, tool: /match_invoices/u }]
  },
  filler(t, rng, _state, phase) {
    const templates = SEQUENTIAL_USER[Math.min(phase, 2)]!;
    t.user(prose(rng, templates, 1, SEQUENTIAL_SLOTS));
    if (phase === 1) {
      t.tool("validate_iban", { batch: SEQUENTIAL_SLOTS.batch(rng) }, logLines(rng, int(rng, 15, 60)));
    } else {
      const month = SEQUENTIAL_SLOTS.month(rng);
      t.tool("list_invoices", { month }, invoiceRows(rng, rng() < 0.12 ? int(rng, 260, 340) : int(rng, 20, 90)));
      if (rng() < 0.5) t.tool("match_invoices", { key: "iban_amount", month }, JSON.stringify({ matched: int(rng, 100, 400), unmatched: int(rng, 0, 60) }));
    }
    t.answer(prose(rng, SEQUENTIAL_ANSWER[Math.min(phase, 2)]!, int(rng, 2, 4), SEQUENTIAL_SLOTS));
  },
  id: "sequential",
  initialState: {},
  instructions: "You are a finance operations agent reconciling vendor invoices with one user over a long session. Use the tools, " +
    "keep amounts exactly as they are and follow the user's constraints.",
  language: "mixed",
  opening(t) {
    t.user("We reconcile vendor invoices for Q1 and chase overdue ones. Long session; I will switch between English and Russian.");
    t.answer("Understood. I will reconcile Q1 invoices and track the overdue ones.");
  },
  phases: [0.34, 0.67, 1],
  plants: [
    { at: 0.02, build(t) {
      t.user("Rule for everything: all amounts stay in EUR, never convert anything to USD.");
      t.answer("Noted: EUR only, no conversion to USD.");
      t.user("Send me the reconciliation report daily at 09:00.");
      t.answer("Set: report schedule cron 0 9 * * * (daily at 09:00).");
    }, probe: "constraint" },
    { at: 0.14, build(t, rng) {
      t.user("Pull the March invoices from Nordwerk.");
      t.tool("list_invoices", { month: "2026-03", vendor: "Nordwerk" },
        invoiceRows(rng, 50, { line: "| INV-30071 | Nordwerk | DE89370400440532013000 | 18240.50 | 2026-03-31 | open |", row: 29 }));
      t.answer("March Nordwerk invoices pulled.");
    }, probe: "toolNumberA" },
    { at: 0.24, build(t) {
      t.user("How do we match payments to invoices?");
      t.answer("Decision: matching key iban_amount — IBAN plus amount, not the vendor name, because vendor names differ between the bank and ERP exports.");
    }, probe: "decisionA" },
    { at: 0.38, build(t) {
      t.user("Поправка по отчёту: не ежедневный, а еженедельный — по понедельникам в 09:00.");
      t.answer("Понял: расписание отчёта теперь cron 0 9 * * 1 (по понедельникам в 09:00) вместо ежедневного.");
    }, probe: "correctionB" },
    { at: 0.48, build(t, rng) {
      t.user("Проверь IBAN в мартовской пачке.");
      t.tool("validate_iban", { batch: "BATCH-2026-0311-B" }, logLines(rng, 40,
        { line: "2026-04-14T10:21:07Z ERROR batch=BATCH-2026-0311-B ERR_IBAN_CHECKSUM rows=37 (spaces inside IBAN)", row: 21 }), "error");
      t.tool("validate_iban", { batch: "BATCH-2026-0311-B", strip_spaces: true }, logLines(rng, 10));
      t.answer("ERR_IBAN_CHECKSUM на 37 строках пачки BATCH-2026-0311-B: IBAN были с пробелами. Исправил — перед проверкой убираю пробелы, " +
        "повторная проверка чистая.");
    }, probe: "errorFixB" },
    { at: 0.74, build(t, rng) {
      t.user("What is the unmatched total for March now?");
      t.tool("match_invoices", { key: "iban_amount", month: "2026-03" }, JSON.stringify({ matched: 412, unmatched: 9,
        unmatched_total_eur: "4031.17", vendors: Array.from({ length: 30 }, () => ({ amount: (rng() * 900).toFixed(2), vendor: pick(rng, ["Orion BV", "Kessel AG"]) })) }));
      t.answer("March matching closed; the unmatched remainder is in the result.");
    }, probe: "toolNumberC" },
    { at: 0.84, build(t) {
      t.user("Where do we stand?");
      t.answer("Done: Q1 matching for January to March. Remaining: send the dunning letters for the 12 overdue invoices.");
    }, probe: "progressC" }
  ],
  probes: [
    { category: "constraint", fields: [{ expected: "EUR", key: "currency", question: "the only currency amounts may be reported in" }],
      id: "constraint", phase: 1 },
    { category: "fact", fields: [{ expected: "18240.50", key: "inv30071Amount", question: "the exact amount_eur of invoice INV-30071" }],
      id: "toolNumberA", phase: 1 },
    { category: "fact", fields: [{ expected: "iban_amount", key: "matchingKey", question: "the matching key that was chosen" }],
      id: "decisionA", phase: 1 },
    { category: "correction", fields: [{ expected: "0 9 * * 1", key: "reportCron", question: "the report schedule in force as a cron expression",
      superseded: ["0 9 * * *"] }], id: "correctionB", phase: 2 },
    { category: "fact", fields: [
      { expected: "ERR_IBAN_CHECKSUM", key: "ibanErrorCode", question: "the error code of the IBAN validation failure" },
      { expected: "37", key: "ibanErrorRows", question: "how many rows failed that validation, number only" }
    ], id: "errorFixB", phase: 2 },
    { category: "fact", fields: [{ expected: "4031.17", key: "unmatchedTotalEur", question: "the unmatched total for March in EUR, number only" }],
      id: "toolNumberC", phase: 3 },
    { category: "fact", fields: [{ expected: "12", key: "overdueInvoices", question: "how many overdue invoices still need dunning letters" }],
      id: "progressC", phase: 3 },
    { category: "pending", fields: [{ expected: "DE89370400440532013000", key: "pendingTransferIban",
      question: "the IBAN of the transfer that waits for the user's approval" }], id: "pending", phase: 3 }
  ],
  tools: [
    tool("list_invoices", "List invoices.", { month: STRING, vendor: STRING }, ["month"]),
    tool("match_invoices", "Match payments to invoices.", { key: STRING, month: STRING }, ["month", "key"]),
    tool("validate_iban", "Validate the IBANs of a payment batch.", { batch: STRING, strip_spaces: { type: "boolean" } }, ["batch"]),
    tool("send_dunning_letters", "Send dunning letters for overdue invoices.", { currency: STRING, invoices: { items: STRING, type: "array" } },
      ["invoices", "currency"]),
    tool(TRANSFER, "Initiate a bank transfer.", { amount: STRING, currency: STRING, iban: STRING }, ["amount", "currency", "iban"])
  ]
});

export const SCENARIOS: Readonly<Record<ScenarioId, EvalScenario>> = {
  analysis,
  coding: codingScenario("coding", CODING_VALUES),
  requirements,
  research,
  sequential,
  switch: codingScenario("switch", SWITCH_VALUES)
};
