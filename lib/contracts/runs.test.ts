import { describe, expect, it } from "vitest";
import {
  decodeCancelModelRunResponse,
  decodeRunOutcomeResponse
} from "./runs";

describe("decodeCancelModelRunResponse", () => {
  it("decodes only the cancellation facts consumed by the browser", () => {
    expect(decodeCancelModelRunResponse({
      run: {
        id: "run-1",
        providerCancelPreview: { secret: "not-a-client-field" },
        providerResponseId: "provider-private",
        status: "cancelled"
      }
    })).toEqual({
      kind: "cancelled",
      run: { id: "run-1", status: "cancelled" }
    });

    expect(decodeCancelModelRunResponse({
      error: "model_run_not_cancelable",
      run: { id: "run-1", status: "complete" }
    })).toEqual({
      kind: "not_cancelled",
      run: { id: "run-1", status: "complete" }
    });
  });

  it.each([
    null,
    {},
    { run: null },
    { run: { id: "", status: "cancelled" } },
    { run: { id: "run-1", status: "preparing" } },
    { run: { id: "run-1", status: "complete" } },
    {
      error: "unexpected",
      run: { id: "run-1", status: "complete" }
    }
  ])("rejects malformed cancellation response %#", (value) => {
    expect(decodeCancelModelRunResponse(value)).toBeNull();
  });
});

describe("decodeRunOutcomeResponse", () => {
  it("decodes the versioned minimal outcome and ignores non-contract input fields", () => {
    expect(decodeRunOutcomeResponse({
      run: {
        events: [{ payload: "forbidden" }],
        id: "run-1",
        normalizedRequest: { prompt: "forbidden" },
        status: "complete"
      },
      version: 1
    })).toEqual({ id: "run-1", status: "complete" });
  });

  it.each([
    null,
    {},
    { run: { id: "run-1", status: "complete" } },
    { run: { id: "run-1", status: "complete" }, version: 2 },
    { run: null, version: 1 },
    { run: { id: "", status: "complete" }, version: 1 },
    { run: { id: "run-1", status: "preparing" }, version: 1 },
    { run: { id: "run-1", status: null }, version: 1 }
  ])("rejects malformed run outcome %#", (value) => {
    expect(decodeRunOutcomeResponse(value)).toBeNull();
  });
});
