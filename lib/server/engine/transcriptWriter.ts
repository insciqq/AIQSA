import { logEvent } from "../observability";
import type { TranscriptItem } from "./transcript";

/**
 * The durable record of one run's transcript, written in order behind the
 * run (answer first). Each write is tried again a few times; a write the
 * turn cannot do without (a response's tool calls, before any of them is
 * sent) rejects once its last attempt failed, every other write is
 * bookkeeping that only logs. Sequences are taken when a write is queued, so
 * a record that could not be written leaves a gap, never a reordering.
 */
export const TRANSCRIPT_WRITE_RETRY = Object.freeze({ attempts: 3, baseDelayMs: 250 });

export type TranscriptWriter = Readonly<{
  /** Queues the items' record; it resolves once written and rejects when its last attempt failed. */
  record(items: readonly TranscriptItem[]): Promise<void>;
  /** Takes the next `count` sequences for items written elsewhere (a compaction recorded after its run), so no record takes them. */
  reserve(count: number): number;
  /** Waits for every queued record; never rejects. */
  flush(): Promise<void>;
}>;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs).unref?.();
  });
}

export function createTranscriptWriter(input: Readonly<{
  /** Writes the items from this sequence on; a repeat of a write that committed must succeed. */
  append(from: number, items: readonly TranscriptItem[]): Promise<void>;
  firstSequence: number;
  runId: string;
  sleep?(delayMs: number): Promise<void>;
}>): TranscriptWriter {
  const sleep = input.sleep ?? wait;
  let sequence = input.firstSequence;
  let queue: Promise<unknown> = Promise.resolve();

  async function write(from: number, items: readonly TranscriptItem[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await input.append(from, items);
        return;
      } catch (error) {
        logEvent("service_operation", { action: attempt < TRANSCRIPT_WRITE_RETRY.attempts ? "retry" : "degrade", attempt,
          code: "transcript_record_unsaved", error, outcome: attempt < TRANSCRIPT_WRITE_RETRY.attempts ? "failed" : "degraded",
          run_id: input.runId, stage: "write", subsystem: "database" });
        if (attempt >= TRANSCRIPT_WRITE_RETRY.attempts) throw error;
        await sleep(TRANSCRIPT_WRITE_RETRY.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  return {
    record(items) {
      if (items.length === 0) return Promise.resolve();
      const from = sequence;
      sequence += items.length;
      const written = queue.then(() => write(from, items));
      queue = written.catch(() => undefined);
      return written;
    },
    reserve(count) {
      const from = sequence;
      sequence += count;
      return from;
    },
    async flush() {
      await queue;
    }
  };
}
