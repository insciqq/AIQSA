import { describe, expect, it } from "vitest";
import { occurrenceCheckSourcesMissing, occurrenceSourcesIncomplete } from "./sourceHealth";

describe("scheduled run source health", () => {
  const source = { name: "Tracker", reason: "mcp_server_unavailable", relied: true, serverId: "server-tracker" };

  it("makes a monitoring check unable to check only when it missed a source a previous result relied on", () => {
    // A relied-on source: the run is incomplete and the check could not check.
    expect([occurrenceSourcesIncomplete([source]), occurrenceCheckSourcesMissing([source])]).toEqual([true, true]);
    // Recorded only because nothing judged relevance yet: incomplete, but the check still counts.
    const unjudged = [{ ...source, relied: false }];
    expect([occurrenceSourcesIncomplete(unjudged), occurrenceCheckSourcesMissing(unjudged)]).toEqual([true, false]);
    // Nothing missing, or a stored value that is not a recorded gap.
    for (const value of [null, [], "[]", [{ ...source, serverId: "not an id" }], [{ ...source, relied: "yes" }]]) {
      expect([occurrenceSourcesIncomplete(value), occurrenceCheckSourcesMissing(value)]).toEqual([false, false]);
    }
  });
});
