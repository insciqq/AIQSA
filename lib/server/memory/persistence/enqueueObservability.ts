import { logEvent } from "../../observability";

// Only an owner that awaits the outer transaction may publish these receipts.
// Enqueue helpers also run inside foreign transactions, where no observer exists.
const pendingEnqueues = new WeakMap<object, Set<string>>();

export function observeMemoryEnqueues(transaction: object): () => void {
  const jobs = new Set<string>();
  pendingEnqueues.set(transaction, jobs);
  return () => {
    pendingEnqueues.delete(transaction);
    for (const job_id of jobs) logEvent("job_enqueued", { subsystem: "memory", job_id });
    jobs.clear();
  };
}

export function rememberMemoryEnqueue(transaction: object, jobId: string): void {
  pendingEnqueues.get(transaction)?.add(jobId);
}
