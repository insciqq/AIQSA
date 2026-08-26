import { describe, expect, it } from "vitest";
import {
  MEMORY_HISTORY_BACKFILL_MAX_PARALLELISM,
  MEMORY_HISTORY_BACKFILL_MAX_WINDOW,
  MEMORY_HISTORY_BACKFILL_WINDOW,
  resolveMemoryHistoryBackfillWindow
} from "./backfill";

describe("Memory history backfill concurrency", () => {
  it("does not underfeed configured per-user worker parallelism", () => {
    expect(resolveMemoryHistoryBackfillWindow(1))
      .toBe(MEMORY_HISTORY_BACKFILL_WINDOW);
    expect(resolveMemoryHistoryBackfillWindow(10)).toBe(40);
    expect(resolveMemoryHistoryBackfillWindow(MEMORY_HISTORY_BACKFILL_MAX_PARALLELISM))
      .toBe(MEMORY_HISTORY_BACKFILL_MAX_WINDOW);
  });

  it.each([0, 1.5, MEMORY_HISTORY_BACKFILL_MAX_PARALLELISM + 1])(
    "rejects invalid per-user parallelism %s",
    (parallelism) => {
      expect(() => resolveMemoryHistoryBackfillWindow(parallelism))
        .toThrow("memory_history_backfill_window_invalid");
    }
  );
});
