/**
 * Opt-in, paid, bounded evidence for the user's default sub-agent and for a named one never being replaced by the
 * built-in (`lib/server/engine/subagents/callTools.ts`, `lib/server/subagents/`, `agent_docs/RUN_CONTRACTS.md`, "Sub-agents").
 * Never a default lane: it runs only on a disposable stand (`next dev`, AIQSA_TEST_MODE=1, AIQSA_STATEFUL_TEST_TARGET=DISPOSABLE) with
 *
 *   AIQSA_FEATURES_PAID_E2E=DISPOSABLE
 *   CODEX_LB_BASE_URL, CODEX_LB_API_KEY, AIQSA_SUBAGENT_DEFAULT_CHAT_MODEL   model A, the chat model, by its upstream id
 *   OPENROUTER_API_KEY, AIQSA_SUBAGENT_DEFAULT_OTHER_MODEL                   model B, on another provider: an OpenRouter
 *     upstream id with a catalog template (`openrouter:<id>` in `lib/domain/providerTemplates.ts`), such as a cheap Gemini
 *
 * Expected paid calls: Codex LB custom setup and one OpenRouter model check, then 7 short turns (one on A, usually one
 * sub-agent turn on B). A paid turn is never retried. Oracles are the database rows and the owner routes, never the
 * model's wording. Output is one content-free line, `subagent_default_paid_evidence`: booleans, counts and stable codes.
 * Models, connections and the withdrawn model B stay on the stand, which is torn down afterwards.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import type { AssistantDetailResponse } from "../../lib/contracts/assistants";
import { decodeCatalogResponse, type CatalogModel } from "../../lib/contracts/catalog";
import type { ChatDetailResponseWire } from "../../lib/contracts/chats";
import type { SubagentChangeCard } from "../../lib/contracts/resourceChanges";
import {
  decodeSubagentDefinitionListResponse, subagentModelLabel, type SubagentDefaultUndoRequest, type SubagentDefinitionListResponse,
  type SubagentDefinitionResponse, type SubagentModelOption
} from "../../lib/contracts/subagentDefinitions";
import {
  CALL_SUBAGENT_TOOL_NAME, CREATE_SUBAGENT_TOOL_NAME, DELETE_SUBAGENT_TOOL_NAME, EDIT_SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAMES
} from "../../lib/contracts/subagents";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { providerModelTemplateId } from "../../lib/domain/providerTemplates";
import { journeyRunParams, modelInConnection, readConnections, type JourneyConnection } from "../../scripts/context-compaction-journey-support";
import { e2eAssistantAvatar, e2eAssistantRows } from "./support/assistants";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, waitForCatalogModel,
  type PaidAnswerModel
} from "./support/paidProviders";

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL") || !paidEnv("AIQSA_SUBAGENT_DEFAULT_CHAT_MODEL") ||
  !paidEnv("OPENROUTER_API_KEY") || !paidEnv("AIQSA_SUBAGENT_DEFAULT_OTHER_MODEL"),
"paid: requires CODEX_LB_API_KEY, CODEX_LB_BASE_URL, AIQSA_SUBAGENT_DEFAULT_CHAT_MODEL, OPENROUTER_API_KEY and AIQSA_SUBAGENT_DEFAULT_OTHER_MODEL");
test.describe.configure({ mode: "serial", timeout: 900_000 });
test.use({ trace: "off", screenshot: "off", video: "off" });

const prisma = new PrismaClient();
const OPENROUTER_ROOT = "https://openrouter.ai/api/v1";
const HELPER_NAME = "gemini-helper";
const DEFAULT_NAME = "gemini-default";
const TYPE_UNAVAILABLE = "subagent_type_unavailable";
/** Long enough for a tool call with a short brief; the answers asked for are one word. */
const MAX_OUTPUT_TOKENS = 1_024;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const MANAGEMENT_TOOLS: readonly string[] = [CREATE_SUBAGENT_TOOL_NAME, EDIT_SUBAGENT_TOOL_NAME, DELETE_SUBAGENT_TOOL_NAME];

const evidence: Record<string, boolean | number | string | null> = {};
let userId = "";
let chatModel: PaidAnswerModel | null = null;
let otherModel: Readonly<{ connectionId: string; modelId: string }> | null = null;
let helperId = "";

test.afterAll(async () => {
  console.log(`subagent_default_paid_evidence ${JSON.stringify(evidence)}`);
  await prisma.$disconnect();
});
test.beforeEach(async ({ request }) => { await authenticateWithLocalToken(request); });

const chatA = () => chatModel ?? (() => { throw new Error("subagent_paid_setup_missing"); })();
const modelB = () => otherModel ?? (() => { throw new Error("subagent_paid_setup_missing"); })();

async function adminOk(response: APIResponse, step: string): Promise<unknown> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  expect(response.ok(), `${step} (${response.status()} ${typeof body?.error === "string" ? body.error : ""})`).toBe(true);
  return body;
}

// ---------------------------------------------------------------------------
// Setup

type RawConnection = Readonly<{ checkRun?: Readonly<{ id?: unknown; state?: unknown }> | null; displayName?: unknown; id?: unknown }>;

function rawConnections(body: unknown): RawConnection[] {
  const connections = (body as { connections?: unknown } | null)?.connections;
  return Array.isArray(connections) ? connections as RawConnection[] : [];
}

async function readConnection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
  if (!found) throw new Error("subagent_paid_connection_missing");
  return found;
}

/**
 * A new OpenRouter connection holding exactly model B, through the ordinary admin connection API. Quick Setup would add
 * and probe every candidate; here `add_catalog_models` starts the one model's check, the only paid probe (the same
 * sequence as `tests/e2e/prod-1018-paid.spec.ts`, whose helper a spec file cannot export).
 */
async function setupOtherModel(request: APIRequestContext, upstreamModelId: string, secret: string) {
  const templateId = providerModelTemplateId(`openrouter:${upstreamModelId}`);
  expect(Boolean(templateId), "model B has an OpenRouter catalog template").toBe(true);
  const displayName = `Subagent default ${randomUUID().slice(0, 8)}`;
  const before = new Set(rawConnections(await (await request.get("/api/admin/providers")).json()).map((entry) => entry.id));
  const created = rawConnections(await adminOk(await request.post("/api/admin/providers", { data: {
    configuration: { allowPrivateNetwork: false, apiRoot: OPENROUTER_ROOT, authenticationMode: "bearer", responseTimeoutSeconds: 300 },
    displayName, family: "openrouter", unassignedPolicy: "use_default"
  } }), "the connection draft is created")).find((entry) => !before.has(entry.id) && entry.displayName === displayName);
  expect(Boolean(created), "the new connection is listed").toBe(true);
  const connectionId = String(created!.id);

  const placeholder = await adminOk(await request.post(`/api/admin/providers/${connectionId}/models`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    activate: true, displayName: "Placeholder",
    configuration: { adapterKind: "openrouter_chat_completions", answerSelectable: true, modelClass: "answer", upstreamModelId: "aiqsa/placeholder",
      defaultParams: {}, capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      openRouterRouting: { mode: "automatic", providers: [] } }
  } }), "the keyless placeholder publishes the connection") as { receipt?: { modelId?: unknown } };
  const placeholderId = String(placeholder.receipt?.modelId);
  await adminOk(await request.patch(`/api/admin/providers/${connectionId}/models/${placeholderId}`, { data: { action: "disable" } }),
    "the placeholder is disabled");
  await adminOk(await request.delete(`/api/admin/providers/${connectionId}/models/${placeholderId}`, { data: { confirmed: true } }),
    "the placeholder is deleted");
  await adminOk(await request.post(`/api/admin/providers/${connectionId}/credentials`, { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { activate: true, label: "Paid check key", secret } }), "the key is tested and added");
  await adminOk(await request.post(`/api/admin/providers/${connectionId}/actions`, { data: { action: "enable" } }), "the connection is enabled");

  const keyed = await readConnection(request, connectionId);
  const added = await adminOk(await request.post(`/api/admin/providers/${connectionId}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    action: "add_catalog_models", credentialId: keyed.defaultCredentialId, expectedConnectionVersion: keyed.activeVersion,
    expectedCredentialVersionId: keyed.defaultCredentialVersionId, modelIds: [templateId]
  } }), "the catalog model is added") as { unavailableModelIds?: unknown };
  expect(Array.isArray(added.unavailableModelIds) && added.unavailableModelIds.length === 0, "the key's catalog lists model B").toBe(true);
  const runId = rawConnections(added).find((entry) => entry.id === connectionId)?.checkRun?.id;
  expect(typeof runId, "the addition started the model's check run").toBe("string");
  const runState = await pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const response = await request.get(`/api/admin/providers/${connectionId}/actions?run=${encodeURIComponent(String(runId))}`);
    const run = response.ok() ? (await response.json() as { run?: { state?: unknown } }).run ?? null : null;
    return run && run.state !== "running" ? String(run.state) : null;
  }, "subagent_paid_check_run_timeout");
  evidence.otherModelCheckRun = runState;
  expect(runState, "model B's check run completed").toBe("completed");
  const row = modelInConnection(await readConnection(request, connectionId), upstreamModelId);
  expect(Boolean(row), "model B is on the connection").toBe(true);
  const catalog: CatalogModel = await waitForCatalogModel(request, connectionId, (candidate) => candidate.modelId === row!.id);
  expect(catalog.capabilities.toolCalling, "the catalog offers model B with tool calling").toBe(true);
  return { connectionId, modelId: row!.id };
}

async function listDefinitions(request: APIRequestContext): Promise<SubagentDefinitionListResponse> {
  const response = await request.get("/api/me/subagents");
  expect(response.ok(), `the sub-agent list is read (${response.status()})`).toBe(true);
  const list = decodeSubagentDefinitionListResponse(await response.json());
  if (!list) throw new Error("subagent_paid_list_invalid");
  return list;
}

/** A rerun on the same stand starts over: only this spec's own names are removed, which also clears a default on them. */
async function removeEarlierDefinitions(request: APIRequestContext): Promise<void> {
  for (const definition of (await listDefinitions(request)).definitions) {
    if (definition.name !== HELPER_NAME && definition.name !== DEFAULT_NAME) continue;
    await adminOk(await request.delete(`/api/me/subagents/${definition.id}`, { data: { expectedVersion: definition.version } }),
      "an earlier run's sub-agent is removed");
  }
}

async function setDefault(request: APIRequestContext, definitionId: string | null, expected: string | null): Promise<void> {
  await adminOk(await request.put("/api/me/subagents/default", { data: { definitionId, expected } }), "the default is moved");
}

// ---------------------------------------------------------------------------
// Turns and records

type TurnTarget = Readonly<{ assistantId: string } | { model: PaidAnswerModel }>;

/** One turn through the ordinary send route, without MCP or the Workspace. It is sent once and must complete. */
async function paidTurn(request: APIRequestContext, chatId: string, text: string, target: TurnTarget): Promise<ModelRun> {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  const routing = "model" in target
    ? { mcp: { mode: "off" }, modelId: target.model.modelId, params: target.model.params, provider: target.model.connectionId,
      searchPlan: { mode: "all_selected", optionIds: [] }, skills: { mode: "off" } }
    // An Assistant's rows decide the rest; an unchanged Assistant sends no ordinary composer payload.
    : { assistantId: target.assistantId };
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
    ...routing, content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId, timeZone: "UTC",
    workspace: { enabled: false }
  } });
  expect(response.ok(), `the paid turn is accepted (${response.status()})`).toBe(true);
  await response.body();
  const newest = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
  const settled = await pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: newest.id } });
    return ACTIVE_RUN_STATUSES.includes(run.status) ? null : run;
  }, "subagent_paid_turn_timeout");
  expect(settled.status, "the paid turn completes").toBe("complete");
  return settled;
}

/** The chat's sub-agent turns once none is still working, with the thread each belongs to. */
async function settledTurns(chatId: string) {
  return pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const turns = await prisma.subagentTurn.findMany({ where: { chatId }, orderBy: { startedAt: "asc" }, select: {
      modelSource: true, outcome: true, provider: true, providerModelId: true, state: true,
      thread: { select: { definitionId: true, typeName: true } }
    } });
    return turns.some((turn) => turn.state === "running" || turn.state === "waiting") ? null : turns;
  }, "subagent_paid_turns_timeout");
}
type Turn = Awaited<ReturnType<typeof settledTurns>>[number];

async function chatToolCalls(chatId: string) {
  return prisma.modelRunToolCall.findMany({ where: { modelRun: { chatId } }, select: {
    arguments: true, mcpRunBindingId: true, result: true, state: true, subagentThreadId: true, toolName: true
  } });
}
type ToolCall = Awaited<ReturnType<typeof chatToolCalls>>[number];

const mainCalls = (calls: readonly ToolCall[], toolName: string) => calls.filter((call) => call.subagentThreadId === null && call.toolName === toolName);
const carriesCode = (call: ToolCall, code: string) => JSON.stringify(call.result ?? null).includes(`"${code}"`);
const onB = (turn: Turn) => turn.providerModelId === modelB().modelId && turn.provider === modelB().connectionId;
const onA = (turn: Turn) => turn.providerModelId === chatA().modelId;
const isHelper = (turn: Turn) => turn.thread.definitionId === helperId && turn.thread.typeName === HELPER_NAME;
const isBuiltIn = (turn: Turn) => turn.thread.definitionId === null && turn.thread.typeName === null;

/** Whether every call left `type` out: the default, not a name the model chose, decided the type. */
const everyCallWithoutType = (calls: readonly ToolCall[]) => {
  const started = mainCalls(calls, CALL_SUBAGENT_TOOL_NAME);
  return started.length > 0 && started.every((call) => (call.arguments as { type?: unknown } | null)?.type === undefined);
};

/** Every recorded turn ran as `gemini-helper` on B and finished; the counts go into the evidence under `key`. */
function expectHelperTurns(turns: readonly Turn[], key: string): void {
  evidence[`${key}Turns`] = turns.length;
  evidence[`${key}TurnsOnA`] = turns.filter(onA).length;
  evidence[`${key}TurnsOnB`] = turns.filter(onB).length;
  evidence[`${key}BuiltInTurns`] = turns.filter(isBuiltIn).length;
  evidence[`${key}TurnsAsHelper`] = turns.filter(isHelper).length;
  evidence[`${key}TurnsDone`] = turns.filter((turn) => turn.state === "done").length;
  evidence[`${key}ModelSource`] = turns.at(-1)?.modelSource ?? null;
  evidence[`${key}Outcome`] = turns.at(-1)?.outcome ?? null;
  expect(turns.filter(onA).length, "no sub-agent turn ran on model A").toBe(0);
  expect(turns.filter(isBuiltIn).length, "the built-in sub-agent did not run").toBe(0);
  expect(turns.filter(onB).length, "every sub-agent turn ran on model B").toBe(turns.length);
  expect(turns.filter(isHelper).length, "every sub-agent turn ran as gemini-helper").toBe(turns.length);
  expect(turns.filter((turn) => turn.state === "done").length, "every sub-agent turn finished").toBe(turns.length);
}

/** The cards of the run's answer, as the browser reads them. */
async function answerCards(request: APIRequestContext, run: ModelRun): Promise<SubagentChangeCard[]> {
  const response = await request.get(`/api/chats/${run.chatId}`);
  expect(response.ok(), `the chat is read (${response.status()})`).toBe(true);
  const { chat } = await response.json() as ChatDetailResponseWire;
  const cards = chat.messages.find((message) => message.id === run.assistantMessageId)?.artifactSummary?.resourceChanges ?? [];
  return cards.filter((card): card is SubagentChangeCard => card.resource === "subagent");
}

async function hasAnswerText(run: ModelRun): Promise<boolean> {
  if (!run.assistantMessageId) return false;
  const message = await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } });
  return Boolean(message?.content && typeof message.content === "object" &&
    textFromContentBlocks(message.content as { blocks?: unknown[] }).trim());
}

const storedDefault = async () => (await prisma.userSettings.findUnique({ select: { defaultSubagentDefinitionId: true },
  where: { userId } }))?.defaultSubagentDefinitionId ?? null;

// ---------------------------------------------------------------------------

test("setup: chat model A on Codex LB, model B on OpenRouter, and gemini-helper on B", async ({ request }) => {
  test.setTimeout(1_800_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  expect(process.env.AIQSA_TEST_MODE, "the stand runs in test mode").toBe("1");
  userId = (await (await request.get("/api/me")).json() as { user: { id: string } }).user.id;

  const upstreamA = paidEnv("AIQSA_SUBAGENT_DEFAULT_CHAT_MODEL")!;
  const answer = await setupCodexLbAnswerModel(request, { label: "Subagent default", nativeSearch: false, preferredModel: upstreamA });
  // `setupCodexLbAnswerModel` falls back when the endpoint does not list the model; this evidence is about the one asked for.
  expect(answer.upstreamModelId === upstreamA, "model A is the requested model").toBe(true);
  const catalogA = await waitForCatalogModel(request, answer.connectionId, (candidate) => candidate.modelId === answer.modelId);
  chatModel = { ...answer, params: journeyRunParams(catalogA, MAX_OUTPUT_TOKENS) };

  otherModel = await setupOtherModel(request, paidEnv("AIQSA_SUBAGENT_DEFAULT_OTHER_MODEL")!, paidEnv("OPENROUTER_API_KEY")!);
  expect(chatA().connectionId !== modelB().connectionId, "A and B are on different connections").toBe(true);

  await removeEarlierDefinitions(request);
  await setDefault(request, null, await storedDefault());
  const list = await listDefinitions(request);
  const option: SubagentModelOption | undefined = list.models.find((candidate) => candidate.modelId === modelB().modelId);
  expect(Boolean(option), "model B is among the models a sub-agent may run on").toBe(true);
  const created = await adminOk(await request.post("/api/me/subagents", { data: {
    description: "Answers short questions through Gemini.", effort: option!.efforts.includes("low") ? "low" : null,
    instructions: "Reply with exactly what you are asked to reply, nothing else.", modelId: modelB().modelId, name: HELPER_NAME, tools: []
  } }), "gemini-helper is created") as SubagentDefinitionResponse;
  helperId = created.definition.id;
  expect(await storedDefault(), "no default sub-agent yet").toBeNull();
});

test("a loose name runs the custom sub-agent on its own model, never the built-in on the chat's", async ({ request }) => {
  const chatId = await newExcludedChat(request, `Subagent loose ${randomUUID().slice(0, 8)}`);
  await paidTurn(request, chatId, "Вызови саб-агента gemini, пусть ответит OK.", { model: chatA() });
  const turns = await settledTurns(chatId);
  const calls = await chatToolCalls(chatId);
  // Telling the user the name does not exist is allowed by the contract; quietly running the built-in one is not.
  evidence.looseToldUserInstead = turns.length === 0;
  evidence.looseRefusalsBeforeExactName = mainCalls(calls, CALL_SUBAGENT_TOOL_NAME).filter((call) => carriesCode(call, TYPE_UNAVAILABLE)).length;
  expectHelperTurns(turns, "loose");
});

test("a sub-agent on another model and the default, from one chat message, with one card whose Undo restores both", async ({ request }) => {
  const list = await listDefinitions(request);
  const label = subagentModelLabel(list.models.find((candidate) => candidate.modelId === modelB().modelId)!);
  const chatId = await newExcludedChat(request, `Subagent create ${randomUUID().slice(0, 8)}`);
  const run = await paidTurn(request, chatId, `Сделай саб-агента с именем ${DEFAULT_NAME} на модели «${label}» и сделай его дефолтным. ` +
    "Описание и инструкции: по одному короткому предложению. Больше ничего не делай и не вызывай его.", { model: chatA() });
  const calls = await chatToolCalls(chatId);
  const creations = mainCalls(calls, CREATE_SUBAGENT_TOOL_NAME);
  const definition = await prisma.subagentDefinition.findUnique({ where: { ownerUserId_name: { name: DEFAULT_NAME, ownerUserId: userId } },
    select: { currentRevision: { select: { providerModelId: true } }, id: true } });
  const cards = await answerCards(request, run);
  const card = cards[0];
  evidence.createSuccessfulCalls = creations.filter((call) => call.state === "complete").length;
  evidence.createCards = cards.length;
  evidence.createCardMovedDefault = card?.defaultChange?.isDefault ?? null;
  evidence.createOtherChanges = mainCalls(calls, EDIT_SUBAGENT_TOOL_NAME).length + mainCalls(calls, CALL_SUBAGENT_TOOL_NAME).length;
  evidence.createDefinitionOnB = definition?.currentRevision?.providerModelId === modelB().modelId;
  evidence.createDefaultSet = definition !== null && await storedDefault() === definition.id;
  expect(evidence.createSuccessfulCalls, "exactly one successful create_subagent").toBe(1);
  expect(evidence.createOtherChanges, "nothing else was done").toBe(0);
  expect(evidence.createDefinitionOnB, "the sub-agent runs on model B").toBe(true);
  expect(evidence.createDefaultSet, "the default points at it").toBe(true);
  expect(cards.length, "one card").toBe(1);
  expect(card!.action === "created" && card!.definitionId === definition!.id, "the card is this creation").toBe(true);
  expect(card!.defaultChange?.isDefault === true && card!.defaultChange.previous === null, "the card says the default moved from the built-in").toBe(true);

  // What the card's Undo sends (`features/answer-outputs-v2/ResourceChangeCardV2.tsx`).
  const undo: SubagentDefaultUndoRequest = { definition: { expectedVersion: card!.definitionVersion, id: card!.definitionId, revisionId: null },
    restore: { expected: card!.definitionId, target: null } };
  const undone = await adminOk(await request.post("/api/me/subagents/default/undo", { data: undo }), "Undo is accepted") as { outcome?: unknown };
  evidence.undoOutcome = typeof undone.outcome === "string" ? undone.outcome : null;
  evidence.undoDefinitionGone = await prisma.subagentDefinition.count({ where: { id: definition!.id } }) === 0;
  evidence.undoDefaultCleared = await storedDefault() === null;
  expect(evidence.undoOutcome, "the default is back").toBe("restored");
  expect(evidence.undoDefinitionGone, "the definition is gone").toBe(true);
  expect(evidence.undoDefaultCleared, "the pointer is back to none").toBe(true);

  await setDefault(request, helperId, null);
  expect(await storedDefault() === helperId, "gemini-helper is the default now").toBe(true);
});

test("with a default set, a new chat's sub-agent runs on its model, and type built-in on the chat's", async ({ request }) => {
  const defaultChat = await newExcludedChat(request, `Subagent default ${randomUUID().slice(0, 8)}`);
  await paidTurn(request, defaultChat, "Вызови саб-агента, пусть ответит OK.", { model: chatA() });
  const defaultTurns = await settledTurns(defaultChat);
  evidence.defaultCallLeftTypeOut = everyCallWithoutType(await chatToolCalls(defaultChat));
  expect(defaultTurns.length, "the default sub-agent ran").toBeGreaterThan(0);
  expectHelperTurns(defaultTurns, "default");

  const builtInChat = await newExcludedChat(request, `Subagent built-in ${randomUUID().slice(0, 8)}`);
  await paidTurn(request, builtInChat, "Вызови встроенного саб-агента (type: built-in), пусть ответит OK.", { model: chatA() });
  const builtInTurns = await settledTurns(builtInChat);
  evidence.builtInTurns = builtInTurns.length;
  evidence.builtInTurnsOnA = builtInTurns.filter(onA).length;
  evidence.builtInTurnsOnB = builtInTurns.filter(onB).length;
  evidence.builtInTurnsAsBuiltIn = builtInTurns.filter(isBuiltIn).length;
  evidence.builtInTurnsDone = builtInTurns.filter((turn) => turn.state === "done").length;
  expect(evidence.builtInTurns, "the built-in sub-agent ran").toBeGreaterThan(0);
  expect(evidence.builtInTurnsOnA, "on model A").toBe(builtInTurns.length);
  expect(evidence.builtInTurnsAsBuiltIn, "as the built-in").toBe(builtInTurns.length);
  expect(evidence.builtInTurnsDone, "and finished").toBe(builtInTurns.length);
});

test("in an Assistant chat a named sub-agent and the default run on their model, within the run's tools", async ({ request }) => {
  const created = await adminOk(await request.post("/api/me/assistants", { data: {
    answerRules: null, avatar: e2eAssistantAvatar(), category: null, description: "", name: `Subagent paid ${randomUUID().slice(0, 8)}`,
    responseReminder: "", rows: e2eAssistantRows(chatA().modelId), starterPrompts: [], systemPrompt: "You are terse."
  } }), "the Assistant is created") as AssistantDetailResponse;
  const target = { assistantId: created.assistant.id };

  const check = async (text: string, key: string) => {
    const chatId = await newExcludedChat(request, `Subagent assistant ${randomUUID().slice(0, 8)}`);
    const run = await paidTurn(request, chatId, text, target);
    const turns = await settledTurns(chatId);
    const calls = await chatToolCalls(chatId);
    const ownCalls = calls.filter((call) => call.subagentThreadId !== null);
    const offLimits = new Set<string>([...SUBAGENT_TOOL_NAMES]);
    evidence[`${key}RunAsAssistant`] = run.assistantId === target.assistantId;
    evidence[`${key}RunProviderIsConnection`] = run.provider === chatA().connectionId;
    evidence[`${key}RunOnA`] = [chatA().upstreamModelId, chatA().modelId].includes(run.modelId);
    expect(evidence[`${key}RunAsAssistant`], "the answer ran as the Assistant").toBe(true);
    evidence[`${key}ManagementCalls`] = calls.filter((call) => MANAGEMENT_TOOLS.includes(call.toolName)).length;
    evidence[`${key}SubagentToolCalls`] = ownCalls.length;
    // The Assistant's tools are off, so a sub-agent reaches no MCP server and never the main agent's sub-agent tools.
    evidence[`${key}SubagentCallsBeyondRun`] = ownCalls.filter((call) => offLimits.has(call.toolName) || call.mcpRunBindingId !== null).length;
    expect(evidence[`${key}RunOnA`], "the answer ran on model A").toBe(true);
    expect(turns.length, "the sub-agent ran").toBeGreaterThan(0);
    expectHelperTurns(turns, key);
    expect(evidence[`${key}ManagementCalls`], "no management tool was called").toBe(0);
    expect(evidence[`${key}SubagentCallsBeyondRun`], "the sub-agent stayed within the run's tools").toBe(0);
    return calls;
  };

  await check("Вызови саб-агента gemini-helper, пусть ответит OK.", "assistantNamed");
  evidence.assistantDefaultCallLeftTypeOut = everyCallWithoutType(await check("Вызови саб-агента, пусть ответит OK.", "assistantDefault"));
});

test("a default whose model is withdrawn refuses visibly and starts nothing else", async ({ request }) => {
  const { connectionId, modelId } = modelB();
  await adminOk(await request.patch(`/api/admin/providers/${connectionId}/models/${modelId}`, { data: { action: "disable" } }), "model B is disabled");
  await pollUntil(120_000, async () => {
    const catalog = decodeCatalogResponse(await (await request.get("/api/me/catalog")).json());
    return catalog && !catalog.models.some((model) => model.modelId === modelId) ? true : null;
  }, "subagent_paid_catalog_kept_model");

  const chatId = await newExcludedChat(request, `Subagent withdrawn ${randomUUID().slice(0, 8)}`);
  const run = await paidTurn(request, chatId, "Вызови саб-агента, пусть ответит OK.", { model: chatA() });
  const turns = await settledTurns(chatId);
  const started = mainCalls(await chatToolCalls(chatId), CALL_SUBAGENT_TOOL_NAME);
  evidence.withdrawnCalls = started.length;
  evidence.withdrawnRefusals = started.filter((call) => carriesCode(call, TYPE_UNAVAILABLE)).length;
  evidence.withdrawnTurns = turns.length;
  evidence.withdrawnAnswerFinished = await hasAnswerText(run);
  expect(evidence.withdrawnRefusals, "the tool refused with subagent_type_unavailable").toBeGreaterThan(0);
  expect(evidence.withdrawnTurns, "no sub-agent ran on any other model").toBe(0);
  expect(evidence.withdrawnAnswerFinished, "the answer finished").toBe(true);
});
