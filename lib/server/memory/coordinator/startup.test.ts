import { Prisma } from "@prisma/client";
import { reportSubsystemHealthy } from "../../observability";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryCoordinatorStartupError,
  listRequiredMemorySuppressionKeyIds,
  startMemoryCoordinatorFeatureLocally
} from "./startup";

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
    const reconcileDeletionAudits = vi.fn(async () => undefined);
    const result = await startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING:
          `current=v2,v1=${KEY_V1},v2=${KEY_V2}`
      },
      listRequiredKeyIds: async () => ["v2", "v1", "v1"],
      reconcileDeletionAudits,
      start
    });

    expect(result).toEqual({ status: "ready" });
    expect(reconcileDeletionAudits).toHaveBeenCalledOnce();
    expect(reconcileDeletionAudits.mock.invocationCallOrder[0])
      .toBeLessThan(start.mock.invocationCallOrder[0]!);
    expect(start).toHaveBeenCalledOnce();
  });

  it("runs the worker capability preflight before reconciliation and start", async () => {
    const order: string[] = [];
    const result = await startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}`
      },
      listRequiredKeyIds: async () => [],
      preflight: async () => {
        order.push("preflight");
      },
      reconcileDeletionAudits: async () => {
        order.push("reconcile");
      },
      start: () => {
        order.push("start");
      }
    });

    expect(result).toEqual({ status: "ready" });
    expect(order).toEqual(["preflight", "reconcile", "start"]);
  });

  it("blocks when the registry or database capability preflight fails", async () => {
    const start = vi.fn();
    const result = await startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}`
      },
      listRequiredKeyIds: async () => [],
      preflight: async () => {
        throw new Error("database capability unavailable");
      },
      start
    });

    expect(result).toEqual({
      code: "memory_coordinator_startup_failed",
      missingKeyIds: [],
      status: "blocked"
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves a content-free explicit startup block code", async () => {
    const result = await startMemoryCoordinatorFeatureLocally({
      env: {
        AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}`
      },
      listRequiredKeyIds: async () => [],
      preflight: async () => {
        throw new MemoryCoordinatorStartupError(
          "memory_coordinator_registry_incomplete"
        );
      },
      start: vi.fn()
    });

    expect(result).toEqual({
      code: "memory_coordinator_registry_incomplete",
      missingKeyIds: [],
      status: "blocked"
    });
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


it("observes startup database failure at its read boundary and reports recovery without private key IDs", async () => {
  for (const stage of ["read", "preflight", "cleanup", "startup"] as const) reportSubsystemHealthy("memory", stage);
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const failure = new Prisma.PrismaClientKnownRequestError("PRIVATE_DB_KEY_IDS", {
    clientVersion: "test", code: "P1001", meta: { private: "PRIVATE_META" }
  });
  const findMany = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce([]);
  const input = {
    env: { AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}` },
    listRequiredKeyIds: () => listRequiredMemorySuppressionKeyIds({ memorySuppression: { findMany } } as never),
    start: vi.fn()
  };
  try {
    expect(await startMemoryCoordinatorFeatureLocally(input)).toMatchObject({ status: "blocked" });
    expect(input.start).not.toHaveBeenCalled();
    expect(await startMemoryCoordinatorFeatureLocally(input)).toEqual({ status: "ready" });
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: "runtime_lifecycle", subsystem: "memory", stage: "read",
      code: "memory_coordinator_startup_failed", prisma_code: "P1001", action: "stop" });
    expect(records[1]).toMatchObject({ event: "subsystem.recovered", subsystem: "memory", stage: "read" });
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    expect(JSON.stringify(records)).not.toContain(KEY_V1);
  } finally { writer.mockRestore(); }
});
