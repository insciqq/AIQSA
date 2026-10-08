/**
 * Opt-in, paid, bounded end-to-end check of the cross-turn tool history
 * (issue #38) on a DISPOSABLE stand with a real tool-capable answer model.
 * Never a default lane: it runs only with AIQSA_TOOL_HISTORY_PAID_E2E=DISPOSABLE
 * and either
 * - AIQSA_TOOL_HISTORY_PROVIDER + AIQSA_TOOL_HISTORY_MODEL: the catalog
 *   provider (connection id) and model id of a ready tool-capable model, or
 * - CODEX_LB_API_KEY + CODEX_LB_BASE_URL (the OpenAI-compatible root, `…/v1`)
 *   and optionally AIQSA_TOOL_HISTORY_CODEX_MODEL (default gpt-5.5): a codex-lb
 *   Responses model this spec configures through the Admin API with the window
 *   AIQSA_TOOL_HISTORY_CONTEXT_WINDOW (default 32768), so notes are bought early.
 * AIQSA_TOOL_HISTORY_FIXTURE_HOST / AIQSA_TOOL_HISTORY_FIXTURE_PUBLIC_HOST place
 * the synthetic MCP peer for a stand that reaches it by another name.
 *
 * Oracles never rest on the model's wording alone: the synthetic peer counts
 * dispatches by exact arguments, and the stand's database holds each run's
 * frozen history references, call rows and context notes. Prompts, answers
 * and payloads are never printed; the attached summary holds counts and
 * booleans only.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { decodeCatalogResponse, type CatalogModel } from "../../lib/contracts/catalog";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { namespacedMcpToolName } from "../../lib/server/mcp/runPlan";
import { toolCallRef } from "../../lib/server/runs/toolHistoryContract";
import { decodeAdminProviderModelSaveReceipt } from "../../lib/contracts/adminProviderModelSave";
import {
  catalogReadiness,
  codexLbSetupBody,
  contextWindowUpdate,
  journeyRunParams,
  modelInConnection,
  readConnections
} from "../../scripts/context-compaction-journey-support";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { signInWithLocalToken } from "./support/localAuth";
import {
  createToolHistoryFixture,
  startMutableMcpEndpoint,
  TOOL_HISTORY_FIXTURE,
  toolHistoryItemCode
} from "./support/mutableMcpEndpoint";
import { disableMemoryRecall } from "./support/workspace";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_TOOL_HISTORY_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_TOOL_HISTORY_PAID_E2E=DISPOSABLE on a disposable stand");
test.afterAll(() => prisma.$disconnect());

const SETUP_TIMEOUT_MS = 900_000;
const TURN_TIMEOUT_MS = 660_000;
const POLL_INTERVAL_MS = 2_000;
const ACTIVE_STATUSES = ["preparing", "queued", "streaming", "in_progress"] as const;

type AnswerModel = Readonly<{ contextWindow: number | null; modelId: string; params: Record<string, unknown>; provider: string }>;
type FrozenTurn = Readonly<{ callRefs: readonly string[]; turnMessageId: string }>;

const env = (name: string) => process.env[name]?.trim() || null;

async function poll<T>(timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("tool_history_poll_timeout");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Parameters the composer would send, else the model's defaults. */
function runParams(model: CatalogModel): Record<string, unknown> {
  try { return journeyRunParams(model, 4096); } catch { return { ...model.defaultParams }; }
}

async function catalogModel(request: APIRequestContext, provider: string, modelId: string, contextWindow?: number): Promise<AnswerModel> {
  let state = "catalog_model_missing";
  const model = await poll(SETUP_TIMEOUT_MS, async () => {
    const catalog = decodeCatalogResponse(await (await request.get("/api/me/catalog")).json());
    const entry = catalog?.models.find((candidate) => candidate.provider === provider && candidate.modelId === modelId);
    state = contextWindow === undefined
      ? !entry ? "catalog_model_missing" : entry.capabilities.toolCalling ? "ready" : "catalog_tool_calling_unavailable"
      : catalogReadiness(entry, contextWindow);
    return state === "ready" ? entry! : null;
  }).catch((error: unknown) => {
    // The timeout names the last observed catalog state.
    throw error instanceof Error && error.message === "tool_history_poll_timeout" ? new Error(`tool_history_${state}`) : error;
  });
  return { contextWindow: model.contextWindow, modelId, params: runParams(model), provider };
}

/** A codex-lb Responses model, configured once through the Admin API. */
async function codexLbModel(request: APIRequestContext): Promise<AnswerModel> {
  const apiRoot = env("CODEX_LB_BASE_URL")?.replace(/\/+$/u, "");
  const secret = env("CODEX_LB_API_KEY");
  if (!apiRoot || !secret) throw new Error("tool_history_model_unconfigured");
  const upstream = env("AIQSA_TOOL_HISTORY_CODEX_MODEL") ?? "gpt-5.5";
  const contextWindow = Number(env("AIQSA_TOOL_HISTORY_CONTEXT_WINDOW") ?? 32_768);
  const discovered = await request.post("/api/admin/providers/custom-setup/discover", { timeout: SETUP_TIMEOUT_MS,
    data: { allowPrivateNetwork: true, apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret } });
  const discovery = discovered.ok() ? await discovered.json() as { catalogProof?: unknown; models?: Array<{ id?: unknown }> } : null;
  const catalogProof = typeof discovery?.catalogProof === "string" && discovery.models?.some((model) => model.id === upstream)
    ? discovery.catalogProof : undefined;
  const setup = await request.post("/api/admin/providers/custom-setup", { timeout: SETUP_TIMEOUT_MS,
    data: codexLbSetupBody({ apiRoot, ...(catalogProof ? { catalogProof } : {}), contextWindow, model: upstream, secret,
      connectionDisplayName: `Tool history ${randomUUID().slice(0, 8)}` }) });
  expect(setup.ok(), "codex-lb custom setup is accepted").toBe(true);
  const outcome = await setup.json() as { connectionId?: unknown; outcome?: unknown };
  expect(["ready", "partial"], "codex-lb custom setup is usable").toContain(outcome.outcome);
  const connectionId = String(outcome.connectionId);
  const providerModelId = await poll(SETUP_TIMEOUT_MS, async () => {
    const connection = readConnections(await (await request.get("/api/admin/providers")).json())
      ?.find((candidate) => candidate.id === connectionId);
    return connection && !connection.checkRunning ? modelInConnection(connection, upstream)?.id ?? null : null;
  });
  // A discovered model keeps the upstream catalog's window; publish the check window as the administrator's value.
  const configured = readConnections(await (await request.get("/api/admin/providers")).json())
    ?.find((candidate) => candidate.id === connectionId);
  const configuredModel = configured ? modelInConnection(configured, upstream) : null;
  const windowUpdate = configuredModel ? contextWindowUpdate(configuredModel, contextWindow) : null;
  if (windowUpdate) {
    const saved = await request.patch(
      `/api/admin/providers/${encodeURIComponent(connectionId)}/models/${encodeURIComponent(providerModelId)}`,
      { data: windowUpdate, timeout: SETUP_TIMEOUT_MS });
    const receipt = decodeAdminProviderModelSaveReceipt(saved.ok() ? (await saved.json() as { receipt?: unknown }).receipt : null);
    expect(receipt?.publication, "the check context window is published").toBe("active");
  }
  return catalogModel(request, connectionId, providerModelId, contextWindow);
}

async function answerModel(request: APIRequestContext): Promise<AnswerModel> {
  const provider = env("AIQSA_TOOL_HISTORY_PROVIDER");
  const modelId = env("AIQSA_TOOL_HISTORY_MODEL");
  return provider && modelId ? catalogModel(request, provider, modelId) : codexLbModel(request);
}

/** Publishes the synthetic peer and enables it for the signed-in user. */
async function registerFixtureServer(request: APIRequestContext, url: string, userId: string): Promise<AdminMcpServer> {
  const created = await request.post("/api/admin/mcp", { data: {
    activate: false, description: "Synthetic records for the cross-turn tool history",
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url }, transport: "streamable_http" },
    name: `Tool history records ${randomUUID().slice(0, 8)}`, sharedValues: {}
  } });
  expect(created.status()).toBe(201);
  const server = (await created.json() as { server: AdminMcpServer }).server;
  const checked = await request.post(`/api/admin/mcp/${server.id}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true } });
  expect(checked.status()).toBe(200);
  expect((await request.put(`/api/admin/mcp/${server.id}/grants`, { data: { canUse: true, personalSlotKeys: [], userId } })).ok()).toBe(true);
  expect((await request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
  // These scenarios test the history of real writes, not their approval: the
  // user always allows the synthetic server, as its card's Always allow would.
  await prisma.mcpToolConsent.create({ data: { serverId: server.id, userId } });
  return server;
}

/** A personal chat that never becomes a Memory source. */
async function newChat(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/chats", { data: { title: "Tool history check" } });
  expect(created.ok()).toBe(true);
  const chatId = (await created.json() as { chat: { id: string } }).chat.id;
  expect((await request.patch(`/api/me/chats/${chatId}/memory-mode`, { data: { mode: "EXCLUDED" } })).ok()).toBe(true);
  return chatId;
}

function controls(model: AnswerModel) {
  return { mcp: { mode: "load_all" }, modelId: model.modelId, params: model.params, provider: model.provider,
    searchPlan: { mode: "all_selected", optionIds: [] }, searchStrategy: "search-disabled", timeZone: "UTC" };
}

/** Posts one message and waits for its stream, which ends with the run. */
async function post(request: APIRequestContext, chatId: string, text: string, model: AnswerModel): Promise<void> {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: TURN_TIMEOUT_MS, data: {
    ...controls(model), content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId } });
  expect(response.ok(), `send is accepted (${response.status()})`).toBe(true);
  await response.body();
}

async function newestRun(chatId: string): Promise<ModelRun> {
  return prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
}

async function completed(run: ModelRun): Promise<ModelRun> {
  const settled = await poll(TURN_TIMEOUT_MS, async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } });
    return (ACTIVE_STATUSES as readonly string[]).includes(current.status) ? null : current;
  });
  const code = (settled.errorPayload as { code?: unknown } | null)?.code;
  expect(settled.status, `the run completes (${typeof code === "string" ? code : settled.status})`).toBe("complete");
  return settled;
}

async function turn(request: APIRequestContext, chatId: string, text: string, model: AnswerModel): Promise<ModelRun> {
  await post(request, chatId, text, model);
  return completed(await newestRun(chatId));
}

async function regenerate(request: APIRequestContext, chatId: string, assistantMessageId: string, model: AnswerModel): Promise<ModelRun> {
  const response = await request.post(`/api/messages/${assistantMessageId}/regenerate`, { timeout: TURN_TIMEOUT_MS,
    data: { ...controls(model), admissionId: randomUUID(), workspace: { enabled: false } } });
  expect(response.ok(), `regenerate is accepted (${response.status()})`).toBe(true);
  await response.body();
  return completed(await newestRun(chatId));
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ where: { id: run.assistantMessageId }, select: { content: true } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

function frozenTurns(run: ModelRun): readonly FrozenTurn[] {
  const history = (run.normalizedRequest as { toolHistory?: { turns?: FrozenTurn[] } } | null)?.toolHistory;
  return history?.turns ?? [];
}

async function callRow(runId: string, toolName: string, args?: Readonly<Record<string, unknown>>) {
  const rows = await prisma.modelRunToolCall.findMany({ where: { modelRunId: runId, toolName }, orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }] });
  return rows.find((row) => !args || Object.entries(args).every(([key, value]) => (row.arguments as Record<string, unknown>)[key] === value)) ?? null;
}

/** Whether any committed context note of the chat cites `ref`. */
async function notesCite(chatId: string, ref: string): Promise<boolean> {
  const runs = await prisma.modelRun.findMany({ where: { chatId }, select: { toolLoopState: true } });
  const cites = (value: unknown): boolean => Array.isArray(value) ? value.some(cites)
    : value !== null && typeof value === "object"
      ? Array.isArray((value as { sourceRefs?: unknown }).sourceRefs) &&
        typeof (value as { notes?: unknown }).notes === "string" && ((value as { sourceRefs: unknown[] }).sourceRefs).includes(ref) ||
        Object.values(value).some(cites)
      : false;
  return runs.some((run) => cites(run.toolLoopState));
}

/** About `tokens` tokens of neutral text for one filler turn. */
function filler(index: number, tokens: number): string {
  const line = `Synthetic filler ${index}: neutral archive text about weather stations, ferries and libraries.`;
  return `Reply only "OK". ${Array.from({ length: Math.ceil((tokens * 4) / line.length) }, () => line).join(" ")}`;
}

test("a real model keeps earlier tool calls across turns, attempts, context notes and Stop", async ({ page }, testInfo) => {
  test.setTimeout(90 * 60_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const fixture = createToolHistoryFixture();
  const host = env("AIQSA_TOOL_HISTORY_FIXTURE_HOST");
  const publicHost = env("AIQSA_TOOL_HISTORY_FIXTURE_PUBLIC_HOST");
  const endpoint = await startMutableMcpEndpoint(fixture.tools, { callTool: fixture.callTool,
    ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
  const chats = new Set<string>();
  const summary: Record<string, unknown> = {};
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    await disableMemoryRecall(page);
    const request = page.request;
    const userId = ((await (await request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    const server = await registerFixtureServer(request, endpoint.url, userId);
    serverId = server.id;
    const names = { read: namespacedMcpToolName(server.namespace, TOOL_HISTORY_FIXTURE.readTool),
      write: namespacedMcpToolName(server.namespace, TOOL_HISTORY_FIXTURE.writeTool) };
    const model = await answerModel(request);
    summary.contextWindow = model.contextWindow;
    const write = (title: string) => ({ title });

    await test.step("a write stays known to the next turn and is not repeated", async () => {
      const chatId = await newChat(request);
      chats.add(chatId);
      const title = `Synthetic history ${randomUUID().slice(0, 8)}`;
      const first = await turn(request, chatId, `Create one record titled "${title}" with the create_record tool, then reply with the id it returned and nothing else.`, model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)), "the write was dispatched once").toBe(1);
      const created = fixture.records().find((record) => record.title === title)!;
      const call = await callRow(first.id, names.write);
      expect(call, "the write is persisted").not.toBeNull();
      const second = await turn(request, chatId, `Did you already create the record "${title}" earlier in this chat? Reply with its id and the exact title you used. Do not create anything new.`, model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)), "the next turn did not repeat the write").toBe(1);
      expect(frozenTurns(second).find((entry) => entry.turnMessageId === first.assistantMessageId)?.callRefs ?? [],
        "the next turn froze the write under its answer").toContain(toolCallRef(call!.id));
      summary.write = { dispatches: 1, frozenUnderAnswer: true, answerNamesRecord: (await answerText(second)).includes(created.id) };

      // Ten distinguishable reads, then the fifth one's code from its saved record.
      const reads = await turn(request, chatId, `Call get_item once for each index from 1 to ${TOOL_HISTORY_FIXTURE.items}, one index per call. After the ${TOOL_HISTORY_FIXTURE.items} calls reply only "done".`, model);
      for (let index = 1; index <= TOOL_HISTORY_FIXTURE.items; index += 1) {
        expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.readTool, { index }), `item ${index} was read once`).toBe(1);
      }
      const fifth = await callRow(reads.id, names.read, { index: 5 });
      expect(fifth, "the fifth read is persisted").not.toBeNull();
      const leaked = (await answerText(reads)).includes(toolHistoryItemCode(5));
      const probe = await turn(request, chatId, "What verification code did the get_item call for index 5 report? Do not call get_item again: the code is at the end of that report, so read the saved call or result if the history does not show it.", model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.readTool), "no item was read again").toBe(TOOL_HISTORY_FIXTURE.items);
      const probeCalls = await prisma.modelRunToolCall.findMany({ where: { modelRunId: probe.id } });
      expect(probeCalls.some((call) => call.toolName === names.read || call.toolName === names.write), "the probe dispatched nothing").toBe(false);
      const readers = probeCalls.filter((call) => call.toolName === "read_tool_call" || call.toolName === "read_tool_result");
      const named = probeCalls.filter((call) => call.toolName === "read_tool_call")
        .map((call) => (call.arguments as { call_ref?: unknown }).call_ref);
      if (!leaked) expect(readers.length, "the probe read the saved record").toBeGreaterThan(0);
      if (named.length > 0) expect(named, "read_tool_call named the fifth call").toContain(toolCallRef(fifth!.id));
      expect((await answerText(probe)).includes(toolHistoryItemCode(5)), "the answer names the fifth report's code").toBe(true);
      summary.fifthOfTen = { reads: TOOL_HISTORY_FIXTURE.items, probeReaderCalls: readers.length, readToolCallCalls: named.length,
        answerTextAlreadyHadCode: leaked, codeAnswered: true };
    });

    await test.step("Regenerate after a write sees the earlier attempt and does not repeat it", async () => {
      const chatId = await newChat(request);
      chats.add(chatId);
      const title = `Synthetic regenerate ${randomUUID().slice(0, 8)}`;
      const first = await turn(request, chatId, `Create one record titled "${title}" with the create_record tool, then reply with its id only.`, model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title))).toBe(1);
      const ref = toolCallRef((await callRow(first.id, names.write))!.id)!;
      const regenerated = await regenerate(request, chatId, first.assistantMessageId!, model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)), "Regenerate did not repeat the write").toBe(1);
      expect(frozenTurns(regenerated).find((entry) => entry.turnMessageId === first.userMessageId)?.callRefs ?? [],
        "the regenerated run froze the earlier attempt's write").toContain(ref);
      const next = await turn(request, chatId, `Which record did you create for "${title}"? Confirm it with read_tool_call on that earlier call, and do not create anything.`, model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)), "the next send did not repeat the write").toBe(1);
      expect(frozenTurns(next).find((entry) => entry.turnMessageId === regenerated.assistantMessageId)?.callRefs ?? [],
        "the next send keeps the earlier attempt's write").toContain(ref);
      const reads = (await prisma.modelRunToolCall.findMany({ where: { modelRunId: next.id, toolName: "read_tool_call" } }))
        .filter((call) => (call.arguments as { call_ref?: unknown }).call_ref === ref);
      for (const read of reads) {
        expect(JSON.stringify(read.result).includes("tool_call_unavailable"), "the reader accepts the earlier attempt's ref").toBe(false);
      }
      summary.regenerate = { dispatches: 1, frozenAsEarlierAttempt: true, keptAfterNextSend: true, readsOfEarlierAttempt: reads.length };
    });

    await test.step("context notes keep the write's call_ref after forced compaction", async () => {
      if (model.contextWindow === null || model.contextWindow > 65_536) {
        test.info().annotations.push({ type: "skipped", description: "compaction needs a context window of at most 65536" });
        summary.compaction = { skipped: true };
        return;
      }
      const chatId = await newChat(request);
      chats.add(chatId);
      const title = `Synthetic notes ${randomUUID().slice(0, 8)}`;
      const first = await turn(request, chatId, `Create one record titled "${title}" with the create_record tool, then reply with its id only.`, model);
      const ref = toolCallRef((await callRow(first.id, names.write))!.id)!;
      let fillers = 0;
      while (!await notesCite(chatId, ref) && fillers < 12) {
        await turn(request, chatId, filler(fillers, Math.floor(model.contextWindow / 6)), model);
        fillers += 1;
      }
      const cited = await notesCite(chatId, ref);
      expect(cited, "committed notes cite the write by its call_ref").toBe(true);
      const probe = await turn(request, chatId, "What exact title did the record you created at the start of this chat have, and what id? Do not create anything.", model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)), "the write was not repeated after compaction").toBe(1);
      summary.compaction = { fillers, notesCiteWrite: cited, answerHasTitle: (await answerText(probe)).includes(title) };
    });

    await test.step("Stop after a write keeps it in the next turn's history", async () => {
      const chatId = await newChat(request);
      chats.add(chatId);
      const title = `Synthetic stop ${randomUUID().slice(0, 8)}`;
      fixture.setReadDelayMs(5_000);
      const stopped = post(request, chatId, `First create one record titled "${title}" with the create_record tool. After that, call get_item for each index from 1 to ${TOOL_HISTORY_FIXTURE.items}, one call at a time, and finally summarize the reports.`, model);
      await poll(TURN_TIMEOUT_MS, async () => endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)) === 1 ? true : null);
      const active = await prisma.modelRun.findFirstOrThrow({ where: { chatId, status: { in: [...ACTIVE_STATUSES] } } });
      expect((await request.post(`/api/model-runs/${active.id}/cancel`, { data: {} })).ok(), "Stop is accepted").toBe(true);
      await stopped.catch(() => undefined);
      fixture.setReadDelayMs(0);
      const cancelled = await poll(TURN_TIMEOUT_MS, async () => {
        const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: active.id } });
        return (ACTIVE_STATUSES as readonly string[]).includes(run.status) ? null : run;
      });
      expect(cancelled.status).toBe("cancelled");
      const ref = toolCallRef((await callRow(active.id, names.write))!.id)!;
      const next = await turn(request, chatId, `Was the record "${title}" created before you were stopped? If it exists, do not create it again; reply with its id.`, model);
      expect(endpoint.dispatches(TOOL_HISTORY_FIXTURE.writeTool, write(title)), "the write was not repeated after Stop").toBe(1);
      expect(frozenTurns(next).flatMap((entry) => entry.callRefs), "the next turn froze the stopped run's write").toContain(ref);
      const created = fixture.records().find((record) => record.title === title)!;
      summary.stop = { dispatches: 1, stoppedRunCancelled: true, frozenAfterStop: true,
        answerNamesRecord: (await answerText(next)).includes(created.id) };
    });
  } finally {
    await testInfo.attach("tool-history-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    fixture.setReadDelayMs(0);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chats) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    await endpoint.close();
  }
});
