import {
  MEMORY_UI_COPY,
  MEMORY_UI_COPY_KEYS,
  memoryFactStateLabel,
  memoryModalityLabel,
  memorySensitivityLabel,
  memoryUiCopy
} from "./memoryUiCopy";
import {
  MEMORY_FACT_STATES,
  MEMORY_MODALITIES,
  MEMORY_SENSITIVITY_CLASSES
} from "@/lib/contracts/memory";
import { describe, expect, it } from "vitest";

describe("Memory UI copy", () => {
  it("has non-blank English coverage without fallback", () => {
    for (const key of MEMORY_UI_COPY_KEYS) {
      expect(memoryUiCopy(key).trim(), key).not.toBe("");
    }
  });

  it("labels every visible fact enum", () => {
    for (const state of MEMORY_FACT_STATES) expect(memoryFactStateLabel(state)).toBeTruthy();
    for (const modality of MEMORY_MODALITIES) expect(memoryModalityLabel(modality)).toBeTruthy();
    for (const sensitivity of MEMORY_SENSITIVITY_CLASSES) {
      expect(memorySensitivityLabel(sensitivity)).toBeTruthy();
    }
  });
});
