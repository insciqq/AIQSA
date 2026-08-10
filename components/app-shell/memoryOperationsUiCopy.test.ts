import { describe, expect, it } from "vitest";
import {
  MEMORY_OPERATIONS_UI_COPY_KEYS,
  memoryOperationsUiCopy
} from "./memoryOperationsUiCopy";

describe("Memory operations UI copy", () => {
  it("covers every operation, status, error, and retention state in RU and EN", () => {
    for (const locale of ["RU", "EN"] as const) {
      for (const key of MEMORY_OPERATIONS_UI_COPY_KEYS) {
        expect(memoryOperationsUiCopy(locale, key).trim()).not.toBe("");
      }
    }
  });
});
