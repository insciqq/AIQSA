import { describe, expect, it } from "vitest";
import { CODEX_LB_TEMPLATE_CONTEXT_WINDOW, listedContextWindow, withListedContextWindow } from "./codexLbContextWindow";
import { providerSetupModels } from "./setupModels";

const codexEndpoint = { apiRoot: "https://fixture.example.test/backend-api/codex" };
const template = providerSetupModels("openai_compatible", codexEndpoint)
  .find((candidate) => candidate.modelId === "codex-lb:gpt-6.1-sol")!.configuration;
const withWindow = (contextWindow: number | undefined) => ({ ...template, capabilities: { ...template.capabilities, contextWindow } });
const listing = [
  { id: "gpt-6.1-sol", capabilities: { contextWindow: 500_000 } },
  { id: "gpt-6-luna", capabilities: {} }
];

describe("Codex LB context windows from the gateway listing", () => {
  it("keeps the template value only as the fallback for every answer candidate", () => {
    for (const candidate of providerSetupModels("openai_compatible", codexEndpoint)
      .filter(({ configuration }) => configuration.modelClass === "answer")) {
      expect(candidate.configuration.capabilities.contextWindow).toBe(CODEX_LB_TEMPLATE_CONTEXT_WINDOW);
    }
  });

  it("finds the listed window of the exact model and nothing for an unlisted or windowless one", () => {
    expect(listedContextWindow(listing, "gpt-6.1-sol")).toBe(500_000);
    expect(listedContextWindow(listing, "gpt-6-luna")).toBeUndefined();
    expect(listedContextWindow(listing, "gpt-6-astra")).toBeUndefined();
    expect(listedContextWindow(undefined, "gpt-6.1-sol")).toBeUndefined();
  });

  it("replaces a template-default or missing window with the listed one", () => {
    expect(withListedContextWindow(template, 500_000).capabilities.contextWindow).toBe(500_000);
    expect(withListedContextWindow(withWindow(undefined), 500_000).capabilities.contextWindow).toBe(500_000);
    expect(withListedContextWindow(template, 200_000).capabilities.contextWindow).toBe(200_000);
  });

  it("never overwrites an administrator's window, up or down", () => {
    const raised = withWindow(700_000);
    expect(withListedContextWindow(raised, 500_000)).toBe(raised);
    const lowered = withWindow(128_000);
    expect(withListedContextWindow(lowered, 500_000)).toBe(lowered);
  });

  it("keeps the stored value when the listing publishes no window, and leaves other model classes alone", () => {
    expect(withListedContextWindow(template, undefined)).toBe(template);
    const image = providerSetupModels("openai_compatible", codexEndpoint)
      .find(({ configuration }) => configuration.modelClass === "image")!.configuration;
    expect(withListedContextWindow(image, 500_000)).toBe(image);
  });
});
