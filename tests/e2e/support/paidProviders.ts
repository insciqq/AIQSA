import { randomUUID } from "node:crypto";
import type { ModelRun, PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext } from "@playwright/test";
import { adminSearchExecutionDefaults, type AdminSearchCatalog, type AdminSearchIntegration } from "../../../lib/contracts/adminSearch";
import { decodeCatalogResponse, type CatalogModel } from "../../../lib/contracts/catalog";
import { codexLbSetupBody, journeyRunParams, modelInConnection, readConnections } from "../../../scripts/context-compaction-journey-support";

/**
 * Real-provider setup and bounded turns for the opt-in paid usage specs on a
 * DISPOSABLE stand. Secrets come from the environment and are only sent to
 * the stand's admin API; nothing here prints them. Connections a spec creates
 * stay on the disposable stand.
 */

export const PAID_SETUP_TIMEOUT_MS = 600_000;
export const PAID_TURN_TIMEOUT_MS = 300_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];

export const paidEnv = (name: string): string | null => process.env[name]?.trim() || null;

export type PaidAnswerModel = Readonly<{
  /** The catalog provider id: the connection. */
  connectionId: string;
  displayName: string;
  /** The catalog model id: the provider model (deployment). */
  modelId: string;
  params: Record<string, unknown>;
  upstreamModelId: string;
}>;

export async function pollUntil<T>(timeoutMs: number, probe: () => Promise<T | null>, code = "paid_poll_timeout"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(code);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function catalogModels(request: APIRequestContext): Promise<readonly CatalogModel[]> {
  return decodeCatalogResponse(await (await request.get("/api/me/catalog")).json())?.models ?? [];
}

/** Waits until the connection has catalog models that `accept` admits; returns all of them. */
export async function waitForCatalogModels(
  request: APIRequestContext,
  connectionId: string,
  accept: (model: CatalogModel) => boolean,
  timeoutMs = PAID_SETUP_TIMEOUT_MS
): Promise<readonly CatalogModel[]> {
  return pollUntil(timeoutMs, async () => {
    const models = (await catalogModels(request)).filter((model) => model.provider === connectionId && accept(model));
    return models.length ? models : null;
  }, "paid_catalog_model_timeout");
}

/** Waits for a catalog model of the connection that `accept` admits. */
export async function waitForCatalogModel(
  request: APIRequestContext,
  connectionId: string,
  accept: (model: CatalogModel) => boolean,
  timeoutMs = PAID_SETUP_TIMEOUT_MS
): Promise<CatalogModel> {
  return (await waitForCatalogModels(request, connectionId, accept, timeoutMs))[0]!;
}

/**
 * A codex-lb answer model through custom setup (CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL, the Codex root ending in `/backend-api/codex`, so catalog
 * prices apply). `nativeSearch` also creates the connection's hosted web
 * search source. `preferredModel`, else AIQSA_BUDGETS_CODEX_MODEL, picks the
 * model (default gpt-5.6-luna, else gpt-5.5 when the endpoint does not list it).
 */
export async function setupCodexLbAnswerModel(
  request: APIRequestContext,
  options: Readonly<{ label: string; nativeSearch: boolean; preferredModel?: string | null }>
): Promise<PaidAnswerModel> {
  const apiRoot = paidEnv("CODEX_LB_BASE_URL")?.replace(/\/+$/u, "");
  const secret = paidEnv("CODEX_LB_API_KEY");
  if (!apiRoot || !secret) throw new Error("codex_lb_unconfigured");
  const discovered = await request.post("/api/admin/providers/custom-setup/discover", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { allowPrivateNetwork: true, apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret } });
  const discovery = discovered.ok() ? await discovered.json() as { catalogProof?: unknown; models?: Array<{ id?: unknown }> } : null;
  const listed = new Set((discovery?.models ?? []).map((model) => model.id));
  const preferred = options.preferredModel ?? paidEnv("AIQSA_BUDGETS_CODEX_MODEL") ?? "gpt-5.6-luna";
  const upstream = listed.size === 0 || listed.has(preferred) ? preferred : "gpt-5.5";
  const catalogProof = typeof discovery?.catalogProof === "string" && listed.has(upstream) ? discovery.catalogProof : undefined;
  const tag = randomUUID().slice(0, 8);
  const displayName = `${options.label} model ${tag}`;
  const body = codexLbSetupBody({ apiRoot, ...(catalogProof ? { catalogProof } : {}), contextWindow: 65_536, model: upstream, secret,
    connectionDisplayName: `${options.label} ${tag}` });
  const setup = await request.post("/api/admin/providers/custom-setup", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    ...body,
    capabilities: { ...body.capabilities as Record<string, unknown>, nativeSearch: options.nativeSearch },
    modelDisplayName: displayName
  } });
  expect(setup.ok(), `codex-lb custom setup is accepted (${setup.status()})`).toBe(true);
  const outcome = await setup.json() as { connectionId?: unknown; outcome?: unknown };
  expect(["ready", "partial"]).toContain(outcome.outcome);
  const connectionId = String(outcome.connectionId);
  const providerModelId = await pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const connection = readConnections(await (await request.get("/api/admin/providers")).json())
      ?.find((candidate) => candidate.id === connectionId);
    return connection && !connection.checkRunning ? modelInConnection(connection, upstream)?.id ?? null : null;
  }, "codex_lb_model_timeout");
  const model = await waitForCatalogModel(request, connectionId, (candidate) => candidate.modelId === providerModelId);
  return { connectionId, displayName: model.displayName, modelId: providerModelId, params: journeyRunParams(model, 512), upstreamModelId: upstream };
}

type QuickSetupResult = Readonly<{
  candidates?: Array<{ candidateId: string; displayName: string }>; connectionId?: string; expectedState?: string;
  outcome: string; policyVersion?: number;
}>;

/**
 * The installation's OpenRouter connection (OPENROUTER_API_KEY): an enabled,
 * checked one is reused, so a stand where another paid spec ran Quick Setup
 * pays for its model checks once; otherwise OpenRouter Quick Setup runs. Quick
 * Setup also turns on the family's Search source and may make an OpenRouter
 * model the installation's default chat model.
 */
export async function openRouterConnection(request: APIRequestContext, secret: string): Promise<string> {
  return quickSetupConnection(request, "openrouter", secret, /flash/iu);
}

/**
 * The family's canonical connection through Quick Setup with `secret`, reusing
 * an enabled, checked one; `prefer` picks the cheapest offered answer model
 * when Quick Setup asks for a choice.
 */
export async function quickSetupConnection(
  request: APIRequestContext, provider: "openai" | "openrouter", secret: string, prefer: RegExp
): Promise<string> {
  const existing = readConnections(await (await request.get("/api/admin/providers")).json())
    ?.find((connection) => connection.family === provider && connection.enabled && connection.active &&
      connection.defaultCredentialVersionId !== null && !connection.checkRunning);
  if (existing) return existing.id;
  const snapshot = await (await request.get("/api/admin/providers/quick-setup")).json() as {
    providers: Array<{ provider: string; stateToken: string }>;
  };
  const state = snapshot.providers.find((entry) => entry.provider === provider)?.stateToken;
  expect(state, `the stand offers ${provider} Quick Setup`).toBeTruthy();
  let response = await request.post("/api/admin/providers/quick-setup", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { expectedState: state, provider, secret } });
  expect(response.ok(), `${provider} Quick Setup is accepted (${response.status()})`).toBe(true);
  let result = await response.json() as QuickSetupResult;
  if (result.outcome === "selection_required") {
    // The cheapest offered answer model keeps the paid turn small.
    const candidate = result.candidates!.find((option) => prefer.test(option.displayName)) ?? result.candidates![0]!;
    response = await request.post("/api/admin/providers/quick-setup", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
      expectedState: result.expectedState, provider, secret,
      selectedModel: { candidateId: candidate.candidateId, policyVersion: result.policyVersion }
    } });
    expect(response.ok(), `${provider} Quick Setup with a selected model is accepted (${response.status()})`).toBe(true);
    result = await response.json() as QuickSetupResult;
  }
  expect(["ready", "partial"]).toContain(result.outcome);
  const connectionId = String(result.connectionId);
  await pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const connection = readConnections(await (await request.get("/api/admin/providers")).json())
      ?.find((candidate) => candidate.id === connectionId);
    return connection && !connection.checkRunning ? true : null;
  }, `${provider}_checks_timeout`);
  return connectionId;
}

async function searchCatalog(request: APIRequestContext): Promise<AdminSearchCatalog> {
  const response = await request.get("/api/admin/search");
  expect(response.ok()).toBe(true);
  return (await response.json() as { search: AdminSearchCatalog }).search;
}

/**
 * The connection's enabled Search source of `kind`. A missing one is created
 * through the admin Search API on the connection's first eligible technical
 * model (`create`, when given); a disabled one is enabled.
 */
export async function connectionSearchSource(
  request: APIRequestContext,
  connectionId: string,
  kind: AdminSearchIntegration["kind"],
  create?: Readonly<{ protocol: "openrouter_perplexity_chat" | "openai_responses_web_search"; preferModel?: RegExp }>
): Promise<AdminSearchIntegration> {
  const find = (catalog: AdminSearchCatalog) => catalog.integrations.find((integration) =>
    integration.sourceConnectionId === connectionId && integration.kind === kind && integration.archivedAt === null &&
    integration.configurationActive) ?? null;
  let integration = await pollUntil(60_000, async () => find(await searchCatalog(request)), "search_source_missing").catch(() => null);
  if (!integration && create) {
    const catalog = await searchCatalog(request);
    const candidates = catalog.providerModels.filter((model) => model.connectionId === connectionId && model.enabled &&
      model.searchKind === (kind === "perplexity_search" ? "perplexity_search" : "web_search"));
    const technical = candidates.find((model) => create.preferModel?.test(model.displayName)) ?? candidates[0];
    expect(technical, "the connection has a model that can run its Search source").toBeTruthy();
    const created = await request.post("/api/admin/search", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
      check: true, description: "Paid usage check Search source.", displayName: `Paid usage Search ${randomUUID().slice(0, 8)}`,
      draft: { ...adminSearchExecutionDefaults, adapterKind: "provider_model_client", credentialMode: "provider_model",
        maxSearchCallsPerAnswer: 1, protocol: create.protocol, providerModelId: technical!.id }
    } });
    expect(created.ok(), `the Search source is created and checked (${created.status()})`).toBe(true);
    integration = find(await searchCatalog(request));
  }
  expect(integration, `the connection has a ${kind} Search source`).toBeTruthy();
  if (!integration!.enabled) {
    const enabled = await request.post(`/api/admin/search/${integration!.id}/actions`, { data: { action: "enable" } });
    expect(enabled.ok(), `the Search source is enabled (${enabled.status()})`).toBe(true);
    integration = find(await searchCatalog(request))!;
  }
  return integration!;
}

/** A new chat outside Memory, so no Memory work follows the paid turn. */
export async function newExcludedChat(request: APIRequestContext, title: string): Promise<string> {
  const created = await request.post("/api/chats", { data: { title } });
  expect(created.ok()).toBe(true);
  const chatId = (await created.json() as { chat: { id: string } }).chat.id;
  expect((await request.patch(`/api/me/chats/${chatId}/memory-mode`, { data: { mode: "EXCLUDED" } })).ok()).toBe(true);
  return chatId;
}

/**
 * One API turn without MCP, Skills or Workspace. `searchOptionIds` names the
 * Search sources it may use; `searchMode` "model_choice" admits a source's
 * hosted (native) route, "all_selected" (the default) only client routes.
 */
export async function completedPaidTurn(
  request: APIRequestContext,
  prisma: PrismaClient,
  input: Readonly<{
    chatId: string; model: PaidAnswerModel; searchMode?: "all_selected" | "model_choice"; searchOptionIds: readonly string[]; text: string;
  }>
): Promise<ModelRun> {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: input.chatId }, select: { activeLeafMessageId: true } });
  const response = await request.post(`/api/chats/${input.chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
    content: { blocks: [{ text: input.text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId,
    mcp: { mode: "off" }, modelId: input.model.modelId, params: input.model.params, provider: input.model.connectionId,
    searchPlan: { mode: input.searchMode ?? "all_selected", optionIds: [...input.searchOptionIds] }, skills: { mode: "off" }, timeZone: "UTC",
    workspace: { enabled: false }
  } });
  expect(response.ok(), `the paid turn is accepted (${response.status()})`).toBe(true);
  await response.body();
  const newest = await prisma.modelRun.findFirstOrThrow({ where: { chatId: input.chatId }, orderBy: { createdAt: "desc" } });
  const settled = await pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: newest.id } });
    return ACTIVE_RUN_STATUSES.includes(run.status) ? null : run;
  }, "paid_turn_timeout");
  expect(settled.status, `the paid turn completes (${settled.status})`).toBe("complete");
  return settled;
}

/** Deletes a test chat permanently; its usage rows stay. */
export async function deletePaidChat(request: APIRequestContext, chatId: string): Promise<void> {
  await request.post(`/api/chats/${chatId}/delete-permanently`, { data: {
    alsoForgetOriginMemories: false, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID()
  } }).catch(() => undefined);
}
