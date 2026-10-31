/**
 * Pure parts of `scripts/smoke-subagents-paid.ts`: the sub-agent scenarios
 * A–I of the acceptance task (scenarios 1–9), J (two production defects), K
 * (files and images across agents) and L (a document the parser refuses, read
 * in the Workspace) with their Russian prompts, the oracles over `browser-result.json` and the run's stored rows, and the
 * content-free evidence computed from read-only rows (turn bindings, usage
 * per purpose, callbacks and wake-ups, concurrency from the tool-call
 * timeline, thread-state progression). Stand guard, setup, cleanup ports and
 * the S5/S6 oracles are the browser-scenario harness's own
 * (`scripts/browser-scenarios-support.ts`, `scripts/browser-scenarios-stand.ts`).
 *
 * Evidence carries codes, counts, booleans, timings and token numbers only:
 * never prompts, answers, names the agents chose, ids, URLs or values the
 * oracles compare (the per-run words and nonce stay in memory).
 */
import { createHash } from "node:crypto";
import { utils, write } from "xlsx";
import {
  ACTIVE_SUBAGENT_STATES, SUBAGENT_END_REASONS, SUBAGENT_THREAD_STATES, type SubagentThreadState
} from "../lib/contracts/subagents";
import {
  BLOCKED_AFTER_USER_SIGN_IN, BROWSER_SCENARIOS, BrowserScenarioError, S5_CHECKOUT_FIELDS, SAFETY, amazonProductKey, blockedCodes,
  canonicalPageKey, checkBrowserResult, costEstimates, euroAmount, oracleS5Run, ratingValue, resultInstruction, resultShapeErrors,
  reviewCount, type BrowserResult, type CostEstimates, type OracleVerdict, type ScenarioRunEvidence
} from "./browser-scenarios-support";

const fail = (code: string): never => { throw new BrowserScenarioError(code); };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyText = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000;
const nameKey = (value: unknown) => String(value).trim().toLowerCase().replace(/\s+/gu, " ");
const flag = (value: boolean) => value ? 1 : 0;

// Scenarios and selection -----------------------------------------------------------

/**
 * A: no-setup sub-agents (scenario 1). B: background fan-out of 5 (2).
 * C1/C2: S6 with sub-agents on the default sub-agent and with a one-off
 * `model` override (3). D5/D1: 5 agents browsing amazon.es at once, and the
 * same task by one agent for the wall-time reference (3a). E: a message to a
 * running sub-agent and the three stops (4). F: a thread continued by name,
 * then an edit that branches it away (5). G: a restart during background
 * work (6). H: a background sub-agent's browser handoff while another agent
 * browses (8). I: a scheduled task (9; Telegram is not drivable on a
 * real-runtime stand, see the harness). J: an image viewed by an attached
 * sub-agent, then a Workspace-free sub-agent that ends last with the VM up,
 * and the chat's next message at once (the capture and retire defects). K: two
 * sub-agents and the main agent read each other's text and image files, in the
 * background and the foreground, finished sub-agents continued by name, "a
 * chart in the background" ending as a download, and a sub-agent on a model
 * without vision when one is configured. L: an XLSX over the spreadsheet
 * reader's limit, sent with a Workspace, answered from the file itself.
 */
export const SUBAGENT_SCENARIO_IDS = ["A", "B", "C1", "C2", "D5", "D1", "E", "F", "G", "H", "I", "J", "K", "L"] as const;
export type SubagentScenarioId = (typeof SUBAGENT_SCENARIO_IDS)[number];
/** The cheap scenarios that need no hook, no second model and no live panel; the others run only when named. */
export const DEFAULT_SUBAGENT_SCENARIO_IDS: readonly SubagentScenarioId[] = Object.freeze(["A", "B", "E", "F"]);

export function selectedSubagentScenarios(raw: string | undefined): SubagentScenarioId[] {
  const value = raw?.trim() || DEFAULT_SUBAGENT_SCENARIO_IDS.join(",");
  const ids = value.split(",").map((entry) => entry.trim().toUpperCase());
  if (ids.length === 0 || ids.some((id) => !(SUBAGENT_SCENARIO_IDS as readonly string[]).includes(id)) ||
    new Set(ids).size !== ids.length) fail("scenarios_invalid");
  return SUBAGENT_SCENARIO_IDS.filter((id) => ids.includes(id));
}

/** What a scenario needs beyond the stand: a second model (C2), the restart hook (G), or the live panel driven by Playwright. */
export type ScenarioNeeds = Readonly<{ livePanel?: "cancel" | "sign_in"; restartHook?: true; secondModel?: true }>;

export const SUBAGENT_SCENARIO_NEEDS: Readonly<Record<SubagentScenarioId, ScenarioNeeds>> = Object.freeze({
  A: {}, B: {}, C1: { livePanel: "cancel" }, C2: { livePanel: "cancel", secondModel: true }, D5: { livePanel: "cancel" },
  D1: { livePanel: "cancel" }, E: {}, F: {}, G: { restartHook: true }, H: { livePanel: "sign_in" }, I: {}, J: {}, K: {}, L: {}
});

export type RestartHook = Readonly<{ command: string; timeoutMs: number }>;
export type SubagentHarnessOptions = Readonly<{
  /** The second chat model's upstream id for C2 (added beside the parent on the same codex-lb route). */
  secondModel: string | null;
  restart: RestartHook | null;
  runs: number;
  /** A text-only OpenRouter chat model for K's sub-agent without vision (`ensureTextModel`). */
  textModel: string | null;
}>;

const UPSTREAM_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPENROUTER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(code);
}

/**
 * The harness's own environment. A selected scenario whose need is missing
 * fails before anything is set up, never later in a paid run.
 * - AIQSA_SUBAGENTS_SECOND_MODEL: the upstream id of a second codex-lb chat model (C2), not the parent's.
 * - AIQSA_SUBAGENTS_RESTART_COMMAND: one shell line the harness host runs to restart the stand's app container (G).
 * - AIQSA_SUBAGENTS_RESTART_TIMEOUT_SECONDS (30..900, default 300).
 * - AIQSA_SUBAGENTS_RUNS (1..3, default 1).
 * - AIQSA_SUBAGENTS_TEXT_MODEL with OPENROUTER_API_KEY: a text-only OpenRouter model for K's last step.
 */
export function subagentHarnessOptions(env: Readonly<Record<string, string | undefined>>, scenarios: readonly SubagentScenarioId[],
  parentModel: string): SubagentHarnessOptions {
  const needs = scenarios.map((id) => SUBAGENT_SCENARIO_NEEDS[id]);
  const second = env.AIQSA_SUBAGENTS_SECOND_MODEL?.trim() || null;
  if (second !== null && !UPSTREAM_MODEL_PATTERN.test(second)) fail("second_model_invalid");
  if (second !== null && second === parentModel) fail("second_model_is_parent");
  if (needs.some((need) => need.secondModel) && second === null) fail("second_model_required");
  const command = env.AIQSA_SUBAGENTS_RESTART_COMMAND?.trim() || null;
  if (command !== null && (command.length > 2_000 || /[\r\n\0]/u.test(command))) fail("restart_command_invalid");
  if (needs.some((need) => need.restartHook) && command === null) fail("restart_command_required");
  const timeoutSeconds = boundedInteger(env.AIQSA_SUBAGENTS_RESTART_TIMEOUT_SECONDS, 300, 30, 900, "restart_timeout_invalid");
  const text = env.AIQSA_SUBAGENTS_TEXT_MODEL?.trim() || null;
  if (text !== null && !OPENROUTER_MODEL_PATTERN.test(text)) fail("text_model_invalid");
  if (text !== null && !env.OPENROUTER_API_KEY?.trim()) fail("openrouter_key_required");
  return {
    restart: command === null ? null : { command, timeoutMs: timeoutSeconds * 1_000 },
    runs: boundedInteger(env.AIQSA_SUBAGENTS_RUNS, 1, 1, 3, "runs_invalid"),
    secondModel: second,
    textModel: text
  };
}

// Per-run secrets -------------------------------------------------------------------

/**
 * Values only the harness knows before the run: E's two marker words (the
 * correction swaps one for the other) and F's nonce, whose hash only the
 * sub-agent computes. They are never printed.
 */
export type RunSecrets = Readonly<{ correctionFrom: string; correctionTo: string; nonce: string }>;

const WORDS = ["ALPHA", "BRAVO", "CEDAR", "DELTA", "EMBER", "FJORD", "GRAIN", "HAVEN"] as const;

/** Secrets from 16 or more random bytes: two distinct words with a hex tag each, and a 16-hex nonce. */
export function runSecrets(bytes: Uint8Array): RunSecrets {
  if (bytes.length < 16) fail("secrets_bytes_short");
  const hex = Buffer.from(bytes).toString("hex");
  const first = bytes[0]! % WORDS.length;
  const second = (first + 1 + (bytes[1]! % (WORDS.length - 1))) % WORDS.length;
  return {
    correctionFrom: `${WORDS[first]}-${hex.slice(4, 8).toUpperCase()}`,
    correctionTo: `${WORDS[second]}-${hex.slice(8, 12).toUpperCase()}`,
    nonce: hex.slice(12, 28)
  };
}

/** What F's sub-agent computes and must recall: the first 12 hex characters of SHA-256 of the nonce. */
export function notaryValue(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex").slice(0, 12);
}

// Prompts ---------------------------------------------------------------------------

/** The sub-agent names the prompts fix, so later steps address them without reading what the agent chose. */
export const SUBAGENT_NAMES = Object.freeze({
  background: ["bg-1", "bg-2", "bg-3", "bg-4", "bg-5"],
  counter: "counter",
  hold: ["hold-1", "hold-2"],
  idle: ["idle-1", "idle-2"],
  notary: "notary",
  restart: { browsing: ["browse-a", "browse-b"], sleeper: "sleeper" },
  handoff: { browse: "browse", sauce: "sauce" },
  probe: "probe",
  capture: { quiet: "quiet", viewer: "viewer" },
  files: { blind: "blind", chart: "chart-bg", left: "file-left", right: "file-right" }
} as const);

/** The result instruction for an answer that will receive sub-agent results later, not the one being written. */
function laterResult(when: string, fields: string, blocked?: string): string {
  return `${when} — в том ответе, где ты это получишь, а не сейчас, — выполни следующее.\n${resultInstruction(fields, blocked)}`;
}

const NO_WEB = "Браузер и веб-поиск не нужны.";
const START_AND_REPLY = "Не жди их: сразу после запуска ответь мне одной короткой фразой.";

export const SIDE_QUESTION = Object.freeze({ answer: "391", text: "Пока суб-агенты работают, ответь на вопрос: сколько будет 17 × 23? Ответь одним числом." });

const S6_SUBAGENTS = "Сделай это задание с помощью суб-агентов: запусти параллельно 5 суб-агентов, по одному на категорию " +
  "(cat-juice, cat-yogurt, cat-pizza, cat-coffee, cat-cereal), и дождись их результатов. Каждый ищет кандидатов своей категории " +
  "на amazon.es в общем браузере Workspace и записывает их в файл s6/<категория>.json. Лучший товар в каждой категории выбери сам. " +
  "Положить выбранные товары в корзину и прочитать корзину поручи одному суб-агенту cart или сделай сам.";

const D_TASK = "Найди 5 лучших беспроводных наушников (auriculares inalámbricos) на amazon.es по соотношению цены, рейтинга и числа отзывов.";
const D_BANDS = "ценовые диапазоны до 30 €, 30–60 €, 60–100 €, 100–200 € и дороже 200 €";
const D_FIELDS = '  "products": [{"name": "...", "price": 49.99, "rating": 4.5, "reviews": 1234, "url": "https://www.amazon.es/dp/..."}]';

/**
 * Work that keeps a sub-agent running for `minutes` without a long single
 * command: one Workspace command can hit the tool's own timeout, after which
 * a model tends to report instead of going on.
 */
const HOLD_WORK = (minutes: number) => `каждый ${minutes} минут подряд выполняет в Workspace команду \`sleep 60\`, по одной ` +
  "команде за раз, на переднем плане (без `&`, nohup, timeout и других обёрток), и не заканчивает работу раньше; " +
  "коротко отчитывается только после этого.";

/** J's picture: a fixed 64×64 solid red PNG, written by one shell command; base64 needs no packages and no quoting. */
export const SCENARIO_J_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAtx/ZMZxgi+hcEK" +
  "LNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywKqxUDxqh7TUQAAAABJRU5ErkJggg==";

/**
 * K's pictures: a 64×64 solid PNG of the given colour from standard Python, so
 * no agent needs a package or copies image bytes through a model.
 */
export const SCENARIO_K_PNG_SCRIPT = [
  "import struct, sys, zlib",
  "def chunk(kind, data):",
  "    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))",
  "pixel = bytes(int(value) for value in sys.argv[2:5])",
  "rows = (b'\\0' + pixel * 64) * 64",
  "header = struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)",
  "image = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')",
  "open(sys.argv[1], 'wb').write(image)"
].join("\n");

const K_AGENTS = ["left", "main", "right"] as const;
type KAgent = (typeof K_AGENTS)[number];
const K_COLORS: Readonly<Record<KAgent, Readonly<{ name: string; rgb: string }>>> = Object.freeze({
  left: { name: "blue", rgb: "0 0 255" }, main: { name: "red", rgb: "255 0 0" }, right: { name: "green", rgb: "0 128 0" }
});

/** One K run's shared folder and what only each writer's file holds: a hash no agent is told and none reports until asked. */
export type ScenarioKFacts = Readonly<{ directory: string; nonce: string; texts: Readonly<Record<KAgent, string>> }>;

export function scenarioKFacts(nonce: string): ScenarioKFacts {
  return { directory: `/workspace/project/subagent-k-${nonce}`, nonce,
    texts: { left: notaryValue(`${nonce}-left`), main: notaryValue(`${nonce}-main`), right: notaryValue(`${nonce}-right`) } };
}

const kWrites = (facts: ScenarioKFacts, agent: KAgent) => `\`python3 ${facts.directory}/png.py ${facts.directory}/${agent}.png ${K_COLORS[agent].rgb}\` и ` +
  `\`printf '%s' ${facts.nonce}-${agent} | sha256sum | cut -c1-12 > ${facts.directory}/${agent}.txt\``;
const K_IMAGE_TOOL = "инструментом view_workspace_image, а если такого инструмента нет, то analyze_image";

/** What one agent reads in K's second step: file by file, never by computing a value again. */
const kReads = (facts: ScenarioKFacts, agents: readonly KAgent[]) => `прочитать файлы ${agents.map((agent) => `${facts.directory}/${agent}.txt`).join(", ")} ` +
  `и посмотреть картинки ${agents.map((agent) => `${facts.directory}/${agent}.png`).join(", ")} ${K_IMAGE_TOOL}, ничего не вычисляя заново и не копируя файлы`;

const K_READ_SECTIONS: Readonly<Record<"left" | "main" | "right", readonly KAgent[]>> = Object.freeze({
  left: K_AGENTS, main: ["left", "right"], right: K_AGENTS
});

const K_RESULT_FIELDS = Object.entries(K_READ_SECTIONS).map(([reader, agents]) => `  "${reader}": {${agents.map((agent) =>
  `"${agent}_text": "...", "${agent}_color": "..."`).join(", ")}}`).join(",\n");

export const SCENARIO_L_FILE_NAME = "subagent-l-ledger.xlsx";
export const SCENARIO_L_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const L_SHEET = "Ledger";
const L_ROWS = 26_000;
const L_COLUMNS = 10;

/** One L run's workbook and the sum only its second column gives; the sum never reaches a prompt or the line. */
export type ScenarioLFacts = Readonly<{ expectedSum: number; populatedCells: number; workbook: Buffer }>;

/**
 * Over `SPREADSHEET_MAX_POPULATED_CELLS`, like `tests/e2e/oversized-document-workspace.spec.ts`,
 * with a header row so a reader's default of taking the first row as the header
 * loses no value. Whole numbers, so the sum has one exact form however it is computed.
 */
export function scenarioLFacts(nonce: string): ScenarioLFacts {
  const amount = (row: number) => Number.parseInt(createHash("sha256").update(`${nonce}-${row}`, "utf8").digest("hex").slice(0, 6), 16);
  const amounts = Array.from({ length: L_ROWS }, (_, row) => amount(row));
  const header = ["id", "amount", ...Array.from({ length: L_COLUMNS - 2 }, (_, column) => `filler_${column + 1}`)];
  const rows = amounts.map((value, row) => [row + 1, value, ...Array.from({ length: L_COLUMNS - 2 }, (_, column) => row * 10 + column)]);
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([header, ...rows]), L_SHEET);
  return {
    expectedSum: amounts.reduce((sum, value) => sum + value, 0),
    populatedCells: (L_ROWS + 1) * L_COLUMNS,
    workbook: write(book, { bookType: "xlsx", compression: true, type: "buffer" }) as Buffer
  };
}

export const SUBAGENT_PROMPTS = Object.freeze({
  A: () => [
    "Найди и сравни 10 вариантов открытых (open-source) векторных баз данных. Сделай это с помощью суб-агентов, " +
      "которые ищут параллельно (например, по 2 варианта на каждого), и дождись их результатов.",
    "Каждый суб-агент открывает не больше одной страницы на вариант (официальный сайт или репозиторий проекта) и делает " +
      "не больше одного веб-поиска. Сравнение и вывод, что лучше взять для небольшого проекта, сделай сам.",
    resultInstruction('  "options": [{"name": "...", "license": "...", "url": "https://...", "summary": "..."}]')
  ].join("\n\n"),
  B: () => [
    `Запусти 5 суб-агентов в фоне (background: true) с именами ${SUBAGENT_NAMES.background.join(", ")}. Задание у всех одно: ` +
      "выполнить в Workspace команду `sleep 90`, затем записать в файл bg/<своё имя>.txt строку «готово» и коротко отчитаться. " +
      `${NO_WEB} ${START_AND_REPLY}`,
    laterResult("Когда придут результаты всех пятерых", '  "agents": [{"name": "bg-1", "state": "done"}]')
  ].join("\n\n"),
  C: (secondModel: string | null) => [
    secondModel === null ? S6_SUBAGENTS : `${S6_SUBAGENTS} Всем суб-агентам задай модель ${secondModel} (параметр model).`,
    BROWSER_SCENARIOS.S6.prompt
  ].join("\n\n"),
  D: (subagents: boolean) => [
    D_TASK,
    subagents
      ? "Используй 5 суб-агентов, которые просматривают amazon.es одновременно: запусти их параллельно и дождись результатов. " +
        `Каждый смотрит свой диапазон (${D_BANDS}) и находит до 3 кандидатов. Итоговые 5 лучших выбери сам.`
      : `Сделай это сам, без суб-агентов: просмотри ${D_BANDS} и в каждом найди до 3 кандидатов. Итоговые 5 лучших выбери сам.`,
    `В аккаунт не входи и не регистрируйся. ${SAFETY}`,
    resultInstruction(D_FIELDS)
  ].join("\n\n"),
  E: Object.freeze({
    holds: () => `Запусти в фоне (background: true) два суб-агента, ${SUBAGENT_NAMES.hold.join(" и ")}: ${HOLD_WORK(10)} ` +
      `${NO_WEB} ${START_AND_REPLY} Не останавливай их сам.`,
    start: (secrets: RunSecrets) => [
      `Запусти в фоне (background: true) три суб-агента. ${NO_WEB} ${START_AND_REPLY}`,
      `1. ${SUBAGENT_NAMES.counter}: 8 раз подряд выполни в Workspace \`sleep 20\` и затем допиши в файл counter/log.txt строку ` +
        `«<номер шага> <слово>», где слово — ${secrets.correctionFrom}. Перед каждым шагом учитывай мои новые сообщения, если они пришли. ` +
        "В отчёте перечисли строки файла.",
      `2. ${SUBAGENT_NAMES.idle.join(" и ")}: ${HOLD_WORK(15)}`,
      "Не останавливай и не перезапускай их сам, пока я не попрошу.",
      laterResult(`Когда придёт результат ${SUBAGENT_NAMES.counter}`,
        '  "lines": [{"step": 1, "word": "..."}]\nВ "lines" перечисли все строки файла counter/log.txt по порядку')
    ].join("\n\n"),
    correction: (secrets: RunSecrets) => `Отправь суб-агенту ${SUBAGENT_NAMES.counter} сообщение: начиная со следующего шага пиши слово ` +
      `${secrets.correctionTo} вместо ${secrets.correctionFrom}. Только отправь сообщение, не жди его результата, и ответь одной короткой фразой.`,
    stopByTool: () => `Останови суб-агента ${SUBAGENT_NAMES.idle[0]} инструментом stop_subagent и ответь одной короткой фразой. ` +
      "Остальных не трогай."
  }),
  F: Object.freeze({
    start: (secrets: RunSecrets) => `Вызови суб-агента ${SUBAGENT_NAMES.notary} и дождись его результата (не в фоне). Поручи ему ` +
      `вычислить в Workspace первые 12 шестнадцатеричных символов SHA-256 строки ${secrets.nonce} (например, ` +
      `\`printf '%s' ${secrets.nonce} | sha256sum | cut -c1-12\`), запомнить это значение, не записывать его ни в какие файлы ` +
      "и не называть его в отчёте: только подтвердить, что значение вычислено. Сам это значение не вычисляй. Ответь одной короткой фразой.",
    continuation: () => [
      `Продолжи суб-агента ${SUBAGENT_NAMES.notary} (то же имя) и дождись его ответа (не в фоне): спроси, какое значение он вычислил. ` +
        "Пусть ответит по памяти, ничего не вычисляя заново и не запуская команд. Сам ничего не вычисляй.",
      resultInstruction('  "value": "<12 шестнадцатеричных символов>"')
    ].join("\n\n"),
    edited: () => "Ответь одним словом: привет.",
    newBranch: () => [
      `Продолжи суб-агента ${SUBAGENT_NAMES.notary} и спроси, какое значение он вычислил раньше. Если суб-агента с таким именем ` +
        'в этом разговоре нет, не создавай нового и запиши "value": null. Сам ничего не вычисляй.',
      resultInstruction('  "value": null')
    ].join("\n\n")
  }),
  G: Object.freeze({
    start: () => [
      `Запусти в фоне (background: true) три суб-агента. ${START_AND_REPLY}`,
      `1. ${SUBAGENT_NAMES.restart.browsing[0]}: открой в браузере Workspace https://example.com, затем 10 раз подряд выполни ` +
        "`sleep 30` и открой страницу заново.",
      `2. ${SUBAGENT_NAMES.restart.browsing[1]}: открой в браузере Workspace https://www.iana.org/help/example-domains, затем 10 раз ` +
        "подряд выполни `sleep 30` и открой страницу заново.",
      `3. ${SUBAGENT_NAMES.restart.sleeper}: 10 раз подряд выполни в Workspace \`sleep 60\`, потом коротко отчитайся.`,
      "Если какой-то из них прервётся, не перезапускай и не продолжай его сам: просто коротко сообщи мне об этом."
    ].join("\n\n"),
    continuation: () => `Продолжи суб-агента ${SUBAGENT_NAMES.restart.sleeper} (то же имя) и дождись его результата (не в фоне): ` +
      "пусть выполнит в Workspace `echo resumed` и коротко отчитается. Ответь одной короткой фразой."
  }),
  H: () => [
    `Запусти в фоне (background: true) два суб-агента. ${START_AND_REPLY}`,
    `1. ${SUBAGENT_NAMES.handoff.sauce}: открой тестовый магазин https://www.saucedemo.com. Войду я сам: когда откроется страница ` +
      "входа, передай мне браузер (browser_handoff), я введу логин и пароль в панели браузера в чате и нажму Done. Сам логин " +
      "и пароль не вводи и не спрашивай. После входа положи в корзину один любой товар, начни оформление, заполни имя, фамилию " +
      "и индекс любыми тестовыми значениями и дойди до страницы обзора заказа (Checkout: Overview). Кнопку Finish не нажимай. " +
      "Запиши адрес страницы обзора, Item total, Tax и Total. Не пиши, под каким логином я вошёл.",
    `2. ${SUBAGENT_NAMES.handoff.browse}: всё это время держи браузер занятым: 8 раз подряд открой https://example.com ` +
      "или https://www.iana.org/help/example-domains и выполни `sleep 20`.",
    `Кнопку Finish не нажимай: заказ должен остаться незавершённым. ${SAFETY}`,
    laterResult(`Когда придёт результат ${SUBAGENT_NAMES.handoff.sauce}`, S5_CHECKOUT_FIELDS, BLOCKED_AFTER_USER_SIGN_IN)
  ].join("\n\n"),
  I: () => [
    `Вызови суб-агента ${SUBAGENT_NAMES.probe}: сначала попробуй запустить его в фоне (background: true); если фоновый режим ` +
      "недоступен, запусти его и дождись результата. Пусть он выполнит в Workspace `python3 -c 'print(6*7)'` и сообщит число.",
    resultInstruction('  "value": 42')
  ].join("\n\n"),
  J: Object.freeze({
    // The Workspace-free agent has no sleep to wait with: a long written answer outlasts the viewer and its wake-up.
    start: (imageName: string) => [
      "Сделай ровно три шага по порядку. Суб-агентов ровно два, вызовов call_subagent ровно два.",
      `1. Выполни в Workspace ровно одну команду в shell: \`printf '%s' '${SCENARIO_J_PNG_BASE64}' | base64 -d > ` +
        `/workspace/project/${imageName}\`. Она создаёт маленькую картинку. Не проверяй её и больше ничего в Workspace не запускай.`,
      `2. Запусти в фоне (background: true) суб-агента ${SUBAGENT_NAMES.capture.viewer}. Его задание: ровно один раз посмотреть файл ` +
        `/workspace/project/${imageName} инструментом view_workspace_image, а если такого инструмента нет, то analyze_image, ` +
        "не запуская команд, и сообщить, какого цвета картинка.",
      `3. Запусти в фоне (background: true) суб-агента ${SUBAGENT_NAMES.capture.quiet}. Его задание: не вызывать ни одного инструмента, ` +
        "ни Workspace, ни браузера, ни поиска, и сразу написать текстом подробное рассуждение не короче 3000 слов о том, почему " +
        `небо голубое. Рассуждение нужно, чтобы он закончил заметно позже суб-агента ${SUBAGENT_NAMES.capture.viewer}.`,
      `${NO_WEB} ${START_AND_REPLY}`,
      "Когда придут их результаты, не вызывай инструментов, не запускай и не продолжай суб-агентов: ответь одной короткой фразой."
    ].join("\n\n"),
    question: Object.freeze({ answer: "144", text: "Ответь без инструментов: сколько будет 12 × 12? Ответь одним числом." })
  }),
  K: Object.freeze({
    start: (facts: ScenarioKFacts) => [
      `Сделай ровно два шага. ${NO_WEB}`,
      `1. Сам создай в Workspace папку ${facts.directory}, запиши в файл ${facts.directory}/png.py ровно этот скрипт на Python:\n` +
        `\`\`\`\n${SCENARIO_K_PNG_SCRIPT}\n\`\`\`\nи выполни ${kWrites(facts, "main")}.`,
      `2. Запусти в фоне (background: true) двух суб-агентов и передай им эти команды дословно. ${SUBAGENT_NAMES.files.left}: выполнить ` +
        `${kWrites(facts, "left")}. ${SUBAGENT_NAMES.files.right}: выполнить ${kWrites(facts, "right")}. Затем каждый должен ` +
        `${kReads(facts, ["main"])}, и коротко отчитаться: что в файле и какого цвета картинка.`,
      START_AND_REPLY,
      "Когда придут их результаты, не вызывай инструментов, не запускай и не продолжай суб-агентов: ответь одной короткой фразой."
    ].join("\n\n"),
    reads: (facts: ScenarioKFacts) => [
      `Сделай ровно три шага. Новых суб-агентов не создавай. ${NO_WEB}`,
      `1. Продолжи суб-агента ${SUBAGENT_NAMES.files.left} (то же имя) и дождись его результата (не в фоне): пусть он ` +
        `${kReads(facts, K_AGENTS)}, и сообщит содержимое каждого файла и цвет каждой картинки.`,
      `2. Продолжи суб-агента ${SUBAGENT_NAMES.files.right} (то же имя) в фоне (background: true): задание то же, что у ` +
        `${SUBAGENT_NAMES.files.left}, те же файлы и картинки.`,
      `3. Сам ${kReads(facts, ["left", "right"])}.`,
      "Цвет пиши одним английским словом строчными буквами (red, green или blue), содержимое файла — как есть.",
      laterResult(`Когда придёт результат ${SUBAGENT_NAMES.files.right}`, `${K_RESULT_FIELDS}\nВ разделах "left" и "right" укажи то, ` +
        "что сообщил этот суб-агент, в разделе \"main\" — то, что прочитал и увидел ты сам")
    ].join("\n\n"),
    chart: () => `Сделай в фоне простой столбчатый график продаж по кварталам (Q1 — 10, Q2 — 14, Q3 — 9, Q4 — 17) в виде PNG: запусти ` +
      `для этого суб-агента ${SUBAGENT_NAMES.files.chart} в фоне (background: true). ${NO_WEB} ${START_AND_REPLY} Когда он закончит, ` +
      "сам посмотри на готовый график и отдай мне его файлом, чтобы я мог его скачать. Ответь коротко.",
    blind: (facts: ScenarioKFacts, model: string) => `Вызови нового суб-агента ${SUBAGENT_NAMES.files.blind} и дождись его результата ` +
      `(не в фоне), задай ему модель ${model} (параметр model). Его задание: ровно один раз посмотреть файл ${facts.directory}/main.png ` +
      `${K_IMAGE_TOOL}, не запуская команд, и сообщить, какого цвета картинка. ${NO_WEB} Сам на картинку не смотри. ` +
      "В ответе мне напиши этот цвет одним английским словом."
  }),
  L: () => [
    `Посчитай точную сумму второго столбца (amount) листа ${L_SHEET} в приложенном файле ${SCENARIO_L_FILE_NAME}. ` +
      "Первая строка — заголовок, значения в столбце — целые числа.",
    "Сделай только одно вычисление: выполни в Workspace один скрипт на Python, который читает сам файл и суммирует все строки " +
      `этого столбца. Суб-агентов не запускай, файлов для скачивания не создавай. ${NO_WEB}`,
    "Ответь одной строкой: только сумма цифрами, без пробелов и разделителей."
  ].join("\n\n")
});

// Oracles over the result file ------------------------------------------------------

/** Shape first (status and blocked), then the scenario's section. */
function shaped(value: BrowserResult, check: (value: BrowserResult) => OracleVerdict): OracleVerdict {
  const shape = resultShapeErrors(value, null);
  return shape.length > 0 ? { counts: {}, failed: shape } : check(value);
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** A: at least 10 distinct options, each with a name and a page of its own. */
export function oracleA(value: BrowserResult): OracleVerdict {
  return shaped(value, (result) => {
    const listed = Array.isArray(result.options) ? result.options.filter(record) : [];
    const pages = new Set<string>();
    const names = new Set<string>();
    for (const option of listed) {
      if (!nonEmptyText(option.name) || !httpUrl(option.url)) continue;
      const page = canonicalPageKey(String(option.url));
      const name = nameKey(option.name);
      if (!page || pages.has(page) || names.has(name)) continue;
      pages.add(page);
      names.add(name);
    }
    return { counts: { distinctOptions: names.size, options: listed.length },
      failed: names.size < 10 ? ["options_lt_10"] : [] };
  });
}

/** B: the wake-up answer lists the five background sub-agents. */
export function oracleB(value: BrowserResult): OracleVerdict {
  return shaped(value, (result) => {
    const listed = Array.isArray(result.agents) ? result.agents.filter(record) : [];
    const expected: readonly string[] = SUBAGENT_NAMES.background;
    const seen = new Set(listed.map((agent) => nameKey(agent.name)).filter((name) => expected.includes(name)));
    return { counts: { agents: listed.length, expectedAgents: seen.size }, failed: seen.size < expected.length ? ["agents_lt_5"] : [] };
  });
}

/** C: the S6 oracle, unchanged. */
export function oracleC(value: BrowserResult): OracleVerdict {
  return checkBrowserResult(BROWSER_SCENARIOS.S6, value);
}

/** D: five distinct amazon.es products, each with price, rating, review count and product page. */
export function oracleD(value: BrowserResult): OracleVerdict {
  return shaped(value, (result) => {
    const listed = Array.isArray(result.products) ? result.products.filter(record) : [];
    const keys = new Set<string>();
    for (const product of listed) {
      const key = amazonProductKey(product.url);
      if (key && nonEmptyText(product.name) && euroAmount(product.price) !== null && ratingValue(product.rating) !== null &&
        reviewCount(product.reviews) !== null) keys.add(key);
    }
    const failed: string[] = [];
    if (keys.size < 5) failed.push("products_lt_5");
    if (blockedCodes(result.blocked).length > 0) failed.push("blocked_reported");
    return { counts: { distinctProducts: keys.size, products: listed.length }, failed };
  });
}

/**
 * E: the correction reached the running sub-agent and it followed it: the
 * log ends with the new word, never goes back to the old one after the
 * first new line, and has at least 6 of its 8 steps (one may be cut short
 * when the message lands mid-step).
 */
export function oracleE(value: BrowserResult, secrets: RunSecrets): OracleVerdict {
  return shaped(value, (result) => {
    const lines = Array.isArray(result.lines) ? result.lines.filter(record) : [];
    const words = lines.map((line) => typeof line.word === "string" ? line.word.trim().toUpperCase() : "");
    const from = secrets.correctionFrom.toUpperCase();
    const to = secrets.correctionTo.toUpperCase();
    const firstTo = words.indexOf(to);
    const backToOld = firstTo >= 0 && words.slice(firstTo).includes(from);
    const failed: string[] = [];
    if (lines.length < 6) failed.push("lines_lt_6");
    if (firstTo < 0) failed.push("correction_not_followed");
    else if (backToOld) failed.push("correction_reverted");
    else if (words.at(-1) !== to) failed.push("last_line_not_corrected");
    if (words.some((word) => word !== from && word !== to)) failed.push("unknown_word");
    return { counts: { fromLines: words.filter((word) => word === from).length, lines: lines.length,
      toLines: words.filter((word) => word === to).length }, failed };
  });
}

const valueText = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : null;

/** F, before the edit: the continued sub-agent recalled the value only it computed. */
export function oracleFContinued(value: BrowserResult, expected: string): OracleVerdict {
  return shaped(value, (result) => {
    const recalled = valueText(result.value) === expected.toLowerCase();
    return { counts: { recalled: flag(recalled) }, failed: recalled ? [] : ["value_not_recalled"] };
  });
}

/** F, on the edited branch: the abandoned branch's sub-agent and its value are out of reach. */
export function oracleFBranched(value: BrowserResult, expected: string): OracleVerdict {
  return shaped(value, (result) => {
    const seen = valueText(result.value) === expected.toLowerCase();
    return { counts: { abandonedValueSeen: flag(seen), valueNull: flag(result.value === null) },
      failed: seen ? ["abandoned_branch_value_seen"] : [] };
  });
}

/** H: S5's checkout oracle on the result file, and S5's handoff and leak check on the sub-agents' rows. */
export function oracleH(value: BrowserResult, evidence: ScenarioRunEvidence): OracleVerdict {
  const file = checkBrowserResult(BROWSER_SCENARIOS.S5, value);
  const run = oracleS5Run(evidence);
  return { counts: { ...file.counts, ...run.counts }, failed: [...file.failed, ...run.failed] };
}

/** I: the scheduled run's sub-agent computed the number. */
export function oracleI(value: BrowserResult): OracleVerdict {
  return shaped(value, (result) => {
    const right = result.value === 42 || (typeof result.value === "string" && result.value.trim() === "42");
    return { counts: { valueRight: flag(right) }, failed: right ? [] : ["value_wrong"] };
  });
}

// Evidence from stored rows ---------------------------------------------------------

type Instant = Date | string;
const time = (value: Instant | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
};

/** A `SubagentTurn` with its parent run's binding, read in memory only. */
export type TurnRow = Readonly<{
  callbackRunId: string | null;
  effortSource: string;
  endedAt: Instant | null;
  /** The background run that executes it (`ModelRun.subagentTurnId`); null for a foreground turn. */
  executionRunId: string | null;
  mode: string;
  modelId: string;
  modelSource: string;
  outcome: string | null;
  parentEffort: string | null;
  /** The parent run's model id (`ModelRun.modelId`), the same field as the turn's `modelId`. */
  parentModelId: string;
  /**
   * The connection the parent run is bound to: its `ProviderRunBinding` of role
   * `answer` (`connectionId`), the same kind of id as the turn's `provider`.
   * `ModelRun.provider` is the adapter kind and is never compared.
   */
  parentProvider: string | null;
  parentRunId: string;
  provider: string;
  /** The turn's catalog row id (`ProviderModel.id`); not comparable with the parent run's `modelId`. */
  providerModelId: string | null;
  reasonCode: string | null;
  reasoningEffort: string | null;
  startedAt: Instant;
  state: string;
  threadId: string;
  turnId: string;
}>;

const isActive = (state: string) => (ACTIVE_SUBAGENT_STATES as readonly string[]).includes(state);

/** How many turns ran on the parent's model and effort, and how many took them from the parent (no override, no type). */
export function bindingEvidence(turns: readonly TurnRow[]) {
  const onParentModel = turns.filter((turn) => turn.provider === turn.parentProvider && turn.modelId === turn.parentModelId).length;
  const onParentEffort = turns.filter((turn) => (turn.reasoningEffort ?? null) === (turn.parentEffort ?? null)).length;
  return {
    allOnParentBinding: turns.length > 0 && onParentModel === turns.length && onParentEffort === turns.length,
    backgroundTurns: turns.filter((turn) => turn.mode === "background").length,
    foregroundTurns: turns.filter((turn) => turn.mode === "foreground").length,
    onParentEffort,
    onParentModel,
    parentSourced: turns.filter((turn) => turn.modelSource === "parent" && turn.effortSource === "parent").length,
    threads: new Set(turns.map((turn) => turn.threadId)).size,
    turns: turns.length
  };
}

/**
 * C2: how many turns ran on the model the call named, with the call as its
 * source: the turn's `modelId` is one of the second model's ids (its upstream
 * id, which the call names, or the catalog's model id) on its connection.
 */
export function requestedModelEvidence(turns: readonly TurnRow[], target: Readonly<{ modelIds: readonly string[]; provider: string }>) {
  const onRequested = turns.filter((turn) => turn.provider === target.provider && target.modelIds.includes(turn.modelId)).length;
  return {
    allOnRequestedModel: turns.length > 0 && onRequested === turns.length,
    callSourced: turns.filter((turn) => turn.modelSource === "call").length,
    onRequestedModel: onRequested
  };
}

/** Turn states and end reasons as counts, for the line. */
export function turnOutcomes(turns: readonly TurnRow[]) {
  const states: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const reasonsByMode: Record<string, Record<string, number>> = {};
  for (const turn of turns) {
    states[turn.state] = (states[turn.state] ?? 0) + 1;
    if (!turn.reasonCode) continue;
    const reason = stableCode(turn.reasonCode);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    const mode = reasonsByMode[stableCode(turn.mode)] ??= {};
    mode[reason] = (mode[reason] ?? 0) + 1;
  }
  return { reasons, reasonsByMode, states };
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
/** A stable code as stored, `other` for anything that is not code-shaped (never text), `none` when absent. */
export function stableCode(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "none";
  return CODE_PATTERN.test(value) ? value : "other";
}
const toolKey = (value: string) => /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : "other";

export type Interval = Readonly<{ end: number | null; key: string; start: number }>;

/**
 * The most distinct keys open at one instant: an interval covers
 * [start, end), an open one (null end) runs until `now`. Intervals of one key
 * overlapping each other count once.
 */
export function peakConcurrency(intervals: readonly Interval[], now: number): number {
  const events: { at: number; delta: 1 | -1; key: string }[] = [];
  for (const interval of intervals) {
    const end = interval.end ?? now;
    if (!(end > interval.start)) continue;
    events.push({ at: interval.start, delta: 1, key: interval.key }, { at: end, delta: -1, key: interval.key });
  }
  // Ends before starts at one instant: back-to-back intervals do not overlap.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const open = new Map<string, number>();
  let peak = 0;
  for (const event of events) {
    const count = (open.get(event.key) ?? 0) + event.delta;
    if (count <= 0) open.delete(event.key);
    else open.set(event.key, count);
    peak = Math.max(peak, open.size);
  }
  return peak;
}

/** The most sub-agent turns running at once, from their start and end. */
export function peakConcurrentTurns(turns: readonly TurnRow[], now: number): number {
  return peakConcurrency(turns.flatMap((turn) => {
    const start = time(turn.startedAt);
    return start === null ? [] : [{ end: time(turn.endedAt), key: turn.turnId, start }];
  }), now);
}

/**
 * A tool call of the chat's runs, read for the timeline. `browser`, `busy`,
 * `memoryLow` and `backgroundRefused` are computed in SQL from the call's
 * arguments and result, which never leave the database.
 */
export type ToolRow = Readonly<{
  backgroundRefused: boolean;
  browser: boolean;
  busy: boolean;
  completedAt: Instant | null;
  memoryLow: boolean;
  /**
   * The stable code of the stored result (`ModelRunToolCall.result`), read in
   * SQL from its first content block: a JSON block's `error` string,
   * `error.code` or `code`, `ended_<state>` for a sub-agent call's ended
   * result, or a text block's Workspace envelope `{"ok":false,"error":{"code":…}}`.
   * Null when there is none.
   */
  resultCode: string | null;
  /** A sub-agent call's ended `reason` (for `stop_subagent`: `stop_subagent` when this call stopped a running turn). */
  resultReason: string | null;
  roundIndex: number;
  runId: string;
  startedAt: Instant | null;
  state: string;
  /**
   * For `stop_subagent` only: whether a turn of the named thread was active
   * when the call started, and its mode (matched in SQL; the name never leaves it).
   */
  stopTarget: "background" | "foreground" | "none" | null;
  threadId: string | null;
  toolName: string;
  turnId: string | null;
}>;

const agentKey = (row: Pick<ToolRow, "threadId">) => row.threadId ?? "main";

/** Browser use over the timeline: who browsed, at most how many agents at once, and the lease refusals. */
export function browserEvidence(rows: readonly ToolRow[], now: number) {
  const browsing = rows.filter((row) => row.browser);
  return {
    browserBusyResults: rows.filter((row) => row.busy).length,
    browserCalls: browsing.length,
    browserMemoryLowResults: rows.filter((row) => row.memoryLow).length,
    browsingAgents: new Set(browsing.map(agentKey)).size,
    mainAgentBrowserCalls: browsing.filter((row) => row.threadId === null).length,
    peakBrowsingAgents: peakConcurrency(browsing.flatMap((row) => {
      const start = time(row.startedAt);
      return start === null ? [] : [{ end: time(row.completedAt), key: agentKey(row), start }];
    }), now)
  };
}

/** Rounds per agent: the main agent's (its runs' highest round summed per run) and each sub-agent's, highest first. */
export function roundsPerAgent(rows: readonly ToolRow[]) {
  const main = new Map<string, number>();
  const threads = new Map<string, number>();
  for (const row of rows) {
    if (row.threadId === null) main.set(row.runId, Math.max(main.get(row.runId) ?? 0, row.roundIndex));
    else threads.set(row.threadId, Math.max(threads.get(row.threadId) ?? 0, row.roundIndex));
  }
  return {
    mainRounds: [...main.values()].reduce((sum, rounds) => sum + rounds, 0),
    subagentRounds: [...threads.values()].sort((a, b) => b - a),
    toolCalls: rows.length,
    failedToolCalls: rows.filter((row) => row.state === "error").length
  };
}

/** The main agent's sub-agent tool calls: how many, how many in one round at most (parallel starts), and refusals of background. */
export function subagentCallEvidence(rows: readonly ToolRow[]) {
  const calls = rows.filter((row) => row.threadId === null && row.toolName === "call_subagent");
  const perRound = new Map<string, number>();
  for (const call of calls) perRound.set(`${call.runId}:${call.roundIndex}`, (perRound.get(`${call.runId}:${call.roundIndex}`) ?? 0) + 1);
  return {
    backgroundRefusals: calls.filter((call) => call.backgroundRefused).length,
    callSubagentCalls: calls.length,
    maxCallSubagentPerRound: Math.max(0, ...perRound.values()),
    stopSubagentCalls: rows.filter((row) => row.threadId === null && row.toolName === "stop_subagent").length
  };
}

/** Failed tool calls as `{ main | subagent: { tool: { code: count } } }`, from stable result codes only. */
export function failedToolCalls(rows: readonly ToolRow[]) {
  const byAgent: Record<"main" | "subagent", Record<string, Record<string, number>>> = { main: {}, subagent: {} };
  for (const row of rows) {
    if (row.state !== "error") continue;
    const tools = byAgent[row.threadId === null ? "main" : "subagent"];
    const codes = tools[toolKey(row.toolName)] ??= {};
    const code = stableCode(row.resultCode);
    codes[code] = (codes[code] ?? 0) + 1;
  }
  return byAgent;
}

/**
 * The main agent's `stop_subagent` calls: what each found (an active
 * background or foreground turn of that name, or none), how many stopped a
 * running turn themselves, and the result codes by count. A stop's result is
 * the stopped turn's ended result, which the engine stores as an error.
 */
export function stopSubagentCalls(rows: readonly ToolRow[]) {
  const calls = rows.filter((row) => row.threadId === null && row.toolName === "stop_subagent");
  const resultCodes: Record<string, number> = {};
  for (const call of calls) {
    const code = stableCode(call.resultCode);
    resultCodes[code] = (resultCodes[code] ?? 0) + 1;
  }
  return {
    calls: calls.length,
    resultCodes,
    stoppedRunningTurn: calls.filter((call) => call.resultReason === "stop_subagent").length,
    targetedActiveBackground: calls.filter((call) => call.stopTarget === "background").length,
    targetedActiveForeground: calls.filter((call) => call.stopTarget === "foreground").length,
    targetedNothingActive: calls.filter((call) => call.stopTarget === "none").length
  };
}

/**
 * The main agent's `call_subagent` refusals by code (`subagent_background_unavailable`,
 * `subagent_busy`, `subagent_limit_reached`, ...), and its calls whose turn
 * ended other than done, by `ended_<state>`.
 */
export function callSubagentOutcomes(rows: readonly ToolRow[]) {
  const refusals: Record<string, number> = {};
  const endedNotDone: Record<string, number> = {};
  for (const row of rows) {
    if (row.threadId !== null || row.toolName !== "call_subagent" || row.state !== "error") continue;
    const code = stableCode(row.resultCode);
    const bucket = code.startsWith("ended_") ? endedNotDone : refusals;
    bucket[code] = (bucket[code] ?? 0) + 1;
  }
  return { endedNotDone, refusals };
}

/** A `UsageEvent` of the chat's runs: purpose and token numbers only. */
export type PurposeUsageRow = Readonly<{
  cachedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  purpose: string;
}>;

export type PurposeUsage = Readonly<{
  cachedInputTokens: number | null;
  costEstimates: CostEstimates | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rows: number;
}>;

/**
 * Provider-reported tokens per usage purpose (`chat_answer` for the main
 * agent, `subagent` for sub-agents), with cost estimates at the baseline's
 * list prices. A sum stays null when any row of the purpose did not report
 * the field: never estimated.
 */
export function usageByPurpose(rows: readonly PurposeUsageRow[]) {
  const purposes = [...new Set(rows.map((row) => row.purpose))].sort();
  const sum = (own: readonly PurposeUsageRow[], key: "cachedInputTokens" | "inputTokens" | "outputTokens") =>
    own.length > 0 && own.every((row) => row[key] !== null) ? own.reduce((total, row) => total + (row[key] ?? 0), 0) : null;
  const byPurpose: Record<string, PurposeUsage> = {};
  for (const purpose of purposes) {
    const own = rows.filter((row) => row.purpose === purpose);
    const inputTokens = sum(own, "inputTokens");
    const outputTokens = sum(own, "outputTokens");
    byPurpose[purpose] = { cachedInputTokens: sum(own, "cachedInputTokens"), costEstimates: costEstimates(inputTokens, outputTokens),
      inputTokens, outputTokens, rows: own.length };
  }
  const inputTokens = sum(rows, "inputTokens");
  const outputTokens = sum(rows, "outputTokens");
  return {
    byPurpose,
    split: (byPurpose.chat_answer?.rows ?? 0) > 0 && (byPurpose.subagent?.rows ?? 0) > 0,
    total: { costEstimates: costEstimates(inputTokens, outputTokens), inputTokens, outputTokens, rows: rows.length }
  };
}

/** A server-written wake-up turn of the chat (`Message.systemTurnKind = subagent_callback`) and its answer's run. */
export type WakeUpRow = Readonly<{ createdAt: Instant; runId: string | null; runStatus: string | null }>;

/**
 * Callback delivery: each ended background turn's callback went to one
 * main-agent run, either a wake-up turn or a running answer (a follow-up).
 * `coalesced` is true when a wake-up took more than one callback.
 * `secondsToWakeUp` runs from the first background end at or after `since`
 * to the first wake-up turn after it.
 */
export function callbackEvidence(turns: readonly TurnRow[], wakeUps: readonly WakeUpRow[], since: number | null = null) {
  const background = turns.filter((turn) => turn.mode === "background");
  const ended = background.filter((turn) => !isActive(turn.state));
  const wakeRuns = new Set(wakeUps.flatMap((wakeUp) => wakeUp.runId ? [wakeUp.runId] : []));
  const perWake = new Map<string, number>();
  let intoRunningAnswer = 0;
  for (const turn of ended) {
    if (!turn.callbackRunId) continue;
    if (wakeRuns.has(turn.callbackRunId)) perWake.set(turn.callbackRunId, (perWake.get(turn.callbackRunId) ?? 0) + 1);
    else intoRunningAnswer += 1;
  }
  const ends = ended.map((turn) => time(turn.endedAt)).filter((at): at is number => at !== null && (since === null || at >= since));
  const firstEnd = ends.length > 0 ? Math.min(...ends) : null;
  const wakes = wakeUps.map((wakeUp) => time(wakeUp.createdAt)).filter((at): at is number => at !== null &&
    (firstEnd === null || at >= firstEnd)).sort((a, b) => a - b);
  const callbacksByWakeUp = [...perWake.values()].sort((a, b) => b - a);
  return {
    backgroundTurns: background.length,
    callbacksByWakeUp,
    callbacksDelivered: ended.filter((turn) => turn.callbackRunId !== null).length,
    callbacksIntoRunningAnswer: intoRunningAnswer,
    callbacksOwed: ended.filter((turn) => turn.callbackRunId === null).length,
    coalesced: callbacksByWakeUp.some((count) => count > 1),
    endedBackgroundTurns: ended.length,
    secondsToWakeUp: firstEnd !== null && wakes[0] !== undefined ? Math.round((wakes[0] - firstEnd) / 100) / 10 : null,
    wakeUpTurns: wakeUps.length
  };
}

// Thread states over time ----------------------------------------------------------

export type StateCounts = Readonly<Record<string, number>>;

/** Thread states as counts in the vocabulary's order; an unknown state counts as `other`. */
export function stateCounts(states: readonly string[]): StateCounts {
  const counts: Record<string, number> = {};
  for (const state of states) {
    const key = (SUBAGENT_THREAD_STATES as readonly string[]).includes(state) ? state : "other";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const ordered: Record<string, number> = {};
  for (const key of [...SUBAGENT_THREAD_STATES, "other"]) if (counts[key] !== undefined) ordered[key] = counts[key];
  return ordered;
}

const sameCounts = (a: StateCounts, b: StateCounts) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, count]) => b[key] === count);

/** Appends a poll's counts when they differ from the last ones, keeping at most `max` steps (the newest replaces the last). */
export function appendProgression(series: readonly StateCounts[], next: StateCounts, max = 48): StateCounts[] {
  const last = series.at(-1);
  if (last && sameCounts(last, next)) return [...series];
  return series.length < max ? [...series, next] : [...series.slice(0, max - 1), next];
}

/** Whether any step of a progression had a thread in `state`. */
export function progressionSaw(series: readonly StateCounts[], state: SubagentThreadState): boolean {
  return series.some((counts) => (counts[state] ?? 0) > 0);
}

// The capture and retire defects (J) -----------------------------------------------

/** The tools a sub-agent looks at a Workspace image with (`lib/server/tools/`). */
const IMAGE_TOOLS: readonly string[] = ["analyze_image", "view_workspace_image"];

/**
 * The longest a healthy last turn may leave its session `RUNNING`, in seconds.
 * The ordinary path stops the VM before the turn's end is written, so this is
 * normally zero or less; it stays under the 30 s a session must sit stale before
 * maintenance takes it (`SESSION_BACKSTOP_STALE_MS` in `lib/server/workspace/cleanup.ts`).
 */
export const SCENARIO_J_STOP_SECONDS = 25;

/** One thread's image tool calls: how many, how many gave a result, and the others by stable code. */
export function imageToolEvidence(rows: readonly ToolRow[], threadId: string | null) {
  return imageCallEvidence(threadId === null ? [] : rows.filter((row) => row.threadId === threadId && IMAGE_TOOLS.includes(row.toolName)));
}

/** The same for the main agent's own calls in the given runs. */
export function mainImageToolEvidence(rows: readonly ToolRow[], runIds: readonly string[]) {
  return imageCallEvidence(rows.filter((row) => row.threadId === null && runIds.includes(row.runId) && IMAGE_TOOLS.includes(row.toolName)));
}

function imageCallEvidence(calls: readonly ToolRow[]) {
  const succeeded = calls.filter((row) => row.state === "complete" && row.resultCode === null);
  const failureCodes: Record<string, number> = {};
  for (const call of calls) {
    if (succeeded.includes(call)) continue;
    const code = stableCode(call.resultCode);
    failureCodes[code] = (failureCodes[code] ?? 0) + 1;
  }
  return { calls: calls.length, failureCodes, succeeded: succeeded.length };
}

/**
 * Whether J reached what the retire defect needs, the model deciding: the
 * Workspace-free agent ended last, touched no tool, and no main-agent run was
 * still attached beside it. `order_not_reached` is data, not a failure.
 */
export function scenarioJOrder(input: Readonly<{
  mainRunsActive: number; quiet: TurnRow | null; quietToolCalls: number; viewer: TurnRow | null;
}>) {
  const quietEnd = time(input.quiet?.endedAt);
  const viewerEnd = time(input.viewer?.endedAt);
  const lastTurnEnd = quietEnd === null || viewerEnd === null ? null : Math.max(quietEnd, viewerEnd);
  const reached = quietEnd !== null && viewerEnd !== null && viewerEnd < quietEnd && input.quietToolCalls === 0 && input.mainRunsActive === 0;
  return { lastTurnEnd, mainRunsActive: input.mainRunsActive, order_not_reached: !reached, quietToolCalls: input.quietToolCalls };
}

/** The chat's `WorkspaceSession` at one instant; `owner` is the kind of its operation, never the owner itself. */
export type SessionSample = Readonly<{ at: Instant; closing: boolean; owner: "maintenance" | "none" | "other"; state: string }>;

/** Appends a sample when the session changed, keeping at most `max` steps (the newest replaces the last). */
export function appendSessionSample(series: readonly SessionSample[], next: SessionSample, max = 64): SessionSample[] {
  const last = series.at(-1);
  if (last && last.state === next.state && last.owner === next.owner && last.closing === next.closing) return [...series];
  return series.length < max ? [...series, next] : [...series.slice(0, max - 1), next];
}

/**
 * How the session left `RUNNING` around the last turn's end: the state it went
 * to, the signed seconds from that end (negative: it left first, the ordinary
 * order), and whether maintenance held it on the way, which only the backstop does.
 */
export function sessionStopEvidence(samples: readonly SessionSample[], lastTurnEnd: number | null) {
  const running = samples.flatMap((sample, index) => sample.state === "RUNNING" &&
    (lastTurnEnd === null || (time(sample.at) ?? Infinity) <= lastTurnEnd) ? [index] : []).at(-1);
  const tail = running === undefined ? [] : samples.slice(running);
  const left = tail.find((sample) => sample.state !== "RUNNING") ?? null;
  const leftAt = time(left?.at);
  return {
    finalState: samples.at(-1)?.state ?? null,
    leftRunningTo: left?.state ?? null,
    maintenanceHeld: tail.some((sample) => sample.owner === "maintenance"),
    runningSeen: running !== undefined,
    secondsToLeaveRunning: leftAt === null || lastTurnEnd === null ? null : Math.round((leftAt - lastTurnEnd) / 100) / 10
  };
}

/** A refusal that only means the server's wake-up took the turn first: the composer's next send goes through. */
export const SEND_LOST_TO_WAKE_UP = "lost_to_wake_up";

/**
 * Why a send was refused. The API answers `workspace_busy` whichever rule
 * refused (the reason stays in the server's log), so the session as it stands
 * right after tells the rules apart: `workspace_busy_session_state` is the
 * retire defect's signature, a `RUNNING` session that nothing owns.
 */
export function sendRefusal(code: string, input: Readonly<{ mainRunActive: boolean; session: SessionSample | null }>): string {
  const state = input.session?.state;
  if (code === "workspace_busy" && input.session?.owner === "none" && (state === "RUNNING" || state === "CREATING")) {
    return "workspace_busy_session_state";
  }
  if (code === "active_run_in_progress" || code === "active_leaf_changed" || input.mainRunActive) return SEND_LOST_TO_WAKE_UP;
  if (code === "workspace_busy") return input.session?.closing ? "workspace_busy_join_closing" : "workspace_busy_other";
  return stableCode(code);
}

/**
 * J's verdict. A wake-up is required only where one is due: a callback that
 * went into a running answer needs none, and the second message may win that
 * race, but no callback may stay owed either way. The stop's timing is judged
 * only when the order was reached; a backstop stop never passes.
 */
export function oracleJ(input: Readonly<{
  callbacks: ReturnType<typeof callbackEvidence>;
  failures: Readonly<{ captureIdentity: number; visionInternal: number }>;
  image: ReturnType<typeof imageToolEvidence>;
  order: ReturnType<typeof scenarioJOrder>;
  secondAccepted: boolean;
  secondAnswered: boolean;
  secondRefusals: readonly string[];
  session: ReturnType<typeof sessionStopEvidence>;
  settled: boolean;
  wakeUps: readonly WakeUpRow[];
}>): OracleVerdict {
  const { callbacks, failures, image, order, session } = input;
  const failed: string[] = [];
  if (image.succeeded === 0) failed.push("image_tool_not_succeeded");
  if (failures.captureIdentity > 0) failed.push("capture_identity_failure");
  if (failures.visionInternal > 0) failed.push("vision_internal_failure");
  if (input.secondRefusals.includes("workspace_busy_session_state")) failed.push("workspace_busy_session_state");
  else if (input.secondRefusals.some((refusal) => refusal !== SEND_LOST_TO_WAKE_UP)) failed.push("second_send_refused");
  if (!input.secondAccepted) failed.push("second_send_not_accepted");
  else if (!input.secondAnswered) failed.push("second_message_not_answered");
  if (callbacks.backgroundTurns !== 2) failed.push("background_turns_not_2");
  if (!input.settled) failed.push("callbacks_still_owed");
  else if (callbacks.callbacksOwed > 0 || callbacks.callbacksDelivered < callbacks.backgroundTurns) failed.push("callbacks_owed");
  if (callbacks.callbacksDelivered > callbacks.callbacksIntoRunningAnswer && callbacks.wakeUpTurns === 0) failed.push("no_wake_up");
  if (input.wakeUps.some((wakeUp) => wakeUp.runStatus !== "complete")) failed.push("wake_up_not_complete");
  if (!session.runningSeen) failed.push("session_never_running");
  else if (session.leftRunningTo === null) failed.push("session_still_running");
  else if (session.leftRunningTo !== "STOPPED" && session.leftRunningTo !== "PENDING") failed.push("session_left_to_other_state");
  if (session.maintenanceHeld) failed.push("session_stopped_by_backstop");
  if (!order.order_not_reached && (session.secondsToLeaveRunning ?? 0) > SCENARIO_J_STOP_SECONDS) failed.push("session_stop_slow");
  return { counts: { imageCalls: image.calls, imageSucceeded: image.succeeded, secondRefusals: input.secondRefusals.length,
    wakeUps: input.wakeUps.length }, failed };
}

// Files and images across agents (K) -----------------------------------------------

/** K's reads as the result file reports them: every text exact, every picture's colour named. Only the name of a wrong read is kept. */
export function oracleKReads(value: BrowserResult, texts: ScenarioKFacts["texts"]): OracleVerdict {
  return shaped(value, (result) => {
    const failed: string[] = [];
    let reads = 0;
    for (const [reader, agents] of Object.entries(K_READ_SECTIONS)) {
      const reported = result[reader];
      const section: Readonly<Record<string, unknown>> = record(reported) ? reported : {};
      for (const agent of agents) {
        const text = section[`${agent}_text`];
        const color = section[`${agent}_color`];
        const textRead = typeof text === "string" && text.trim().toLowerCase() === texts[agent];
        const colorRead = typeof color === "string" && color.trim().toLowerCase() === K_COLORS[agent].name;
        reads += flag(textRead) + flag(colorRead);
        if (!textRead) failed.push(`${reader}_read_${agent}_text`);
        if (!colorRead) failed.push(`${reader}_read_${agent}_color`);
      }
    }
    return { counts: { reads }, failed };
  });
}

/** The exported PNGs of the runs: only sizes and whether the bytes the user downloads open as a PNG. */
export type KChartDownload = Readonly<{ bytes: number; png: boolean }>;

export function pngBytes(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** A sub-agent on a model without vision: direct view is never called, System Vision answers. */
export function blindImageEvidence(rows: readonly ToolRow[], threadId: string | null) {
  const own = threadId === null ? [] : rows.filter((row) => row.threadId === threadId);
  return { ...imageToolEvidence(own.filter((row) => row.toolName === "analyze_image"), threadId),
    viewCalls: own.filter((row) => row.toolName === "view_workspace_image").length };
}

/**
 * K's verdict beyond the reads. Each named sub-agent's turns ended `done` and
 * its second turn continued its thread; the chart's turn ran in the background,
 * the main agent looked at the picture and the user can download it. Without a
 * model without vision that step is `blind: null`, which is data, not a pass of it.
 */
export function oracleKFlow(input: Readonly<{
  blind: Readonly<{ answered: boolean; image: ReturnType<typeof blindImageEvidence>; turn: TurnRow | null }> | null;
  callbacks: ReturnType<typeof callbackEvidence>;
  chart: Readonly<{ downloads: readonly KChartDownload[]; mainImage: ReturnType<typeof imageCallEvidence>; turn: TurnRow | null }>;
  images: Readonly<{ left: ReturnType<typeof imageToolEvidence>; main: ReturnType<typeof imageCallEvidence>; right: ReturnType<typeof imageToolEvidence> }>;
  left: readonly TurnRow[];
  right: readonly TurnRow[];
  settled: boolean;
}>): OracleVerdict {
  const { blind, callbacks, chart, images, left, right } = input;
  const failed: string[] = [];
  const done = (turn: TurnRow | null | undefined) => turn?.state === "done";
  if (left.length !== 2 || left.some((turn) => !done(turn)) || left[0]?.mode !== "background" || left[1]?.mode !== "foreground") failed.push("left_not_continued_in_foreground");
  if (right.length !== 2 || right.some((turn) => !done(turn)) || right.some((turn) => turn.mode !== "background")) failed.push("right_not_continued_in_background");
  // One picture in the first turn, three in the continued one, its own earlier one among them.
  if (images.left.succeeded < 4) failed.push("left_images_not_read");
  if (images.right.succeeded < 4) failed.push("right_images_not_read");
  if (images.main.succeeded < 2) failed.push("main_images_not_read");
  if (!done(chart.turn) || chart.turn?.mode !== "background") failed.push("chart_turn_not_done_in_background");
  if (chart.mainImage.succeeded === 0) failed.push("chart_not_viewed_by_main");
  if (!chart.downloads.some((download) => download.png && download.bytes > 0)) failed.push("chart_not_downloadable");
  if (blind) {
    if (!done(blind.turn)) failed.push("blind_turn_not_done");
    if (blind.image.viewCalls > 0) failed.push("blind_called_direct_view");
    if (blind.image.succeeded === 0) failed.push("blind_image_not_analyzed");
    if (!blind.answered) failed.push("blind_color_not_answered");
  }
  if (!input.settled || callbacks.callbacksOwed > 0) failed.push("callbacks_owed");
  return { counts: { chartDownloads: chart.downloads.length, leftImages: images.left.succeeded, leftTurns: left.length,
    mainChartViews: chart.mainImage.succeeded, mainImages: images.main.succeeded, rightImages: images.right.succeeded, rightTurns: right.length }, failed };
}

// A document the parser refuses, read in the Workspace (L) --------------------------

/** L's stored attachment, read in memory only: its state, its code and whether it has text. */
export type LAttachmentRow = Readonly<{ extractedTextNull: boolean; processingErrorCode: string | null; status: string }>;

/** What must hold before anything paid is sent; null is an upload the parser never settled. */
export function scenarioLUploadChecks(row: LAttachmentRow | null): string[] {
  if (row === null) return ["upload_not_settled"];
  const failed: string[] = [];
  if (row.status !== "failed") failed.push("upload_not_failed");
  if (row.processingErrorCode !== "parser_output_too_large") failed.push("upload_code_not_output_too_large");
  if (!row.extractedTextNull) failed.push("upload_has_extracted_text");
  return failed;
}

/**
 * The expected sum as a regular expression over the answer, valid in PostgreSQL
 * and JavaScript and matched inside SQL: the whole number, with or without
 * thousands separators (a model may ignore the prompt's format, which is not
 * what L proves).
 */
export function scenarioLAnswerPattern(sum: number): string {
  const groups = String(sum).match(/\d{1,3}(?=(?:\d{3})*$)/gu) ?? [];
  return `(^|[^0-9])${groups.join("[ ,\u00a0\u202f]?")}([^0-9]|$)`;
}

/** A Workspace tool call of the run; `namesInbox` and `unknownOutcome` are computed in SQL from arguments and a result that never leave it. */
export type LWorkspaceCall = Readonly<{ namesInbox: boolean; state: string; toolName: string; unknownOutcome: boolean }>;

/** A Workspace tool as stored, the provider-facing name of `lib/server/workspace/toolCatalog.ts`. */
const WORKSPACE_TOOL_NAME = /^mcp_workspace_(sandbox_[a-z_]+)_[0-9a-f]{10}$/u;
const WORKSPACE_COMMAND_TOOLS: readonly string[] = ["sandbox_exec", "sandbox_exec_start", "sandbox_shell"];

/** A sandbox file call may hold the script that names the file, so `inboxCalls` counts every Workspace tool. */
export function scenarioLWorkspaceEvidence(rows: readonly LWorkspaceCall[]) {
  const calls = rows.filter((row) => WORKSPACE_TOOL_NAME.test(row.toolName));
  const finished = calls.filter((row) => row.state === "complete" && !row.unknownOutcome);
  return {
    commands: finished.filter((row) => WORKSPACE_COMMAND_TOOLS.includes(WORKSPACE_TOOL_NAME.exec(row.toolName)?.[1] ?? "")).length,
    inboxCalls: finished.filter((row) => row.namesInbox).length,
    unknownOutcomes: calls.filter((row) => row.unknownOutcome).length,
    workspaceCalls: calls.length
  };
}

/** L's verdict: only a real model reading the original can name a sum no prompt and no extracted text holds. */
export function oracleL(input: Readonly<{
  answerHasSum: boolean; terminal: string; workspace: ReturnType<typeof scenarioLWorkspaceEvidence>;
}>): OracleVerdict {
  const { workspace } = input;
  const failed: string[] = [];
  if (input.terminal !== "complete") failed.push("run_not_complete");
  if (!input.answerHasSum) failed.push("sum_not_in_answer");
  if (workspace.commands === 0) failed.push("no_workspace_command");
  if (workspace.inboxCalls === 0) failed.push("inbox_not_read");
  if (workspace.unknownOutcomes > 0) failed.push("workspace_outcome_unknown");
  return { counts: { ...workspace, answerHasSum: flag(input.answerHasSum) }, failed };
}

// Stops (E) and the restart (G) -----------------------------------------------------

/** How each way of stopping ended its thread: the expected reason per path, from the turns of that thread. */
export function stopEvidence(turnsByPath: Readonly<{
  /** Every agent Stop all had to reach (E's two holds); all must end `stopped` with `stop_all`. */
  stopAll: readonly TurnRow[];
  stopRoute: TurnRow | null;
  stopTool: TurnRow | null;
}>) {
  const ok = (turn: TurnRow | null, reason: string) => turn !== null && turn.state === "stopped" && turn.reasonCode === reason;
  return {
    stopAllStopped: turnsByPath.stopAll.length > 0 && turnsByPath.stopAll.every((turn) => ok(turn, SUBAGENT_END_REASONS.stoppedAll)),
    stopRouteStopped: ok(turnsByPath.stopRoute, SUBAGENT_END_REASONS.stoppedByUser),
    stopToolStopped: ok(turnsByPath.stopTool, SUBAGENT_END_REASONS.stoppedByAgent)
  };
}

export type StopPath = "stopAll" | "stopRoute" | "stopTool";

/**
 * E's verdict on the three stops. A stop is judged only when its idle agent
 * was still `running` (the thread view) right before it; one that had already
 * ended on its own is `idle_agent_ended_early`, a model shortcut rather than a
 * product failure.
 */
export function stopChecks(stops: ReturnType<typeof stopEvidence>, runningBefore: Readonly<Record<StopPath, boolean>>): string[] {
  const checks: string[] = [];
  const paths: readonly [StopPath, boolean, string][] = [
    ["stopTool", stops.stopToolStopped, "stop_subagent_failed"],
    ["stopRoute", stops.stopRouteStopped, "stop_route_failed"],
    ["stopAll", stops.stopAllStopped, "stop_all_failed"]
  ];
  for (const [path, stopped, failure] of paths) {
    if (!runningBefore[path]) {
      if (!checks.includes("idle_agent_ended_early")) checks.push("idle_agent_ended_early");
    } else if (!stopped) checks.push(failure);
  }
  return checks;
}

/** G: every background turn the restart cut off ended `interrupted` (`restart`), and one wake-up took all their callbacks. */
export function restartEvidence(turns: readonly TurnRow[], wakeUps: readonly WakeUpRow[], restartedAt: number) {
  const cut = turns.filter((turn) => turn.mode === "background" && (time(turn.startedAt) ?? Infinity) < restartedAt);
  const interrupted = cut.filter((turn) => turn.state === "interrupted" && turn.reasonCode === SUBAGENT_END_REASONS.restart);
  const after = wakeUps.filter((wakeUp) => (time(wakeUp.createdAt) ?? -Infinity) >= restartedAt);
  const wakeRuns = new Set(after.flatMap((wakeUp) => wakeUp.runId ? [wakeUp.runId] : []));
  const intoWake = interrupted.filter((turn) => turn.callbackRunId !== null && wakeRuns.has(turn.callbackRunId)).length;
  return {
    allInterrupted: cut.length > 0 && interrupted.length === cut.length,
    backgroundTurnsCut: cut.length,
    interruptedTurns: interrupted.length,
    interruptedCallbacksInWakeUps: intoWake,
    oneCoalescedWakeUp: after.length === 1 && intoWake === interrupted.length && interrupted.length > 0,
    wakeUpsAfterRestart: after.length
  };
}

// Cleanup ---------------------------------------------------------------------------

export type ScenarioCleanupPorts = Readonly<{
  /** Deletes the chat permanently and resolves true only once it is proven gone. */
  deleteChat(chatId: string): Promise<boolean>;
  /** Deletes the scheduled task and resolves true only once it is proven gone. */
  deleteTask(taskId: string): Promise<boolean>;
  /** Removes every saved browser session, proves none is left, and returns how many it removed. */
  removeBrowserSessions(): Promise<number>;
}>;

export type ScenarioCleanup = Readonly<{
  browserSessionsRemoved: number | null;
  chatsDeleted: number;
  chatsKept: number;
  chatsNotDeleted: number;
  cleaned: boolean;
  tasksDeleted: number;
  tasksNotDeleted: number;
}>;

/**
 * A scenario's postcondition before the next may start: its scheduled tasks
 * go first (no new occurrence may start), then its chats (deleting a chat
 * stops its sub-agents and fences a late browser-session save), then saved
 * browser sessions are removed and proven gone. Any failure leaves `cleaned`
 * false, and the harness stops with exit 1.
 */
export async function cleanUpScenario(ports: ScenarioCleanupPorts, input: Readonly<{
  chatIds: readonly string[]; keepChats: boolean; taskIds: readonly string[];
}>): Promise<ScenarioCleanup> {
  let tasksDeleted = 0;
  let tasksNotDeleted = 0;
  for (const taskId of new Set(input.taskIds)) {
    if (await ports.deleteTask(taskId).catch(() => false)) tasksDeleted += 1;
    else tasksNotDeleted += 1;
  }
  let chatsDeleted = 0;
  let chatsNotDeleted = 0;
  const chats = [...new Set(input.chatIds)];
  if (!input.keepChats) {
    for (const chatId of chats) {
      if (await ports.deleteChat(chatId).catch(() => false)) chatsDeleted += 1;
      else chatsNotDeleted += 1;
    }
  }
  const browserSessionsRemoved = await ports.removeBrowserSessions().catch(() => null);
  return {
    browserSessionsRemoved,
    chatsDeleted,
    chatsKept: input.keepChats ? chats.length : 0,
    chatsNotDeleted,
    cleaned: tasksNotDeleted === 0 && chatsNotDeleted === 0 && browserSessionsRemoved !== null,
    tasksDeleted,
    tasksNotDeleted
  };
}

// Summary ---------------------------------------------------------------------------

/**
 * S6 on the single-agent engine, the baseline C is compared with
 * (`20261029205057147-browser-long-scenario-baseline`, 2026-10-29, codex-lb
 * `gpt-6-astra`, the frozen-pizza version of S6 that C reuses).
 */
export const S6_BASELINE = Object.freeze([
  { inputTokens: 3_437_316, outputTokens: 4_656, rounds: 55, run: "S6 #1", success: false, wallSeconds: 409.3 },
  { inputTokens: 382_860, outputTokens: 1_467, rounds: 14, run: "S6 #2", success: false, wallSeconds: 718.0 }
] as const);

export function s6BaselineRows() {
  return S6_BASELINE.map((row) => ({ ...row, costEstimates: costEstimates(row.inputTokens, row.outputTokens) }));
}

export type SubagentRunRecord = Readonly<{
  run: number;
  scenario: SubagentScenarioId;
  success: boolean;
  usage: ReturnType<typeof usageByPurpose> | null;
  wallSeconds: number | null;
}>;

/** One summary row per scenario: successes, wall times and tokens per purpose per run; C carries the S6 baseline beside it. */
export function subagentScenarioSummary(scenario: SubagentScenarioId, records: readonly SubagentRunRecord[]) {
  const own = records.filter((entry) => entry.scenario === scenario);
  return {
    runs: own.length,
    runsDetail: own.map((entry) => ({
      run: entry.run,
      success: entry.success,
      tokensByPurpose: entry.usage ? Object.fromEntries(Object.entries(entry.usage.byPurpose).map(([purpose, usage]) =>
        [purpose, { costEstimates: usage.costEstimates, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }])) : null,
      total: entry.usage?.total ?? null,
      wallSeconds: entry.wallSeconds
    })),
    scenario,
    successes: own.filter((entry) => entry.success).length,
    ...(scenario === "C1" || scenario === "C2" ? { baseline: s6BaselineRows() } : {})
  };
}
