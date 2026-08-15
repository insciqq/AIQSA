import type { MemoryJobKind } from "@prisma/client";
import type { MemoryCoordinatorPolicy } from "./policy";

export const MEMORY_SAFETY_JOB_KINDS = Object.freeze([
  "RECONCILE_BRANCH",
  "RECONCILE_SOURCE"
] satisfies readonly MemoryJobKind[]);

type MemorySchedulerTier = "SAFETY" | "STANDARD";

type OwnerWaiter = {
  resolve: (release: () => void) => void;
};

const PRIORITY_CYCLE = Object.freeze([
  "SAFETY",
  "SAFETY",
  "STANDARD"
] satisfies readonly MemorySchedulerTier[]);
const ALL_TIERS = Object.freeze([
  "SAFETY",
  "STANDARD"
] satisfies readonly MemorySchedulerTier[]);
const safetyKinds = new Set<MemoryJobKind>(MEMORY_SAFETY_JOB_KINDS);

function tier(kind: MemoryJobKind): MemorySchedulerTier {
  return safetyKinds.has(kind) ? "SAFETY" : "STANDARD";
}

export class MemoryScheduler {
  readonly #activeOwners = new Map<string, number>();
  readonly #policy: MemoryCoordinatorPolicy;
  readonly #waiters = new Map<string, OwnerWaiter[]>();
  #priorityOrdinal = 0;

  constructor(input: Readonly<{ policy: MemoryCoordinatorPolicy }>) {
    this.#policy = input.policy;
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
