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

  it("treats full access as a semantic wildcard for present and future catalog ids", () => {
    const entitlements = resolveEntitlements("user-1", ["full-access"], [], {
      fullAccess: true
    });

    expect(entitlements.fullAccess).toBe(true);
    expect(entitlements.modelKeys).toEqual(new Set());
    expect(entitlements.providerKeys).toEqual(new Set());
    expect(entitlements.searchStrategies).toEqual(new Set());
    expect(canAccessModel(entitlements, "future-provider", "future-model")).toBe(true);
    expect(canAccessSearchStrategy(entitlements, "future-search")).toBe(true);
    expect(validateRunAccess(entitlements, {
      modelId: "future-model",
      provider: "future-provider",
      searchStrategy: "future-search"
    })).toEqual({ ok: true });
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
