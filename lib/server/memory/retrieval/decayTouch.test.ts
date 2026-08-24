import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  runMemoryDecayTouchWithRetry,
  touchFrozenMemoryPack
} from "./decayTouch";

describe("frozen Memory decay touch", () => {
  it("rejects ambiguous or missing durable identities before repository access", async () => {
    const client = {} as PrismaClient;
    await expect(touchFrozenMemoryPack(client, { userId: "user-1" }))
      .rejects.toThrow("memory_decay_touch_input_invalid");
    await expect(touchFrozenMemoryPack(client, {
      bindingId: "binding-1",
      modelRunId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("memory_decay_touch_input_invalid");
  });

  it("does not inspect frozen items when the admitted setting was disabled", async () => {
    const findMany = vi.fn();
    const client = {
      modelRunMemoryBinding: {
        findFirst: vi.fn(async () => ({
          id: "binding-1",
          settingsSnapshot: {
            acceptedUtilityEgressFingerprint: null,
            acceptedUtilityPolicyVersion: null,
            activeIndexGenerationId: null,
            decayEnabled: false,
            decayPolicyVersion: null,
            learnAutomatically: false,
            memoryConsentRevision: 0,
            referenceChatHistory: false,
            schemaVersion: 2,
            settingsRevision: 0,
            useMemoryFacts: true
          }
        }))
      },
      modelRunMemoryItem: { findMany }
    } as unknown as PrismaClient;

    await expect(touchFrozenMemoryPack(client, {
      bindingId: "binding-1",
      userId: "user-1"
    })).resolves.toEqual({ eligibleItems: 0, touchedItems: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("bounds post-answer retry and isolates a permanent touch failure", async () => {
    const failed = vi.fn(async () => { throw new Error("database unavailable"); });
    await expect(runMemoryDecayTouchWithRetry(failed, 100)).resolves.toBe(false);
    expect(failed).toHaveBeenCalledTimes(2);

    const transient = vi.fn()
      .mockRejectedValueOnce(new Error("serialization failure"))
      .mockResolvedValueOnce(undefined);
    await expect(runMemoryDecayTouchWithRetry(transient, 2)).resolves.toBe(true);
    expect(transient).toHaveBeenCalledTimes(2);
  });
});
