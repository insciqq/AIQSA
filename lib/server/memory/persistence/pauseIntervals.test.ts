import { describe, expect, it } from "vitest";
import {
  memoryDestructiveSourceCutoff,
  memorySourceIsInsidePause,
  type MemoryPauseIntervalSnapshot
} from "./pauseIntervals";

function interval(
  input: Partial<MemoryPauseIntervalSnapshot> = {}
): MemoryPauseIntervalSnapshot {
  return {
    id: "pause",
    memoryGeneration: 1,
    pausedAt: new Date("2026-08-21T10:00:00.000Z"),
    resumedAt: new Date("2026-08-21T10:10:00.000Z"),
    scope: "MASTER",
    ...input
  };
}

describe("Memory pause intervals", () => {
  it("admits A-before and C-after while excluding only B-during", () => {
    const pause = interval();
    expect(memorySourceIsInsidePause(
      new Date("2026-08-21T09:59:59.999Z"),
      [pause]
    )).toBe(false);
    expect(memorySourceIsInsidePause(
      new Date("2026-08-21T10:05:00.000Z"),
      [pause]
    )).toBe(true);
    expect(memorySourceIsInsidePause(
      new Date("2026-08-21T10:10:00.001Z"),
      [pause]
    )).toBe(false);
  });

  it("keeps an open pause fail-closed", () => {
    expect(memorySourceIsInsidePause(
      new Date("2099-01-01T00:00:00.000Z"),
      [interval({ resumedAt: null })]
    )).toBe(true);
  });

  it("keeps destructive clear barriers separate from pause admission", () => {
    const older = new Date("2026-08-21T09:00:00.000Z");
    const newer = new Date("2026-08-21T11:00:00.000Z");

    expect(memoryDestructiveSourceCutoff([
      { explicitOverrideAllowed: true, sourceCreatedAtCutoff: newer },
      { explicitOverrideAllowed: false, sourceCreatedAtCutoff: older }
    ])).toEqual(older);
    expect(memoryDestructiveSourceCutoff([
      { explicitOverrideAllowed: true, sourceCreatedAtCutoff: newer }
    ])).toBeNull();
  });
});
