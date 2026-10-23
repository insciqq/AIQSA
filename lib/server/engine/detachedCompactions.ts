import type { TranscriptTarget } from "./transcript";

/**
 * Background compactions that outlive the run that started them. Answer
 * first: a run completes as soon as its answer and bookkeeping are done, so
 * a compaction still running then goes on detached, at most one per chat in
 * this process (`runContext.ts`). It stops at its own deadline, when its
 * chat or account is deleted (checked while it runs and before its item is
 * recorded), when a later compaction of the chat replaces it, or when the
 * process shuts down. When it finishes, the run that started it records its
 * item in its own transcript, where later runs read it. A run of the chat
 * that starts meanwhile joins it instead of compacting the same span again,
 * and so does one that read the transcript just before the item was on
 * record: a finished compaction stays listed a while, holding only its
 * result. The registry lives on `globalThis`, so the send and regenerate
 * route bundles share it, like the run controllers.
 */
export const DETACHED_COMPACTION = Object.freeze({
  /** A detached compaction stops this long after it started, whatever it is doing. */
  deadlineMs: 10 * 60_000,
  /** A finished compaction stays listed this long after its item was recorded. */
  keepMs: 5 * 60_000,
  /** How often a detached compaction checks that its chat still exists. */
  liveCheckMs: 15_000
});

/** Why a detached compaction stopped, for its log line (`failureCodes.json`). */
export type DetachedStopCode = "compaction_chat_gone" | "compaction_deadline" | "compaction_shutdown" | "compaction_superseded";

export type DetachedCompaction = Readonly<{
  chatId: string;
  /** The compaction itself, opaque here: only the runs that start and join it read it. */
  job: unknown;
  stop(code: DetachedStopCode): void;
  /** Only a run with the same route, model and replay rules joins it (`transcriptTargetKey`). */
  targetKey: string;
  userId: string;
}>;

export type DetachedCompactions = Readonly<{
  /** Takes a compaction that goes on after its run; one the chat already had stops. */
  add(entry: DetachedCompaction): void;
  /** The chat's detached compaction a run of the same user and target may join. */
  find(input: Readonly<{ chatId: string; targetKey: string; userId: string }>): DetachedCompaction | null;
  /**
   * The compaction finished and its item is recorded: it stays listed for
   * `DETACHED_COMPACTION.keepMs` with nothing left to stop, so nothing of
   * the run that started it stays referenced but the compaction itself.
   */
  finish(chatId: string, job: unknown): void;
  /** Forgets a compaction that stopped or failed. */
  remove(chatId: string, job: unknown): void;
  stopAll(code: DetachedStopCode): void;
}>;

export function transcriptTargetKey(target: TranscriptTarget): string {
  return JSON.stringify([target.provider, target.model, target.nativeCompaction === true, target.reasoningScope ?? "all"]);
}

export function createDetachedCompactions(options: Readonly<{ onFirstAdd?: (registry: DetachedCompactions) => void }> = {}):
  DetachedCompactions {
  const byChat = new Map<string, DetachedCompaction>();
  let added = false;
  const registry: DetachedCompactions = {
    add(entry) {
      const earlier = byChat.get(entry.chatId);
      byChat.set(entry.chatId, entry);
      if (earlier && earlier.job !== entry.job) earlier.stop("compaction_superseded");
      if (!added) {
        added = true;
        options.onFirstAdd?.(registry);
      }
    },
    find({ chatId, targetKey, userId }) {
      const entry = byChat.get(chatId);
      return entry && entry.userId === userId && entry.targetKey === targetKey ? entry : null;
    },
    finish(chatId, job) {
      const entry = byChat.get(chatId);
      if (!entry || entry.job !== job) return;
      byChat.set(chatId, { chatId, job, stop: () => undefined, targetKey: entry.targetKey, userId: entry.userId });
      const expiry = setTimeout(() => registry.remove(chatId, job), DETACHED_COMPACTION.keepMs);
      expiry.unref?.();
    },
    remove(chatId, job) {
      if (byChat.get(chatId)?.job === job) byChat.delete(chatId);
    },
    stopAll(code) {
      for (const entry of [...byChat.values()]) entry.stop(code);
      byChat.clear();
    }
  };
  return registry;
}

/** Stops detached compactions with the process, beside the handler that ends it: a lone listener would keep it alive. */
function stopOnShutdown(registry: DetachedCompactions): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (process.listenerCount(signal) > 0) process.once(signal, () => registry.stopAll("compaction_shutdown"));
  }
}

const globalForEngine = globalThis as unknown as { __aiqsaDetachedCompactions?: DetachedCompactions };
export const detachedCompactions: DetachedCompactions = globalForEngine.__aiqsaDetachedCompactions ??=
  createDetachedCompactions({ onFirstAdd: stopOnShutdown });
