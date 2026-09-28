import { onTestFinished, vi } from "vitest";

/** Capture run records after settling the process writer's earlier backpressure. */
export async function captureRunObservation() {
  await new Promise<void>((resolve) => { process.stdout.write("", () => resolve()); });
  // An empty write can finish without a drain when the logger dropped a record
  // before writing to stdout. Notify its existing listener before installing the spy.
  process.stdout.emit("drain");
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    writer.mockRestore();
  };
  onTestFinished(restore);
  return {
    records: (): Record<string, unknown>[] => writer.mock.calls.flatMap(([chunk]) => {
      try {
        const record: unknown = JSON.parse(String(chunk));
        if (!record || typeof record !== "object" || Array.isArray(record)) return [];
        const entry = record as Record<string, unknown>;
        // Process accounting is not a run event. Keep attributed records and
        // ordinary events with missing context so tracing regressions remain visible.
        return entry.event === "logging.dropped_records" && entry.trace_id === undefined && entry.run_id === undefined
          ? [] : [entry];
      } catch { return []; }
    }),
    restore
  };
}
