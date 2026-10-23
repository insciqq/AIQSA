import { describe, expect, it, vi } from "vitest";
import { createDetachedCompactions, DETACHED_COMPACTION, detachedCompactions, transcriptTargetKey } from "./detachedCompactions";

const target = { model: "gpt-6.1-sol", provider: "connection-1" };

function entry(chatId: string, job: object, extra: Partial<{ targetKey: string; userId: string }> = {}) {
  return { chatId, job, stop: vi.fn(), targetKey: extra.targetKey ?? transcriptTargetKey(target), userId: extra.userId ?? "user" };
}

describe("detached compactions", () => {
  it("keep one compaction per chat: a later one stops the earlier", () => {
    const onFirstAdd = vi.fn();
    const registry = createDetachedCompactions({ onFirstAdd });
    const first = entry("chat", {});
    const second = entry("chat", {});
    registry.add(first);
    registry.add(second);
    expect(first.stop).toHaveBeenCalledWith("compaction_superseded");
    expect(second.stop).not.toHaveBeenCalled();
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBe(second);
    expect(onFirstAdd).toHaveBeenCalledTimes(1);
  });

  it("are joined only by the same user on the same route, model and replay rules", () => {
    const registry = createDetachedCompactions();
    registry.add(entry("chat", {}));
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "other" })).toBeNull();
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey({ ...target, model: "gpt-6-astra" }), userId: "user" }))
      .toBeNull();
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey({ ...target, nativeCompaction: true }), userId: "user" }))
      .toBeNull();
    expect(registry.find({ chatId: "other", targetKey: transcriptTargetKey(target), userId: "user" })).toBeNull();
  });

  it("forget a compaction only for itself, and stop them all at shutdown", () => {
    const registry = createDetachedCompactions();
    const job = {};
    const listed = entry("chat", job);
    registry.add(listed);
    registry.remove("chat", {});
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBe(listed);
    registry.remove("chat", job);
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBeNull();
    const a = entry("a", {});
    const b = entry("b", {});
    registry.add(a);
    registry.add(b);
    registry.stopAll("compaction_shutdown");
    expect(a.stop).toHaveBeenCalledWith("compaction_shutdown");
    expect(b.stop).toHaveBeenCalledWith("compaction_shutdown");
    expect(registry.find({ chatId: "a", targetKey: transcriptTargetKey(target), userId: "user" })).toBeNull();
  });

  it("keep a finished compaction listed for a while with nothing left to stop", () => {
    vi.useFakeTimers();
    try {
      const registry = createDetachedCompactions();
      const job = {};
      const listed = entry("chat", job);
      registry.add(listed);
      registry.finish("chat", {});
      expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBe(listed);
      registry.finish("chat", job);
      const finished = registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" });
      expect(finished).toMatchObject({ chatId: "chat", job, userId: "user" });
      // A later compaction of the chat replaces it without stopping anything.
      finished!.stop("compaction_superseded");
      expect(listed.stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(DETACHED_COMPACTION.keepMs - 1);
      expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBe(finished);
      vi.advanceTimersByTime(1);
      expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBeNull();
      // Its expiry never removes a compaction that replaced it.
      const replaced = {};
      registry.add(entry("chat", replaced));
      registry.finish("chat", replaced);
      const newer = entry("chat", {});
      registry.add(newer);
      vi.advanceTimersByTime(DETACHED_COMPACTION.keepMs);
      expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(target), userId: "user" })).toBe(newer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("are one registry for the whole process, whichever route bundle loads it", async () => {
    const again = await import("./detachedCompactions");
    expect(again.detachedCompactions).toBe(detachedCompactions);
    expect((globalThis as { __aiqsaDetachedCompactions?: unknown }).__aiqsaDetachedCompactions).toBe(detachedCompactions);
  });
});
