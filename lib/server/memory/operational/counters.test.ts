import { describe, expect, it } from "vitest";
import {
  decodeMemoryOperationalCounters,
  MEMORY_OPERATIONAL_COUNTER_KEYS
} from "./counters";

describe("Memory operational counters", () => {
  it("accepts only allowlisted non-negative integer measurements", () => {
    expect(decodeMemoryOperationalCounters({
      digestNoop: 1,
      historyMessagesProjected: 4
    })).toEqual({ digestNoop: 1, historyMessagesProjected: 4 });
    expect(decodeMemoryOperationalCounters({ privateText: 1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ digestNoop: "private" })).toBeNull();
    expect(decodeMemoryOperationalCounters({ digestNoop: -1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ digestNoop: 1.5 })).toBeNull();
    expect(decodeMemoryOperationalCounters([])).toBeNull();
  });

  it("keeps the durable key vocabulary free of identity and content fields", () => {
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("userId");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("text");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("label");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("prompt");
  });
});
