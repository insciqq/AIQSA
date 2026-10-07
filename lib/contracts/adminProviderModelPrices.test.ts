import { describe, expect, it } from "vitest";
import { ADMIN_MODEL_PRICE_FIELDS, decodeAdminModelPriceChange, decodeAdminModelPricing, decodeAdminModelTokenPrices,
  EMPTY_ADMIN_MODEL_PRICES, invalidAdminModelPriceField, isAdminModelPriceField, modelClassPriceFields,
  normalizeAdminModelPrice } from "./adminProviderModelPrices";
import { decodeAdminProviderModelSaveReceipt } from "./adminProviderModelSave";

describe("exact admin model prices", () => {
  it.each([["0.25", "0.25"], ["0.025", "0.025"], ["000.25000000", "0.25"],
    ["0", "0"], ["0.00000001", "0.00000001"], ["9999999999.99999999", "9999999999.99999999"], [null, null]])(
    "preserves %s without floating-point conversion", (value, expected) => expect(normalizeAdminModelPrice(value)).toBe(expected));
  it.each(["-1", "+1", "1e3", "1e-3", "NaN", "Infinity", "0.000000001", "10000000000", "", " ", " 0.25", 0.25, NaN, Infinity, {}, []])(
    "rejects unsupported decimal input %j", value => expect(normalizeAdminModelPrice(value)).toBeUndefined());
  it("requires complete known fields and keeps restore authority out of client input", () => {
    expect(decodeAdminModelTokenPrices(EMPTY_ADMIN_MODEL_PRICES)).toEqual(EMPTY_ADMIN_MODEL_PRICES);
    expect(decodeAdminModelTokenPrices({ ...EMPTY_ADMIN_MODEL_PRICES, source: "admin" })).toBeNull();
    expect(decodeAdminModelTokenPrices({ inputTokenPriceUsdPerMillion: "1" })).toBeNull();
    expect(decodeAdminModelPriceChange({ mode: "restore_catalog" })).toEqual({ mode: "restore_catalog" });
    for (const patch of [{ source: "catalog" }, { templateKey: "openai:gpt-5.5" }, { prices: EMPTY_ADMIN_MODEL_PRICES }]) {
      expect(decodeAdminModelPriceChange({ mode: "restore_catalog", ...patch })).toBeNull();
    }
    expect(decodeAdminModelPricing({ prices: EMPTY_ADMIN_MODEL_PRICES, source: "admin", catalogPrices: null })).not.toBeNull();
  });
  it("gives each model class only the token prices it can be costed with", () => {
    expect(modelClassPriceFields("answer")).toEqual(ADMIN_MODEL_PRICE_FIELDS);
    for (const modelClass of ["decision", "image"]) {
      expect(modelClassPriceFields(modelClass)).toEqual(["inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion"]);
    }
    for (const modelClass of ["embedding", "reranker"]) expect(modelClassPriceFields(modelClass)).toEqual(["inputTokenPriceUsdPerMillion"]);
    for (const modelClass of ["", "Answer", "search", "constructor"]) expect(modelClassPriceFields(modelClass)).toEqual([]);
  });
  it("names the first rejected price field of a manual change", () => {
    const prices = { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "0.25" };
    expect(invalidAdminModelPriceField({ mode: "manual", prices: { ...prices, cacheWriteInputTokenPriceUsdPerMillion: "1e3", outputTokenPriceUsdPerMillion: -1 } }))
      .toBe("cacheWriteInputTokenPriceUsdPerMillion");
    expect(invalidAdminModelPriceField({ mode: "manual", prices: { ...prices, outputTokenPriceUsdPerMillion: 2 } })).toBe("outputTokenPriceUsdPerMillion");
    for (const value of [{ mode: "manual", prices }, { mode: "restore_catalog" }, { mode: "manual" }, null, "manual"]) {
      expect(invalidAdminModelPriceField(value)).toBeNull();
    }
    expect(isAdminModelPriceField("outputTokenPriceUsdPerMillion")).toBe(true);
    for (const value of ["timeout", undefined, null, 1]) expect(isAdminModelPriceField(value)).toBe(false);
  });
  it("requires a complete price acknowledgement for a metadata receipt", () => {
    const receipt = { connectionId: "connection", modelId: "model", displayName: "Model", draftVersion: 1,
      saved: "metadata", publication: "not_requested", checks: "not_requested" };
    expect(decodeAdminProviderModelSaveReceipt(receipt)).toBeNull();
    expect(decodeAdminProviderModelSaveReceipt({ ...receipt,
      pricing: { prices: EMPTY_ADMIN_MODEL_PRICES, source: "admin", catalogPrices: null } })).not.toBeNull();
    expect(decodeAdminProviderModelSaveReceipt({ ...receipt, pricing: { prices: EMPTY_ADMIN_MODEL_PRICES, source: "admin" } })).toBeNull();
  });
});
