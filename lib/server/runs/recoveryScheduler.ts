const DEFAULT_RECOVERY_INTERVAL_MS = 10_000;

export class RunRecoveryScheduler {
  readonly #intervalMs: number;
  readonly #reconcile: () => Promise<void>;
  #pending = false;
  #runPromise: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: Readonly<{
    intervalMs?: number;
    reconcile(): Promise<void>;
  }>) {
    this.#intervalMs = input.intervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.#reconcile = input.reconcile;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.kick(), this.#intervalMs);
    this.#timer.unref?.();
    this.kick();
  }

  kick(): void {
    this.#pending = true;
    if (this.#runPromise) return;
    this.#runPromise = Promise.resolve()
      .then(async () => {
        while (this.#pending) {
          this.#pending = false;
          await this.#reconcile();
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
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#runPromise?.catch(() => undefined);
  }
}
