import type { ErrorResponse } from "./http";

/**
 * Control Center Health "Background queues": an administrator-only snapshot of
 * the durable job tables. Each row carries counts, an age and a state, never
 * job identities, owners, payloads or error text.
 *
 * - `waiting`: unfinished jobs nobody is working on right now.
 * - `running`: jobs a worker has claimed or is working on.
 * - `oldestSeconds`: how long the oldest unfinished job has been due, so a job
 *   held by a worker that died keeps ageing; `null` when nothing is due.
 * - `failed24h`: jobs whose last attempt in the last 24 hours failed; `null`
 *   when the queue does not record failures.
 */
export const adminHealthQueueIds = [
  "attachment_processing",
  "document_processing",
  "chat_titles",
  "scheduled_tasks",
  "memory",
  "mcp_activation",
  "workspace_cleanup",
  "knowledge_deletion",
  "file_deletion"
] as const;
export type AdminHealthQueueId = (typeof adminHealthQueueIds)[number];

export const adminHealthQueueStates = ["ok", "slow", "stalled", "unavailable"] as const;
export type AdminHealthQueueState = (typeof adminHealthQueueStates)[number];

/** Plain-English names and what each queue does, shared by the card and attention copy. */
export const adminHealthQueueCopy: Readonly<Record<AdminHealthQueueId, Readonly<{ label: string; purpose: string }>>> = {
  attachment_processing: { label: "Chat file processing", purpose: "Reads files attached in chats so answers can use them" },
  document_processing: { label: "Knowledge document processing", purpose: "Prepares Knowledge documents for search" },
  chat_titles: { label: "Chat titles", purpose: "Names new chats after their first answer" },
  scheduled_tasks: { label: "Scheduled tasks", purpose: "Starts scheduled task runs when they are due" },
  memory: { label: "Memory learning and indexing", purpose: "Learns facts and indexes chat history, as on the Memory card" },
  mcp_activation: { label: "MCP server checks", purpose: "Checks installation MCP server settings before they go live" },
  workspace_cleanup: { label: "Workspace cleanup", purpose: "Removes sandboxes of deleted or expired Workspaces" },
  knowledge_deletion: { label: "Knowledge deletion", purpose: "Purges deleted Knowledge documents and bases" },
  file_deletion: { label: "Stored file deletion", purpose: "Deletes stored files nothing references any more" }
};

export type AdminHealthQueueRow = {
  queue: AdminHealthQueueId;
  state: AdminHealthQueueState;
  waiting: number | null;
  running: number | null;
  oldestSeconds: number | null;
  failed24h: number | null;
  /** The age at which the queue counts as slow and as stalled. */
  slowAfterSeconds: number;
  stalledAfterSeconds: number;
};

export type AdminHealthQueues = {
  checkedAt: string;
  queues: AdminHealthQueueRow[];
};

export type AdminHealthQueuesResponse = { queues: AdminHealthQueues };

export type AdminHealthQueuesErrorResponse = ErrorResponse<"admin_health_failed" | "forbidden" | "unauthorized">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableCount(value: unknown): value is number | null {
  return value === null || count(value);
}

function decodeRow(value: unknown): AdminHealthQueueRow | null {
  if (!isRecord(value) || typeof value.queue !== "string" ||
    !(adminHealthQueueIds as readonly string[]).includes(value.queue) ||
    typeof value.state !== "string" || !(adminHealthQueueStates as readonly string[]).includes(value.state) ||
    !nullableCount(value.waiting) || !nullableCount(value.running) || !nullableCount(value.oldestSeconds) ||
    !nullableCount(value.failed24h) || !count(value.slowAfterSeconds) || !count(value.stalledAfterSeconds)) return null;
  return {
    queue: value.queue as AdminHealthQueueId,
    state: value.state as AdminHealthQueueState,
    waiting: value.waiting,
    running: value.running,
    oldestSeconds: value.oldestSeconds,
    failed24h: value.failed24h,
    slowAfterSeconds: value.slowAfterSeconds,
    stalledAfterSeconds: value.stalledAfterSeconds
  };
}

/** Browser decoding: a malformed response fails visibly instead of becoming guessed state. */
export function decodeAdminHealthQueuesResponse(value: unknown): AdminHealthQueuesResponse | null {
  if (!isRecord(value) || !isRecord(value.queues)) return null;
  const { checkedAt, queues } = value.queues;
  if (typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt)) ||
    !Array.isArray(queues) || queues.length > adminHealthQueueIds.length) return null;
  const rows = queues.map(decodeRow);
  if (rows.some((row) => row === null)) return null;
  if (new Set(rows.map((row) => row!.queue)).size !== rows.length) return null;
  return { queues: { checkedAt, queues: rows as AdminHealthQueueRow[] } };
}
