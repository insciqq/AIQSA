import { logEvent } from "../observability";
import { sleepWithSignal } from "../providers/providerRetry";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { NO_ENGINE_TEST_FAULTS, type EngineTestFaults } from "./faults";
import type { NativeRunScope, NativeRunStore } from "./runStore";

/**
 * The usage of one native run: one record per physical paid call (every model
 * request, retries included, and every Search engine call), with the
 * provider's own figures and cost, never estimated from text. Records are
 * written after the answer and retried; a write that keeps failing is
 * logged and never fails the run or hides its answer.
 */
export const USAGE_WRITE_RETRY = Object.freeze({ attempts: 3, baseDelayMs: 1_000 });

export type UsageLedger = Readonly<{
  add(attribution: RunUsageAttribution): void;
  readonly attributions: readonly RunUsageAttribution[];
  /** Writes every record not yet written and the run's totals; never throws. */
  settle(): Promise<boolean>;
}>;

export function createUsageLedger(input: Readonly<{
  faults?: EngineTestFaults;
  /** Prices calls whose provider reported no cost from the model's prices. */
  price(attributions: readonly RunUsageAttribution[]): Promise<RunUsageAttribution[]>;
  scope: NativeRunScope;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  store: Pick<NativeRunStore, "applyUsageTotals" | "writeUsageRows">;
}>): UsageLedger {
  const faults = input.faults ?? NO_ENGINE_TEST_FAULTS;
  const entries: RunUsageAttribution[] = [];
  let priced: RunUsageAttribution[] | null = null;

  async function write(): Promise<void> {
    if (faults.take("usage_write_fail")) throw new Error("synthetic_usage_write_failure");
    if (!priced || priced.length !== entries.length) priced = await input.price(entries);
    await input.store.writeUsageRows(input.scope, priced.map((attribution, index) => ({ attribution, key: String(index) })));
    await input.store.applyUsageTotals(input.scope, priced);
  }

  return {
    add(attribution) {
      entries.push(attribution);
    },
    get attributions() {
      return entries;
    },
    async settle() {
      if (entries.length === 0) return true;
      for (let attempt = 1; attempt <= USAGE_WRITE_RETRY.attempts; attempt += 1) {
        try {
          await write();
          return true;
        } catch (error) {
          logEvent("service_operation", { action: attempt < USAGE_WRITE_RETRY.attempts ? "retry" : "degrade", attempt,
            code: "run_usage_unrecorded", error, outcome: attempt < USAGE_WRITE_RETRY.attempts ? "failed" : "degraded",
            run_id: input.scope.runId, stage: "write", subsystem: "database" });
          if (attempt < USAGE_WRITE_RETRY.attempts) {
            await (input.sleep ?? sleepWithSignal)(USAGE_WRITE_RETRY.baseDelayMs * 2 ** (attempt - 1), new AbortController().signal);
          }
        }
      }
      return false;
    }
  };
}
