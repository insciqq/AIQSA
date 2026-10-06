import { describe, expect, it } from "vitest";
import {
  decodeMemoryOperationalCounters,
  MEMORY_OPERATIONAL_COUNTER_KEYS
} from "./counters";

describe("Memory operational counters", () => {
  it("accepts only allowlisted non-negative integer measurements", () => {
    expect(decodeMemoryOperationalCounters({
      historyRoundSegmentsBuilt: 6,
      historyMessagesProjected: 4
    })).toEqual({
      historyRoundSegmentsBuilt: 6,
      historyMessagesProjected: 4
    });
    expect(decodeMemoryOperationalCounters({ privateText: 1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ historyChunksBuilt: "private" })).toBeNull();
    expect(decodeMemoryOperationalCounters({ historyChunksBuilt: -1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ historyChunksBuilt: 1.5 })).toBeNull();
    expect(decodeMemoryOperationalCounters([])).toBeNull();
  });

  it("rejects the retired digest and contextual-key counters for new writes", () => {
    expect(decodeMemoryOperationalCounters({ digestNoop: 1 })).toBeNull();
    expect(decodeMemoryOperationalCounters({ contextualRoundsGenerated: 1 })).toBeNull();
  });

  it("keeps the durable key vocabulary free of identity and content fields", () => {
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("userId");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("text");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("label");
    expect(MEMORY_OPERATIONAL_COUNTER_KEYS).not.toContain("prompt");
  });
});
