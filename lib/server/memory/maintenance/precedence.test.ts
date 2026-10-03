import { describe, expect, it } from "vitest";
import { memoryMaintenanceContradictionPrecedence, settleMemoryMaintenanceContradictions,
  type MemoryMaintenanceContradictionCandidate, type MemoryMaintenanceTestimony } from "./precedence";

const day = (value: number) => new Date(Date.UTC(2026, 8, value));
const said = (messageId: string, at: number): MemoryMaintenanceTestimony => ({ messageId, observedAt: day(at) });
const target = (testimony: readonly MemoryMaintenanceTestimony[], protectedFact = false, lasting = true) =>
  ({ protected: protectedFact, lasting, testimony });

describe("contradiction precedence", () => {
  it("lets an explicit, owner-edited, pinned or remember-requested memory outrank the automatic source, whatever its age", () => {
    // Protection covers explicit saves without testimony and older protected automatic facts alike, confirmed lasting or not.
    for (const testimony of [[], [said("old", 1)], [said("same", 5)], [said("new", 9)]]) {
      for (const lasting of [true, false]) {
        expect(memoryMaintenanceContradictionPrecedence({ source: [said("same", 5)], target: target(testimony, true, lasting) }))
          .toBe("TARGET");
      }
    }
  });
  it("lets an automatic memory outrank the source only with later testimony from another message", () => {
    const source = [said("m1", 2), said("m2", 4)];
    // Newer: a later, different message.
    expect(memoryMaintenanceContradictionPrecedence({ source, target: target([said("m3", 6)]) })).toBe("TARGET");
    expect(memoryMaintenanceContradictionPrecedence({ source, target: target([said("m1", 2), said("m3", 6)]) })).toBe("TARGET");
    // Older: the source outranks it instead.
    expect(memoryMaintenanceContradictionPrecedence({ source, target: target([said("m0", 1)]) })).toBe("SOURCE");
    // Interleaved: the latest testimony decides, so the source's later repetition keeps it ahead.
    expect(memoryMaintenanceContradictionPrecedence({ source, target: target([said("m5", 3)]) })).toBe("SOURCE");
  });
  it("never lets a newer automatic memory that maintenance has not confirmed lasting outrank the source", () => {
    const source = [said("m1", 2)];
    expect(memoryMaintenanceContradictionPrecedence({ source, target: target([said("m3", 6)], false, false) })).toBe("NONE");
    expect(memoryMaintenanceContradictionPrecedence({ source, target: target([said("m0", 1)], false, false) })).toBe("SOURCE");
  });
  it("finds no clear order between automatic memories resting on the same message or on simultaneous testimony", () => {
    // The same single message.
    expect(memoryMaintenanceContradictionPrecedence({ source: [said("m1", 3)], target: target([said("m1", 3)]) })).toBe("NONE");
    // A shared latest message, whatever came before.
    expect(memoryMaintenanceContradictionPrecedence({ source: [said("m2", 5)], target: target([said("m1", 2), said("m2", 5)]) })).toBe("NONE");
    expect(memoryMaintenanceContradictionPrecedence({ source: [said("m1", 2), said("m2", 5)], target: target([said("m2", 5)]) })).toBe("NONE");
    // Different messages at the same moment.
    expect(memoryMaintenanceContradictionPrecedence({ source: [said("m1", 4)], target: target([said("m2", 4)]) })).toBe("NONE");
    // Missing testimony never establishes an order.
    expect(memoryMaintenanceContradictionPrecedence({ source: [], target: target([said("m2", 9)]) })).toBe("NONE");
    expect(memoryMaintenanceContradictionPrecedence({ source: [said("m1", 1)], target: target([]) })).toBe("NONE");
  });
});

describe("contradiction settlement", () => {
  const candidate = (sourceRef: string, targetFactId: string,
    precedence: MemoryMaintenanceContradictionCandidate["precedence"]): MemoryMaintenanceContradictionCandidate =>
    ({ sourceRef, sourceFactId: `fact-${sourceRef}`, targetFactId, precedence });
  const settle = (candidates: readonly MemoryMaintenanceContradictionCandidate[], removed: readonly string[] = []) =>
    Object.fromEntries(settleMemoryMaintenanceContradictions(candidates, new Set(removed)));

  it("removes an outranked source, keeps an unordered pair in conflict and a source whose memory changed", () => {
    expect(settle([candidate("S1", "fact-explicit", "TARGET"), candidate("S2", "fact-S3", "NONE"),
      candidate("S3", "fact-S2", "NONE"), candidate("S4", "fact-older", "SOURCE"), candidate("S5", "fact-changed", null)]))
      .toEqual({ S1: "REMOVE", S2: "CONFLICT", S3: "CONFLICT", S4: "CONFLICT", S5: "KEEP" });
  });
  it("never removes a source for a memory that this settlement removes too", () => {
    // Removed as transient in the same batch.
    expect(settle([candidate("S1", "fact-S2", "TARGET")], ["fact-S2"])).toEqual({ S1: "KEEP" });
    // The newer memory is itself outranked by an explicit one: only it goes, and the older one stays without a conflict.
    expect(settle([candidate("S1", "fact-S2", "TARGET"), candidate("S2", "fact-explicit", "TARGET")]))
      .toEqual({ S1: "KEEP", S2: "REMOVE" });
    // The same chain in any decision order.
    expect(settle([candidate("S2", "fact-explicit", "TARGET"), candidate("S1", "fact-S2", "TARGET")]))
      .toEqual({ S1: "KEEP", S2: "REMOVE" });
    // A superseded memory is removed while the newer one that named it back keeps no conflict.
    expect(settle([candidate("S1", "fact-S2", "TARGET"), candidate("S2", "fact-S1", "SOURCE")])).toEqual({ S1: "REMOVE", S2: "KEEP" });
  });
  it("keeps both sides of a mutual removal in conflict, in any order", () => {
    for (const order of [["S1", "S2"], ["S2", "S1"]]) {
      expect(settle(order.map((ref) => candidate(ref, ref === "S1" ? "fact-S2" : "fact-S1", "TARGET"))))
        .toEqual({ S1: "CONFLICT", S2: "CONFLICT" });
    }
  });
});
