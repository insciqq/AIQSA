import { describe, expect, it } from "vitest";
import { memoryResetOutboxWhere } from "./defaultConsumer";

describe("Memory consumer reset state", () => {
  it("reads the active purge operation written by Reset", () => {
    expect(memoryResetOutboxWhere("user-1")).toEqual({
      operation: "FORGET_PURGE",
      targetType: { startsWith: "ALL_REUSABLE@" },
      userId: "user-1"
    });
  });
});
