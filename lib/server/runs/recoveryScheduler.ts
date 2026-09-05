const DEFAULT_RECOVERY_INTERVAL_MS = 10_000;

export class RunRecoveryScheduler {
  readonly #intervalMs: number;
  readonly #reconcile: (signal: AbortSignal) => Promise<void>;
  readonly #controller = new AbortController();
  readonly #exports: RunRecoveryScheduler | null;
  #stopped = false;
  #pending = false;
  #runPromise: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: Readonly<{
    intervalMs?: number;
    reconcile(signal: AbortSignal): Promise<void>;
    recoverWorkspaceExports?(signal: AbortSignal): Promise<void>;
  }>) {
    this.#intervalMs = input.intervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.#reconcile = input.reconcile;
    this.#exports = input.recoverWorkspaceExports
      ? new RunRecoveryScheduler({ reconcile: input.recoverWorkspaceExports }) : null;
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.kick(), this.#intervalMs);
    this.#timer.unref?.();
    this.kick();
  }

  kick(): void {
    if (this.#stopped) return;
    // One owned export worker progresses independently of run reconciliation.
    // It shares the timer, but never the in-flight promise or pending slot.
    this.#exports?.kick();
    this.#pending = true;
    if (this.#runPromise) return;
    this.#runPromise = Promise.resolve()
      .then(async () => {
        while (this.#pending && !this.#stopped) {
          this.#pending = false;
          await this.#reconcile(this.#controller.signal);
        }
      })
      .finally(() => {
        this.#runPromise = null;
        if (this.#pending) this.kick();
      });
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
    await Promise.all([this.#exports?.stop(), this.#runPromise?.catch(() => undefined)]);
  }
}
