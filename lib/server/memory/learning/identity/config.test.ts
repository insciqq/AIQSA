import { describe, expect, it } from "vitest";
import {
  MEMORY_IDENTITY_WRITE_PROFILE_ENV,
  loadMemoryIdentityWriteProfile
} from "./config";
import {
  memoryPropositionCanonicalKey,
  normalizeMemoryIdentityComponent
} from "./normalization";

describe("Memory identity write profile", () => {
  it.each([undefined, "", "  ", "UNICODE_V2"])(
    "preserves complete identity for newly admitted source text (%#)", (configured) => {
      const profile = loadMemoryIdentityWriteProfile({
        [MEMORY_IDENTITY_WRITE_PROFILE_ENV]: configured
      });
      const labels = [
        "project 東京", "project 大阪", "report café", "report cafè",
        "tag красный", "tag синий"
      ];
      const keys = labels.map((label) =>
        normalizeMemoryIdentityComponent("fixture", label, profile));
      expect(keys.every((key) => key !== null)).toBe(true);
      expect(new Set(keys).size).toBe(labels.length);
      expect(memoryPropositionCanonicalKey("Ёлка", profile))
        .not.toBe(memoryPropositionCanonicalKey("Елка", profile));
    }
  );

  it("rejects selecting a retired profile for new work", () => {
    expect(() => loadMemoryIdentityWriteProfile({
      [MEMORY_IDENTITY_WRITE_PROFILE_ENV]: "LEGACY_V1"
    })).toThrow("memory_identity_profile_environment_invalid");
  });

  it("fails closed for an unknown profile", () => {
    expect(() => loadMemoryIdentityWriteProfile({
      [MEMORY_IDENTITY_WRITE_PROFILE_ENV]: "best_effort"
    })).toThrow("memory_identity_profile_environment_invalid");
  });
});
