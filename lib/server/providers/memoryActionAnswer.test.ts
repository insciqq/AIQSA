import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../domain/contextBudget";
import {
  decodeMemoryActionAnswerResult,
  MEMORY_ACTION_NO_COMMIT_RESULT,
  MEMORY_ACTION_PENDING_RESULT,
  memoryActionAnswerContract
} from "./memoryActionAnswer";

describe("Memory action answer result", () => {
  it.each([
    { operation: "SAVE", status: "COMMITTED", version: 1 },
    { operation: "UPDATE", status: "REJECTED", version: 1 },
    { operation: "NONE", status: "UNAVAILABLE", version: 1 },
    { operation: "SEARCH", status: "COMPLETE", version: 1 },
    { operation: "SAVE", status: "COMMITTED", version: 2 },
    { operation: "NONE", status: "UNAVAILABLE", version: 2 },
    { operation: "NONE", status: "PENDING", version: 3 },
    { operation: "SAVE", status: "UNAVAILABLE", version: 4 },
    { operation: "NONE", status: "UNAVAILABLE", version: 4 }
  ] as const)("accepts the bounded authoritative pair %#", (result) => {
    expect(decodeMemoryActionAnswerResult(result)).toEqual(result);
  });

  it.each([
    { operation: "NONE", status: "COMMITTED", version: 1 },
    { operation: "SEARCH", status: "REJECTED", version: 1 },
    { operation: "SAVE", status: "COMMITTED", statement: "private", version: 1 },
    { operation: "SAVE", status: "COMMITTED", version: 5 },
    { operation: "SAVE", status: "PENDING", version: 3 },
    { operation: "NONE", status: "PENDING", version: 4 },
    { operation: "NONE", status: "PENDING", version: 2 },
    { operation: "NONE", status: "PENDING", version: 1 }
  ])("rejects invalid or content-bearing bridge %#", (result) => {
    expect(decodeMemoryActionAnswerResult(result)).toBeNull();
  });

  it("reproduces the frozen v1 instruction exactly for accepted runs", () => {
    const contract = memoryActionAnswerContract({
      operation: "SAVE",
      status: "REJECTED",
      version: 1
    });
    expect(contract).toBe([
      '<aiqsa_memory_result version="1">',
      "operation=SAVE; status=REJECTED.".padEnd(
        "operation=UPDATE; status=CONFIRMATION_REQUIRED.".length, " "
      ),
      "Server truth: claim Personal Memory changed only for the matching COMMITTED operation; otherwise no reusable change occurred.",
      "For REJECTED or UNAVAILABLE, never expose or paraphrase candidate content or secrets.",
      "Preserve the ordinary answer; exact Memory feedback is rendered separately.",
      "</aiqsa_memory_result>"
    ].join("\n"));
  });

  it.each([
    { operation: "NONE", status: "UNAVAILABLE" },
    { operation: "SAVE", status: "REJECTED" },
    { operation: "SAVE", status: "THIS_CHAT_ONLY" },
    { operation: "SAVE", status: "UNAVAILABLE" },
    { operation: "UPDATE", status: "AMBIGUOUS" },
    { operation: "UPDATE", status: "REJECTED" },
    { operation: "FORGET", status: "UNAVAILABLE" },
    { operation: "LIST", status: "COMPLETE" },
    { operation: "SEARCH", status: "UNAVAILABLE" },
    { operation: "RESET", status: "CONFIRMATION_REQUIRED" }
  ] as const)("requires honest non-commit feedback for %#", (result) => {
    const contract = memoryActionAnswerContract({ ...result, version: 2 });
    expect(contract).toContain('<aiqsa_memory_result version="2">');
    expect(contract).toContain("you do not perform the mutation yourself");
    expect(contract).toContain("explicitly say it was not done");
    expect(contract).toContain("Current-chat context is not saved Memory");
    expect(contract).not.toContain("rendered separately");
    expect(contract).not.toContain("private-secret-sentinel");
  });

  it("allows confirmation only for the matching committed operation", () => {
    const contract = memoryActionAnswerContract({
      operation: "SAVE", status: "COMMITTED", version: 2
    });
    expect(contract).toContain("Confirm saving, changing, or forgetting only when the matching operation has status COMMITTED");
    expect(contract).toContain("acknowledge it as done, never say it failed or was not saved");
  });

  it("acknowledges durable background work without promising its result", () => {
    const contract = memoryActionAnswerContract(MEMORY_ACTION_PENDING_RESULT);
    expect(contract).toContain('<aiqsa_memory_result version="3">');
    expect(contract).toContain("intent and outcome are not yet known");
    expect(contract).toContain("explicitly say you will try; never promise success");
    expect(contract).toContain("claim it is done, failed, or absent");
    expect(contract).toContain("Do not ask the user to wait");
    expect(contract).toContain("did not request a Memory change, do not mention");
    expect(Object.isFrozen(MEMORY_ACTION_PENDING_RESULT)).toBe(true);
    expect(estimateApproxTokens(contract)).toBeLessThanOrEqual(
      estimateApproxTokens(memoryActionAnswerContract(MEMORY_ACTION_NO_COMMIT_RESULT))
    );
  });

  it("reproduces the frozen v2 instruction exactly for accepted runs", () => {
    expect(memoryActionAnswerContract({ operation: "NONE", status: "UNAVAILABLE", version: 2 })).toBe([
      '<aiqsa_memory_result version="2">',
      "operation=NONE; status=UNAVAILABLE.".padEnd("operation=UPDATE; status=CONFIRMATION_REQUIRED.".length, " "),
      "Only this server result establishes whether Personal Memory changed. You report the server's completed work; you do not perform the mutation yourself.",
      "Confirm saving, changing, or forgetting only when the matching operation has status COMMITTED.",
      "COMMITTED means the server successfully completed that operation: acknowledge it as done, never say it failed or was not saved.",
      "If this user message asks to save, change, or forget and the matching operation is not COMMITTED, explicitly say it was not done. This includes NONE/UNAVAILABLE and THIS_CHAT_ONLY.",
      "Current-chat context is not saved Memory. Do not expose or paraphrase rejected candidate content or secrets.",
      "Preserve any separately requested ordinary answer.",
      "</aiqsa_memory_result>"
    ].join("\n"));
  });

  it("issues new answers under v4, which never narrates a Memory failure or claims success", () => {
    expect(MEMORY_ACTION_NO_COMMIT_RESULT.version).toBe(4);
    for (const operation of ["SAVE", "UPDATE", "FORGET", "LIST", "SEARCH", "RESET"] as const) {
      const contract = memoryActionAnswerContract({ operation, status: "UNAVAILABLE", version: 4 });
      expect(contract).toContain('<aiqsa_memory_result version="4">');
      expect(contract).toContain("its status is UNAVAILABLE, say nothing about it: never mention Memory, saving, remembering, a failure, error, limit, or unavailability, never say whether it was done");
      expect(contract).not.toContain("This includes NONE/UNAVAILABLE");
    }
    // NONE keeps the v2 meaning: a requested change that was not recognized is not done.
    expect(memoryActionAnswerContract(MEMORY_ACTION_NO_COMMIT_RESULT))
      .toContain("Otherwise, if this user message asks to save, change, or forget and the result is operation=NONE, or status REJECTED or THIS_CHAT_ONLY, explicitly say it was not done.");
    expect(memoryActionAnswerContract({ operation: "SAVE", status: "COMMITTED", version: 4 }))
      .toContain("acknowledge it as done, never say it failed or was not saved");
  });

  it("uses one bounded reservation for the default and every authoritative result", () => {
    const results = [
      { operation: "NONE", status: "UNAVAILABLE", version: 2 },
      { operation: "SAVE", status: "COMMITTED", version: 2 },
      { operation: "SAVE", status: "REJECTED", version: 2 },
      { operation: "SAVE", status: "THIS_CHAT_ONLY", version: 2 },
      { operation: "UPDATE", status: "AMBIGUOUS", version: 2 },
      { operation: "FORGET", status: "COMMITTED", version: 2 },
      { operation: "LIST", status: "COMPLETE", version: 2 },
      { operation: "SEARCH", status: "UNAVAILABLE", version: 2 },
      { operation: "RESET", status: "CONFIRMATION_REQUIRED", version: 2 }
    ] as const;
    const current = results.map((result) => ({ ...result, version: 4 as const }));
    const currentCounts = current.map((result) =>
      estimateApproxTokens(memoryActionAnswerContract(result)));
    expect(new Set(currentCounts)).toEqual(new Set([
      estimateApproxTokens(memoryActionAnswerContract(MEMORY_ACTION_NO_COMMIT_RESULT))
    ]));
    const tokenCounts = results.map((result) =>
      estimateApproxTokens(memoryActionAnswerContract(result)));

    expect(new Set(tokenCounts)).toEqual(new Set([tokenCounts[0]]));
    expect(Object.isFrozen(MEMORY_ACTION_NO_COMMIT_RESULT)).toBe(true);
  });
});
