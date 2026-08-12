import { Prisma, type MemoryJobKind, type PrismaClient } from "@prisma/client";
import type { MemoryCoordinatorPolicy } from "./policy";
import type { MemoryJobClaim } from "./types";

export const MEMORY_BACKGROUND_JOB_KINDS = Object.freeze([
  "GLOBAL_DREAM",
  "RECALCULATE_WORKING_SET"
] satisfies readonly MemoryJobKind[]);

export const MEMORY_SAFETY_JOB_KINDS = Object.freeze([
  "RECONCILE_BRANCH",
  "RECONCILE_SOURCE"
] satisfies readonly MemoryJobKind[]);

type MemorySchedulerTier = "BACKGROUND" | "SAFETY" | "STANDARD";

export type MemorySchedulerUsage = Readonly<{
  calls: number;
  costMicros: number;
}>;

export type MemorySchedulerDailyUsage = Readonly<{
  installation: MemorySchedulerUsage;
  users: ReadonlyMap<string, MemorySchedulerUsage>;
}>;

export type MemorySchedulerUsageSource = Readonly<{
  readDailyBackgroundUsage(input: Readonly<{
    windowEnd: Date;
    windowStart: Date;
  }>): Promise<MemorySchedulerDailyUsage>;
}>;

export type MemorySchedulerDecision =
  | Readonly<{ status: "RUN" }>
  | Readonly<{
      errorCode:
        | "memory_scheduler_budget_deferred"
        | "memory_scheduler_budget_unavailable";
      nextAttemptAt: Date;
      status: "DEFER";
    }>;

export type MemorySchedulerBudgetStatus = Readonly<{
  backgroundKinds: readonly MemoryJobKind[];
  installation: MemorySchedulerUsage & Readonly<{ deferred: boolean }>;
  limits: Readonly<{
    installationCalls: number;
    installationCostMicros: number;
    userCalls: number;
    userCostMicros: number;
  }>;
  resetAt: string;
  status: "ready" | "unavailable";
  user: (MemorySchedulerUsage & Readonly<{ deferred: boolean }>) | null;
  windowStart: string;
}>;

type MutableUsage = {
  calls: number;
  costMicros: number;
};

type CachedUsage = {
  installation: MutableUsage;
  loadedAt: number;
  status: "ready" | "unavailable";
  users: Map<string, MutableUsage>;
  windowEnd: Date;
  windowStart: Date;
};

type LoadingUsage = Readonly<{
  promise: Promise<CachedUsage>;
  windowStart: number;
}>;

type OwnerWaiter = {
  resolve: (release: () => void) => void;
};

const PRIORITY_CYCLE = Object.freeze([
  "SAFETY",
  "SAFETY",
  "STANDARD",
  "BACKGROUND"
] satisfies readonly MemorySchedulerTier[]);
const ALL_TIERS = Object.freeze([
  "SAFETY",
  "STANDARD",
  "BACKGROUND"
] satisfies readonly MemorySchedulerTier[]);
const backgroundKinds = new Set<MemoryJobKind>(MEMORY_BACKGROUND_JOB_KINDS);
const safetyKinds = new Set<MemoryJobKind>(MEMORY_SAFETY_JOB_KINDS);

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function utcDayWindow(now: Date): Readonly<{ end: Date; start: Date }> {
  if (!validDate(now)) throw new Error("memory_scheduler_clock_invalid");
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  if (!validDate(end)) throw new Error("memory_scheduler_clock_invalid");
  return { end, start };
}

function asSafeCount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("memory_scheduler_usage_invalid");
  }
  return Number(value);
}

function deferred(
  usage: MemorySchedulerUsage,
  callLimit: number,
  costLimit: number
): boolean {
  return usage.calls >= callLimit || usage.costMicros >= costLimit;
}

function validUsage(value: MemorySchedulerUsage): boolean {
  return Number.isSafeInteger(value.calls) && value.calls >= 0 &&
    Number.isSafeInteger(value.costMicros) && value.costMicros >= 0;
}

function tier(kind: MemoryJobKind): MemorySchedulerTier {
  if (backgroundKinds.has(kind)) return "BACKGROUND";
  if (safetyKinds.has(kind)) return "SAFETY";
  return "STANDARD";
}

export function createPrismaMemorySchedulerUsageSource(
  client: PrismaClient
): MemorySchedulerUsageSource {
  return Object.freeze({
    async readDailyBackgroundUsage(input) {
      if (!validDate(input.windowStart) || !validDate(input.windowEnd)) {
        throw new Error("memory_scheduler_clock_invalid");
      }
      if (input.windowEnd.getTime() <= input.windowStart.getTime()) {
        throw new Error("memory_scheduler_clock_invalid");
      }
      const rows = await client.$queryRaw<Array<{
        calls: bigint;
        costMicros: bigint;
        userId: string;
      }>>(Prisma.sql`
        SELECT
          binding."userId",
          COUNT(*)::bigint AS "calls",
          COALESCE(SUM(binding."estimatedCostMicros"), 0)::bigint AS "costMicros"
        FROM "MemoryExecutionBinding" AS binding
        INNER JOIN "MemoryJob" AS job
          ON job."userId" = binding."userId"
          AND job."id" = binding."memoryJobId"
        WHERE binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
          AND binding."createdAt" >= ${input.windowStart}
          AND binding."createdAt" < ${input.windowEnd}
          AND job."kind" IN (
            'GLOBAL_DREAM'::"MemoryJobKind",
            'RECALCULATE_WORKING_SET'::"MemoryJobKind"
          )
        GROUP BY binding."userId"
        ORDER BY binding."userId"
      `);
      const users = new Map<string, MemorySchedulerUsage>();
      let calls = 0;
      let costMicros = 0;
      for (const row of rows) {
        const usage = Object.freeze({
          calls: asSafeCount(row.calls),
          costMicros: asSafeCount(row.costMicros)
        });
        users.set(row.userId, usage);
        calls += usage.calls;
        costMicros += usage.costMicros;
        if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(costMicros)) {
          throw new Error("memory_scheduler_usage_invalid");
        }
      }
      return Object.freeze({
        installation: Object.freeze({ calls, costMicros }),
        users
      });
    }
  });
}

export function createEmptyMemorySchedulerUsageSource(): MemorySchedulerUsageSource {
  return Object.freeze({
    async readDailyBackgroundUsage() {
      return Object.freeze({
        installation: Object.freeze({ calls: 0, costMicros: 0 }),
        users: new Map<string, MemorySchedulerUsage>()
      });
    }
  });
}

export class MemoryScheduler {
  readonly #activeOwners = new Map<string, number>();
  readonly #policy: MemoryCoordinatorPolicy;
  readonly #usageSource: MemorySchedulerUsageSource;
  readonly #waiters = new Map<string, OwnerWaiter[]>();
  #cache: CachedUsage | null = null;
  #loading: LoadingUsage | null = null;
  #priorityOrdinal = 0;

  constructor(input: Readonly<{
    policy: MemoryCoordinatorPolicy;
    usageSource: MemorySchedulerUsageSource;
  }>) {
    this.#policy = input.policy;
    this.#usageSource = input.usageSource;
  }

  claimWaves(kinds: readonly MemoryJobKind[]): readonly (readonly MemoryJobKind[])[] {
    const uniqueKinds = [...new Set(kinds)];
    if (uniqueKinds.length === 0) return Object.freeze([]);
    const preferred = PRIORITY_CYCLE[
      this.#priorityOrdinal % PRIORITY_CYCLE.length
    ]!;
    this.#priorityOrdinal += 1;
    const order = [preferred, ...ALL_TIERS.filter((value) => value !== preferred)];
    return Object.freeze(order
      .map((value) => Object.freeze(uniqueKinds.filter((kind) => tier(kind) === value)))
      .filter((wave) => wave.length > 0));
  }

  async decide(claim: MemoryJobClaim, now: Date): Promise<MemorySchedulerDecision> {
    if (!backgroundKinds.has(claim.kind)) return Object.freeze({ status: "RUN" });
    const snapshot = await this.#usage(now);
    if (snapshot.status === "unavailable") {
      return Object.freeze({
        errorCode: "memory_scheduler_budget_unavailable",
        nextAttemptAt: new Date(Math.min(
          snapshot.windowEnd.getTime(),
          now.getTime() + this.#policy.backgroundBudgetRefreshMs
        )),
        status: "DEFER"
      });
    }
    const user = snapshot.users.get(claim.userId) ?? { calls: 0, costMicros: 0 };
    if (
      deferred(
        snapshot.installation,
        this.#policy.backgroundInstallDailyCallLimit,
        this.#policy.backgroundInstallDailyCostMicrosLimit
      ) ||
      deferred(
        user,
        this.#policy.backgroundUserDailyCallLimit,
        this.#policy.backgroundUserDailyCostMicrosLimit
      )
    ) {
      return Object.freeze({
        errorCode: "memory_scheduler_budget_deferred",
        nextAttemptAt: new Date(snapshot.windowEnd),
        status: "DEFER"
      });
    }
    snapshot.installation.calls += 1;
    const reserved = snapshot.users.get(claim.userId) ?? { calls: 0, costMicros: 0 };
    reserved.calls += 1;
    snapshot.users.set(claim.userId, reserved);
    return Object.freeze({ status: "RUN" });
  }

  async status(
    now: Date,
    userId?: string
  ): Promise<MemorySchedulerBudgetStatus> {
    const snapshot = await this.#usage(now);
    const installation = { ...snapshot.installation };
    const user = userId === undefined
      ? null
      : { ...(snapshot.users.get(userId) ?? { calls: 0, costMicros: 0 }) };
    return Object.freeze({
      backgroundKinds: MEMORY_BACKGROUND_JOB_KINDS,
      installation: Object.freeze({
        ...installation,
        deferred: snapshot.status === "unavailable" || deferred(
          installation,
          this.#policy.backgroundInstallDailyCallLimit,
          this.#policy.backgroundInstallDailyCostMicrosLimit
        )
      }),
      limits: Object.freeze({
        installationCalls: this.#policy.backgroundInstallDailyCallLimit,
        installationCostMicros:
          this.#policy.backgroundInstallDailyCostMicrosLimit,
        userCalls: this.#policy.backgroundUserDailyCallLimit,
        userCostMicros: this.#policy.backgroundUserDailyCostMicrosLimit
      }),
      resetAt: snapshot.windowEnd.toISOString(),
      status: snapshot.status,
      user: user === null
        ? null
        : Object.freeze({
            ...user,
            deferred: snapshot.status === "unavailable" || deferred(
              user,
              this.#policy.backgroundUserDailyCallLimit,
              this.#policy.backgroundUserDailyCostMicrosLimit
            )
          }),
      windowStart: snapshot.windowStart.toISOString()
    });
  }

  acquireOwner(userId: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const active = this.#activeOwners.get(userId) ?? 0;
    if (active < this.#policy.maxJobParallelPerUser) {
      this.#activeOwners.set(userId, active + 1);
      return Promise.resolve(this.#release(userId));
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: OwnerWaiter;
      const abort = () => {
        const queue = this.#waiters.get(userId);
        if (queue) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) this.#waiters.delete(userId);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      waiter = {
        resolve: (release) => {
          signal.removeEventListener("abort", abort);
          resolve(release);
        }
      };
      const queue = this.#waiters.get(userId) ?? [];
      queue.push(waiter);
      this.#waiters.set(userId, queue);
    });
  }

  async #usage(now: Date): Promise<CachedUsage> {
    const window = utcDayWindow(now);
    const cacheAge = this.#cache
      ? now.getTime() - this.#cache.loadedAt
      : -1;
    if (
      this.#cache &&
      this.#cache.windowStart.getTime() === window.start.getTime() &&
      cacheAge >= 0 &&
      cacheAge < this.#policy.backgroundBudgetRefreshMs
    ) {
      return this.#cache;
    }
    if (this.#loading) {
      const loading = this.#loading;
      if (loading.windowStart === window.start.getTime()) {
        return loading.promise;
      }
      await loading.promise;
      if (this.#loading === loading) this.#loading = null;
      return this.#usage(now);
    }
    const loading: LoadingUsage = Object.freeze({
      promise: this.#load(now, window.start, window.end),
      windowStart: window.start.getTime()
    });
    this.#loading = loading;
    try {
      return await loading.promise;
    } finally {
      if (this.#loading === loading) this.#loading = null;
    }
  }

  async #load(now: Date, windowStart: Date, windowEnd: Date): Promise<CachedUsage> {
    try {
      const usage = await this.#usageSource.readDailyBackgroundUsage({
        windowEnd,
        windowStart
      });
      if (!validUsage(usage.installation)) {
        throw new Error("memory_scheduler_usage_invalid");
      }
      let calls = 0;
      let costMicros = 0;
      for (const [userId, value] of usage.users) {
        if (!userId || !validUsage(value)) {
          throw new Error("memory_scheduler_usage_invalid");
        }
        calls += value.calls;
        costMicros += value.costMicros;
        if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(costMicros)) {
          throw new Error("memory_scheduler_usage_invalid");
        }
      }
      if (
        calls !== usage.installation.calls ||
        costMicros !== usage.installation.costMicros
      ) {
        throw new Error("memory_scheduler_usage_invalid");
      }
      const snapshot: CachedUsage = {
        installation: { ...usage.installation },
        loadedAt: now.getTime(),
        status: "ready",
        users: new Map([...usage.users].map(([userId, value]) => [
          userId,
          { ...value }
        ])),
        windowEnd,
        windowStart
      };
      this.#cache = snapshot;
      return snapshot;
    } catch {
      const snapshot: CachedUsage = {
        installation: { calls: 0, costMicros: 0 },
        loadedAt: now.getTime(),
        status: "unavailable",
        users: new Map(),
        windowEnd,
        windowStart
      };
      this.#cache = snapshot;
      return snapshot;
    }
  }

  #release(userId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = this.#activeOwners.get(userId) ?? 0;
      if (active <= 1) this.#activeOwners.delete(userId);
      else this.#activeOwners.set(userId, active - 1);
      const queue = this.#waiters.get(userId);
      const next = queue?.shift();
      if (!next) {
        if (queue?.length === 0) this.#waiters.delete(userId);
        return;
      }
      if (queue!.length === 0) this.#waiters.delete(userId);
      const nextActive = this.#activeOwners.get(userId) ?? 0;
      this.#activeOwners.set(userId, nextActive + 1);
      next.resolve(this.#release(userId));
    };
  }
}
