import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import type { AdminSystemModelPolicyCatalog, AdminSystemModelPolicyResponse } from "../../../lib/contracts/adminSystemModelPolicy";
import { DEFAULT_EMBEDDING_MODEL_PRESET_ID, embeddingModelPresets } from "../../../lib/domain/embeddingModels";
import { DEFAULT_RERANKER_MODEL_PRESET_ID, rerankerModelPresets } from "../../../lib/domain/rerankerModels";
import { providerModelTemplateId } from "../../../lib/domain/providerTemplates";
import { readConnections, type JourneyConnection, type JourneyProviderModel } from "../../../scripts/context-compaction-journey-support";
import { openRouterConnection, PAID_SETUP_TIMEOUT_MS, pollUntil } from "./paidProviders";

/**
 * Real past-chat search roles for the opt-in paid specs on a DISPOSABLE stand: the installation's OpenRouter connection
 * (`openRouterConnection`, OPENROUTER_API_KEY) with the default embedding preset and the default approved reranker
 * (`lib/domain/embeddingModels.ts`, `lib/domain/rerankerModels.ts`), each with its own passing check on the
 * connection's default key, assigned as the past-chat embedding and reranker roles through
 * `PATCH /api/admin/providers/system-model-policy`. OpenRouter Quick Setup already adds and checks both helpers; a
 * reused connection that lacks one gets it from the catalog (`add_catalog_models`), and one never checked on the
 * current key gets one check (`check_models`). Roles already on these models are left alone, so a rerun neither bumps
 * the policy nor re-embeds the index. Evidence is content-free: booleans, counts and stable codes.
 */

const EMBEDDING_UPSTREAM = embeddingModelPresets.find((preset) => preset.id === DEFAULT_EMBEDDING_MODEL_PRESET_ID)!.upstreamModelId;
const RERANKER_UPSTREAM = rerankerModelPresets.find((preset) => preset.id === DEFAULT_RERANKER_MODEL_PRESET_ID)!.upstreamModelId;

export type PastChatSearchRoles = Readonly<{
  connectionId: string;
  embeddingModelId: string;
  evidence: Record<string, boolean | number | string | null>;
  rerankerModelId: string;
}>;

async function okJson(response: APIResponse, step: string): Promise<unknown> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof body?.error === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(body.error) ? body.error : "";
  expect(response.ok(), `${step} (${response.status()} ${code})`).toBe(true);
  return body;
}

export async function readSystemModelPolicy(request: APIRequestContext): Promise<AdminSystemModelPolicyCatalog> {
  const body = await okJson(await request.get("/api/admin/providers/system-model-policy"), "the system model policy is read");
  return (body as AdminSystemModelPolicyResponse).systemModelPolicy;
}

/** Saves the past-chat roles named in `roles` (null clears one) against the current policy version. */
export async function savePastChatSearchRoles(
  request: APIRequestContext,
  roles: Readonly<{ embeddingProviderModelId?: string | null; rerankerProviderModelId?: string | null }>
): Promise<AdminSystemModelPolicyCatalog> {
  const current = await readSystemModelPolicy(request);
  const body = await okJson(await request.patch("/api/admin/providers/system-model-policy", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { expectedVersion: current.policy.version, ...roles } }), "the past-chat roles are saved");
  return (body as AdminSystemModelPolicyResponse).systemModelPolicy;
}

async function readConnection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  const connection = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
  if (!connection) throw new Error("past_chat_roles_connection_missing");
  return connection;
}

function helperModel(connection: JourneyConnection, modelClass: "embedding" | "reranker", upstreamModelId: string): JourneyProviderModel | null {
  return connection.models.find((model) => {
    const configuration = model.activeConfig ?? model.draftConfig;
    return configuration.modelClass === modelClass && configuration.upstreamModelId === upstreamModelId;
  }) ?? null;
}

async function settledConnection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const connection = await readConnection(request, connectionId);
    return connection.checkRunning ? null : connection;
  }, "past_chat_roles_check_run_timeout");
}

/** The helper models on the connection, added from its catalog when missing and enabled when disabled. */
async function ensureHelperModels(request: APIRequestContext, connectionId: string, evidence: PastChatSearchRoles["evidence"]) {
  let connection = await settledConnection(request, connectionId);
  const wanted = [["embedding", EMBEDDING_UPSTREAM], ["reranker", RERANKER_UPSTREAM]] as const;
  const missing = wanted.filter(([modelClass, upstream]) => !helperModel(connection, modelClass, upstream));
  evidence.helperModelsAdded = missing.length;
  if (missing.length > 0) {
    const templateIds = missing.map(([, upstream]) => providerModelTemplateId(`openrouter:${upstream}`));
    expect(templateIds.every(Boolean), "the helper models have OpenRouter catalog templates").toBe(true);
    expect(Boolean(connection.defaultCredentialId && connection.defaultCredentialVersionId), "the connection has a usable default key").toBe(true);
    const added = await okJson(await request.post(`/api/admin/providers/${connectionId}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
      action: "add_catalog_models", credentialId: connection.defaultCredentialId, expectedConnectionVersion: connection.activeVersion,
      expectedCredentialVersionId: connection.defaultCredentialVersionId, modelIds: templateIds
    } }), "the helper models are added from the catalog") as { unavailableModelIds?: unknown };
    expect(Array.isArray(added.unavailableModelIds) && added.unavailableModelIds.length === 0, "the key's catalog lists the helper models").toBe(true);
    connection = await settledConnection(request, connectionId);
  }
  const embedding = helperModel(connection, "embedding", EMBEDDING_UPSTREAM);
  const reranker = helperModel(connection, "reranker", RERANKER_UPSTREAM);
  expect(Boolean(embedding && reranker), "both helper models are on the connection").toBe(true);
  for (const model of [embedding!, reranker!]) {
    if (model.enabled) continue;
    await okJson(await request.patch(`/api/admin/providers/${connectionId}/models/${model.id}`, { data: { action: "enable" } }),
      "a disabled helper model is enabled");
  }
  return { connection: await settledConnection(request, connectionId), embeddingModelId: embedding!.id, rerankerModelId: reranker!.id };
}

const offered = (policy: AdminSystemModelPolicyCatalog, embeddingModelId: string, rerankerModelId: string) => ({
  embedding: (policy.embeddingCandidates ?? []).some((candidate) => candidate.id === embeddingModelId),
  reranker: policy.rerankerCandidates.some((candidate) => candidate.id === rerankerModelId)
});

/**
 * Sets up both past-chat roles on real OpenRouter models and returns them once `GET system-model-policy` shows the
 * embedding role working (assigned and available) and the reranker assigned and available.
 */
export async function setupPastChatSearchRoles(request: APIRequestContext, openRouterKey: string): Promise<PastChatSearchRoles> {
  const evidence: PastChatSearchRoles["evidence"] = {};
  const connectionId = await openRouterConnection(request, openRouterKey);
  const { connection, embeddingModelId, rerankerModelId } = await ensureHelperModels(request, connectionId, evidence);

  // Each helper needs a passing check of its own protocol on the exact active tuple and default key; the role lists
  // offer only such models. A model never checked on the current key gets one check, never a repeat of a failed one.
  let policy = await readSystemModelPolicy(request);
  let candidates = offered(policy, embeddingModelId, rerankerModelId);
  evidence.recheckRequested = false;
  if (!candidates.embedding || !candidates.reranker) {
    const unchecked = [...(!candidates.embedding ? [embeddingModelId] : []), ...(!candidates.reranker ? [rerankerModelId] : [])];
    await okJson(await request.post(`/api/admin/providers/${connectionId}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS,
      data: { action: "check_models", credentialId: connection.defaultCredentialId, modelIds: unchecked } }), "the helper models' check starts");
    evidence.recheckRequested = true;
    await settledConnection(request, connectionId);
    policy = await readSystemModelPolicy(request);
    candidates = offered(policy, embeddingModelId, rerankerModelId);
  }
  evidence.embeddingOffered = candidates.embedding;
  evidence.rerankerOffered = candidates.reranker;
  expect(candidates.embedding, "the embedding model passed its embedding check on the default key").toBe(true);
  expect(candidates.reranker, "the reranker passed its rerank check on the default key").toBe(true);

  const changes = {
    ...(policy.policy.embeddingModel?.id === embeddingModelId ? {} : { embeddingProviderModelId: embeddingModelId }),
    ...(policy.policy.rerankerModel?.id === rerankerModelId ? {} : { rerankerProviderModelId: rerankerModelId })
  };
  evidence.rolesSaved = Object.keys(changes).length;
  if (Object.keys(changes).length > 0) policy = await savePastChatSearchRoles(request, changes);
  evidence.embeddingRoleAvailable = policy.policy.embeddingModel?.id === embeddingModelId && policy.policy.embeddingModel.available;
  evidence.rerankerRoleAvailable = policy.policy.rerankerModel?.id === rerankerModelId && policy.policy.rerankerModel.available;
  expect(evidence.embeddingRoleAvailable, "the past-chat embedding role is working").toBe(true);
  expect(evidence.rerankerRoleAvailable, "the reranker role is working").toBe(true);
  return { connectionId, embeddingModelId, evidence, rerankerModelId };
}
