import { createChatSearchEmbedder } from "../chatSearch/embedderPrisma";
import { prisma } from "../prisma";
import { createS3StorageAdapter } from "../uploads/storage";
import { workspaceRuntime } from "../workspace/defaultServices";
import { createPermanentChatDeletionPass, createTemporaryChatDeletionPass } from "./chatDeletionPasses";
import { createChatSearchBackfillPass, createChatSearchIndexPass } from "./chatSearchPasses";
import {
  BACKGROUND_WORKER_HEARTBEAT_INTERVAL_MS,
  createPrismaBackgroundWorkerHeartbeat,
  type BackgroundWorkerHeartbeat
} from "./heartbeat";
import { defaultBackgroundPassRegistry, type BackgroundPassRegistry } from "./passes";
import { createBackgroundWorker, type BackgroundWorker } from "./worker";

type DefaultsGlobal = typeof globalThis & {
  __aiqsaBackgroundDefaultsRegistered?: boolean;
  __aiqsaBackgroundLocalWorker?: Readonly<{ heartbeat: BackgroundWorkerHeartbeat; worker: BackgroundWorker }>;
};

/**
 * The deletion duties (Temporary chats past their deadline, chats fenced for permanent deletion) and the past-chat
 * search index with its backfill.
 */
export function registerDefaultBackgroundPasses(
  registry: BackgroundPassRegistry = defaultBackgroundPassRegistry
): void {
  const scope = globalThis as DefaultsGlobal;
  if (registry === defaultBackgroundPassRegistry && scope.__aiqsaBackgroundDefaultsRegistered) return;
  const dependencies = { client: prisma, storage: createS3StorageAdapter(), workspaceRuntime };
  registry.register(createTemporaryChatDeletionPass(dependencies));
  registry.register(createPermanentChatDeletionPass(dependencies));
  const chatSearch = { db: prisma, embedder: createChatSearchEmbedder(prisma) };
  registry.register(createChatSearchIndexPass(chatSearch));
  registry.register(createChatSearchBackfillPass(chatSearch));
  if (registry === defaultBackgroundPassRegistry) scope.__aiqsaBackgroundDefaultsRegistered = true;
}

/**
 * Development only (`instrumentation.ts`): the web process runs the passes itself, since the disposable stand has
 * no worker service. Work-item leases keep it safe beside a dedicated worker.
 */
export async function startBackgroundWorkerLocally(): Promise<void> {
  const scope = globalThis as DefaultsGlobal;
  if (scope.__aiqsaBackgroundLocalWorker) return;
  registerDefaultBackgroundPasses();
  const heartbeat = createPrismaBackgroundWorkerHeartbeat(prisma);
  const worker = createBackgroundWorker({ passes: defaultBackgroundPassRegistry.list() });
  scope.__aiqsaBackgroundLocalWorker = { heartbeat, worker };
  worker.start();
  await heartbeat.beat();
  setInterval(() => { void heartbeat.beat().catch(() => undefined); }, BACKGROUND_WORKER_HEARTBEAT_INTERVAL_MS).unref();
}
