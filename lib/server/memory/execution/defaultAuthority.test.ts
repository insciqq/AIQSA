import { describe, expect, it } from "vitest";
import { defaultMemoryExecutionAuthority } from "./defaultAuthority";

describe("default Memory execution authority", () => {
  it("does not carry a signed quality registry or language benchmark gate", () => {
    expect(defaultMemoryExecutionAuthority).toEqual({ qualification: {} });
    expect(JSON.stringify(defaultMemoryExecutionAuthority)).not.toContain("registry");
    expect(JSON.stringify(defaultMemoryExecutionAuthority)).not.toContain("corpus");
    expect(JSON.stringify(defaultMemoryExecutionAuthority)).not.toContain("language");
  });
});
