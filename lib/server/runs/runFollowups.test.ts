import { describe, expect, it } from "vitest";
import { decodeRunFollowupState } from "../../contracts/runFollowups";
import { projectRunFollowups } from "./runFollowups";

const entry = (ordinal: number, text: string) => ({ authorName: "Owner", createdAt: new Date("2026-10-30T10:00:00.000Z"),
  deliveredAt: null, id: `followup-${ordinal}`, ordinal, precedingText: null, text });

describe("run follow-up projection", () => {
  it("numbers the user's own follow-ups by their position, whatever ordinals sub-agent callbacks took between them", () => {
    // Stored ordinals 2 and 5: a callback and messages to a sub-agent took 1, 3 and 4 of the run's revision.
    const run = { answerCompletedAt: null, followupClosedAt: null, followupMode: "chat", status: "streaming" as const,
      followups: [entry(2, "Use a table"), entry(5, "And a chart")] };
    const projected = projectRunFollowups(run);
    expect(projected.entries.map((followup) => followup.ordinal)).toEqual([1, 2]);
    expect(decodeRunFollowupState(projected)).not.toBeNull();
    // One entry projected alone keeps its place among the user's own.
    expect(projectRunFollowups({ ...run, followups: [entry(5, "And a chart")] }, 1).entries[0]!.ordinal).toBe(2);
    // The engine's read keeps the stored ordinals.
    expect(projectRunFollowups(run, 0, { renumber: false }).entries.map((followup) => followup.ordinal)).toEqual([2, 5]);
  });
});
