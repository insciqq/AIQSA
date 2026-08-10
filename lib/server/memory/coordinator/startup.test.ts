import { describe, expect, it, vi } from "vitest";
import { startMemoryCoordinatorFeatureLocally } from "./startup";

function encodedKey(offset: number): string {
  return Buffer.from(
    Array.from({ length: 32 }, (_, index) => (index + offset) % 256)
  ).toString("base64");
}

const KEY_V1 = encodedKey(17);
const KEY_V2 = encodedKey(83);

describe("Memory coordinator feature-local startup", () => {
  it("starts only after every referenced suppression key passes preflight", async () => {
    const start = vi.fn();
    const result = await startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING:
          `current=v2,v1=${KEY_V1},v2=${KEY_V2}`
      },
      listRequiredKeyIds: async () => ["v2", "v1", "v1"],
      start
    });

    expect(result).toEqual({ status: "ready" });
    expect(start).toHaveBeenCalledOnce();
  });

  it("blocks missing historical keys without starting or exposing key material", async () => {
    const start = vi.fn();
    const result = await startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v2,v2=${KEY_V2}`
      },
      listRequiredKeyIds: async () => ["v1"],
      start
    });

    expect(result).toEqual({
      code: "memory_suppression_historical_key_missing",
      missingKeyIds: ["v1"],
      status: "blocked"
    });
    expect(start).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(KEY_V2);
  });

  it("contains invalid configuration, database failure, and startup failure", async () => {
    const start = vi.fn();
    await expect(startMemoryCoordinatorFeatureLocally({
      env: {},
      listRequiredKeyIds: async () => [],
      start
    })).resolves.toEqual({
      code: "memory_suppression_keyring_invalid",
      missingKeyIds: [],
      status: "blocked"
    });

    await expect(startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}`
      },
      listRequiredKeyIds: async () => {
        throw new Error("private database failure");
      },
      start
    })).resolves.toEqual({
      code: "memory_coordinator_startup_failed",
      missingKeyIds: [],
      status: "blocked"
    });

    await expect(startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}`
      },
      listRequiredKeyIds: async () => [],
      start: () => {
        throw new Error("private startup failure");
      }
    })).resolves.toEqual({
      code: "memory_coordinator_startup_failed",
      missingKeyIds: [],
      status: "blocked"
    });
    expect(start).not.toHaveBeenCalled();
  });
});
