import { describe, expect, it } from "vitest";
import { describeDeleteBlockers } from "./providerBlockers";

describe("describeDeleteBlockers", () => {
  it("turns server blocker kinds into one plain-language sentence", () => {
    expect(describeDeleteBlockers([
      { count: 2, kind: "assistants" },
      { count: 1, kind: "system_model" }
    ], "provider")).toBe("Used by 2 Assistants and a system role — reassign first.");
    expect(describeDeleteBlockers([
      { count: 1, kind: "installation_default" },
      { count: 3, kind: "search_references" },
      { count: 1, kind: "run_bindings" }
    ], "provider")).toBe(
      "Used by the default chat model, 3 Search sources and 1 running or recoverable chat — reassign first."
    );
  });

  it("explains built-in providers, default keys and the off-first rule separately", () => {
    expect(describeDeleteBlockers([{ count: 1, kind: "code_owned_template" }, { count: 1, kind: "resource_enabled" }], "provider"))
      .toBe("Built-in providers can't be deleted — turn it off instead.");
    expect(describeDeleteBlockers([{ count: 1, kind: "connection_default" }, { count: 2, kind: "group_assignments" }], "key"))
      .toBe("It is the default key — choose another default first. Used by 2 group overrides — reassign first.");
    expect(describeDeleteBlockers([{ count: 1, kind: "resource_enabled" }], "key")).toBe("Turn the key off first.");
    expect(describeDeleteBlockers([], "key")).toBe("The key is still in use.");
    expect(describeDeleteBlockers([{ count: 1, kind: "future_kind" }], "key")).toBe("Used by future kind — reassign first.");
  });
});
