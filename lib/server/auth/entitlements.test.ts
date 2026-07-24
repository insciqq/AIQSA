import { describe, expect, it } from "vitest";
import { canAccessModel, canAccessSearchStrategy, resolveEntitlements, validateRunAccess } from "./entitlements";

describe("entitlement resolver", () => {
  it("combines direct user grants and group grants", () => {
    const entitlements = resolveEntitlements("user-1", ["group-1"], [
      {
        enabled: true,
        providerModelConnectionId: "openai-connection",
        providerModelId: "gpt-deployment",
        userId: "user-1"
      },
      {
        enabled: true,
        groupId: "group-1",
        searchStrategy: "openai-native-web-search"
      }
    ]);

    expect(canAccessModel(entitlements, "openai-connection", "gpt-deployment")).toBe(true);
    expect(canAccessSearchStrategy(entitlements, "openai-native-web-search")).toBe(true);
  });

  it("ignores disabled and unrelated grants", () => {
    const entitlements = resolveEntitlements("user-1", ["group-1"], [
      {
        enabled: false,
        providerModelConnectionId: "anthropic-connection",
        providerModelId: "claude-deployment",
        userId: "user-1"
      },
      {
        enabled: true,
        groupId: "other-group",
        searchStrategy: "unsupported-search"
      }
    ]);

    expect(canAccessModel(entitlements, "anthropic-connection", "claude-deployment")).toBe(false);
    expect(canAccessSearchStrategy(entitlements, "unsupported-search")).toBe(false);
  });

  it("rejects unavailable model and search combinations", () => {
    const entitlements = resolveEntitlements("user-1", [], [
      {
        enabled: true,
        providerModelConnectionId: "openai-connection",
        providerModelId: "gpt-deployment",
        userId: "user-1"
      }
    ]);

    expect(
      validateRunAccess(entitlements, {
        modelId: "claude-deployment",
        provider: "anthropic-connection"
      })
    ).toEqual({
      code: "model_not_available",
      ok: false
    });
    expect(
      validateRunAccess(entitlements, {
        modelId: "gpt-deployment",
        provider: "openai-connection",
        searchStrategy: "unsupported-search"
      })
    ).toEqual({
      code: "search_strategy_not_available",
      ok: false
    });
  });
});
