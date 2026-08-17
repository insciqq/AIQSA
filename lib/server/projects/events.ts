import type { PrismaClient } from "@prisma/client";
import { Client, type Notification } from "pg";
import type { ProjectChatSummaryWire } from "@/lib/contracts/projects";
import { resolveProjectAccess } from "./access";
import {
  loadProjectChatDefaultAuthority,
  projectChatDefaultsProjection
} from "./chatDefaults";

/**
 * Project events are intentionally content-free invalidations.  The database
 * row is the durable source of truth; this small process-local hub is only a
 * wake-up mechanism for SSE subscribers.  A reconnect always replays from the
 * cursor in PostgreSQL, so a missed wake-up cannot lose state.
 */
type WakeListener = () => void;

const listeners = new Map<string, Set<WakeListener>>();
const PROJECT_EVENT_CHANNEL = "aiqsa_project_events";

type ProjectEventListenerState = {
  client: Client | null;
  connecting: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

const eventGlobal = globalThis as typeof globalThis & {
  __aiqsaProjectEventListener?: ProjectEventListenerState;
};

function listenerState(): ProjectEventListenerState {
  return eventGlobal.__aiqsaProjectEventListener ??= {
    client: null,
    connecting: null,
    retryTimer: null
  };
}

function validProjectNotification(notification: Notification): string | null {
  const projectId = notification.channel === PROJECT_EVENT_CHANNEL
    ? notification.payload?.trim() ?? ""
    : "";
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(projectId) ? projectId : null;
}

function scheduleProjectEventReconnect(state: ProjectEventListenerState): void {
  if (state.retryTimer || !process.env.DATABASE_URL) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void ensureProjectEventListener().catch(() => undefined);
  }, 1_000);
  state.retryTimer.unref?.();
}

/**
 * Establish the single LISTEN connection owned by this Node process.  It only
 * wakes local subscribers; every subscriber performs a durable cursor query
 * after subscribing, which closes the LISTEN/catch-up race.
 */
export function ensureProjectEventListener(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return Promise.resolve();
  const state = listenerState();
  if (state.client) return Promise.resolve();
  if (state.connecting) return state.connecting;

  const client = new Client({
    application_name: "aiqsa-project-events",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    keepAlive: true
  });
  state.connecting = (async () => {
    await client.connect();
    await client.query(`LISTEN ${PROJECT_EVENT_CHANNEL}`);
    state.client = client;
    client.on("notification", (notification) => {
      const projectId = validProjectNotification(notification);
      if (projectId) notifyProjectEvent(projectId);
    });
    const disconnected = () => {
      if (state.client !== client) return;
      state.client = null;
      state.connecting = null;
      scheduleProjectEventReconnect(state);
    };
    client.once("end", disconnected);
    client.on("error", () => {
      disconnected();
      void client.end().catch(() => undefined);
    });
  })().catch((error) => {
    if (state.client === client) state.client = null;
    void client.end().catch(() => undefined);
    scheduleProjectEventReconnect(state);
    throw error;
  }).finally(() => {
    state.connecting = null;
  });
  return state.connecting;
}

export function notifyProjectEvent(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) {
    try {
      listener();
    } catch {
      // A stale subscriber must never break a mutation or another client.
    }
  }
}

export function subscribeProjectEvents(projectId: string, listener: WakeListener): () => void {
  const bucket = listeners.get(projectId) ?? new Set<WakeListener>();
  bucket.add(listener);
  listeners.set(projectId, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(projectId);
  };
}

export type ProjectEventCursor = bigint;

export function parseProjectEventCursor(value: string | null | undefined): ProjectEventCursor | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  try {
    const cursor = BigInt(value);
    return cursor >= 0n ? cursor : null;
  } catch {
    return null;
  }
}

export function projectEventId(value: bigint): string {
  return value.toString(10);
}

const SAFE_EVENT_CATEGORIES: Record<string, string> = {
  assistant_added: "resource_changed",
  attachment_changed: "attachment_changed",
  deletion_requested: "lifecycle_changed",
  defaults_updated: "project_changed",
  group_grant_added: "access_changed",
  group_grant_changed: "access_changed",
  group_grant_removed: "access_changed",
  instructions_updated: "project_changed",
  memory_fact_created: "memory_changed",
  memory_fact_edited: "memory_changed",
  memory_fact_forgotten: "memory_changed",
  memory_policy_updated: "memory_changed",
  memory_proposal_approved: "memory_changed",
  memory_proposal_created: "memory_changed",
  memory_proposal_rejected: "memory_changed",
  message_changed: "run_changed",
  message_created: "message_changed",
  policy_updated: "project_changed",
  project_archived: "lifecycle_changed",
  project_chat_archived: "chat_changed",
  project_chat_created: "chat_changed",
  project_chat_restored: "chat_changed",
  project_created: "project_changed",
  project_description_updated: "project_changed",
  project_folder_created: "folder_changed",
  project_folder_deleted: "folder_changed",
  project_folder_updated: "folder_changed",
  project_renamed: "project_changed",
  project_restored: "lifecycle_changed",
  public_sharing_disabled: "lifecycle_changed",
  public_sharing_enabled: "lifecycle_changed",
  public_snapshot_created: "lifecycle_changed",
  public_snapshot_revoked: "lifecycle_changed",
  resource_attached: "resource_changed",
  resource_detached: "resource_changed",
  resource_owner_revoked: "resource_changed",
  resource_revision_updated: "resource_changed",
  run_changed: "run_changed",
  run_output_changed: "run_changed",
  run_tool_changed: "run_changed",
  user_grant_added: "access_changed",
  user_grant_changed: "access_changed",
  user_grant_removed: "access_changed",
  user_left_project: "access_changed"
};

export function safeProjectEventCategory(eventType: string): string {
  return SAFE_EVENT_CATEGORIES[eventType] ?? "project_changed";
}

type ProjectEventProjectionSource = Readonly<{
  entityId: string | null;
  entityType: string | null;
  eventType: string;
  sequence: bigint;
}>;

export type SafeProjectEventDelivery = Readonly<{
  category: string;
  chat?: ProjectChatSummaryWire;
  chatId?: string;
  revision: string;
}>;

async function projectEventChatId(
  prisma: PrismaClient,
  projectId: string,
  event: ProjectEventProjectionSource
): Promise<string | null> {
  if (!event.entityId) return null;
  if (event.entityType === "chat") return event.entityId;
  if (event.entityType === "message") {
    return (await prisma.message.findFirst({
      select: { chatId: true },
      where: { chat: { projectId }, id: event.entityId }
    }))?.chatId ?? null;
  }
  if (event.entityType === "run") {
    return (await prisma.modelRun.findFirst({
      select: { chatId: true },
      where: { chat: { projectId }, id: event.entityId }
    }))?.chatId ?? null;
  }
  return null;
}

async function projectChatProjection(
  prisma: PrismaClient,
  projectId: string,
  chatId: string
): Promise<ProjectChatSummaryWire | null> {
  const chat = await prisma.chat.findFirst({
    select: {
      _count: {
        select: {
          messages: true,
          modelRuns: {
            where: { status: { in: ["preparing", "queued", "streaming", "in_progress"] } }
          }
        }
      },
      activeLeafMessageId: true,
      archived: true,
      createdAt: true,
      createdByDisplayName: true,
      createdByUserId: true,
      defaultKnowledgePlan: true,
      defaultProviderModel: { select: { connectionId: true, id: true } },
      id: true,
      pinned: true,
      projectFolderId: true,
      projectId: true,
      title: true,
      updatedAt: true
    },
    where: { id: chatId, permanentDeletionAt: null, projectId }
  });
  if (!chat || !chat.projectId) return null;
  const authority = await loadProjectChatDefaultAuthority(prisma, projectId);
  const defaults = projectChatDefaultsProjection(authority, {
    defaultKnowledgePlan: chat.defaultKnowledgePlan,
    defaultModelId: chat.defaultProviderModel?.id ?? null
  });
  return {
    activeRun: chat._count.modelRuns > 0,
    activeLeafMessageId: chat.activeLeafMessageId,
    archived: chat.archived,
    createdAt: chat.createdAt.toISOString(),
    createdByDisplayName: chat.createdByDisplayName,
    createdByUserId: chat.createdByUserId,
    defaultKnowledgePlan: defaults.defaultKnowledgePlan,
    defaultModelId: defaults.defaultModelId,
    defaultProvider: defaults.defaultProvider,
    folderId: chat.projectFolderId,
    id: chat.id,
    messageCount: chat._count.messages,
    pinned: chat.pinned,
    projectId: chat.projectId,
    title: chat.title,
    updatedAt: chat.updatedAt.toISOString()
  };
}

/** Reconstruct the current client-safe delta from authoritative rows. Event
 * storage remains content-free and a revoked/deleted entity produces no stale
 * label or payload. */
export async function safeProjectEventDelivery(
  prisma: PrismaClient,
  projectId: string,
  event: ProjectEventProjectionSource
): Promise<SafeProjectEventDelivery> {
  const category = safeProjectEventCategory(event.eventType);
  const base = { category, revision: projectEventId(event.sequence) };
  if (!["chat_changed", "message_changed", "run_changed"].includes(category)) return base;
  const chatId = await projectEventChatId(prisma, projectId, event);
  if (!chatId) return base;
  const chat = await projectChatProjection(prisma, projectId, chatId);
  return chat ? { ...base, chat, chatId } : { ...base, chatId };
}

export async function readProjectEvents(
  prisma: PrismaClient,
  input: Readonly<{ after: bigint; limit: number; projectId: string }>
) {
  const rows = await prisma.projectEvent.findMany({
    orderBy: { sequence: "asc" },
    take: Math.min(Math.max(input.limit, 1), 256),
    where: { projectId: input.projectId, sequence: { gt: input.after } }
  });
  return rows;
}

export async function latestProjectEventCursor(
  prisma: PrismaClient,
  projectId: string
): Promise<ProjectEventCursor> {
  const latest = await prisma.projectEvent.findFirst({
    orderBy: { sequence: "desc" },
    select: { sequence: true },
    where: { projectId }
  });
  return latest?.sequence ?? 0n;
}

/** Return whether a cursor is older than the retained event history. */
export async function projectCursorNeedsResync(
  prisma: PrismaClient,
  input: Readonly<{ after: bigint; projectId: string }>
): Promise<boolean> {
  // Sequence is global, while retention is per Project. A gap before the first
  // Project event does not prove expiry (other Projects may own those cursor
  // values), and an initial cursor always replays the retained window.
  if (input.after === 0n) return false;
  const oldest = await prisma.projectEvent.findFirst({
    orderBy: { sequence: "asc" },
    select: { sequence: true },
    where: { projectId: input.projectId }
  });
  if (oldest === null || input.after >= oldest.sequence - 1n) return false;
  const retained = await prisma.projectEvent.count({ where: { projectId: input.projectId } });
  return retained >= 10_000;
}

/** Revalidate access immediately before an SSE delivery batch. */
export async function projectEventAccess(
  prisma: PrismaClient,
  input: Readonly<{ projectId: string; userId: string }>
) {
  return resolveProjectAccess(prisma, {
    minimumRole: "VIEWER",
    projectId: input.projectId,
    userId: input.userId
  });
}
