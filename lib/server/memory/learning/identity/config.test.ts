import { describe, expect, it } from "vitest";
import {
  MEMORY_IDENTITY_WRITE_PROFILE_ENV,
  loadMemoryIdentityWriteProfile
} from "./config";

describe("Memory identity write profile", () => {
  it("defaults safely to legacy until explicit Unicode activation", () => {
    expect(loadMemoryIdentityWriteProfile({})).toBe("LEGACY_V1");
    expect(loadMemoryIdentityWriteProfile({
      [MEMORY_IDENTITY_WRITE_PROFILE_ENV]: "UNICODE_V2"
    })).toBe("UNICODE_V2");
  });

  it("fails closed for an unknown profile", () => {
    expect(() => loadMemoryIdentityWriteProfile({
      [MEMORY_IDENTITY_WRITE_PROFILE_ENV]: "best_effort"
    })).toThrow("memory_identity_profile_environment_invalid");
  });
});
