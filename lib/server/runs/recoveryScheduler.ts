import { logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, type Subsystem } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailureCode } from "../providers/providerObservability";

const DEFAULT_RECOVERY_INTERVAL_MS = 10_000;

export class RunRecoveryScheduler {
  readonly #intervalMs: number;
  readonly #reconcile: (signal: AbortSignal) => Promise<void>;
  readonly #controller = new AbortController();
  readonly #exports: RunRecoveryScheduler | null;
  readonly #titles: RunRecoveryScheduler | null;
  readonly #subsystem: Subsystem;
  #stopped = false;
  #pending = false;
  #runPromise: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: Readonly<{
    intervalMs?: number;
    reconcile(signal: AbortSignal): Promise<void>;
    recoverWorkspaceExports?(signal: AbortSignal): Promise<void>;
    recoverChatTitles?(signal: AbortSignal): Promise<void>;
    subsystem?: "run_recovery" | "workspace" | "chat_title";
  }>) {
    this.#intervalMs = input.intervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.#reconcile = input.reconcile;
    this.#subsystem = input.subsystem ?? "run_recovery";
    this.#exports = input.recoverWorkspaceExports
      ? new RunRecoveryScheduler({ reconcile: input.recoverWorkspaceExports, subsystem: "workspace" }) : null;
    this.#titles = input.recoverChatTitles
      ? new RunRecoveryScheduler({ reconcile: input.recoverChatTitles, subsystem: "chat_title" }) : null;
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = runInBackground(() => setInterval(() => this.kick(), this.#intervalMs));
    this.#timer.unref?.();
    this.kick();
  }

  kick(): void {
    if (this.#stopped) return;
    // One owned export worker progresses independently of run reconciliation.
    // It shares the timer, but never the in-flight promise or pending slot.
    this.#exports?.kick();
    this.#titles?.kick();
    this.#pending = true;
    if (this.#runPromise) return;
    this.#runPromise = runInBackground(() => Promise.resolve()
      .then(async () => {
        while (this.#pending && !this.#stopped) {
          this.#pending = false;
          try {
            await this.#reconcile(this.#controller.signal);
            reportSubsystemHealthy(this.#subsystem, "recovery");
          } catch (error) {
            if (this.#controller.signal.aborted) logEvent("runtime_lifecycle", {
              subsystem: this.#subsystem, stage: "recovery", outcome: "cancelled", action: "stop"
            });
            else reportSubsystemFailure({ subsystem: this.#subsystem, stage: "recovery",
              code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "retry" });
            throw error;
          }
        }
      })
      .finally(() => {
        this.#runPromise = null;
        if (this.#pending) this.kick();
      }));
    void this.#runPromise.catch(() => undefined);
  }

  async reconcileNow(): Promise<void> {
    this.kick();
    await this.#runPromise;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pending = false;
    this.#controller.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await Promise.all([this.#exports?.stop(), this.#titles?.stop(), this.#runPromise?.catch(() => undefined)]);
  }
}
