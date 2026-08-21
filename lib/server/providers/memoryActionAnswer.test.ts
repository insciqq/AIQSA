import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../domain/contextBudget";
import {
  decodeMemoryActionAnswerResult,
  MEMORY_ACTION_NO_COMMIT_RESULT,
  memoryActionAnswerContract
} from "./memoryActionAnswer";

describe("Memory action answer result", () => {
  it.each([
    { operation: "SAVE", status: "COMMITTED", version: 1 },
    { operation: "UPDATE", status: "REJECTED", version: 1 },
    { operation: "NONE", status: "UNAVAILABLE", version: 1 },
    { operation: "SEARCH", status: "COMPLETE", version: 1 }
  ] as const)("accepts the bounded authoritative pair %#", (result) => {
    expect(decodeMemoryActionAnswerResult(result)).toEqual(result);
  });

  it.each([
    { operation: "NONE", status: "COMMITTED", version: 1 },
    { operation: "SEARCH", status: "REJECTED", version: 1 },
    { operation: "SAVE", status: "COMMITTED", statement: "private", version: 1 },
    { operation: "SAVE", status: "COMMITTED", version: 2 }
  ])("rejects invalid or content-bearing bridge %#", (result) => {
    expect(decodeMemoryActionAnswerResult(result)).toBeNull();
  });

  it("renders only operation/status authority and explicit secret-safe failure rules", () => {
    const contract = memoryActionAnswerContract({
      operation: "SAVE",
      status: "REJECTED",
      version: 1
    });
    expect(contract).toContain("operation=SAVE; status=REJECTED");
    expect(contract).toContain("claim Personal Memory changed only");
    expect(contract).toContain("never expose or paraphrase candidate content or secrets");
    expect(contract).not.toContain("private-secret-sentinel");
  });

  it("uses one bounded reservation for the default and every authoritative result", () => {
    const results = [
      MEMORY_ACTION_NO_COMMIT_RESULT,
      { operation: "SAVE", status: "COMMITTED", version: 1 },
      { operation: "SAVE", status: "REJECTED", version: 1 },
      { operation: "SAVE", status: "THIS_CHAT_ONLY", version: 1 },
      { operation: "UPDATE", status: "AMBIGUOUS", version: 1 },
      { operation: "FORGET", status: "COMMITTED", version: 1 },
      { operation: "LIST", status: "COMPLETE", version: 1 },
      { operation: "SEARCH", status: "UNAVAILABLE", version: 1 },
      { operation: "RESET", status: "CONFIRMATION_REQUIRED", version: 1 }
    ] as const;
    const tokenCounts = results.map((result) =>
      estimateApproxTokens(memoryActionAnswerContract(result)));

    expect(new Set(tokenCounts)).toEqual(new Set([tokenCounts[0]]));
    expect(Object.isFrozen(MEMORY_ACTION_NO_COMMIT_RESULT)).toBe(true);
  });
});
