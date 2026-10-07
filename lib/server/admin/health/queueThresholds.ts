import type { AdminHealthQueueId } from "../../../contracts/adminHealthQueues";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export type AdminHealthQueuePolicy = Readonly<{
  /** The oldest due job at or above this age makes the queue slow... */
  slowAfterSeconds: number;
  /** ...and at or above this age stalled. */
  stalledAfterSeconds: number;
  /**
   * Whether a stalled queue raises its own "Needs attention" item. Queues that
   * another alert already watches stay quiet here: Knowledge processing and
   * deletion and stored file deletion (Knowledge operations), Memory (its
   * worker and processing alerts) and MCP server checks (the server's own
   * item, and an administrator who just started the check is watching it).
   */
  attention: boolean;
}>;

/**
 * Per-queue age thresholds: every value lives here so calibration touches one
 * place. Ages count from when a job became due, so healthy queues stay far
 * below them; the reasons note what a healthy queue looks like.
 */
export const ADMIN_HEALTH_QUEUE_POLICIES: Readonly<Record<AdminHealthQueueId, AdminHealthQueuePolicy>> = Object.freeze({
  // Claimed within seconds; three short attempts settle a file within minutes.
  attachment_processing: { slowAfterSeconds: 10 * MINUTE, stalledAfterSeconds: 30 * MINUTE, attention: true },
  // The Knowledge operations card's "ingestion queue stalled" warning and critical ages.
  document_processing: { slowAfterSeconds: 15 * MINUTE, stalledAfterSeconds: HOUR, attention: false },
  // A pending title expires after five minutes; an older one means the title worker is not running.
  chat_titles: { slowAfterSeconds: 10 * MINUTE, stalledAfterSeconds: 30 * MINUTE, attention: true },
  // Due runs start within a minute; per-user run limits may hold a few back for a while.
  scheduled_tasks: { slowAfterSeconds: 30 * MINUTE, stalledAfterSeconds: 2 * HOUR, attention: true },
  // The Memory card treats work without progress for 15 minutes as stalled.
  memory: { slowAfterSeconds: 15 * MINUTE, stalledAfterSeconds: HOUR, attention: false },
  mcp_activation: { slowAfterSeconds: 10 * MINUTE, stalledAfterSeconds: 30 * MINUTE, attention: false },
  // Cleanup retries with backoff; hours of failing cleanup leave sandboxes running.
  workspace_cleanup: { slowAfterSeconds: 30 * MINUTE, stalledAfterSeconds: 2 * HOUR, attention: true },
  knowledge_deletion: { slowAfterSeconds: HOUR, stalledAfterSeconds: 24 * HOUR, attention: false },
  // The Knowledge operations card's "object deletion stalled" warning and critical ages.
  file_deletion: { slowAfterSeconds: HOUR, stalledAfterSeconds: 24 * HOUR, attention: false }
});

/** Each queue read is bounded so one slow table cannot hold the Health page. */
export const ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS = 2_000;

/** The failure window of `failed24h`. */
export const ADMIN_HEALTH_QUEUE_FAILURE_WINDOW_MS = 24 * HOUR * 1_000;
