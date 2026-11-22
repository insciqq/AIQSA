/**
 * The background worker's unit of work: a named periodic pass. A pass finds its own due items from durable
 * state, claims each through `workItems.ts` (or its own store) and settles it; the loop only schedules passes,
 * isolates their failures and drains them at shutdown (`worker.ts`).
 */
export type BackgroundPassContext = Readonly<{
  now: () => Date;
  /** Aborted at shutdown: a pass stops claiming and releases what it holds. */
  signal: AbortSignal;
}>;

export type BackgroundPassOutcome = Readonly<{
  /** The pass left due work behind (a bounded batch was full): run it again soon instead of after its interval. */
  more?: boolean;
}>;

export type BackgroundPass = Readonly<{
  /** Content-free and stable, `^[a-z][a-z0-9_]{0,63}$`: it names the pass in logs. */
  name: string;
  /** The pause between two runs of the pass; a failed run waits longer (backoff). */
  intervalMs: number;
  run(context: BackgroundPassContext): Promise<BackgroundPassOutcome | void>;
}>;

const PASS_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function assertBackgroundPass(pass: BackgroundPass): BackgroundPass {
  if (
    !PASS_NAME.test(pass.name) ||
    !Number.isSafeInteger(pass.intervalMs) ||
    pass.intervalMs < MIN_INTERVAL_MS ||
    pass.intervalMs > MAX_INTERVAL_MS ||
    typeof pass.run !== "function"
  ) {
    throw new Error("background_pass_invalid");
  }
  return pass;
}

/**
 * The passes the worker process starts. Register before the worker starts (`scripts/background-worker.ts`):
 * the deletion duties register themselves through `registerDefaultBackgroundPasses`, and a later duty (the
 * past-chat index) adds its pass here without touching the loop.
 */
export class BackgroundPassRegistry {
  readonly #passes = new Map<string, BackgroundPass>();

  register(pass: BackgroundPass): () => void {
    assertBackgroundPass(pass);
    const existing = this.#passes.get(pass.name);
    if (existing && existing !== pass) throw new Error("background_pass_conflict");
    this.#passes.set(pass.name, pass);
    return () => {
      if (this.#passes.get(pass.name) === pass) this.#passes.delete(pass.name);
    };
  }

  list(): readonly BackgroundPass[] {
    return Object.freeze([...this.#passes.values()]);
  }
}

type BackgroundRegistryGlobal = typeof globalThis & {
  __aiqsaBackgroundPassRegistry?: BackgroundPassRegistry;
};

export const defaultBackgroundPassRegistry: BackgroundPassRegistry = (() => {
  const scope = globalThis as BackgroundRegistryGlobal;
  scope.__aiqsaBackgroundPassRegistry ??= new BackgroundPassRegistry();
  return scope.__aiqsaBackgroundPassRegistry;
})();

/** Adds a pass to the worker process's default registry; returns its unregistration. */
export function registerBackgroundPass(pass: BackgroundPass): () => void {
  return defaultBackgroundPassRegistry.register(pass);
}
