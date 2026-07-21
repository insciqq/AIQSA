import { describe, expect, it } from "vitest";
import { canAccessModel, canAccessSearchStrategy, resolveEntitlements, validateRunAccess } from "./entitlements";

describe("entitlement resolver", () => {
  it("combines direct user grants and group grants", () => {
    const entitlements = resolveEntitlements("user-1", ["group-1"], [
      {
        enabled: true,
        modelId: "gpt-5.5",
        provider: "openai",
        userId: "user-1"
      },
      {
        enabled: true,
        groupId: "group-1",
        searchStrategy: "openai-native-web-search"
      }
    ]);

    expect(canAccessModel(entitlements, "openai", "gpt-5.5")).toBe(true);
    expect(canAccessSearchStrategy(entitlements, "openai-native-web-search")).toBe(true);
  });

  it("ignores disabled and unrelated grants", () => {
    const entitlements = resolveEntitlements("user-1", ["group-1"], [
      {
        enabled: false,
        modelId: "claude-opus-4-8",
        provider: "anthropic",
        userId: "user-1"
      },
      {
        enabled: true,
        groupId: "other-group",
        searchStrategy: "unsupported-search"
      }
    ]);

    expect(canAccessModel(entitlements, "anthropic", "claude-opus-4-8")).toBe(false);
    expect(canAccessSearchStrategy(entitlements, "unsupported-search")).toBe(false);
  });

  it("rejects unavailable model and search combinations", () => {
    const entitlements = resolveEntitlements("user-1", [], [
      {
        enabled: true,
        modelId: "gpt-5.5",
        provider: "openai",
        userId: "user-1"
      }
    ]);

    expect(
      validateRunAccess(entitlements, {
        modelId: "claude-opus-4-8",
        provider: "anthropic"
      })
    ).toEqual({
      code: "model_not_available",
      ok: false
    });
    expect(
      validateRunAccess(entitlements, {
        modelId: "gpt-5.5",
        provider: "openai",
        searchStrategy: "unsupported-search"
      })
    ).toEqual({
      code: "search_strategy_not_available",
      ok: false
    });
  });
});
