import { describe, expect, it } from "vitest";
import { decodeNativeRouteAdoptionDiagnostic, nativeRouteAdoptionStatus } from "./nativeRoutingAdoption";

describe("native route adoption diagnostics", () => {
  const diagnostic = { version: 1, stage: "modelAccess", code: "http_error", servingMode: "automatic",
    provider: "deepseek", httpStatus: 404, missing: ["modelAccess"], previouslyUnverified: ["directPdf"] };

  it("keeps a rejected route separate from active model availability and does not invent legacy evidence", () => {
    expect(nativeRouteAdoptionStatus("native_incompatible", diagnostic)).toEqual({ reason: "native_incompatible", diagnostic });
    expect(nativeRouteAdoptionStatus("native_incompatible", null)).toEqual({ reason: "native_incompatible" });
    expect(nativeRouteAdoptionStatus("applied", diagnostic)).toBeUndefined();
  });

  it.each([
    { message: "PRIVATE_RAW_BODY" }, { provider: "https://private.invalid/key" }, { code: "PRIVATE_RAW_BODY" },
    { missing: ["PRIVATE_MODEL_PATH"] }, { previouslyUnverified: ["PRIVATE_KEY"] }, { httpStatus: 200 },
    { httpStatus: 999 }, { stage: "PRIVATE_PATH" }, { servingMode: "only_selected" }
  ])("rejects noncanonical fields: %j", (invalid) => {
    expect(decodeNativeRouteAdoptionDiagnostic({ ...diagnostic, ...invalid })).toBeNull();
    expect(JSON.stringify(nativeRouteAdoptionStatus("native_incompatible", { ...diagnostic, ...invalid }))).not.toContain("PRIVATE");
  });
});
