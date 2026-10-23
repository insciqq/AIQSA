import { describe, expect, it, vi } from "vitest";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { engineTestFaults } from "./faults";
import { nativeUsageRowId } from "./runStore";
import { createUsageLedger } from "./usage";

const scope = { assistantMessageId: "a", chatId: "c", runId: "r", userId: "u" };
const call = (inputTokens: number): RunUsageAttribution => ({ modelId: "m", operationCount: 1, provider: "p", purpose: "chat_answer",
  usage: { inputTokens, outputTokens: 1 } });

describe("native usage ledger", () => {
  it("writes one row per physical call with stable ids, then the totals", async () => {
    const store = { applyUsageTotals: vi.fn(async () => undefined), writeUsageRows: vi.fn(async () => undefined) };
    const ledger = createUsageLedger({ price: async (entries) => [...entries], scope, store });
    ledger.add(call(10));
    ledger.add(call(12));
    await expect(ledger.settle()).resolves.toBe(true);
    expect(store.writeUsageRows).toHaveBeenCalledWith(scope, [
      { attribution: call(10), key: "0" }, { attribution: call(12), key: "1" }
    ]);
    expect(store.applyUsageTotals).toHaveBeenCalledWith(scope, [call(10), call(12)]);
    expect(nativeUsageRowId("r", "0")).toBe(nativeUsageRowId("r", "0"));
    expect(nativeUsageRowId("r", "0")).not.toBe(nativeUsageRowId("r", "1"));
    expect(nativeUsageRowId("r", "0")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("retries a failed write and never throws when it keeps failing", async () => {
    const store = { applyUsageTotals: vi.fn(async () => undefined), writeUsageRows: vi.fn(async () => { throw new Error("db"); }) };
    const sleep = vi.fn(async () => undefined);
    const ledger = createUsageLedger({ price: async (entries) => [...entries], scope, sleep, store });
    ledger.add(call(10));
    await expect(ledger.settle()).resolves.toBe(false);
    expect(store.writeUsageRows).toHaveBeenCalledTimes(3);
  });

  it("fails every write under the stand's usage fault", async () => {
    const store = { applyUsageTotals: vi.fn(async () => undefined), writeUsageRows: vi.fn(async () => undefined) };
    const faults = engineTestFaults({ AIQSA_NATIVE_ENGINE_TEST_FAULTS: "usage_write_fail", AIQSA_TEST_MODE: "1", NODE_ENV: "test" });
    const ledger = createUsageLedger({ faults, price: async (entries) => [...entries], scope, sleep: async () => undefined, store });
    ledger.add(call(10));
    await expect(ledger.settle()).resolves.toBe(false);
    expect(store.writeUsageRows).not.toHaveBeenCalled();
  });
});
