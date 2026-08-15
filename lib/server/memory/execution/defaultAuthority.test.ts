import { describe, expect, it } from "vitest";
import { defaultMemoryExecutionAuthority } from "./defaultAuthority";

describe("default Memory execution authority", () => {
  it("contains no optional quality-authority dependency", () => {
    expect(defaultMemoryExecutionAuthority).toEqual({});
  });
});
