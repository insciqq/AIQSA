import { describe, expect, it } from "vitest";
import { decodeUserImageModelChoice, decodeUserImageModelSettings } from "./imageModels";

const model = { id: "image-1", displayName: "GPT Image 2", providerName: "OpenAI", generation: true, editing: false, unavailableReason: null };
const other = { ...model, id: "image-2", displayName: "Nano Banana", providerName: "Gemini", editing: true, unavailableReason: "verification_required" };

describe("user image model contract", () => {
  it("derives the effective model from the personal choice or the organization default", () => {
    const following = { models: [model, other], organizationDefaultId: "image-1", selectedId: null,
      effective: { id: "image-1", source: "organization" } };
    expect(decodeUserImageModelSettings(following)).toEqual(following);
    const chosen = { ...following, selectedId: "image-2", effective: { id: "image-2", source: "personal" } };
    expect(decodeUserImageModelSettings(chosen)).toEqual(chosen);
    const none = { models: [], organizationDefaultId: null, selectedId: null, effective: null };
    expect(decodeUserImageModelSettings(none)).toEqual(none);
  });

  it.each([
    { organizationDefaultId: "unpublished" },
    { selectedId: "unpublished", effective: { id: "unpublished", source: "personal" } },
    { effective: { id: "image-2", source: "organization" } },
    { effective: { id: "image-1", source: "personal" } },
    { effective: null },
    { models: [model, model] },
    { models: [{ ...model, unavailableReason: "maybe" }] },
    { models: [{ ...model, generation: "yes" }] },
    { models: [{ ...model, displayName: "" }] }
  ])("rejects a projection that would guess or substitute a model: %j", (patch) => {
    expect(decodeUserImageModelSettings({ models: [model, other], organizationDefaultId: "image-1", selectedId: null,
      effective: { id: "image-1", source: "organization" }, ...patch })).toBeNull();
  });

  it("accepts only one published model id or null as a save", () => {
    expect(decodeUserImageModelChoice({ providerModelId: "image-1" })).toEqual({ providerModelId: "image-1" });
    expect(decodeUserImageModelChoice({ providerModelId: null })).toEqual({ providerModelId: null });
    for (const value of [null, {}, { providerModelId: "" }, { providerModelId: " image-1" }, { providerModelId: 7 },
      { providerModelId: "image-1", parameters: { quality: "high" } }, { providerModelId: "x".repeat(257) }]) {
      expect(decodeUserImageModelChoice(value)).toBeNull();
    }
  });
});
