import { describe, expect, it } from "vitest";
import {
  decodeAssistantDeleteRequest,
  decodeAssistantDeletionConsequencesResponse
} from "./assistantDeletion";

const consequences = {
  audiences: { groupNames: ["Design", "Research"], installation: false },
  chatCount: 0,
  pendingListingRequest: false,
  version: 3
};

describe("Assistant deletion contract", () => {
  it("decodes consequences and drops unknown fields", () => {
    expect(decodeAssistantDeletionConsequencesResponse({
      consequences: { ...consequences, hiddenProjectCount: 2, ownerUserId: "private", projects: [{ id: "p-1", name: "Launch" }] }
    })).toEqual({ consequences });
  });

  it.each([
    ["a negative chat count", { chatCount: -1 }],
    ["an empty group name", { audiences: { groupNames: [""], installation: false } }],
    ["a missing installation flag", { audiences: { groupNames: [] } }],
    ["a zero version", { version: 0 }]
  ])("rejects %s", (_label, override) => {
    expect(decodeAssistantDeletionConsequencesResponse({ consequences: { ...consequences, ...override } })).toBeNull();
  });

  it("accepts only a positive integer expected version", () => {
    expect(decodeAssistantDeleteRequest({ expectedVersion: 4 })).toEqual({ expectedVersion: 4 });
    for (const body of [null, {}, { expectedVersion: 0 }, { expectedVersion: "4" }, { expectedVersion: 4, extra: 1 }]) {
      expect(decodeAssistantDeleteRequest(body)).toBeNull();
    }
  });
});
