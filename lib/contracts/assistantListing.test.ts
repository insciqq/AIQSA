import { describe, expect, it } from "vitest";
import { decodeAssistantListingStatus, decodeAssistantListingStatusResponse } from "./assistantListing";

const request = { id: "request-1", state: "pending", definitionVersion: 2, outdated: true,
  createdAt: "2026-09-27T00:00:00.000Z", reviewedAt: null, reviewNote: null };
const status = { listed: false, request, canRequest: true, canWithdraw: true };

describe("Assistant listing status wire", () => {
  it("decodes the owner's status with a computed outdated request", () => {
    expect(decodeAssistantListingStatusResponse({ listing: status })).toEqual({ listing: status });
    expect(decodeAssistantListingStatus({ listed: true, request: null, canRequest: false, canWithdraw: false }))
      .toEqual({ listed: true, request: null, canRequest: false, canWithdraw: false });
    expect(decodeAssistantListingStatus({ ...status, request: { ...request, state: "rejected", outdated: false,
      reviewedAt: "2026-09-28T00:00:00.000Z", reviewNote: "Please narrow the instructions" }, canWithdraw: false }))
      .toMatchObject({ request: { state: "rejected", reviewNote: "Please narrow the instructions" } });
  });

  it("rejects unknown states, impossible combinations and oversized notes", () => {
    expect(decodeAssistantListingStatus({ ...status, request: { ...request, state: "outdated" } })).toBeNull();
    expect(decodeAssistantListingStatus({ ...status, request: { ...request, state: "approved" } })).toBeNull();
    expect(decodeAssistantListingStatus({ ...status, request: null })).toBeNull();
    expect(decodeAssistantListingStatus({ ...status, request: { ...request, definitionVersion: 0 } })).toBeNull();
    expect(decodeAssistantListingStatus({ ...status, request: { ...request, reviewNote: "a".repeat(4_001) } })).toBeNull();
    expect(decodeAssistantListingStatus({ ...status, listed: "no" })).toBeNull();
    expect(decodeAssistantListingStatusResponse({ status })).toBeNull();
  });
});
