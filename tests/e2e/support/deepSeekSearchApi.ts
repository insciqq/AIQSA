import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import type { AdminSearchCatalog, AdminSearchIntegration } from "../../../lib/contracts/adminSearch";
import { providerModelTemplateId } from "../../../lib/domain/providerTemplates";
import { DEEPSEEK_SEARCH_API_MODEL_ID, DEEPSEEK_SEARCH_API_REQUEST_USD } from "../../../lib/server/providers/deepSeekSearchApi";
import {
  modelInConnection, readConnections, type JourneyConnection, type JourneyProviderModel
} from "../../../scripts/context-compaction-journey-support";
import { PAID_SETUP_TIMEOUT_MS, pollUntil } from "./paidProviders";

/**
 * The built-in DeepSeek Search API source on a DISPOSABLE stand, set up the
 * way `tests/e2e/prod-1018-paid.spec.ts` scenario 7 does it (same steps and
 * bounds): a keyed native DeepSeek connection with an enabled model is reused
 * without any probe, else a new one gets only DeepSeek V4.1 Flash through the
 * ordinary admin connection API (at most 8 probes of that model, never Quick
 * Setup); a set-up source on that connection is reused, else Admin → Search →
 * Add source saves it with one request per answer (Save runs one probe
 * search), and it is enabled. Keys are only sent to the stand's admin API.
 */

/** DeepSeek reports no cost, so a result-bearing request is billed at the published per-request price. */
export const DEEPSEEK_SEARCH_API_COST_MICROS = Math.round(DEEPSEEK_SEARCH_API_REQUEST_USD * 1_000_000);
export const DEEPSEEK_SEARCH_API_USAGE_MODEL = DEEPSEEK_SEARCH_API_MODEL_ID;

const DEEPSEEK_ROOT = "https://api.deepseek.com";

type RawCheckRun = Readonly<{ id?: unknown; results?: Array<{ state?: unknown }>; state?: unknown }>;
type RawConnection = Readonly<{ checkRun?: RawCheckRun | null; displayName?: unknown; id?: unknown }>;

function rawConnections(body: unknown): RawConnection[] {
  const connections = (body as { connections?: unknown } | null)?.connections;
  return Array.isArray(connections) ? connections as RawConnection[] : [];
}

async function adminOk(response: APIResponse, step: string): Promise<unknown> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  expect(response.ok(), `${step} (${response.status()} ${typeof body?.error === "string" ? body.error : ""})`).toBe(true);
  return body;
}

async function settledConnection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, "deepseek_checks_timeout");
}

/** Waits for exactly the check run `runId` of the connection to leave `running`; returns it. */
async function settledCheckRun(request: APIRequestContext, connectionId: string, runId: string): Promise<RawCheckRun> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const response = await request.get(`/api/admin/providers/${connectionId}/actions?run=${encodeURIComponent(runId)}`);
    const run = response.ok() ? (await response.json() as { run?: RawCheckRun }).run ?? null : null;
    return run && run.state !== "running" ? run : null;
  }, "deepseek_check_run_timeout");
}

/**
 * A new native DeepSeek connection with the key and exactly one catalog answer model: published
 * with a keyless placeholder model (no provider call), the placeholder removed, the key added
 * (a free model-list read), the connection enabled, and `add_catalog_models` adds the one model
 * and starts its first capability check, the only paid probe set.
 */
async function oneModelDeepSeekConnection(request: APIRequestContext, input: Readonly<{ label: string; secret: string }>): Promise<{
  connection: JourneyConnection; model: JourneyProviderModel; run: RawCheckRun;
}> {
  const displayName = `${input.label} ${randomUUID().slice(0, 8)}`;
  const before = new Set(rawConnections(await (await request.get("/api/admin/providers")).json()).map((entry) => entry.id));
  const created = rawConnections(await adminOk(await request.post("/api/admin/providers", { data: {
    configuration: { allowPrivateNetwork: false, apiRoot: DEEPSEEK_ROOT, authenticationMode: "bearer", responseTimeoutSeconds: 300 },
    displayName, family: "deepseek", unassignedPolicy: "use_default"
  } }), "the connection draft is created")).find((entry) => !before.has(entry.id) && entry.displayName === displayName);
  expect(created, "the new connection is listed").toBeTruthy();
  const connectionId = String(created!.id);

  const placeholder = await adminOk(await request.post(`/api/admin/providers/${connectionId}/models`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    activate: true, displayName: "Placeholder",
    configuration: { adapterKind: "deepseek_responses_native", answerSelectable: true, modelClass: "answer",
      upstreamModelId: "aiqsa/placeholder", defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false } }
  } }), "the keyless placeholder publishes the connection") as { receipt?: { checks?: unknown; modelId?: unknown } };
  // No key yet, so publishing checked nothing.
  expect(placeholder.receipt?.checks, "the placeholder was not probed").toBe("skipped");
  const placeholderId = String(placeholder.receipt?.modelId);
  await adminOk(await request.patch(`/api/admin/providers/${connectionId}/models/${placeholderId}`, { data: { action: "disable" } }),
    "the placeholder is disabled");
  await adminOk(await request.delete(`/api/admin/providers/${connectionId}/models/${placeholderId}`, { data: { confirmed: true } }),
    "the placeholder is deleted");

  await adminOk(await request.post(`/api/admin/providers/${connectionId}/credentials`, { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { activate: true, label: "Paid check key", secret: input.secret } }), "the key is tested and added");
  await adminOk(await request.post(`/api/admin/providers/${connectionId}/actions`, { data: { action: "enable" } }), "the connection is enabled");
  const keyed = await settledConnection(request, connectionId);
  expect(keyed.models, "the connection has no model before the catalog addition").toHaveLength(0);
  expect(keyed.defaultCredentialVersionId, "the key is the connection's default").not.toBeNull();

  const added = await adminOk(await request.post(`/api/admin/providers/${connectionId}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    action: "add_catalog_models", credentialId: keyed.defaultCredentialId, expectedConnectionVersion: keyed.activeVersion,
    expectedCredentialVersionId: keyed.defaultCredentialVersionId, modelIds: [providerModelTemplateId("deepseek:deepseek-flash")]
  } }), "the catalog model is added") as { connections?: unknown; unavailableModelIds?: unknown };
  expect(added.unavailableModelIds, "the key's catalog lists the model").toEqual([]);
  const runId = rawConnections(added).find((entry) => entry.id === connectionId)?.checkRun?.id;
  expect(typeof runId, "the addition started the model's check run").toBe("string");
  const run = await settledCheckRun(request, connectionId, String(runId));
  const settled = await settledConnection(request, connectionId);
  const model = modelInConnection(settled, "deepseek-flash");
  expect(model, "the model is on the connection").toBeTruthy();
  expect(settled.models, "the connection holds exactly that one model").toHaveLength(1);
  return { connection: settled, model: model!, run };
}

/**
 * A keyed, enabled native DeepSeek connection with an enabled answer model: an existing one is
 * reused without any probe; otherwise a new one gets only DeepSeek V4.1 Flash.
 */
export async function deepSeekConnection(request: APIRequestContext, secret: string, label: string,
  summary: Record<string, unknown>): Promise<JourneyConnection> {
  const existing = readConnections(await (await request.get("/api/admin/providers")).json())
    ?.find((candidate) => candidate.family === "deepseek" && candidate.enabled && candidate.active &&
      candidate.defaultCredentialVersionId !== null && !candidate.checkRunning &&
      candidate.models.some((model) => model.enabled && model.activeConfig !== null)) ?? null;
  summary.deepSeekReused = Boolean(existing);
  if (existing) return existing;
  const { connection: created, run } = await oneModelDeepSeekConnection(request, { label, secret });
  Object.assign(summary, { deepSeekCheckResults: run.results?.map((entry) => entry.state) ?? [], deepSeekCheckRun: run.state });
  expect(run.results ?? [], "the run checked only DeepSeek V4.1 Flash").toHaveLength(1);
  return created;
}

async function searchCatalog(request: APIRequestContext): Promise<AdminSearchCatalog> {
  const response = await request.get("/api/admin/search");
  expect(response.ok()).toBe(true);
  return (await response.json() as { search: AdminSearchCatalog }).search;
}

/** The connection's set-up API source; a built-in that setup has not completed does not count. */
function searchApiSource(catalog: AdminSearchCatalog, connectionId: string): AdminSearchIntegration | null {
  return catalog.integrations.find((source) => source.kind === "deepseek_search_api" && source.sourceConnectionId === connectionId &&
    source.archivedAt === null && source.ready) ?? null;
}

/** Adds the source through Admin → Search → Add source (Save runs one probe search) and enables it; a set-up one is reused. */
export async function deepSeekSearchApiSource(page: Page, prisma: PrismaClient, connectionId: string,
  summary: Record<string, unknown>): Promise<AdminSearchIntegration> {
  const existing = searchApiSource(await searchCatalog(page.request), connectionId);
  summary.sourceReused = Boolean(existing);
  if (!existing) {
    const { displayName: connectionName } = await prisma.providerConnection.findUniqueOrThrow({ select: { displayName: true },
      where: { id: connectionId } });
    await page.goto("/admin?section=search", { timeout: 300_000 });
    const add = page.getByTestId("search-add");
    await expect(add).toBeEnabled({ timeout: 60_000 });
    await add.click();
    const sheet = page.getByRole("dialog", { name: "Add source" });
    // The select's accessible name also carries its selected option, so it is found by its label.
    const searchModel = sheet.locator("label").filter({ has: page.locator("span", { hasText: /^Search model$/u }) }).locator("select");
    const option = searchModel.locator("option").filter({ hasText: `${connectionName} Search API · key via ` }).first();
    await expect(option).toBeAttached();
    await searchModel.selectOption({ label: (await option.textContent())!.trim() });
    await sheet.getByText("Advanced Search execution", { exact: true }).click();
    await sheet.getByLabel("Maximum requests to this source per answer").fill("1");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet, "Save passed its probe search and closed the sheet").toHaveCount(0, { timeout: 180_000 });
  }
  let source = await pollUntil(60_000, async () => searchApiSource(await searchCatalog(page.request), connectionId),
    "deepseek_search_api_source_missing");
  if (!source.enabled) {
    const enabledResponse = await page.request.post(`/api/admin/search/${source.id}/actions`, { data: { action: "enable" } });
    expect(enabledResponse.ok(), `the DeepSeek Search API source is enabled (${enabledResponse.status()})`).toBe(true);
    source = searchApiSource(await searchCatalog(page.request), connectionId)!;
  }
  expect(source.enabled, "the DeepSeek Search API source is enabled").toBe(true);
  summary.maxSearchCallsPerAnswer = source.configuration?.maxSearchCallsPerAnswer ?? null;
  if (!existing) expect(summary.maxSearchCallsPerAnswer, "the source allows one request per answer").toBe(1);
  return source;
}
