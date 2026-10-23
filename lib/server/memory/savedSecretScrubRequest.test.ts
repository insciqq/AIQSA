import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE,
  requestMemorySavedSecretScrub
} from "./savedSecretScrubRequest";

const TOKEN = "tok_demo_7f3a9c21b8e4";

function tx(input: Readonly<{ held?: boolean; settings?: boolean }> = {}) {
  return {
    $queryRaw: vi.fn(async () => [{ held: input.held ?? true }]),
    memoryDeletionOutbox: { create: vi.fn(async () => ({})) },
    userMemorySettings: {
      findUnique: vi.fn(async () => input.settings === false ? null : { memoryGeneration: 3 })
    }
  };
}

describe("saved secret scrub request", () => {
  it("records one value-free obligation for a screened value when the owner's Memory holds anything", async () => {
    const db = tx();
    await expect(requestMemorySavedSecretScrub(db as never, {
      name: "DEMO_API_TOKEN", revisionId: "revision-1", userId: "user-1", value: { kind: "text", text: TOKEN }
    })).resolves.toBe(true);
    expect(db.memoryDeletionOutbox.create).toHaveBeenCalledWith({ data: {
      memoryGeneration: 3,
      operation: "SOURCE_PURGE",
      targetId: "revision-1",
      targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE,
      userId: "user-1"
    } });
    expect(JSON.stringify(db.memoryDeletionOutbox.create.mock.calls)).not.toContain(TOKEN);
  });

  it("records nothing for a plain value, an owner without Memory or an empty Memory", async () => {
    const plain = tx();
    await expect(requestMemorySavedSecretScrub(plain as never, {
      name: "Env", revisionId: "revision-1", userId: "user-1",
      value: { entries: [{ name: "DB_HOST", value: "localhost" }], kind: "env" }
    })).resolves.toBe(false);
    expect(plain.userMemorySettings.findUnique).not.toHaveBeenCalled();
    for (const db of [tx({ settings: false }), tx({ held: false })]) {
      await expect(requestMemorySavedSecretScrub(db as never, {
        name: "Token", revisionId: "revision-1", userId: "user-1", value: { kind: "text", text: TOKEN }
      })).resolves.toBe(false);
      expect(db.memoryDeletionOutbox.create).not.toHaveBeenCalled();
    }
  });
});
