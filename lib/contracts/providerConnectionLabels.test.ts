import { describe, expect, it } from "vitest";
import { resolveProviderConnectionLabels } from "./providerConnectionLabels";

describe("provider connection labels", () => {
  it("preserves concise names when their normalized forms are unique", () => {
    const labels = resolveProviderConnectionLabels([
      { id: "connection-openai", name: "OpenAI" },
      { id: "connection-anthropic", name: "Anthropic enterprise" }
    ]);

    expect(labels.get("connection-openai")).toBe("OpenAI");
    expect(labels.get("connection-anthropic")).toBe("Anthropic enterprise");
  });

  it("disambiguates case and whitespace-equivalent names without exposing raw ids", () => {
    const firstId = "018f6ca8-2222-7e4a-a0c2-111111111111";
    const secondId = "018f6ca8-3333-7e4a-a0c2-222222222222";
    const labels = resolveProviderConnectionLabels([
      { id: firstId, name: "OpenAI" },
      { id: secondId, name: "  openai  " }
    ]);

    expect(labels.get(firstId)).toMatch(/^OpenAI · ref [0-9A-Z]{6,}$/u);
    expect(labels.get(secondId)).toMatch(/^  openai   · ref [0-9A-Z]{6,}$/u);
    expect(labels.get(firstId)).not.toBe(labels.get(secondId));
    expect([...labels.values()].join(" ")).not.toContain(firstId);
    expect([...labels.values()].join(" ")).not.toContain(secondId);
  });

  it("keeps each connection reference stable when catalog order changes", () => {
    const sources = [
      { id: "connection-b", name: "Shared gateway" },
      { id: "connection-a", name: "Shared gateway" },
      { id: "connection-c", name: "Shared gateway" }
    ];

    expect([...resolveProviderConnectionLabels(sources).entries()].sort()).toEqual(
      [...resolveProviderConnectionLabels([...sources].reverse()).entries()].sort()
    );
  });
});
