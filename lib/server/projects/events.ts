import type { PrismaClient } from "@prisma/client";
import { Client, type Notification } from "pg";
import type { ProjectChatSummaryWire } from "@/lib/contracts/projects";
import { resolveProjectAccess } from "./access";
import {
  loadProjectChatDefaultAuthority
} from "./chatDefaults";
import { projectChatSelect, projectChatWire } from "./chatProjection";
import { workspaceAvailabilityService } from "../workspace/defaultServices";

/**
 * Project events are intentionally content-free invalidations.  The database
 * row is the durable source of truth; this small process-local hub is only a
 * wake-up mechanism for SSE subscribers.  A reconnect always replays from the
 * cursor in PostgreSQL, so a missed wake-up cannot lose state.
 */
type WakeListener = () => void;

const PROJECT_EVENT_CHANNEL = "aiqsa_project_events";

type ProjectEventHubState = {
  client: Client | null;
  connecting: Promise<void> | null;
  listeners: Map<string, Set<WakeListener>>;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

const eventGlobal = globalThis as typeof globalThis & {
  __aiqsaProjectEventHub?: ProjectEventHubState;
};

function hubState(): ProjectEventHubState {
  return eventGlobal.__aiqsaProjectEventHub ??= {
    client: null,
    connecting: null,
    listeners: new Map<string, Set<WakeListener>>(),
    retryTimer: null
  };
}

function validProjectNotification(notification: Notification): string | null {
  const projectId = notification.channel === PROJECT_EVENT_CHANNEL
    ? notification.payload?.trim() ?? ""
    : "";
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(projectId) ? projectId : null;
}

function scheduleProjectEventReconnect(state: ProjectEventHubState): void {
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
  const state = hubState();
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
  for (const listener of hubState().listeners.get(projectId) ?? []) {
    try {
      listener();
    } catch {
      // A stale subscriber must never break a mutation or another client.
    }
  }
}

export function subscribeProjectEvents(projectId: string, listener: WakeListener): () => void {
  const listeners = hubState().listeners;
  const bucket = listeners.get(projectId) ?? new Set<WakeListener>();
  const subscription = () => listener();
  bucket.add(subscription);
  listeners.set(projectId, bucket);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = hubState().listeners.get(projectId);
    if (current !== bucket) return;
    current.delete(subscription);
    if (current.size === 0 && hubState().listeners.get(projectId) === current) {
      hubState().listeners.delete(projectId);
    }
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

/** Reconstruct the current client-safe delta from authoritative rows. Event
 * storage remains content-free and a revoked/deleted entity produces no stale
 * label or payload. */
export async function safeProjectEventDeliveries(
  prisma: PrismaClient,
  projectId: string,
  events: readonly ProjectEventProjectionSource[]
): Promise<SafeProjectEventDelivery[]> {
  const bases = events.map((event) => ({
    category: safeProjectEventCategory(event.eventType),
    revision: projectEventId(event.sequence)
  }));
  const projectable = events.flatMap((event, index) =>
    ["chat_changed", "message_changed", "run_changed"].includes(bases[index]!.category) &&
    event.entityId
      ? [{ entityId: event.entityId, entityType: event.entityType, index }]
      : []
  );
  if (projectable.length === 0) return bases;

  const messageIds = [...new Set(projectable.flatMap((item) =>
    item.entityType === "message" ? [item.entityId] : []
  ))];
  const runIds = [...new Set(projectable.flatMap((item) =>
    item.entityType === "run" ? [item.entityId] : []
  ))];
  const [messages, runs] = await Promise.all([
    messageIds.length > 0
      ? prisma.message.findMany({
          select: { chatId: true, id: true },
          where: { chat: { projectId }, id: { in: messageIds } }
        })
      : [],
    runIds.length > 0
      ? prisma.modelRun.findMany({
          select: { chatId: true, id: true },
          where: { chat: { projectId }, id: { in: runIds } }
        })
      : []
  ]);
  const messageChats = new Map(messages.map((message) => [message.id, message.chatId]));
  const runChats = new Map(runs.map((run) => [run.id, run.chatId]));
  const chatIdByIndex = new Map<number, string>();
  for (const item of projectable) {
    const chatId = item.entityType === "chat"
      ? item.entityId
      : item.entityType === "message"
        ? messageChats.get(item.entityId)
        : item.entityType === "run"
          ? runChats.get(item.entityId)
          : undefined;
    if (chatId) chatIdByIndex.set(item.index, chatId);
  }
  const chatIds = [...new Set(chatIdByIndex.values())];
  if (chatIds.length === 0) return bases;
  const [chats, authority, workspaceSnapshot] = await Promise.all([
    prisma.chat.findMany({
      select: projectChatSelect,
      where: { id: { in: chatIds }, permanentDeletionAt: null, projectId }
    }),
    loadProjectChatDefaultAuthority(prisma, projectId),
    workspaceAvailabilityService.snapshot()
  ]);
  const projected = new Map(chats.filter((chat) => chat.projectId).map((chat) => [
    chat.id,
    projectChatWire(chat, authority, {
      availability: workspaceAvailabilityService,
      snapshot: workspaceSnapshot
    })
  ]));
  return bases.map((base, index) => {
    const chatId = chatIdByIndex.get(index);
    if (!chatId) return base;
    const chat = projected.get(chatId);
    return chat ? { ...base, chat, chatId } : { ...base, chatId };
  });
}

export async function safeProjectEventDelivery(
  prisma: PrismaClient,
  projectId: string,
  event: ProjectEventProjectionSource
): Promise<SafeProjectEventDelivery> {
  return (await safeProjectEventDeliveries(prisma, projectId, [event]))[0]!;
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
