/**
 * Opt-in, paid, bounded evidence for the memory note and past-chat search on real models (operator decision
 * 2026-11-22: Personal Memory is replaced by one note per user and search over the user's past chats;
 * `lib/server/memoryNote/`, `lib/server/tools/manageMemory.ts`, `lib/server/chatSearch/`, `lib/server/tools/pastChats.ts`).
 * Never a default lane: it runs only on a DISPOSABLE stand (`next dev` through the Playwright web server,
 * AIQSA_TEST_MODE=1, AIQSA_STATEFUL_TEST_TARGET=DISPOSABLE, the `docker-compose.dev.yml` database) with
 *
 *   AIQSA_FEATURES_PAID_E2E=DISPOSABLE
 *   CODEX_LB_API_KEY, CODEX_LB_BASE_URL     the answer model (custom setup, `setupCodexLbAnswerModel`);
 *                                           AIQSA_MEMORY_NOTE_PAID_CODEX_MODEL picks it (default as that helper)
 *   OPENROUTER_API_KEY                      the past-chat embedding model and the approved reranker
 *                                           (`support/pastChatSearchRoles.ts`)
 *
 * Run it inside the disposable app container with one worker:
 *
 *   docker compose -f docker-compose.dev.yml run --rm -T -e AIQSA_FEATURES_PAID_E2E=DISPOSABLE \
 *     -e AIQSA_STATEFUL_TEST_TARGET=DISPOSABLE -e CODEX_LB_API_KEY -e CODEX_LB_BASE_URL -e OPENROUTER_API_KEY \
 *     app npm run test:e2e -- tests/e2e/memory-note-paid.spec.ts --workers=1
 *
 * Setup (once per worker): the codex-lb answer model (an earlier run's model on the stand is reused, so a restarted
 * worker pays no second setup), OpenRouter with the default embedding preset and the default approved reranker, both
 * roles assigned; the account's note, Memory switches and composer defaults are restored afterwards. The tests are
 * independent (each makes and deletes its own chats and starts from an empty note) and not serial: a failure does not
 * skip the rest, and nothing retries (a retry would pay again).
 *
 * Expected paid calls: Codex LB discovery and model checks on a first setup; OpenRouter Quick Setup checks unless the
 * stand already has the connection; the scenario script twice (about 50 passage embeddings, then one query embedding
 * and at most one rerank per scenario with a query, 42 scenarios); 13 short answer turns (each a few model requests,
 * with `manage_memory`, `search_past_chats` or `read_past_chat` calls), plus their passages' embeddings and searches.
 *
 * Oracles are the persisted runs, tool calls, frozen run requests (`ModelRun.normalizedRequest.memory`,
 * `prompt.memoryNote`), the owner routes (`/api/me/memory/note`, `/api/chats/:id`), the index rows and the rendered
 * cards and sources. What the model chooses is asserted only where the contract fixes it (an explicit "remember"
 * changes the note; nothing changes without the user asking; Temporary and Memory-off runs have no note and no tools);
 * the rest is annotated. Prompts, answers, note text and excerpts are never printed: each test attaches a content-free
 * JSON summary (booleans, counts, ranks, codes, latencies, tool names) and pushes it as an annotation. Screenshots of
 * the synthetic cards and sources go to the test output.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page, type PlaywrightWorkerArgs, type TestInfo } from "@playwright/test";
import { decodeCatalogResponse } from "../../lib/contracts/catalog";
import type { ChatDetailResponseWire } from "../../lib/contracts/chats";
import {
  MANAGE_MEMORY_TOOL_NAME, decodeMemoryNoteCard, type MemoryNote, type MemoryNoteCard, type MemoryNoteChangeCard,
  type MemoryNoteOfferCard, type MemorySwitches
} from "../../lib/contracts/memoryNote";
import {
  READ_PAST_CHAT_TOOL_NAME, SEARCH_PAST_CHATS_TOOL_NAME, pastChatSearchMode, searchPastChatsResultSchema, type PastChatSource
} from "../../lib/contracts/pastChats";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { journeyRunParams } from "../../scripts/context-compaction-journey-support";
import { engageComposer, selectModel } from "./shell/composer";
import { captureState, type CaptureSize } from "./support/capture";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, paidEnv, pollUntil, setupCodexLbAnswerModel, waitForCatalogModel } from "./support/paidProviders";
import { savePastChatSearchRoles, setupPastChatSearchRoles, type PastChatSearchRoles } from "./support/pastChatSearchRoles";

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL") || !paidEnv("OPENROUTER_API_KEY"),
  "paid: requires CODEX_LB_API_KEY, CODEX_LB_BASE_URL and OPENROUTER_API_KEY");
// Independent scenarios: a failure must not skip the rest, and a retry would pay again.
test.describe.configure({ mode: "default", retries: 0, timeout: 900_000 });
test.use({ trace: "off", screenshot: "off", video: "off" });

const prisma = new PrismaClient();
const LABEL = "Memory note paid";
/** Enough for a tool call or two and a short answer at the lowest reasoning effort. */
const MAX_OUTPUT_TOKENS = 2_048;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const SCENARIO_SCRIPT = "scripts/eval/chat-search-scenarios.ts";
const SCENARIO_TIMEOUT_MS = 1_800_000;
const INDEX_WAIT_MS = 60_000;
const CARD_SIZES: readonly CaptureSize[] = [{ height: 900, width: 1440 }, { height: 1180, width: 820 }, { height: 844, width: 390 }];
const SOURCE_SIZES: readonly CaptureSize[] = [{ height: 900, width: 1440 }, { height: 844, width: 390 }];

/** The composer defaults the chips save; restored after all. */
const DEFAULTS_SELECT = {
  defaultMcpMode: true, defaultProviderModelId: true, defaultSearchPlan: true, defaultSkillsMode: true, defaultWorkspaceEnabled: true
} satisfies Prisma.UserSettingsSelect;
/** The Temporary chat retention policy the composer shows and sends (`lib/contracts/memoryClient.ts`). */
const TEMPORARY_RETENTION_POLICY_VERSION = "temporary-24h-v1";
/** 4200 as an answer may write it: 4200, 4 200, 4,200 or 4.200. */
const BUDGET = /4[\s.,\u00a0\u202f]?200/u;

type AnswerModel = Readonly<{ connectionId: string; displayName: string; modelId: string; params: Record<string, unknown> }>;
type Evidence = Record<string, unknown>;

let answerModel: AnswerModel | null = null;
let roles: PastChatSearchRoles | null = null;
let userId = "";
let originalNoteText: string | null = null;
let originalSwitches: MemorySwitches | null = null;
let originalDefaults: Prisma.UserSettingsGetPayload<{ select: typeof DEFAULTS_SELECT }> | null = null;

const model = () => answerModel ?? (() => { throw new Error("memory_note_paid_setup_missing"); })();
const pastChatRoles = () => roles ?? (() => { throw new Error("memory_note_paid_setup_missing"); })();

/** A content-free failure code: a stable error code or the error class, never the message. */
function failureCode(error: unknown): string {
  if (error && typeof error === "object") {
    for (const key of ["code", "name"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)) return value;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Setup and restore

async function apiContext(playwright: PlaywrightWorkerArgs["playwright"], testInfo: TestInfo): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await authenticateWithLocalToken(context);
  return context;
}

/** An earlier run's codex-lb model on this stand, else a new custom setup. */
async function sharedAnswerModel(request: APIRequestContext): Promise<AnswerModel> {
  const catalog = decodeCatalogResponse(await (await request.get("/api/me/catalog")).json());
  const earlier = catalog?.models.find((candidate) => candidate.displayName.startsWith(`${LABEL} model `) && candidate.capabilities.toolCalling);
  if (earlier) {
    return { connectionId: earlier.provider, displayName: earlier.displayName, modelId: earlier.modelId,
      params: journeyRunParams(earlier, MAX_OUTPUT_TOKENS) };
  }
  const setup = await setupCodexLbAnswerModel(request, { label: LABEL, nativeSearch: false,
    preferredModel: paidEnv("AIQSA_MEMORY_NOTE_PAID_CODEX_MODEL") });
  const catalogModel = await waitForCatalogModel(request, setup.connectionId, (candidate) => candidate.modelId === setup.modelId);
  return { connectionId: setup.connectionId, displayName: catalogModel.displayName, modelId: setup.modelId,
    params: journeyRunParams(catalogModel, MAX_OUTPUT_TOKENS) };
}

async function readNote(request: APIRequestContext): Promise<MemoryNote> {
  const response = await request.get("/api/me/memory/note");
  expect(response.ok(), `the note is read (${response.status()})`).toBe(true);
  return await response.json() as MemoryNote;
}

/** Saves `text` as the whole note, as Settings › Memory does, unless it already is. */
async function writeNote(request: APIRequestContext, text: string): Promise<MemoryNote> {
  const current = await readNote(request);
  if (current.text === text) return current;
  const response = await request.put("/api/me/memory/note", { data: { revision: current.revision, text } });
  expect(response.ok(), `the note is saved (${response.status()})`).toBe(true);
  return await response.json() as MemoryNote;
}

async function patchSwitches(request: APIRequestContext, switches: Partial<MemorySwitches>): Promise<MemorySwitches> {
  const response = await request.patch("/api/me/memory/preferences", { data: switches });
  expect(response.ok(), `the Memory switches are saved (${response.status()})`).toBe(true);
  return await response.json() as MemorySwitches;
}

test.beforeAll(async ({ playwright }, testInfo) => {
  test.setTimeout(1_800_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const request = await apiContext(playwright, testInfo);
  const evidence: Evidence = {};
  try {
    userId = (await (await request.get("/api/me")).json() as { user: { id: string } }).user.id;
    originalDefaults ??= await prisma.userSettings.findUnique({ select: DEFAULTS_SELECT, where: { userId } });
    answerModel = await sharedAnswerModel(request);
    roles = await setupPastChatSearchRoles(request, paidEnv("OPENROUTER_API_KEY")!);
    Object.assign(evidence, roles.evidence);
    originalNoteText ??= (await readNote(request)).text;
    const switches = await (await request.get("/api/me/memory/preferences")).json() as MemorySwitches;
    originalSwitches ??= switches;
    if (!switches.memoryEnabled || !switches.pastChatSearchEnabled || !switches.memorySuggestionsEnabled) {
      await patchSwitches(request, { memoryEnabled: true, memorySuggestionsEnabled: true, pastChatSearchEnabled: true });
    }
    evidence.switchesWereOn = switches.memoryEnabled && switches.pastChatSearchEnabled && switches.memorySuggestionsEnabled;
  } finally {
    testInfo.annotations.push({ description: JSON.stringify(evidence), type: "memory-note-paid-setup" });
    await request.dispose();
  }
});

test.afterAll(async ({ playwright }, testInfo) => {
  const request = await apiContext(playwright, testInfo).catch(() => null);
  try {
    if (request && originalNoteText !== null) await writeNote(request, originalNoteText).catch(() => undefined);
    if (request && originalSwitches) await patchSwitches(request, originalSwitches).catch(() => undefined);
    if (originalDefaults && userId) {
      await prisma.userSettings.update({ where: { userId }, data: {
        ...originalDefaults,
        defaultSearchPlan: originalDefaults.defaultSearchPlan === null ? Prisma.DbNull : originalDefaults.defaultSearchPlan as Prisma.InputJsonValue
      } }).catch(() => undefined);
    }
  } finally {
    await request?.dispose();
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// Scenarios, chats and turns

type Scenario = Readonly<{ chats: Set<string>; evidence: Evidence }>;

/** Runs `body` from an empty note; the chats it made are deleted and its content-free summary attached afterwards. */
async function scenario(request: APIRequestContext, testInfo: TestInfo, name: string, body: (stand: Scenario) => Promise<void>): Promise<void> {
  const stand: Scenario = { chats: new Set(), evidence: { scenario: name } };
  try {
    await writeNote(request, "");
    await body(stand);
    stand.evidence.status = "passed";
  } catch (error) {
    stand.evidence.status = "failed";
    stand.evidence.failure = failureCode(error);
    throw error;
  } finally {
    for (const chatId of stand.chats) await deleteOwnedChatPermanently(request, chatId, { timeout: 60_000 }).catch(() => undefined);
    const summary = JSON.stringify(stand.evidence);
    testInfo.annotations.push({ description: summary, type: "memory-note-paid" });
    await testInfo.attach(`${name}-summary.json`, { body: JSON.stringify(stand.evidence, null, 2), contentType: "application/json" });
    console.log(`memory_note_paid_summary ${summary}`);
  }
}

async function newChat(request: APIRequestContext, stand: Scenario, title: string): Promise<string> {
  const created = await request.post("/api/chats", { data: { title } });
  expect(created.ok(), `the chat is created (${created.status()})`).toBe(true);
  const chatId = (await created.json() as { chat: { id: string } }).chat.id;
  stand.chats.add(chatId);
  return chatId;
}

const toolCallSelect = { arguments: true, result: true, state: true, toolName: true } satisfies Prisma.ModelRunToolCallSelect;
type ToolCall = Prisma.ModelRunToolCallGetPayload<{ select: typeof toolCallSelect }>;

type Turn = Readonly<{
  answer: string;
  calls: ToolCall[];
  cards: MemoryNoteCard[];
  latencyMs: number;
  run: ModelRun;
  sources: PastChatSource[];
}>;

async function settledRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  const admitted = await pollUntil(60_000, async () => prisma.modelRun.findFirst({ orderBy: { createdAt: "desc" },
    where: { chatId, id: { notIn: [...earlier] } } }), "memory_note_paid_run_not_admitted");
  return pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: admitted.id } });
    return ACTIVE_RUN_STATUSES.includes(run.status) ? null : run;
  }, "memory_note_paid_turn_timeout");
}

/** What the run's answer shows, as the browser reads it: its note cards and past-chat sources, and its text. */
async function observeTurn(request: APIRequestContext, run: ModelRun, latencyMs: number): Promise<Turn> {
  expect(run.status, `the turn completes (${run.status})`).toBe("complete");
  const calls = await prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }], select: toolCallSelect,
    where: { modelRunId: run.id } });
  const detail = await request.get(`/api/chats/${run.chatId}`);
  const message = detail.ok()
    ? (await detail.json() as ChatDetailResponseWire).chat.messages.find((candidate) => candidate.id === run.assistantMessageId)
    : undefined;
  const cards = (message?.artifactSummary?.resourceChanges ?? []).flatMap((card) => {
    const decoded = card.resource === "memory_note" ? decodeMemoryNoteCard(card) : null;
    return decoded ? [decoded] : [];
  });
  const stored = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  const answer = stored?.content && typeof stored.content === "object" ? textFromContentBlocks(stored.content as { blocks?: unknown[] }) : "";
  return { answer, calls, cards, latencyMs, run, sources: message?.artifactSummary?.pastChatSources ?? [] };
}

/**
 * One turn through the ordinary send route on the answer model, without MCP, Skills, Search or the Workspace.
 * `temporary` starts a new Temporary chat with this first message, as the composer's Temporary Chat does.
 */
async function apiTurn(request: APIRequestContext, chatId: string, text: string, options: Readonly<{ temporary?: boolean }> = {}): Promise<Turn> {
  const leaf = options.temporary ? null
    : (await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } })).activeLeafMessageId;
  const earlier = (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
  const started = Date.now();
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
    content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: leaf, mcp: { mode: "off" }, modelId: model().modelId,
    params: model().params, provider: model().connectionId, searchPlan: { mode: "all_selected", optionIds: [] }, skills: { mode: "off" },
    timeZone: "UTC", workspace: { enabled: false },
    // What the composer's Temporary Chat sends with a new chat's first message (`temporaryAdmissionPayload` in
    // `components/app-shell/messageRunActions.ts`): the mode with the retention policy it was shown, and the draft.
    ...(options.temporary ? { chatMode: "TEMPORARY", personalDraft: { folderId: null, memoryMode: "TEMPORARY" },
      temporaryRetentionPolicyVersion: TEMPORARY_RETENTION_POLICY_VERSION } : {})
  } });
  expect(response.ok(), `the turn is accepted (${response.status()})`).toBe(true);
  await response.body();
  const run = await settledRun(chatId, earlier);
  return observeTurn(request, run, Date.now() - started);
}

const callsOf = (turn: Turn, toolName: string) => turn.calls.filter((call) => call.toolName === toolName);
const changeCards = (turn: Turn) => turn.cards.filter((card): card is MemoryNoteChangeCard => card.action !== "offered");
const offerCards = (turn: Turn) => turn.cards.filter((card): card is MemoryNoteOfferCard => card.action === "offered");
const frozenMemory = (run: ModelRun) => (run.normalizedRequest as { memory?: { changes?: unknown; offers?: unknown; pastChats?: unknown } } | null)?.memory;
const frozenNote = (run: ModelRun) => (run.normalizedRequest as { prompt?: { memoryNote?: unknown } } | null)?.prompt?.memoryNote;

/** Content-free facts of a turn. */
function turnFacts(turn: Turn): Evidence {
  return {
    cards: turn.cards.map((card) => card.action),
    latencyMs: turn.latencyMs,
    memoryChanges: frozenMemory(turn.run)?.changes ?? null,
    memoryOffers: frozenMemory(turn.run)?.offers ?? null,
    noteInPrompt: typeof frozenNote(turn.run) === "string",
    pastChatsOffered: frozenMemory(turn.run)?.pastChats ?? null,
    pastChatSources: turn.sources.length,
    tools: turn.calls.map((call) => `${call.toolName}:${call.state}`)
  };
}

/** The chats a `search_past_chats` call returned, in its own order, from its persisted result. */
function searchedChatIds(call: ToolCall): string[] {
  const content = (call.result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const value = (part as { type?: unknown; value?: unknown } | null)?.type === "json" ? (part as { value: unknown }).value : null;
    const decoded = searchPastChatsResultSchema.safeParse(value);
    return decoded.success ? decoded.data.results.map((result) => result.chatId) : [];
  });
}

/** Per search call: whether it had a query, its mode, how many results and the 1-based rank of `chatId` (null: absent). */
function searchFacts(turn: Turn, chatId: string) {
  return callsOf(turn, SEARCH_PAST_CHATS_TOOL_NAME).map((call) => {
    const query = (call.arguments as { query?: unknown } | null)?.query;
    const ids = searchedChatIds(call);
    const rank = ids.indexOf(chatId);
    return { hasQuery: typeof query === "string" && query.trim().length > 0,
      mode: pastChatSearchMode(typeof query === "string" ? { query } : {}), rank: rank < 0 ? null : rank + 1,
      results: ids.length, state: call.state };
  });
}

// ---------------------------------------------------------------------------
// The browser

async function openApp(page: Page, destination: string): Promise<void> {
  await page.setViewportSize({ height: 900, width: 1440 });
  // A cold `next dev` compiles the shell on the first visit.
  await page.goto("/", { timeout: PAID_SETUP_TIMEOUT_MS });
  await authenticateWithLocalToken(page.request);
  await page.goto(destination, { timeout: PAID_SETUP_TIMEOUT_MS });
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 120_000 });
}

/** MCP and Skills off through the composer's own chips (they save the account's defaults, restored after all). */
async function composerToolsOff(page: Page): Promise<void> {
  await engageComposer(page);
  const mcp = page.getByRole("button", { name: "Change MCP mode" });
  await expect(mcp).toBeVisible({ timeout: 30_000 });
  if (await mcp.getAttribute("data-mcp-mode") !== "off") {
    await mcp.click();
    await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Off/u }).click();
  }
  await expect(mcp).toHaveAttribute("data-mcp-mode", "off");
  const skills = page.getByRole("button", { name: "Change Skills mode" });
  if (await skills.getAttribute("data-skills-mode") !== "off") {
    await skills.click();
    await page.getByRole("menu", { name: "Skills" }).getByRole("menuitemradio", { name: /^Off/u }).click();
  }
  await expect(skills).toHaveAttribute("data-skills-mode", "off");
}

async function attachShots(testInfo: TestInfo, shots: readonly { path: string }[]): Promise<void> {
  for (const shot of shots) await testInfo.attach(shot.path.split("/").at(-1)!, { contentType: "image/png", path: shot.path });
}

const ACCEPT_VERB = { add: "Remember", remove: "Forget", replace: "Update" } as const;
/** A dismissed offer's heading by its operation (`offerDismissed` in `components/app-shell/memoryNoteUiCopy.ts`). */
const DISMISSED_HEADING = { add: "Not remembered", remove: "Not changed", replace: "Not changed" } as const;

// ---------------------------------------------------------------------------

test("past-chat search scenarios on the real embedding model, with and without the reranker", async ({ request }, testInfo) => {
  test.setTimeout(2 * SCENARIO_TIMEOUT_MS + 300_000);
  await authenticateWithLocalToken(request);
  const evidence: Evidence = {};

  type ScenarioClass = Readonly<{ hitAt1?: number | null; hitAt3?: number | null; hitAt5?: number | null; passed: number; scenarios: number;
    violations: number }>;
  type ScenarioRun = Readonly<{
    exitCode: number | null;
    output: (Readonly<{
      ok?: boolean; refused?: string; roles?: Readonly<{ embedding: string; rerank: string }>;
      index?: Readonly<{ drainMs?: number; freshIndexMs?: number }>;
      report?: Readonly<{ classes: Record<string, ScenarioClass>; latencyMs: Readonly<{ p50: number | null; p95: number | null; max: number | null }>;
        outcomes: Record<string, number>; passed: number; rerank: Record<string, number>; scenarios: number; violations: number;
        failures: ReadonlyArray<Readonly<{ id: string; reasons: readonly string[] }>> }>;
    }>) | null;
  }>;

  /** One run of the scenario script, its exit code and its one content-free JSON document. */
  const runScenarios = (label: string): ScenarioRun => {
    const child = spawnSync(process.execPath, ["--import", "tsx", SCENARIO_SCRIPT], {
      cwd: process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: SCENARIO_TIMEOUT_MS,
      env: { ...process.env, AIQSA_CHAT_SEARCH_SCENARIOS: "DISPOSABLE", AIQSA_STATEFUL_TEST_TARGET: "DISPOSABLE" }
    });
    // The script prints only content-free JSON lines; stderr is not read, so nothing else can leak.
    const documents = (child.stdout ?? "").split("\n").flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as NonNullable<ScenarioRun["output"]>] : [];
      } catch {
        return [];
      }
    });
    const output = documents.find((document) => document.report) ?? documents.at(-1) ?? null;
    const result: ScenarioRun = { exitCode: child.status, output };
    const report = output?.report;
    evidence[label] = {
      exitCode: child.status, refused: output?.refused ?? null, roles: output?.roles ?? null,
      drainMs: output?.index?.drainMs ?? null, freshIndexMs: output?.index?.freshIndexMs ?? null,
      scenarios: report?.scenarios ?? null, passed: report?.passed ?? null, violations: report?.violations ?? null,
      latencyMs: report ? { p50: report.latencyMs.p50, p95: report.latencyMs.p95 } : null,
      hits: report ? Object.fromEntries(Object.entries(report.classes).map(([name, entry]) =>
        [name, { hitAt1: entry.hitAt1 ?? null, hitAt3: entry.hitAt3 ?? null, hitAt5: entry.hitAt5 ?? null }])) : null,
      rerank: report?.rerank ?? null, outcomes: report?.outcomes ?? null,
      failedScenarios: report?.failures.map((failure) => failure.id) ?? null
    };
    testInfo.annotations.push({ description: JSON.stringify(evidence[label]), type: `chat-search-scenarios-${label}` });
    return result;
  };

  const expectSound = async (label: string, result: ScenarioRun) => {
    await testInfo.attach(`chat-search-scenarios-${label}.json`, { body: JSON.stringify(result.output, null, 2), contentType: "application/json" });
    expect(result.output?.refused ?? null, `the ${label} scenario run was not refused`).toBeNull();
    expect(result.output?.roles?.embedding, `the ${label} run used the embedding model`).toBe("model");
    expect(result.output?.report?.violations, `no never-returned rule broke (${label})`).toBe(0);
    expect(result.exitCode, `the ${label} scenario run exits 0`).toBe(0);
  };

  try {
    const withReranker = runScenarios("withReranker");
    await expectSound("withReranker", withReranker);
    await savePastChatSearchRoles(request, { rerankerProviderModelId: null });
    const withoutReranker = await (async () => {
      try {
        return runScenarios("withoutReranker");
      } finally {
        // The reranker comes back even when the run failed, so the later scenarios search as configured.
        await savePastChatSearchRoles(request, { rerankerProviderModelId: pastChatRoles().rerankerModelId });
      }
    })();
    await expectSound("withoutReranker", withoutReranker);
  } finally {
    await testInfo.attach("chat-search-scenarios-summary.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    console.log(`memory_note_paid_summary ${JSON.stringify({ scenario: "search-quality", ...evidence })}`);
  }
});

test("an explicit remember in the web chat adds a line with a card, and Undo takes it back", async ({ page }, testInfo) => {
  await openApp(page, "/");
  await scenario(page.request, testInfo, "explicit-remember", async ({ chats, evidence }) => {
    const before = await readNote(page.request);
    await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
    await expect(async () => selectModel(page, model().connectionId, model().displayName)).toPass({ timeout: 60_000 });
    await composerToolsOff(page);
    const composer = page.getByRole("textbox", { exact: true, name: "Message" });
    await composer.fill("Remember: I prefer answers as short bullet lists.");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({ timeout: 120_000 });
    const started = Date.now();
    await composer.press("Enter");
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/u, { timeout: 120_000 });
    const chatId = /\/c\/([0-9a-f-]{36})/u.exec(page.url())![1]!;
    chats.add(chatId);
    const turn = await observeTurn(page.request, await settledRun(chatId, []), Date.now() - started);
    Object.assign(evidence, turnFacts(turn), { manageMemoryCalls: callsOf(turn, MANAGE_MEMORY_TOOL_NAME).length });
    const after = await readNote(page.request);
    evidence.noteChanged = after.revision > before.revision;
    evidence.noteMentionsBullets = /bullet/iu.test(after.text);
    expect(changeCards(turn).map((card) => card.action), "the answer has one change card that added a line").toEqual(["added"]);
    expect(evidence.noteMentionsBullets, "the note now has a line about bullet lists").toBe(true);

    const card = page.locator("[data-resource='memory_note']").first();
    await expect(card).toContainText("Added to memory", { timeout: PAID_TURN_TIMEOUT_MS });
    const undo = card.getByRole("button", { name: "Undo this change to your memory" });
    await expect(undo).toBeVisible();
    await attachShots(testInfo, await captureState(page, testInfo, "memory-note-paid-change-card", { anchor: card, sizes: CARD_SIZES,
      atEachSize: async () => { await expectNoHorizontalOverflow(page); } }));
    await undo.click();
    await expect(card.getByRole("status")).toContainText("Your note is back to the previous text", { timeout: 60_000 });
    const undone = await readNote(page.request);
    evidence.undoRestored = undone.text === before.text;
    expect(evidence.undoRestored, "Undo put the note back").toBe(true);
  });
});

test("a contradicting remember replaces the line instead of adding a second one", async ({ request }, testInfo) => {
  await authenticateWithLocalToken(request);
  await scenario(request, testInfo, "contradiction", async (stand) => {
    const chatId = await newChat(request, stand, `Memory language ${randomUUID().slice(0, 8)}`);
    const first = await apiTurn(request, chatId, "Remember: answer me in Russian.");
    stand.evidence.first = turnFacts(first);
    expect(changeCards(first).length, "the first remember changed the note").toBe(1);
    const between = await readNote(request);
    stand.evidence.firstNoteMentionsRussian = /russian|русск/iu.test(between.text);
    const second = await apiTurn(request, chatId, "Remember: actually, answer me in English from now on.");
    stand.evidence.second = turnFacts(second);
    const after = await readNote(request);
    stand.evidence.secondCardActions = changeCards(second).map((card) => card.action);
    stand.evidence.noteMentionsEnglish = /english|английск/iu.test(after.text);
    stand.evidence.noteMentionsRussian = /russian|русск/iu.test(after.text);
    stand.evidence.noteLines = after.text.split("\n").filter((line) => line.trim()).length;
    expect(changeCards(second).length, "the second remember changed the note").toBeGreaterThan(0);
    expect(stand.evidence.noteMentionsEnglish, "the note says English").toBe(true);
    expect(stand.evidence.noteMentionsRussian, "the note no longer says Russian").toBe(false);
  });
});

test("lasting context said in passing is only offered, and written only after Remember", async ({ page }, testInfo) => {
  await openApp(page, "/");
  await scenario(page.request, testInfo, "offer", async (stand) => {
    const request = page.request;
    // Remember: the offer is accepted in the answer's card.
    const acceptChat = await newChat(request, stand, `Memory offer ${randomUUID().slice(0, 8)}`);
    const before = await readNote(request);
    const stated = await apiTurn(request, acceptChat, "By the way, I'm a backend engineer and mostly write Go.");
    const unchanged = await readNote(request);
    const offers = offerCards(stated);
    stand.evidence.accept = { ...turnFacts(stated), offered: offers.length > 0, noteUnchangedBeforeDecision: unchanged.revision === before.revision };
    expect(changeCards(stated).length, "nothing was changed without the user asking").toBe(0);
    expect(unchanged.revision, "the note is unchanged until the user decides").toBe(before.revision);
    if (offers.length > 0) {
      const offer = offers[0]!;
      await page.goto(`/c/${acceptChat}`);
      const card = page.locator("[data-resource='memory_note']").first();
      await expect(card).toContainText(offer.operation === "add" ? "Remember this for future chats?" : /memory|chats/u, { timeout: 60_000 });
      await card.getByRole("button", { name: ACCEPT_VERB[offer.operation], exact: true }).click();
      await expect(card.getByRole("button", { name: "Undo this change to your memory" })).toBeVisible({ timeout: 60_000 });
      const accepted = await readNote(request);
      const status = await (await request.get(`/api/me/memory/offers/${offer.offerId}`)).json() as { state?: unknown };
      stand.evidence.acceptedState = typeof status.state === "string" ? status.state : null;
      stand.evidence.acceptedNoteMentionsIt = /\bgo\b|golang|backend/iu.test(accepted.text);
      expect(accepted.revision, "Remember wrote the note").toBeGreaterThan(unchanged.revision);
      expect(stand.evidence.acceptedNoteMentionsIt, "the note holds what was offered").toBe(true);
    }

    // No thanks: a second offer is dismissed and writes nothing.
    const dismissChat = await newChat(request, stand, `Memory offer ${randomUUID().slice(0, 8)}`);
    const beforeSecond = await readNote(request);
    const second = await apiTurn(request, dismissChat, "For context, our team's standups are at 10:00 Berlin time every weekday.");
    const secondOffers = offerCards(second);
    stand.evidence.dismiss = { ...turnFacts(second), offered: secondOffers.length > 0 };
    expect(changeCards(second).length, "nothing was changed without the user asking").toBe(0);
    expect((await readNote(request)).revision, "the note is unchanged until the user decides").toBe(beforeSecond.revision);
    if (secondOffers.length > 0) {
      await page.goto(`/c/${dismissChat}`);
      const card = page.locator("[data-resource='memory_note']").first();
      await expect(card.getByRole("button", { name: "No thanks" })).toBeVisible({ timeout: 60_000 });
      await card.getByRole("button", { name: "No thanks" }).click();
      await expect(page.getByRole("listitem", { name: DISMISSED_HEADING[secondOffers[0]!.operation] })).toBeVisible({ timeout: 60_000 });
      const status = await (await request.get(`/api/me/memory/offers/${secondOffers[0]!.offerId}`)).json() as { state?: unknown };
      stand.evidence.dismissedState = typeof status.state === "string" ? status.state : null;
      expect((await readNote(request)).revision, "No thanks wrote nothing").toBe(beforeSecond.revision);
    }
  });
});

test("a sensitive detail said in passing is neither saved nor offered", async ({ request }, testInfo) => {
  await authenticateWithLocalToken(request);
  await scenario(request, testInfo, "sensitive-in-passing", async (stand) => {
    const chatId = await newChat(request, stand, `Memory passing ${randomUUID().slice(0, 8)}`);
    const before = await readNote(request);
    const turn = await apiTurn(request, chatId, "I have a dentist appointment tomorrow; what is the capital of France?");
    Object.assign(stand.evidence, turnFacts(turn), { answeredParis: /paris|париж/iu.test(turn.answer),
      manageMemoryCalls: callsOf(turn, MANAGE_MEMORY_TOOL_NAME).length });
    expect(changeCards(turn).length, "no change card").toBe(0);
    expect(offerCards(turn).length, "no offer card").toBe(0);
    expect((await readNote(request)).revision, "the note is unchanged").toBe(before.revision);
  });
});

test("past-chat search finds an earlier chat by its facts, by a paraphrase, and lists recent chats", async ({ page }, testInfo) => {
  await openApp(page, "/");
  await scenario(page.request, testInfo, "past-chat-search", async (stand) => {
    const request = page.request;
    const chatA = await newChat(request, stand, `Campaign notes ${randomUUID().slice(0, 8)}`);
    // Ordinary work the model answers, not a request to keep anything ("for the record" read as a remember request).
    const recorded = await apiTurn(request, chatA,
      "Draft a three-line kickoff note for campaign QX-7731: winter launch, budget 4200 EUR, owner Mira.");
    stand.evidence.recorded = { ...turnFacts(recorded), manageMemoryCalls: callsOf(recorded, MANAGE_MEMORY_TOOL_NAME).length };
    // Chat B must find the facts in chat A, never in the note: a note change the model made anyway is undone first.
    stand.evidence.noteClearedBeforeSearch = (await readNote(request)).text !== "";
    const cleared = await writeNote(request, "");
    expect(cleared.text === "" && !/QX-7731/iu.test(cleared.text), "the note holds nothing about the campaign before chat B").toBe(true);
    const indexStarted = Date.now();
    const passages = await pollUntil(INDEX_WAIT_MS, async () => {
      const count = await prisma.chatSearchPassage.count({ where: { chatId: chatA } });
      return count > 0 ? count : null;
    }, "memory_note_paid_chat_not_indexed");
    const embedded = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "ChatSearchPassage" WHERE "chatId" = ${chatA} AND "embedding" IS NOT NULL`;
    stand.evidence.index = { embeddedPassages: embedded[0]?.count ?? 0, passages, searchableAfterMs: Date.now() - indexStarted };

    // The facts asked for directly: the answer reads them from chat A and names it under the answer.
    const chatB = await newChat(request, stand, `Campaign question ${randomUUID().slice(0, 8)}`);
    const asked = await apiTurn(request, chatB, "What budget did we set for campaign QX-7731?");
    const askedSearches = searchFacts(asked, chatA);
    const answerMentionsBudget = BUDGET.test(asked.answer);
    const sourcesIncludeChatA = asked.sources.some((source) => source.chatId === chatA);
    stand.evidence.direct = { ...turnFacts(asked), answerMentionsBudget, reads: callsOf(asked, READ_PAST_CHAT_TOOL_NAME).length,
      searches: askedSearches, sourcesIncludeChatA };
    expect(askedSearches.length, "the answer searched past chats").toBeGreaterThan(0);
    expect(askedSearches.some((search) => search.rank !== null), "a search returned chat A").toBe(true);
    expect(answerMentionsBudget, "the answer gives the budget").toBe(true);
    expect(sourcesIncludeChatA, "the answer's past-chat sources include chat A").toBe(true);

    await page.goto(`/c/${chatB}`);
    const fold = page.getByTestId("tool-activity-disclosure").first();
    await fold.locator(":scope > summary").click({ timeout: 60_000 });
    const sources = page.getByTestId("past-chat-sources");
    const summary = sources.locator(":scope > summary");
    await expect(summary).toHaveText(/^Past chats · \d+$/u, { timeout: 30_000 });
    const shown = Number(/(\d+)$/u.exec((await summary.innerText()).trim())?.[1] ?? "-1");
    stand.evidence.shownSources = shown;
    stand.evidence.shownExactlyOne = shown === 1;
    // The count is the answer's own sources; on a stand whose user has other chats a search may name more than chat A.
    expect(shown, "the fold counts the answer's past-chat sources").toBe(asked.sources.length);
    await summary.click();
    const link = sources.locator(`a[href^="/c/${chatA}"]`).first();
    await expect(link, "the sources link to chat A").toBeVisible();
    await attachShots(testInfo, await captureState(page, testInfo, "memory-note-paid-past-chat-sources", { anchor: sources, sizes: SOURCE_SIZES,
      atEachSize: async () => { await expectNoHorizontalOverflow(page); } }));
    await page.goto("about:blank");
    // Chat B now holds the facts too; it goes before the paraphrase so that search can only find them in chat A.
    await deleteOwnedChatPermanently(request, chatB, { timeout: 60_000 });
    stand.chats.delete(chatB);

    const chatC = await newChat(request, stand, `Launch question ${randomUUID().slice(0, 8)}`);
    const paraphrased = await apiTurn(request, chatC, "How much money did we plan for the winter launch?");
    stand.evidence.paraphrase = { ...turnFacts(paraphrased), answerMentionsBudget: BUDGET.test(paraphrased.answer),
      searches: searchFacts(paraphrased, chatA), sourcesIncludeChatA: paraphrased.sources.some((source) => source.chatId === chatA) };

    const chatD = await newChat(request, stand, `Recent chats ${randomUUID().slice(0, 8)}`);
    const listed = await apiTurn(request, chatD, "List my recent chats.");
    const listings = searchFacts(listed, chatA);
    stand.evidence.listing = { ...turnFacts(listed), listedWithoutQuery: listings.some((search) => search.mode === "recent"), searches: listings };
  });
});

test("a Temporary chat neither changes the note nor offers past-chat search", async ({ request }, testInfo) => {
  await authenticateWithLocalToken(request);
  await scenario(request, testInfo, "temporary-chat", async (stand) => {
    const before = await readNote(request);
    const chatId = randomUUID();
    stand.chats.add(chatId);
    const turn = await apiTurn(request, chatId, "Remember: my cat is called Pixel.", { temporary: true });
    const chat = await prisma.chat.findUnique({ select: { memoryMode: true }, where: { id: chatId } });
    Object.assign(stand.evidence, turnFacts(turn), { chatMode: chat?.memoryMode ?? null, frozenMemory: frozenMemory(turn.run) !== undefined });
    expect(chat?.memoryMode, "the chat is Temporary").toBe("TEMPORARY");
    expect(callsOf(turn, MANAGE_MEMORY_TOOL_NAME).length, "no manage_memory call").toBe(0);
    expect(callsOf(turn, SEARCH_PAST_CHATS_TOOL_NAME).length, "no past-chat search").toBe(0);
    expect(frozenMemory(turn.run), "the run was admitted without Memory, so neither tool was offered").toBeUndefined();
    expect(typeof frozenNote(turn.run), "the run's prompt has no note").toBe("undefined");
    expect(changeCards(turn).length + offerCards(turn).length, "no note card").toBe(0);
    expect((await readNote(request)).revision, "the note is unchanged").toBe(before.revision);
  });
});

test("with Memory off a new chat's run has neither the note nor the Memory tools", async ({ request }, testInfo) => {
  await authenticateWithLocalToken(request);
  await scenario(request, testInfo, "memory-off", async (stand) => {
    await writeNote(request, "Answer in short bullet lists.");
    // Control: with Memory on the same kind of turn carries the note and the tools.
    const onChat = await newChat(request, stand, `Memory on ${randomUUID().slice(0, 8)}`);
    const on = await apiTurn(request, onChat, "What is two plus two?");
    stand.evidence.on = turnFacts(on);
    expect(typeof frozenNote(on.run), "with Memory on the prompt carries the note").toBe("string");
    expect(frozenMemory(on.run)?.pastChats, "with Memory on past-chat search is offered").toBe(true);
    expect(frozenMemory(on.run)?.changes, "with Memory on manage_memory is offered").toBe(true);

    await patchSwitches(request, { memoryEnabled: false });
    try {
      const before = await readNote(request);
      const offChat = await newChat(request, stand, `Memory off ${randomUUID().slice(0, 8)}`);
      const off = await apiTurn(request, offChat, "Remember: I prefer tea over coffee. What is two plus two?");
      stand.evidence.off = turnFacts(off);
      expect(typeof frozenNote(off.run), "with Memory off the prompt has no note").toBe("undefined");
      expect(frozenMemory(off.run), "with Memory off no Memory tool is offered").toBeUndefined();
      expect(callsOf(off, MANAGE_MEMORY_TOOL_NAME).length + callsOf(off, SEARCH_PAST_CHATS_TOOL_NAME).length +
        callsOf(off, READ_PAST_CHAT_TOOL_NAME).length, "no Memory tool was called").toBe(0);
      expect((await readNote(request)).revision, "the note is unchanged").toBe(before.revision);
    } finally {
      await patchSwitches(request, { memoryEnabled: true });
    }
  });
});
