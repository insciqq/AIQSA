export type MemoryGates = Readonly<{
  learnAutomatically: boolean;
  referenceChatHistory: boolean;
  useMemoryFacts: boolean;
}>;

export type MemoryGateCapabilities = Readonly<{
  automaticFactWrites: boolean;
  explicitManagement: true;
  factReads: boolean;
  historyIndexWrites: boolean;
  historyReads: boolean;
}>;

export type MemoryGateFixture = Readonly<{
  capabilities: MemoryGateCapabilities;
  gates: MemoryGates;
  id: string;
}>;

function fixture(
  id: string,
  useMemoryFacts: boolean,
  referenceChatHistory: boolean,
  learnAutomatically: boolean
): MemoryGateFixture {
  return Object.freeze({
    capabilities: Object.freeze({
      automaticFactWrites: learnAutomatically,
      explicitManagement: true,
      factReads: useMemoryFacts,
      historyIndexWrites: referenceChatHistory,
      historyReads: referenceChatHistory
    }),
    gates: Object.freeze({ learnAutomatically, referenceChatHistory, useMemoryFacts }),
    id
  });
}

/** Every one of the 2^3 independent settings combinations is an executable fixture. */
export const MEMORY_GATE_FIXTURES: readonly MemoryGateFixture[] = Object.freeze([
  fixture("facts-off_history-off_learning-off", false, false, false),
  fixture("facts-on_history-off_learning-off", true, false, false),
  fixture("facts-off_history-on_learning-off", false, true, false),
  fixture("facts-on_history-on_learning-off", true, true, false),
  fixture("facts-off_history-off_learning-on", false, false, true),
  fixture("facts-on_history-off_learning-on", true, false, true),
  fixture("facts-off_history-on_learning-on", false, true, true),
  fixture("facts-on_history-on_learning-on", true, true, true)
]);

export function memoryCapabilitiesForGates(gates: MemoryGates): MemoryGateCapabilities {
  return {
    automaticFactWrites: gates.learnAutomatically,
    explicitManagement: true,
    factReads: gates.useMemoryFacts,
    historyIndexWrites: gates.referenceChatHistory,
    historyReads: gates.referenceChatHistory
  };
}
