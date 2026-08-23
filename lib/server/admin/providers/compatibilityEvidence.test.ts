import { describe, expect, it } from "vitest";
import {
  decodeAdminProviderCompatibilityEvidence,
  unsupportedAdminProviderCompatibilityEvidence
} from "./compatibilityEvidence";

const verified = {
  directPdf: "verified",
  modelAccess: "verified",
  probeVersion: 1,
  streaming: "verified",
  structuredOutput: "verified",
  usage: "verified"
} as const;

describe("administrator provider compatibility evidence", () => {
  it("decodes only the bounded binary compatibility contract", () => {
    expect(decodeAdminProviderCompatibilityEvidence(verified)).toEqual(verified);
    expect(decodeAdminProviderCompatibilityEvidence({
      ...verified,
      directPdf: "unknown"
    })).toBeNull();
    expect(decodeAdminProviderCompatibilityEvidence({
      ...verified,
      probeVersion: 2
    })).toBeNull();
    expect(decodeAdminProviderCompatibilityEvidence({
      ...verified,
      usage: undefined
    })).toBeNull();
  });

  it("creates an all-negative result for an unavailable exact tuple", () => {
    expect(unsupportedAdminProviderCompatibilityEvidence()).toEqual({
      directPdf: "not_supported",
      modelAccess: "not_supported",
      probeVersion: 1,
      streaming: "not_supported",
      structuredOutput: "not_supported",
      usage: "not_supported"
    });
  });
});
