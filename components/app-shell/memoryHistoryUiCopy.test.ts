import { describe, expect, it } from "vitest";
import {
  MEMORY_HISTORY_UI_COPY_KEYS,
  memoryHistoryUiCopy
} from "./memoryHistoryUiCopy";

describe("Memory history UI copy", () => {
  it("provides every bounded search state", () => {
    for (const key of MEMORY_HISTORY_UI_COPY_KEYS) {
      expect(memoryHistoryUiCopy(key).trim()).not.toBe("");
    }
  });
});
