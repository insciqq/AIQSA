export function ingestionConcurrency(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError("knowledge_ingestion_concurrency_invalid");
  }
  return value;
}

/** Stop admitting on failure, but let started work finish its durable settlement
 * before the caller releases the claim or schedules recovery. */
export async function mapIngestionWork<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  ingestionConcurrency(concurrency, 1, 64);
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let stopped = false;
  let firstError: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = await worker(values[index]!, index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
      }
    }
  }));
  if (stopped) throw firstError;
  return Object.freeze(results);
}

/** A parser/processor instance shares its capacity across concurrent documents.
 * Acquire before preparing images or reading reusable vectors, not just HTTP. */
export class IngestionWorkPool {
  readonly #maximum: number;
  #active = 0;
  readonly #waiting = new Set<() => void>();

  constructor(maximum: number) {
    this.#maximum = ingestionConcurrency(maximum, 1, 64);
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const aborted = () => signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    if (signal?.aborted) throw aborted();
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        this.#waiting.delete(grant);
        signal?.removeEventListener("abort", cancel);
        this.#active++;
        resolve();
      };
      const cancel = () => {
        if (!this.#waiting.delete(grant)) return;
        signal?.removeEventListener("abort", cancel);
        reject(aborted());
      };
      if (this.#active < this.#maximum) grant();
      else {
        this.#waiting.add(grant);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      }
    });
    try {
      if (signal?.aborted) throw aborted();
      return await operation();
    } finally {
      this.#active--;
      this.#waiting.values().next().value?.();
    }
  }
}
