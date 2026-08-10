import {
  MEMORY_UI_COPY,
  MEMORY_UI_COPY_KEYS,
  memoryFactStateLabel,
  memoryModalityLabel,
  memoryReceiptItemTypeLabel,
  memoryReceiptLifecycleLabel,
  memoryReceiptScopeLabel,
  memoryReceiptSourceModeLabel,
  memoryReceiptUsageLabel,
  memorySensitivityLabel,
  memoryUiCopy
} from "./memoryUiCopy";
import {
  MEMORY_FACT_STATES,
  MEMORY_MODALITIES,
  MEMORY_RECEIPT_ITEM_TYPES,
  MEMORY_RECEIPT_LIFECYCLE_STATES,
  MEMORY_SCOPE_TYPES,
  MEMORY_SENSITIVITY_CLASSES,
  MEMORY_UI_LOCALES
} from "@/lib/contracts/memory";
import { describe, expect, it } from "vitest";

describe("Memory UI copy", () => {
  it("has exact non-blank RU/EN parity without fallback", () => {
    expect(Object.keys(MEMORY_UI_COPY).sort()).toEqual([...MEMORY_UI_LOCALES].sort());
    for (const locale of MEMORY_UI_LOCALES) {
      expect(Object.keys(MEMORY_UI_COPY[locale]).sort()).toEqual([...MEMORY_UI_COPY_KEYS].sort());
      for (const key of MEMORY_UI_COPY_KEYS) {
        expect(memoryUiCopy(locale, key).trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("localizes every visible fact enum in both locales", () => {
    for (const locale of MEMORY_UI_LOCALES) {
      for (const state of MEMORY_FACT_STATES) expect(memoryFactStateLabel(locale, state)).toBeTruthy();
      for (const modality of MEMORY_MODALITIES) expect(memoryModalityLabel(locale, modality)).toBeTruthy();
      for (const sensitivity of MEMORY_SENSITIVITY_CLASSES) {
        expect(memorySensitivityLabel(locale, sensitivity)).toBeTruthy();
      }
      for (const itemType of MEMORY_RECEIPT_ITEM_TYPES) {
        expect(memoryReceiptItemTypeLabel(locale, itemType)).toBeTruthy();
      }
      for (const lifecycle of MEMORY_RECEIPT_LIFECYCLE_STATES) {
        expect(memoryReceiptLifecycleLabel(locale, lifecycle)).toBeTruthy();
      }
      for (const scope of MEMORY_SCOPE_TYPES) {
        expect(memoryReceiptScopeLabel(locale, scope)).toBeTruthy();
      }
      for (const source of ["EXPLICIT", "AUTOMATIC", "HISTORY", "PROFILE"] as const) {
        expect(memoryReceiptSourceModeLabel(locale, source)).toBeTruthy();
      }
    }
  });

  it("summarizes reusable Memory and distinct previous-chat sources", () => {
    const receipt = {
      degradationCode: null,
      itemCount: 3,
      items: [{
        includedText: "Saved preference",
        itemType: "FACT_VERSION" as const,
        lifecycleState: "CURRENT" as const,
        ordinal: 0,
        scopeType: "GLOBAL_USER" as const,
        selectionReason: "exact",
        sourceChatId: null,
        sourceMessageIds: [],
        sourceMode: "EXPLICIT" as const,
        versionId: "version-1"
      }, {
        includedText: "Previous episode",
        itemType: "EPISODE" as const,
        lifecycleState: "CURRENT" as const,
        ordinal: 1,
        scopeType: "CHAT" as const,
        selectionReason: "history_episode_fts",
        sourceChatId: "source-chat",
        sourceMessageIds: ["message-1"],
        sourceMode: "HISTORY" as const,
        versionId: null
      }, {
        includedText: "Previous excerpt",
        itemType: "RECALL_CHUNK" as const,
        lifecycleState: "CURRENT" as const,
        ordinal: 2,
        scopeType: "CHAT" as const,
        selectionReason: "history_recall_fts",
        sourceChatId: "source-chat",
        sourceMessageIds: ["message-2"],
        sourceMode: "HISTORY" as const,
        versionId: null
      }],
      outcome: "USED" as const,
      summary: "memory_receipt:used:3"
    };

    expect(memoryReceiptUsageLabel("EN", receipt))
      .toBe("1 memory and 1 previous chat used");
    expect(memoryReceiptUsageLabel("RU", receipt))
      .toBe("Использовано: 1 воспоминание и 1 предыдущий чат");
  });
});
