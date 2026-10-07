import {
  adminHealthQueueIds,
  type AdminHealthQueueId,
  type AdminHealthQueueRow,
  type AdminHealthQueueState,
  type AdminHealthQueues
} from "../../../contracts/adminHealthQueues";
import { ADMIN_HEALTH_QUEUE_POLICIES, type AdminHealthQueuePolicy } from "./queueThresholds";
import type { AdminHealthQueueReading } from "./queuesRepository";

/** A stalled queue that raises its own "Needs attention" item. */
export type AdminHealthQueueFinding = Readonly<{
  queue: AdminHealthQueueId;
  waiting: number;
  running: number;
  oldestSeconds: number;
}>;

export type AdminHealthQueuesService = Readonly<{
  read(): Promise<AdminHealthQueues>;
  /** Only the queues no other alert watches; rejects when any of them could not be read. */
  stalled(): Promise<AdminHealthQueueFinding[]>;
}>;

type Policies = Readonly<Record<AdminHealthQueueId, AdminHealthQueuePolicy>>;

export function adminHealthQueueState(oldestSeconds: number | null, policy: AdminHealthQueuePolicy): Exclude<AdminHealthQueueState, "unavailable"> {
  if (oldestSeconds === null || oldestSeconds < policy.slowAfterSeconds) return "ok";
  return oldestSeconds < policy.stalledAfterSeconds ? "slow" : "stalled";
}

/** Pure projection of raw readings at `now`; a missing reading is unavailable, never a failed page. */
export function projectAdminHealthQueues(
  readings: readonly AdminHealthQueueReading[],
  now: Date,
  policies: Policies = ADMIN_HEALTH_QUEUE_POLICIES
): AdminHealthQueueRow[] {
  return readings.map(({ queue, counts }) => {
    const policy = policies[queue];
    const thresholds = { slowAfterSeconds: policy.slowAfterSeconds, stalledAfterSeconds: policy.stalledAfterSeconds };
    if (!counts) {
      return { queue, state: "unavailable", waiting: null, running: null, oldestSeconds: null, failed24h: null, ...thresholds };
    }
    // A job due in the future (a clock skew between writers) is not late.
    const oldestSeconds = counts.oldestDueAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - counts.oldestDueAt.getTime()) / 1_000));
    return {
      queue,
      state: adminHealthQueueState(oldestSeconds, policy),
      waiting: counts.waiting,
      running: counts.running,
      oldestSeconds,
      failed24h: counts.failed24h,
      ...thresholds
    };
  });
}

/** Stalled rows of the queues that raise their own "Needs attention" item. */
export function adminHealthQueueFindings(
  rows: readonly AdminHealthQueueRow[],
  policies: Policies = ADMIN_HEALTH_QUEUE_POLICIES
): AdminHealthQueueFinding[] {
  return rows.flatMap((row) => policies[row.queue].attention && row.state === "stalled" && row.oldestSeconds !== null
    ? [{ queue: row.queue, waiting: row.waiting ?? 0, running: row.running ?? 0, oldestSeconds: row.oldestSeconds }]
    : []);
}

export function createAdminHealthQueuesService(input: Readonly<{
  read(queues: readonly AdminHealthQueueId[], now: Date): Promise<AdminHealthQueueReading[]>;
  now?: () => Date;
  policies?: Policies;
}>): AdminHealthQueuesService {
  const clock = input.now ?? (() => new Date());
  const policies = input.policies ?? ADMIN_HEALTH_QUEUE_POLICIES;
  const watched = adminHealthQueueIds.filter((queue) => policies[queue].attention);
  return {
    async read() {
      const now = clock();
      return { checkedAt: now.toISOString(), queues: projectAdminHealthQueues(await input.read(adminHealthQueueIds, now), now, policies) };
    },
    async stalled() {
      const now = clock();
      const rows = projectAdminHealthQueues(await input.read(watched, now), now, policies);
      if (rows.some((row) => row.state === "unavailable")) throw new Error("admin_health_queues_unavailable");
      return adminHealthQueueFindings(rows, policies);
    }
  };
}
