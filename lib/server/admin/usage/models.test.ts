import { describe, expect, it } from "vitest";
import { createUsageModelResolver, rawUsageModelKey, resolvedFromUsageModelKey, type UsageCatalogModel } from "./models";

const model = (id: string, input: Partial<UsageCatalogModel> = {}): UsageCatalogModel => ({
  connectionDisplayName: "OpenRouter", connectionId: "conn-or", displayName: `Model ${id}`, family: "openrouter",
  id, upstreamModelIds: [`vendor/${id}`], ...input
});

describe("usage model canonicalisation", () => {
  const resolve = createUsageModelResolver([
    model("pm-a"),
    model("pm-b"),
    model("pm-c", { connectionDisplayName: "Second", connectionId: "conn-2", upstreamModelIds: ["vendor/shared"] }),
    model("pm-d", { connectionDisplayName: "Third", connectionId: "conn-3", upstreamModelIds: ["vendor/shared"] })
  ]);

  it("groups run, ancillary and chat-summary rows of one catalog model", () => {
    const run = resolve({ provider: "conn-or", modelId: "pm-a", providerModelId: null });
    const ancillary = resolve({ provider: "openrouter", modelId: "vendor/pm-a", providerModelId: "pm-a" });
    const summary = resolve({ provider: "openrouter", modelId: "pm-a", providerModelId: null });
    const upstream = resolve({ provider: "openrouter", modelId: "vendor/pm-a", providerModelId: null });
    expect(new Set([run.key, ancillary.key, summary.key, upstream.key]).size).toBe(1);
    expect(run).toMatchObject({ label: "OpenRouter / Model pm-a", modelId: "pm-a", provider: "conn-or",
      modelLabel: "Model pm-a", providerLabel: "OpenRouter" });
  });

  it("prefers the exact providerModelId over the raw identity", () => {
    expect(resolve({ provider: "conn-or", modelId: "pm-a", providerModelId: "pm-b" }).modelId).toBe("pm-b");
  });

  it("keeps ambiguous or unknown identities raw", () => {
    const ambiguous = resolve({ provider: "openrouter", modelId: "vendor/shared", providerModelId: null });
    expect(ambiguous).toMatchObject({ label: "vendor/shared", modelId: "vendor/shared", provider: "openrouter" });
    expect(ambiguous.key).toBe(rawUsageModelKey("openrouter", "vendor/shared"));
    // A ProviderModel id under another provider is not this model.
    expect(resolve({ provider: "other", modelId: "pm-a", providerModelId: null }).label).toBe("pm-a");
    // A missing ProviderModel falls back to the row's identity.
    expect(resolve({ provider: "conn-or", modelId: "pm-a", providerModelId: "deleted" }).modelId).toBe("pm-a");
  });

  it("reads back SQL-only raw keys and bounds contract text", () => {
    expect(resolvedFromUsageModelKey(rawUsageModelKey("p", "m"))).toMatchObject({ label: "m", modelId: "m", provider: "p" });
    const long = resolve({ provider: "x", modelId: "m".repeat(600), providerModelId: null });
    expect(long.label).toHaveLength(512);
    expect(resolve({ provider: "", modelId: "", providerModelId: null })).toMatchObject({ label: "unknown", provider: "unknown" });
  });
});
