import { describe, expect, it, vi } from "vitest";
import { takeNativeRunInterruption } from "../engine/runInterruption";
import { activeRunControllers } from "./activeRunControllerRegistry";
import { interruptAttachedRuns } from "./attachedRunInterruption";

const interruptRuns = vi.fn((input: { runIds: readonly string[] }) => input.runIds.filter((runId) => runId.startsWith("background")));
vi.mock("./subagentBackground/default", () => ({ getDefaultSubagentBackground: () => ({ control: { interruptRuns } }) }));

describe("runs a forced VM stop ended under them", () => {
  it("end a background run through its control and a main-agent run through the engine, interrupted", async () => {
    const main = new AbortController();
    activeRunControllers.set("main-run", main);
    try {
      await interruptAttachedRuns({ chatId: "chat", runIds: ["background-run", "main-run", "elsewhere-run"], userId: "user" });
      expect(interruptRuns).toHaveBeenCalledWith({ chatId: "chat", runIds: ["background-run", "main-run", "elsewhere-run"], userId: "user" });
      expect(main.signal.aborted).toBe(true);
      // The engine ends it interrupted, never cancelled, and reads the mark once.
      expect(takeNativeRunInterruption("main-run")).toBe(true);
      expect(takeNativeRunInterruption("main-run")).toBe(false);
      expect(takeNativeRunInterruption("background-run")).toBe(false);
      expect(takeNativeRunInterruption("elsewhere-run")).toBe(false);
    } finally {
      activeRunControllers.delete("main-run");
    }
  });
});
