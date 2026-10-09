// @vitest-environment node
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureTransaction } from "../observability/transactionTiming";
import { logRunPersistence, settleRunWrite } from "./runObservability";

type RawTx = { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** A terminal write whose run, user and chat locks wait `lockMs`, then fail with `failure` when given. */
function terminalWrite(lockMs: number, holdMs: number, failure?: unknown) {
  return () => measureTransaction({ subsystem: "runs", operation: "run_complete" }, async (tx: RawTx) => {
    await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${"PRIVATE_CHAT"} FOR UPDATE`;
    await sleep(holdMs);
    return true;
  }, async (body) => body({ $queryRaw: async () => {
    await sleep(lockMs);
    if (failure) throw failure;
    return [];
  } }));
}

function persistence(): Record<string, unknown>[] {
  return output.map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
    .filter((record) => record.event === "run_persistence");
}

let output: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("run terminal write timing", () => {
  it("records how long a confirmed terminal write took and waited for its locks", async () => {
    const pending = settleRunWrite(terminalWrite(1_200, 300));
    await vi.advanceTimersByTimeAsync(1_500);
    const { value, timing } = await pending;
    expect(value).toBe(true);
    logRunPersistence("run_1", "complete", "confirmed", undefined, timing);
    expect(persistence()).toEqual([expect.objectContaining({ level: "info", run_id: "run_1", stage: "complete",
      outcome: "confirmed", duration_ms: 1_500, lock_wait_ms: 1_200 })]);
  });

  it("records a failed terminal write's lock wait from its error", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("PRIVATE", { clientVersion: "test", code: "P2028" });
    const pending = settleRunWrite(terminalWrite(5_010, 0, failure)).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_010);
    const error = await pending;
    expect(error).toBe(failure);
    logRunPersistence("run_1", "complete", "unconfirmed", error);
    expect(persistence()).toEqual([expect.objectContaining({ level: "error", outcome: "unconfirmed", prisma_code: "P2028",
      duration_ms: 5_010, lock_wait_ms: 5_010 })]);
    expect(JSON.stringify(persistence())).not.toContain("PRIVATE");
  });

  it("records nothing more for a write that ran no timed transaction", async () => {
    const { timing } = await settleRunWrite(async () => true);
    logRunPersistence("run_1", "cancel", "confirmed", undefined, timing);
    expect(persistence()[0]).not.toHaveProperty("duration_ms");
    expect(persistence()[0]).not.toHaveProperty("lock_wait_ms");
  });
});
