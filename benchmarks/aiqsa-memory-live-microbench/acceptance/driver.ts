import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { textFromContentBlocks } from "../../../lib/domain/modelRunEvents";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../../lib/contracts/memory";
import { createAuthSession } from "../../../lib/server/auth/requestAuth";
import { createPrismaAuthSessionStore } from "../../../lib/server/auth/prismaSessions";
import { provisionActiveUser } from "../../../lib/server/auth/provisioning";
import { createPrismaMemorySettingsRepository } from "../../../lib/server/memory/persistence/settings";
import { defaultMemoryExecutionAuthority } from "../../../lib/server/memory/execution/defaultAuthority";
import { probeCurrentMemoryEmbeddingPin } from "../../../lib/server/memory/embedding/handler";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from "../../../lib/server/memory/embedding/contract";
import { createMemoryRebuildService } from "../../../lib/server/memory/rebuild/service";
import { createPrismaMemoryRebuildRepository } from "../../../lib/server/memory/rebuild/repository";
import {
  type MemoryConsumerItem
} from "../../../lib/contracts/memoryConsumer";
import { createPrismaMemoryNativeFactSearchService } from "../../../lib/server/memory/retrieval/nativeFactSearch";
import { defaultMemoryConsumerService } from "../../../lib/server/memory/consumer/defaultConsumer";
import { MEMORY_MCP_REQUEST_DEADLINE_MS } from "../../../lib/server/memoryMcp/server";
import { canonicalJson, safeCode } from "./contract";
import { missingMemoryReference } from "./referenceRead";

export const PROFILE = Object.freeze({
  answer: "gpt-5.6-sol", judge: "gpt-5.6-sol", control: "gpt-5.6-terra",
  reasoning: "medium", embedding: "qwen/qwen3-embedding-8b",
  reranker: "voyageai/rerank-2.5", maxOutputTokens: 4_096,
  learnAutomatically: true, referenceChatHistory: true, synthesisEnabled: true,
  decayEnabled: false, requestTimeoutMs: 600_000, settlementTimeoutMs: 600_000
});
export const EXECUTION_LIMITS = Object.freeze({ admissionTimeoutSeconds: 15, caseConcurrency: 1 });
export type Identity = { userId: string; cookie: string };
type CatalogModel = { provider: string; modelId: string; defaultParams: Record<string, unknown> };
export type Conversation = { id: string; leaf: string | null; mode: "NORMAL" | "EXCLUDED" | "TEMPORARY" };
export type SendResult = {
  answer: string; runId: string; userMessageId: string; memoryOutcome: string;
  degradationCode: string | null; memoryItems: number; ownerIsolation: boolean;
  deliveredMemoryEvidence: string[]; elapsedMs: number; totalTokens: number | null;
  userMessageCreatedAt: string;
  cleanupFailureCode?: string;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const activeStates = ["QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_EGRESS_CONSENT", "WAITING_FOR_CONFIGURATION"] as const;

export class AcceptanceDriver {
  readonly prisma: PrismaClient;
  readonly ownedUserIds: string[] = [];
  readonly searchExecutions: Array<{ requestId: string; healthy: boolean; executions: Array<{ logicalRole: string; state: string; errorCode: string | null }> }> = [];
  private readonly excludedProbeIds = new Set<string>();
  private roles!: { modelId: string; connectionId: string; credentialId: string; embeddingId: string };
  private catalog!: CatalogModel;
  profileFingerprint = "";
  constructor(readonly baseUrl: URL, databaseUrl: string, readonly answerModel: string = PROFILE.answer,
    readonly systemModel: string = answerModel) {
    this.prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
  }

  async prepare() {
    const identity = await this.prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
      SELECT current_database() AS database, current_user AS role
    `);
    if (identity.length !== 1 || identity[0]?.database !== "aiqsa_memory_benchmark" || identity[0]?.role !== "aiqsa_benchmark") {
      throw new Error("memory_acceptance_database_identity_mismatch");
    }
    const policy = await this.prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    const admissionPolicy = await this.prisma.modelPolicy.findUniqueOrThrow({
      where: { id: "installation" }, select: { memoryAdmissionTimeoutSeconds: true }
    });
    if (Number(admissionPolicy.memoryAdmissionTimeoutSeconds) !== EXECUTION_LIMITS.admissionTimeoutSeconds) {
      throw new Error("memory_acceptance_admission_profile_mismatch");
    }
    const [models, embeddings, reranker, system] = await Promise.all([
      this.prisma.providerModel.findMany({ where: { modelId: this.answerModel, enabled: true,
        activeVersion: { gt: 0 }, connection: { enabled: true, family: "openai_compatible" } },
      include: { connection: { include: { defaultCredential: true } } } }),
      this.prisma.providerModel.findMany({ where: { modelId: PROFILE.embedding, enabled: true,
        activeVersion: { gt: 0 }, connection: { enabled: true, family: "openrouter" } } }),
      policy.rerankerProviderModelId ? this.prisma.providerModel.findUnique({ where: { id: policy.rerankerProviderModelId } }) : null,
      policy.providerModelId ? this.prisma.providerModel.findUnique({ where: { id: policy.providerModelId } }) : null
    ]);
    const model = models[0];
    const credential = model?.connection.defaultCredential;
    if (models.length !== 1 || embeddings.length !== 1 || !model || !credential?.enabled ||
      !credential.activeVersionId || system?.modelId !== this.systemModel ||
      policy.reasoningEffort !== PROFILE.reasoning || reranker?.modelId !== PROFILE.reranker || !reranker.enabled) {
      throw new Error("memory_acceptance_provider_profile_mismatch");
    }
    this.roles = { modelId: model.id, connectionId: model.connectionId,
      credentialId: credential.id, embeddingId: embeddings[0]!.id };
    this.profileFingerprint = createHash("sha256").update(canonicalJson({
      ...PROFILE, answer: this.answerModel, system: this.systemModel,
      answerConfiguration: model.activeConfig, embeddingConfiguration: embeddings[0]!.activeConfig,
      rerankerConfiguration: reranker.activeConfig
    })).digest("hex");
  }

  async identity(label: string, memory = true): Promise<Identity> {
    const group = await this.prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" } });
    const userId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: userId, displayName: "Synthetic Memory acceptance",
        email: `${label}.${userId}@memory-acceptance.benchmark.invalid`, role: "user", status: "active" } });
      await provisionActiveUser(tx, { groups: [{ groupId: group.id, role: "member" }], userId });
      await tx.userSettings.update({ data: { defaultProviderModelId: this.roles.modelId }, where: { userId } });
      await tx.providerUserCredentialAssignment.create({ data: { userId,
        connectionId: this.roles.connectionId, credentialId: this.roles.credentialId } });
    });
    this.ownedUserIds.push(userId);
    const repository = createPrismaMemorySettingsRepository(this.prisma);
    const settings = await repository.get(userId);
    await repository.patch(userId, { embeddingDeploymentId: this.roles.embeddingId,
      expectedMemoryRevision: settings.memoryRevision, expectedSettingsRevision: settings.settingsRevision,
      useMemoryFacts: memory, learnAutomatically: memory, referenceChatHistory: memory,
      synthesisEnabled: memory, decayEnabled: false });
    const result = { userId, cookie: "" };
    await this.renew(result);
    if (memory) await this.rebuild(result);
    if (!this.catalog) {
      const response = await this.request(result, "/api/me/catalog");
      const body = await response.json() as { catalog: { models: Array<CatalogModel & { upstreamModelId: string }> } };
      const selected = body.catalog.models.filter((item) => item.modelId === this.roles.modelId && item.upstreamModelId === this.answerModel);
      if (selected.length !== 1) throw new Error("memory_acceptance_catalog_model_missing");
      this.catalog = selected[0]!;
    }
    return result;
  }

  async renew(identity: Identity) {
    const session = await createAuthSession({ secureCookie: false,
      sessions: createPrismaAuthSessionStore(this.prisma), userId: identity.userId });
    identity.cookie = session.cookie.split(";", 1)[0]!;
  }

  async request(identity: Identity, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(new URL(path, this.baseUrl), {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { accept: "application/json", "content-type": "application/json", cookie: identity.cookie,
        origin: this.baseUrl.origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(PROFILE.requestTimeoutMs)
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
      const nestedCode = value?.error && typeof value.error === "object" && "code" in value.error ? value.error.code : value?.code;
      const code = typeof value?.error === "string" ? value.error : typeof nestedCode === "string" ? nestedCode : "unknown";
      throw new Error(`memory_acceptance_http_${response.status}:${safeCode(new Error(code))}`);
    }
    return response;
  }

  conversation(mode: Conversation["mode"] = "NORMAL"): Conversation {
    return { id: randomUUID(), leaf: null, mode };
  }

  async send(identity: Identity, chat: Conversation, content: string): Promise<SendResult> {
    const started = Date.now();
    const response = await this.request(identity, `/api/chats/${chat.id}/messages`, {
      content: { blocks: [{ type: "text", text: content }] }, expectedActiveLeafId: chat.leaf,
      ...(!chat.leaf ? { personalDraft: { folderId: null, memoryMode: chat.mode } } : {}),
      ...(chat.mode === "TEMPORARY" ? { chatMode: "TEMPORARY",
        temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } : {}),
      mcp: { mode: "off" }, modelId: this.catalog.modelId, provider: this.catalog.provider,
      params: { ...this.catalog.defaultParams, maxOutputTokens: PROFILE.maxOutputTokens,
        reasoning: { effort: PROFILE.reasoning } },
      searchPlan: { mode: "all_selected", optionIds: [] }, timeZone: "UTC", tools: "none"
    });
    if (!response.body) throw new Error("memory_acceptance_stream_missing");
    const reader = response.body.getReader();
    while (!(await reader.read()).done) { /* Consume the ordinary client stream. */ }
    const run = await this.prisma.modelRun.findFirst({ where: { chatId: chat.id, userId: identity.userId },
      orderBy: { createdAt: "desc" }, include: { assistantMessage: true, userMessage: { select: { createdAt: true } } } });
    if (run?.status !== "complete" || run.assistantMessage?.status !== "complete" ||
      run.assistantMessage.id === chat.leaf) throw new Error("memory_acceptance_run_incomplete");
    chat.leaf = run.assistantMessage.id;
    const [binding, answerBinding] = await Promise.all([
      this.prisma.modelRunMemoryBinding.findUnique({ where: { modelRunId: run.id } }),
      this.prisma.providerRunBinding.findUnique({ where: { modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" } } })
    ]);
    if ((!binding && chat.mode !== "TEMPORARY") || answerBinding?.providerModelId !== this.roles.modelId) throw new Error("memory_acceptance_run_binding_invalid");
    const items = binding ? await this.prisma.modelRunMemoryItem.findMany({ where: { bindingId: binding.id },
      orderBy: { ordinal: "asc" }, select: { includedText: true, userId: true, factVersionId: true, sourceChatIdSnapshot: true } }) : [];
    const factIds = items.flatMap((item) => item.factVersionId ? [item.factVersionId] : []);
    const sourceIds = [...new Set(items.flatMap((item) => item.sourceChatIdSnapshot ? [item.sourceChatIdSnapshot] : []))];
    const [foreignFacts, foreignSources] = await Promise.all([
      this.prisma.memoryFactVersion.count({ where: { id: { in: factIds }, userId: { not: identity.userId } } }),
      this.prisma.chat.count({ where: { id: { in: sourceIds }, userId: { not: identity.userId } } })
    ]);
    const answer = textFromContentBlocks(run.assistantMessage.content as { blocks?: unknown[] }).trim();
    if (!answer) throw new Error("memory_acceptance_answer_empty");
    return { answer, runId: run.id, userMessageId: run.userMessageId, memoryOutcome: binding?.outcome ?? "TEMPORARY",
      degradationCode: binding?.degradationCode ?? null, memoryItems: items.length,
      deliveredMemoryEvidence: items.map((item) => item.includedText),
      ownerIsolation: (chat.mode === "TEMPORARY" ? binding === null : binding?.userId === identity.userId) &&
        items.every((item) => item.userId === identity.userId) && foreignFacts === 0 && foreignSources === 0,
      elapsedMs: Date.now() - started, totalTokens: run.totalTokens,
      userMessageCreatedAt: run.userMessage.createdAt.toISOString() };
  }

  async settle(identity: Identity, source?: { chat: Conversation; messageId: string }) {
    const started = Date.now();
    let stable = 0;
    let failureCode: string | null = null;
    while (Date.now() - started < PROFILE.settlementTimeoutMs) {
      const [jobs, deletions, projections, settings] = await Promise.all([
        this.prisma.memoryJob.findMany({ where: { userId: identity.userId },
          select: { id: true, kind: true, state: true, errorCode: true, sourceMessageId: true, chatId: true } }),
        this.prisma.memoryDeletionOutbox.count({ where: { userId: identity.userId, state: { not: "SUCCEEDED" },
          NOT: { operation: "TEMPORARY_DELETE", state: "PENDING", nextAttemptAt: { gt: new Date() } } } }),
        this.prisma.memoryLexicalProjectionEvent.count({ where: { userId: identity.userId, state: { not: "SUCCEEDED" } } }),
        this.prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: identity.userId } })
      ]);
      const failed = jobs.filter((job) => ["TERMINAL_FAILED", "CANCELLED", "STALE"].includes(job.state) &&
        !(job.kind === "INDEX_HISTORY" && job.state === "STALE" && job.errorCode === "memory_source_stale") &&
        !(job.chatId && this.excludedProbeIds.has(job.chatId) && ["CANCELLED", "STALE"].includes(job.state)));
      for (const job of failed) {
        if (job.kind === "EMBED_ITEMS" && job.state === "STALE" &&
          job.errorCode === "memory_embedding_batch_target_stale") {
          const [items, executions] = await Promise.all([
            this.prisma.memoryEmbeddingBatchItem.count({ where: { userId: identity.userId, memoryJobId: job.id } }),
            this.prisma.memoryExecutionBinding.count({ where: { userId: identity.userId, memoryJobId: job.id,
              state: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"] } } })
          ]);
          // Deletion/merge can retire every target before batch dispatch. The
          // handler deliberately marks this empty work STALE; no current item
          // failed embedding. Other stale batches remain failed evidence.
          if (items === 0 && executions === 0) continue;
        }
        failureCode ??= `memory_acceptance_job_failed:${job.kind.toLowerCase()}:${safeCode(new Error(job.errorCode ?? "unknown"))}`;
      }
      const required = source?.chat.mode === "NORMAL" && settings.useMemoryFacts;
      const extractPresent = !required || !settings.learnAutomatically || jobs.some((job) =>
        job.kind === "EXTRACT_FACTS" && job.sourceMessageId === source.messageId);
      const historyPresent = !required || !settings.referenceChatHistory || jobs.some((job) =>
        job.kind === "INDEX_HISTORY" && job.chatId === source.chat.id);
      const active = jobs.some((job) => (activeStates as readonly string[]).includes(job.state));
      stable = !active && deletions === 0 && projections === 0 && extractPresent && historyPresent ? stable + 1 : 0;
      if (stable >= 2) {
        if (failureCode) throw new Error(failureCode);
        return Date.now() - started;
      }
      await delay(1_000);
    }
    throw new Error("memory_acceptance_settlement_timeout");
  }

  async search(identity: Identity, query: string): Promise<MemoryConsumerItem[]> {
    // This is the native service used by MCP search_memories. The consumer UI's
    // search endpoint is an inventory text filter and does not promise semantic recall.
    const requestId = randomUUID();
    try {
      const result = await createPrismaMemoryNativeFactSearchService(this.prisma).search(identity.userId, {
        query, limit: 20, requestId, signal: AbortSignal.timeout(MEMORY_MCP_REQUEST_DEADLINE_MS)
      });
      return [...result.items];
    } finally {
      const executions = await this.prisma.memoryExecutionBinding.findMany({
        where: { userId: identity.userId, inboundMcpRequestId: requestId },
        select: { logicalRole: true, state: true, errorCode: true }, orderBy: { createdAt: "asc" }
      });
      const lastByRole = new Map(executions.map((item) => [item.logicalRole, item]));
      this.searchExecutions.push({ requestId, executions,
        healthy: executions.length > 0 && [...lastByRole.values()].every((item) => item.state === "SUCCEEDED") });
    }
  }

  async probe(identity: Identity, question: string, temporary = false): Promise<SendResult> {
    const chat = this.conversation(temporary ? "TEMPORARY" : "NORMAL");
    let result: SendResult | undefined;
    try { result = await this.send(identity, chat, question); }
    finally {
      if (!temporary && await this.prisma.chat.count({ where: { id: chat.id, userId: identity.userId } })) {
        await this.request(identity, `/api/me/chats/${chat.id}/memory-mode`, { mode: "EXCLUDED" }, "PATCH");
        await this.restoreExcludedProbes(identity, [chat.id]);
        try { await this.settle(identity); }
        catch (error) {
          // Exclusion authority is already proven. Preserve an obtained answer
          // for scoring while retaining the failed background-work evidence.
          if (!result) throw error;
          result.cleanupFailureCode = safeCode(error);
        }
      }
    }
    return result!;
  }

  /** Resume only after canonical ownership and exclusion have been re-proven. */
  async restoreExcludedProbes(identity: Identity, chatIds: readonly string[]) {
    const ids = [...new Set(chatIds)];
    const count = await this.prisma.chat.count({ where: {
      id: { in: ids }, userId: identity.userId, memoryMode: "EXCLUDED"
    } });
    if (count !== ids.length) throw new Error("memory_acceptance_probe_not_isolated");
    for (const id of ids) this.excludedProbeIds.add(id);
  }

  async missing(identity: Identity, reference: string) {
    return missingMemoryReference(defaultMemoryConsumerService.get, identity.userId, reference);
  }

  async settings(identity: Identity, patch: Record<string, boolean>) {
    await this.request(identity, "/api/me/memory/settings", patch, "PATCH");
    await this.settle(identity);
  }

  async snapshot(identity: Identity) {
    const rows = await this.prisma.memoryFactVersion.findMany({
      where: { userId: identity.userId, state: "ACTIVE", contentPurgedAt: null },
      select: { id: true, displayText: true, structuredValue: true }, orderBy: { id: "asc" }
    });
    return createHash("sha256").update(canonicalJson(rows)).digest("hex");
  }

  async rebuild(identity: Identity) {
    // Account setup can already have queued an automatic index rebuild.
    // Preserve its failure, or let it finish before admitting another rebuild.
    await this.settle(identity);
    const settings = await this.prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: identity.userId } });
    const repository = createPrismaMemoryRebuildRepository(this.prisma);
    const service = createMemoryRebuildService({ repository, probeEmbeddingPin: (userId) =>
      probeCurrentMemoryEmbeddingPin(defaultMemoryExecutionAuthority, this.prisma, userId, MEMORY_ITEM_EMBEDDING_VERSIONS) });
    const started = await service.start(identity.userId, { embeddingDeploymentId: this.roles.embeddingId,
      expectedMemoryRevision: settings.memoryRevision, expectedSettingsRevision: settings.settingsRevision, operation: "REEMBED" });
    const deadline = Date.now() + PROFILE.settlementTimeoutMs;
    while (Date.now() < deadline) {
      const status = await repository.status(identity.userId, started.jobId);
      if (status?.state === "SUCCEEDED") { await this.settle(identity); return; }
      if (!status || ["CANCELLED", "FAILED", "STALE"].includes(status.state)) throw new Error("memory_acceptance_rebuild_failed");
      await delay(1_000);
    }
    throw new Error("memory_acceptance_rebuild_timeout");
  }

  async quiesce(identity: Identity) {
    // Retain synthetic evidence, but prevent future scheduled learning/synthesis.
    await this.settings(identity, { learnAutomatically: false, synthesisEnabled: false, decayEnabled: false });
  }

  async usage() {
    const where = { userId: { in: this.ownedUserIds } };
    const usageSums = {
      cacheWriteInputTokens: true,
      cachedInputTokens: true,
      estimatedCostMicros: true,
      inputTokens: true,
      outputTokens: true,
      reasoningTokens: true,
      totalTokens: true
    } as const;
    const [answers, utilities, ancillaryUsageEvents] = await Promise.all([
      this.prisma.modelRun.groupBy({ by: ["provider", "modelId", "status", "usageCompleteness"], where,
        _count: true, _sum: usageSums }),
      this.prisma.memoryExecutionBinding.groupBy({
        by: ["logicalRole", "providerModelId", "state", "usageCompleteness"], where,
        _count: true, _sum: usageSums
      }),
      this.prisma.usageEvent.groupBy({
        by: ["chatPdfPreparation", "chatTitleGeneration", "imageGeneration", "mcpHubDiscovery", "modelId", "provider", "providerModelId", "usageCompleteness"],
        where: { ...where, memoryExecutionBindingId: null, modelRunId: null },
        _count: true,
        _sum: { ...usageSums, operationCount: true }
      })
    ]);
    return { ancillaryUsageEvents, answers, utilities };
  }

  async assertDatabaseAvailable() {
    await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
  }
}
