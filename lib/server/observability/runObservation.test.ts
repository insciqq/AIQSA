import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { logEvent, MAX_OUTPUT_BYTES, MAX_RECORD_BYTES, runWithContext } from "./runtime.cjs";

describe("isolated run log capture", () => {
  it.each(["pending dropped record", "blocked writer"])("captures the exact run after a %s", async (state) => {
    await new Promise<void>((resolve) => { process.stdout.write("", () => resolve()); });
    const length = vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(state === "pending dropped record" ? MAX_OUTPUT_BYTES - MAX_RECORD_BYTES + 1 : 0);
    const drain = vi.spyOn(process.stdout, "writableNeedDrain", "get").mockReturnValue(false);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => false);
    try {
      logEvent("run_execution", { run_id: "earlier-run", stage: "execution", outcome: "started" });
      expect(write).toHaveBeenCalledTimes(state === "blocked writer" ? 1 : 0);
    } finally { write.mockRestore(); drain.mockRestore(); length.mockRestore(); }

    const original = process.stdout.write;
    const observation = await captureRunObservation();
    try {
      runWithContext({ trace_id: "1".repeat(32), run_id: "captured-run" }, () => {
        logEvent("run_execution", { run_id: "captured-run", stage: "execution", outcome: "completed" });
      });
      expect(observation.records()).toMatchObject([{ event: "run_execution", outcome: "completed",
        trace_id: "1".repeat(32), run_id: "captured-run" }]);
      expect(observation.records()).toHaveLength(1);
    } finally { observation.restore(); }
    expect(process.stdout.write).toBe(original);
  });

  it("excludes only unattributed process accounting without hiding missing run context", async () => {
    const observation = await captureRunObservation();
    try {
      logEvent("logging.dropped_records", { count: 1 });
      logEvent("run_execution", { run_id: "unscoped-run", stage: "execution", outcome: "started" });
      runWithContext({ trace_id: "2".repeat(32), run_id: "attributed-run" }, () => {
        logEvent("logging.dropped_records", { count: 1 });
      });
      const records = observation.records();
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ event: "run_execution" });
      expect(records[0]).not.toHaveProperty("trace_id");
      expect(records[1]).toMatchObject({ event: "logging.dropped_records", run_id: "attributed-run" });
    } finally { observation.restore(); }
  });
});
