import { storedTokenUsage } from "../usage";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { estimateCostMicros, normalizeTokenUsage } from "../../domain/usage";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { resolveChatAccess } from "../projects/access";
import { notifyProjectEvent } from "../projects/events";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { scheduleTemporaryChatDeletion, temporaryRetentionDeadline } from "../memory/temporaryRetention";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { CHAT_SUMMARY_LEASE_MS, ChatContinuationError, type ContinuationRepository, type ContinuationSource } from "./continuation";
import type { StorageAdapter } from "../uploads/storage";
import { WorkspaceRuntimeError, type WorkspaceOutputStream, type WorkspaceRuntime } from "../workspace/runtime";
import { WORKSPACE_OPERATION_LEASE_MS } from "../workspace/sessionOperation";
import { parseWorkspaceOperation } from "../workspace/operationFence";
import { loadExposedChatModelId } from "./chatCreationDefaults";
import { loadProjectChatDefaultAuthority } from "../projects/chatDefaults";

const sourceSelect = {
  activeLeafMessageId: true, archived: true, defaultProviderModelId: true, defaultKnowledgePlan: true, folderId: true,
  id: true, memoryMode: true, permanentDeletionAt: true, projectFolderId: true, projectId: true,
  title: true, updatedAt: true, userId: true, workspaceEnabled: true
} satisfies Prisma.ChatSelect;

async function lockedSource(tx: Prisma.TransactionClient, input: {
  chatId: string; userId: string; leafMessageId: string; updatedAt?: Date;
}) {
  const boundary = await tx.chat.findUnique({ select: { projectId: true }, where: { id: input.chatId } });
  if (boundary?.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${boundary.projectId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${input.chatId} FOR UPDATE`;
  const access = await resolveChatAccess(tx, {
    chatId: input.chatId, userId: input.userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR"
  });
  const actor = await tx.user.findFirst({ select: { displayName: true }, where: { id: input.userId, status: "active" } });
  const chat = access ? await tx.chat.findUnique({ select: sourceSelect, where: { id: input.chatId } }) : null;
  if (!chat || !actor || chat.archived || chat.permanentDeletionAt) throw new ChatContinuationError("chat_not_found", 404);
  if (chat.activeLeafMessageId !== input.leafMessageId ||
    input.updatedAt && chat.updatedAt.getTime() !== input.updatedAt.getTime()) throw new ChatContinuationError("chat_changed");
  const active = await tx.modelRun.findFirst({ select: { id: true }, where: {
    chatId: chat.id, status: { in: ["queued", "preparing", "streaming", "in_progress"] }
  } });
  if (active) throw new ChatContinuationError("chat_busy");
  return { actor, chat, projectRole: access?.project?.effectiveRole ?? null };
}

function currentInput(source: ContinuationSource) {
  return { chatId: source.chatId, userId: source.userId, leafMessageId: source.leafMessageId, updatedAt: source.updatedAt };
}

export async function continuationSourceHref(client: PrismaClient, chatId: string, userId: string): Promise<string | null> {
  if (!await resolveChatAccess(client, { chatId, userId })) return null;
  const operation = await client.chatContinuation.findUnique({ where: { newChatId: chatId }, select: { sourceChatId: true } });
  if (!operation) return null;
  const source = await resolveChatAccess(client, { chatId: operation.sourceChatId, userId });
  if (!source) return null;
  const params = new URLSearchParams({ chat: operation.sourceChatId });
  if (source.project) params.set("project", source.project.projectId);
  return `/?${params}`;
}

export function createChatContinuationRepository(client: PrismaClient, deps: Readonly<{
  runtime?: WorkspaceRuntime;
  storage?: StorageAdapter;
}> = {}): ContinuationRepository {
  return {
    loadSource: (input) => client.$transaction(async (tx) => {
      const { chat } = await lockedSource(tx, { chatId: input.chatId, userId: input.userId, leafMessageId: input.expectedLeafMessageId });
      // First load only bounded graph metadata. Sibling contents, tools, files and Workspace are never read.
      const path = await tx.$queryRaw<Array<{ id: string; parentMessageId: string | null; bytes: number; role: string; status: string; depth: number }>>(Prisma.sql`
        WITH RECURSIVE branch AS (
          SELECT "id", "parentMessageId", octet_length("content"::text) AS bytes, "role", "status", 1 AS depth
          FROM "Message" WHERE "chatId" = ${chat.id} AND "id" = ${input.expectedLeafMessageId}
          UNION ALL
          SELECT m."id", m."parentMessageId", octet_length(m."content"::text), m."role", m."status", b.depth + 1
          FROM "Message" m JOIN branch b ON m."id" = b."parentMessageId"
          WHERE m."chatId" = ${chat.id} AND b.depth < 2001
        ) SELECT * FROM branch ORDER BY depth DESC
      `);
      if (!path.length || path.at(-1)?.role !== "assistant" || path.at(-1)?.status !== "complete") throw new ChatContinuationError("chat_changed");
      if (path[0]?.parentMessageId || path.length > 2000 || path.reduce((total, row) => total + row.bytes, 0) > 4 * 1024 * 1024) {
        throw new ChatContinuationError("chat_summary_too_large", 413);
      }
      const messages = await tx.message.findMany({ where: { chatId: chat.id, id: { in: path.map((row) => row.id) } }, select: { id: true, content: true } });
      const byId = new Map(messages.map((message) => {
        const content = message.content;
        const blocks = content && typeof content === "object" && !Array.isArray(content) && Array.isArray(content.blocks)
          ? content.blocks : [];
        return [message.id, textFromContentBlocks({ blocks })];
      }));
      const transcript = path.flatMap((row) => {
        const text = byId.get(row.id)?.trim();
        return text && (row.role === "user" || row.role === "assistant")
          ? [`${row.role.toUpperCase()}${row.status === "complete" ? "" : " (unfinished)"}:\n${text}`] : [];
      }).join("\n\n");
      if (!transcript) throw new ChatContinuationError("chat_changed");
      return { chatId: chat.id, leafMessageId: input.expectedLeafMessageId, projectId: chat.projectId, updatedAt: chat.updatedAt, userId: input.userId, transcript,
        workspaceEnabled: chat.workspaceEnabled };
    }),

    claim: (source, requestId, modelSelection) => client.$transaction(async (tx) => {
      await lockedSource(tx, currentInput(source));
      const key = { sourceChatId: source.chatId, sourceMessageId: source.leafMessageId, snapshotUpdatedAt: source.updatedAt };
      const duplicateId = await tx.chatContinuation.findUnique({ where: { attemptId: requestId } });
      if (duplicateId && (duplicateId.sourceChatId !== source.chatId || duplicateId.sourceMessageId !== source.leafMessageId)) {
        throw new ChatContinuationError("chat_changed");
      }
      const existing = duplicateId ?? await tx.chatContinuation.findUnique({
        where: { sourceChatId_sourceMessageId_snapshotUpdatedAt: key }
      });
      if (existing?.status === "complete") {
        const access = existing.newChatId ? await resolveChatAccess(tx, { chatId: existing.newChatId, userId: source.userId }) : null;
        if (!access || !existing.newChatId) throw new ChatContinuationError("chat_not_found", 404);
        return { kind: "result", result: { status: "complete", chatId: existing.newChatId, projectId: access.project?.projectId ?? null } };
      }
      if (existing?.status === "running") {
        if (existing.cancelRequestedAt) throw new ChatContinuationError("chat_summary_cancelled");
        if (existing.leaseExpiresAt ? existing.leaseExpiresAt.getTime() > Date.now() : Date.now() - existing.updatedAt.getTime() <= 180_000) {
          return { kind: "result", result: { status: "running", ...(existing.leaseExpiresAt ? { progress: {
            completedParts: existing.completedParts,
            stage: existing.progressStage === "combining" ? "combining" as const : existing.progressStage === "summarizing" ? "summarizing" as const : "preparing" as const
          } } : {}) } };
        }
        // A stopped process has an unknown provider outcome. Only a fresh explicit attempt can retry.
        await tx.chatContinuation.update({ where: { id: existing.id }, data: { status: "failed", errorCode: "chat_summary_failed" } });
        return { kind: "failed" };
      }
      if (existing?.attemptId === requestId) {
        const code = existing.errorCode;
        throw new ChatContinuationError(code === "chat_summary_no_progress" || code === "chat_summary_outcome_unknown" ||
          code === "chat_summary_cancelled" || code === "chat_summary_unavailable" ? code : "chat_summary_failed", 502);
      }
      // Freeze only a server-exposed selection. Polls and duplicate claims
      // return above, so later composer changes cannot retarget this claim.
      let requestedProviderModelId: string | null = null;
      if (modelSelection) {
        if (source.projectId) {
          const authority = await loadProjectChatDefaultAuthority(tx, source.projectId);
          if (authority.modelProviders.get(modelSelection.modelId) === modelSelection.provider) {
            requestedProviderModelId = modelSelection.modelId;
          }
        } else {
          requestedProviderModelId = await loadExposedChatModelId(tx, source.userId, modelSelection);
        }
      }
      const operation = existing
        ? await tx.chatContinuation.update({ where: { id: existing.id }, data: {
            actorUserId: source.userId, attemptId: requestId, errorCode: null, status: "running", requestedProviderModelId, leaseExpiresAt: new Date(Date.now() + CHAT_SUMMARY_LEASE_MS),
            cancelRequestedAt: null, completedParts: 0, progressStage: "preparing"
          } })
        : await tx.chatContinuation.create({ data: {
            ...key, actorUserId: source.userId, attemptId: requestId, status: "running", requestedProviderModelId, leaseExpiresAt: new Date(Date.now() + CHAT_SUMMARY_LEASE_MS),
            cancelRequestedAt: null, completedParts: 0, progressStage: "preparing"
          } });
      const priorSeed = await tx.chatContinuationWorkspaceSeed.findUnique({ where: { continuationId: operation.id } });
      if (priorSeed) {
        if (priorSeed.storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey: priorSeed.storageKey },
          create: { storageKey: priorSeed.storageKey }, update: {} });
        await tx.chatContinuationWorkspaceSeed.update({ where: { id: priorSeed.id }, data: {
          continuationId: null, status: "ABANDONED", leaseToken: null, leaseExpiresAt: null
        } });
      }
      const workspace = source.workspaceEnabled ? await tx.workspaceSession.findUnique({ where: { chatId: source.chatId } }) : null;
      // A stopped microVM still owns the durable project disk. It is safe to
      // archive that disk while stopped; only a missing sandbox id means
      // there is no source state to transfer.
      if (workspace?.state === "DELETING") throw new ChatContinuationError("chat_busy");
      const hasLiveDisk = Boolean(workspace?.runtimeSandboxId);
      if (source.workspaceEnabled) await tx.chatContinuationWorkspaceSeed.create({ data: {
        continuationId: operation.id,
        sourceChatId: source.chatId,
        status: hasLiveDisk ? "CAPTURING" : "NO_SOURCE_DISK",
        ...(hasLiveDisk ? {
          leaseToken: operation.id,
          leaseExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS)
        } : {})
      } });
      if (hasLiveDisk && workspace) {
        const updated = await tx.workspaceSession.updateMany({
          where: { id: workspace.id, version: workspace.version,
            OR: [{ operationOwner: null }, { operationExpiresAt: { lt: new Date() } }] },
          // Advance the durable generation before entering the runtime fence.
          // A stopped source may still have a retired run operation at the
          // previous generation; reusing it would be rejected as stale.
          data: { version: { increment: 1 }, operationOwner: `continuation:${operation.id}`, operationExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS) }
        });
        if (updated.count !== 1) throw new ChatContinuationError("chat_busy");
      }
      return { kind: "claimed", claim: { id: operation.id, attemptId: operation.attemptId } };
    }),

    async heartbeat(claim, progress) {
      const renewed = await client.chatContinuation.updateMany({ where: { id: claim.id, attemptId: claim.attemptId,
        status: "running", cancelRequestedAt: null, leaseExpiresAt: { gt: new Date() } },
        data: { leaseExpiresAt: new Date(Date.now() + CHAT_SUMMARY_LEASE_MS), completedParts: progress.completedParts,
          progressStage: progress.stage } });
      return renewed.count === 1;
    },

    async loadStep(claim, hash) {
      const step = await client.chatContinuationStep.findUnique({ where: {
        continuationId_requestHash: { continuationId: claim.id, requestHash: hash }
      } });
      if (step?.status === "dispatched" || step?.status === "unknown") throw new ChatContinuationError("chat_summary_outcome_unknown", 502);
      return step?.status === "complete" ? step.summary : null;
    },

    beginStep: (claim, hash) => client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatContinuation" WHERE "id" = ${claim.id} FOR UPDATE`;
      if (!await tx.chatContinuation.count({ where: { id: claim.id, attemptId: claim.attemptId, status: "running",
        cancelRequestedAt: null, leaseExpiresAt: { gt: new Date() } } })) throw new ChatContinuationError("chat_summary_cancelled");
      const where = { continuationId_requestHash: { continuationId: claim.id, requestHash: hash } };
      const prior = await tx.chatContinuationStep.findUnique({ where });
      if (prior && prior.status !== "failed") throw new ChatContinuationError("chat_summary_outcome_unknown", 502);
      await tx.chatContinuationStep.upsert({ where,
        create: { continuationId: claim.id, requestHash: hash, attemptId: claim.attemptId, status: "dispatched" },
        update: { attemptId: claim.attemptId, status: "dispatched", summary: null } });
    }),

    async settleStep(claim, hash, result) {
      await client.chatContinuationStep.updateMany({ where: { continuationId: claim.id, requestHash: hash,
        attemptId: claim.attemptId, status: "dispatched" }, data: "summary" in result
          ? { status: "complete", summary: result.summary }
          : { status: result.ambiguous ? "unknown" : "failed", summary: null } });
    },

    async assertCurrent(source) {
      await client.$transaction((tx) => lockedSource(tx, currentInput(source)));
    },

    async captureWorkspace(source, claim, signal) {
      if (!deps.runtime || !deps.storage || !source.workspaceEnabled) return;
      signal?.throwIfAborted();
      // Leave time for the conversation summary when the copy stalls.
      const captureSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      const observed = await client.$transaction(async (tx) => {
        await lockedSource(tx, currentInput(source));
        if (!await tx.chatContinuation.findFirst({ where: { id: claim.id, attemptId: claim.attemptId, status: "running" } })) {
          throw new ChatContinuationError("chat_changed");
        }
        const seed = await tx.chatContinuationWorkspaceSeed.findUnique({ where: { continuationId: claim.id } });
        const session = await tx.workspaceSession.findUnique({ where: { chatId: source.chatId } });
        if (!seed || seed.status === "NO_SOURCE_DISK" || seed.status === "READY") return null;
        if (!session?.runtimeSandboxId || session.operationOwner !== `continuation:${claim.id}`) {
          await tx.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: { status: "NO_SOURCE_DISK", failureCode: null, leaseToken: null, leaseExpiresAt: null } });
          return null;
        }
        return { seedId: seed.id, sessionId: session.id, runtimeSandboxId: session.runtimeSandboxId, generation: session.version };
      });
      if (!observed) return;
      const operation = parseWorkspaceOperation({ generation: observed.generation, owner: `continuation:${claim.id}` });
      let storageKey: string | null = null;
      let archiveOutput: WorkspaceOutputStream | null = null;
      let timer: ReturnType<typeof setInterval> | undefined;
      const renew = () => void client.workspaceSession.updateMany({
        where: { id: observed.sessionId, version: observed.generation, operationOwner: operation.owner },
        data: { operationExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS) }
      }).then(() => client.chatContinuationWorkspaceSeed.updateMany({
        where: { id: observed.seedId, status: "CAPTURING" },
        data: { leaseExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS) }
      })).catch(() => undefined);
      try {
        await deps.runtime.claimSessionOperation?.({ operation, runtimeSandboxId: observed.runtimeSandboxId, sessionId: observed.sessionId });
        timer = setInterval(renew, Math.floor(WORKSPACE_OPERATION_LEASE_MS / 3));
        timer.unref?.();
        archiveOutput = await deps.runtime.createProjectArchive({ operation, runtimeSandboxId: observed.runtimeSandboxId, sessionId: observed.sessionId, signal: captureSignal });
        const output = archiveOutput;
        storageKey = `workspace-continuation/${observed.seedId}.tar.gz`;
        const reserved = await client.chatContinuationWorkspaceSeed.updateMany({
          where: { id: observed.seedId, status: "CAPTURING" }, data: { storageKey }
        });
        if (reserved.count !== 1) {
          await output.body.cancel("continuation_abandoned").catch(() => undefined);
          if (output.batchId) await deps.runtime.releaseOutputs?.({
            batchId: output.batchId, operation, runtimeSandboxId: observed.runtimeSandboxId, sessionId: observed.sessionId
          }).catch(() => undefined);
          return;
        }
        if (deps.storage.putObjectStream) {
          await deps.storage.putObjectStream({ body: output.body, byteSize: output.byteSize, checksum: output.checksum,
            contentType: "application/gzip", signal: captureSignal, storageKey });
        } else {
          const reader = output.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try { while (true) { captureSignal.throwIfAborted(); const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > output.byteSize) throw new Error("archive_size"); chunks.push(next.value); } }
          finally { reader.releaseLock(); }
          if (bytes !== output.byteSize) throw new Error("archive_size");
          const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
          if (createHash("sha256").update(body).digest("hex") !== output.checksum) throw new Error("archive_checksum");
          await deps.storage.putObject({ body, contentType: "application/gzip", storageKey });
        }
        await client.$transaction(async (tx) => {
          const seedReady = (await tx.chatContinuationWorkspaceSeed.updateMany({ where: { id: observed.seedId, status: "CAPTURING" }, data: {
            status: "READY", storageKey, checksum: output.checksum, byteSize: output.byteSize, leaseToken: null, leaseExpiresAt: null
          } })).count === 1;
          if (!seedReady && storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey }, create: { storageKey }, update: {} });
        });
      } catch (error) {
        const failureCode = captureSignal.aborted ? "workspace_tool_timeout" : error instanceof WorkspaceRuntimeError ? error.code : "workspace_archive_export_failed";
        if (archiveOutput?.batchId) await deps.runtime.releaseOutputs?.({
          batchId: archiveOutput.batchId, operation, runtimeSandboxId: observed.runtimeSandboxId, sessionId: observed.sessionId
        }).catch(() => undefined);
        await client.$transaction(async (tx) => {
          await tx.chatContinuationWorkspaceSeed.updateMany({ where: { id: observed.seedId, status: "CAPTURING" }, data: {
            status: "FAILED", failureCode, storageKey, leaseToken: null, leaseExpiresAt: null
          } });
          if (storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey }, create: { storageKey }, update: {} });
        });
        // A copy failure is visible in the destination, but does not discard
        // a usable conversation summary. Cancellation still ends this claim.
        signal?.throwIfAborted();
      } finally {
        if (timer) clearInterval(timer);
        try {
          const runtimeInput = { operation, runtimeSandboxId: observed.runtimeSandboxId, sessionId: observed.sessionId };
          if (deps.runtime.retireSessionOperation) await deps.runtime.retireSessionOperation(runtimeInput);
          else await deps.runtime.stopSession(runtimeInput);
          await client.workspaceSession.updateMany({ where: { id: observed.sessionId, version: observed.generation, operationOwner: operation.owner },
            data: { operationOwner: null, operationExpiresAt: null, state: "STOPPED", stoppedAt: new Date() } });
        } catch {
          // Keep the database reservation until maintenance proves retirement.
        }
      }
    },

    complete: async (source, claim, summary) => {
      const result = await client.$transaction(async (tx) => {
        const { actor, chat, projectRole } = await lockedSource(tx, currentInput(source));
        const operation = await tx.chatContinuation.findFirst({ where: {
          id: claim.id, attemptId: claim.attemptId, actorUserId: source.userId, status: "running", cancelRequestedAt: null,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { gt: new Date() } }]
        } });
        if (!operation) throw new ChatContinuationError("chat_changed");
        // Artifacts are chat context, not part of the summary prose. Carry the
        // exact ready version that was attached to the source chat into the
        // destination so the first follow-up can edit it without asking the
        // model to guess an id or rereading the old chat.
        const newChatId = randomUUID();
        const requestMessageId = randomUUID();
        const messageId = randomUUID();
        const deadline = chat.memoryMode === "TEMPORARY" ? temporaryRetentionDeadline(new Date()) : null;
        await tx.chat.create({ data: {
          id: newChatId, title: `Continued: ${chat.title}`.slice(0, 120),
          defaultProviderModelId: operation.requestedProviderModelId ?? chat.defaultProviderModelId, memoryMode: chat.memoryMode,
          defaultKnowledgePlan: chat.defaultKnowledgePlan ?? Prisma.DbNull,
          workspaceEnabled: chat.workspaceEnabled,
          ...(chat.projectId ? {
            userId: null, projectId: chat.projectId, projectFolderId: chat.projectFolderId,
            createdByUserId: source.userId, createdByDisplayName: actor.displayName
          } : { userId: source.userId, folderId: chat.folderId }),
          ...(deadline ? { temporaryRetentionDeadline: deadline, temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } : {})
        } });
        if (!chat.projectId) {
          await tx.$executeRaw`INSERT INTO "ArtifactChatBinding" ("artifactId", "chatId", "versionId", "createdAt", "updatedAt")
            SELECT binding."artifactId", ${newChatId}, binding."versionId", NOW(), binding."updatedAt"
            FROM "ArtifactChatBinding" binding
            JOIN "Artifact" artifact ON artifact."id" = binding."artifactId"
            JOIN "ArtifactVersion" version ON version."artifactId" = binding."artifactId" AND version."id" = binding."versionId"
            WHERE binding."chatId" = ${chat.id} AND artifact."ownerUserId" = ${source.userId}
              AND artifact."archivedAt" IS NULL AND version."status" = 'READY'`;
        }
        await tx.chatContinuationWorkspaceSeed.updateMany({ where: { continuationId: claim.id, status: "READY" },
          data: { newChatId, status: "TRANSFERRED" } });
        await tx.chatContinuationWorkspaceSeed.updateMany({ where: { continuationId: claim.id, status: { in: ["NO_SOURCE_DISK", "FAILED"] } },
          data: { newChatId } });
        await tx.message.create({ data: {
          id: requestMessageId, chatId: newChatId, role: "user", status: "complete",
          content: textMessageContent("Continue from the conversation summary below."),
          ...(chat.projectId ? { authorUserId: source.userId, authorDisplayName: actor.displayName,
            authorProjectRole: projectRole } : {})
        } });
        await tx.message.create({ data: {
          id: messageId, parentMessageId: requestMessageId, chatId: newChatId, role: "assistant", status: "complete",
          content: textMessageContent(`Conversation summary\n\n${summary}`)
        } });
        if (chat.projectId) {
          await tx.chat.update({ where: { id: newChatId }, data: { activeLeafMessageId: messageId } });
          await tx.projectAuditEvent.create({ data: {
            projectId: chat.projectId, actorUserId: source.userId, actorDisplayName: actor.displayName,
            eventType: "project_chat_created", metadata: { chatId: newChatId }
          } });
        }
        else {
          const newChat = await lockMemorySourceChat(tx, { chatId: newChatId, lock: "UPDATE", userId: source.userId });
          if (!newChat) throw new ChatContinuationError("chat_summary_failed", 502);
          await applyMemorySourceMutations(tx, {
            chat: newChat, hooks: defaultMemorySourceMutationHooks, mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: messageId }
          });
        }
        if (deadline) await scheduleTemporaryChatDeletion(tx, { chatId: newChatId, deadline, now: new Date(), userId: source.userId });
        const settled = await tx.chatContinuation.updateMany({ where: { id: claim.id, attemptId: claim.attemptId, status: "running", cancelRequestedAt: null,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { gt: new Date() } }] }, data: { status: "complete", newChatId, errorCode: null } });
        if (settled.count !== 1) throw new ChatContinuationError("chat_changed");
        await tx.chatContinuationStep.deleteMany({ where: { continuationId: claim.id } });
        return { status: "complete" as const, chatId: newChatId, projectId: chat.projectId };
      });
      if (result.projectId) notifyProjectEvent(result.projectId);
      return result;
    },

    async fail(claim, code) {
      const workspace = await client.$transaction(async (tx) => {
        const failed = await tx.chatContinuation.updateMany({ where: { id: claim.id, attemptId: claim.attemptId, status: "running" }, data: { status: "failed", errorCode: code } });
        // A late failure from an older attempt cannot abandon its successor.
        if (failed.count !== 1) return null;
        const seed = await tx.chatContinuationWorkspaceSeed.findUnique({ where: { continuationId: claim.id } });
        if (seed && !seed.newChatId) {
          await tx.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: { status: "ABANDONED", failureCode: seed.failureCode ?? code,
            leaseToken: null, leaseExpiresAt: null } });
          if (seed.storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey: seed.storageKey }, create: { storageKey: seed.storageKey }, update: {} });
        }
        return tx.workspaceSession.findFirst({ where: { operationOwner: `continuation:${claim.id}` },
          select: { id: true, version: true, runtimeSandboxId: true } });
      });
      // Cancellation can happen after claim and before capture enters its
      // cleanup block. Retire that reservation before admitting another run.
      if (workspace && deps.runtime?.claimSessionOperation && deps.runtime.retireSessionOperation) {
        const operation = { generation: workspace.version, owner: `continuation:${claim.id}` };
        const runtimeInput = { operation, runtimeSandboxId: workspace.runtimeSandboxId, sessionId: workspace.id };
        try {
          await deps.runtime.claimSessionOperation(runtimeInput);
          await deps.runtime.retireSessionOperation(runtimeInput);
          await client.workspaceSession.updateMany({ where: { id: workspace.id, version: workspace.version, operationOwner: operation.owner },
            data: { operationOwner: null, operationExpiresAt: null } });
        } catch {
          // Expired-operation maintenance retries fencing if the runner is down.
        }
      }
    },

    async recordUsage({ claim, ordinal, source, provider, modelId, providerModelId, usage }) {
      const pricing = await client.providerModel.findUnique({ where: { id: providerModelId }, select: {
        inputTokenPriceMicros: true, outputTokenPriceMicros: true
      } });
      const data = {
        userId: source.userId, chatId: source.chatId, projectId: source.projectId, provider, modelId,
        ...storedTokenUsage(usage),
        estimatedCostMicros: pricing && (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0)
          ? estimateCostMicros(normalizeTokenUsage(usage), pricing) : null
      };
      await client.usageEvent.upsert({ where: { id: `chat-summary:${claim.id}:${claim.attemptId}:${ordinal}` },
        create: { ...data, id: `chat-summary:${claim.id}:${claim.attemptId}:${ordinal}` }, update: data });
    }
  };
}

/** Cancel only the authenticated actor's exact attempt; never another member's work. */
export async function cancelChatContinuation(client: PrismaClient, input: {
  chatId: string; userId: string; requestId: string;
}): Promise<void> {
  await client.$transaction(async tx => {
    const access = await resolveChatAccess(tx, { chatId: input.chatId, userId: input.userId, requireMutable: true,
      minimumProjectRole: "CONTRIBUTOR" });
    if (!access) throw new ChatContinuationError("chat_not_found", 404);
    await tx.chatContinuation.updateMany({ where: { sourceChatId: input.chatId, actorUserId: input.userId,
      attemptId: input.requestId, status: "running" }, data: { cancelRequestedAt: new Date() } });
  });
}
