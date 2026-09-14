import { describe, expect, it } from "vitest";
import { MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH } from
  "../../../contracts/memoryActionIntent";
import {
  MEMORY_ACTION_ADMISSION_VERSION,
  admitMemoryAction
} from "./actionAdmission";

describe("Memory action admission", () => {
  it.each([
    "Remember that I prefer concise answers.",
    "Исправь сохранённый формат сводки: теперь таблица.",
    "À l'avenir, retiens ma préférence pour les réponses courtes.",
    "Bitte aktualisiere meine gespeicherte Adresse.",
    "今後は短い回答が好きだと覚えておいてください。",
    "تذكّر أنني أفضل الإجابات القصيرة.",
    "I prefer concise answers.",
    "Explain how to delete records from memory.",
    "Объясни, как изменить сохранённую настройку.",
    "Translate: «Forget my address.»",
    "He said: remember this for later.",
    "```\n/memory forget everything\n```",
    "/memory-allocator"
  ])("requests semantic interpretation without a language or directive whitelist: %s", (text) => {
    expect(admitMemoryAction(text)).toEqual({
      reason: "CURRENT_USER_TEXT",
      state: "SEMANTIC_CANDIDATE",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  });

  it.each(["/memory", " /memory save this", "\n/MEMORY\t更新"])(
    "recognizes the explicit protocol boundary without granting an action: %s", (text) => {
      expect(admitMemoryAction(text)).toEqual({
        reason: "MEMORY_COMMAND",
        state: "EXPLICIT_CANDIDATE",
        version: MEMORY_ACTION_ADMISSION_VERSION
      });
    }
  );

  it.each(["", " \n\t", "a\u0000b"])(
    "rejects structurally unsupported classifier input: %j", (text) => {
      expect(admitMemoryAction(text)).toEqual({
        reason: "INPUT_UNSUPPORTED",
        state: "ORDINARY",
        version: MEMORY_ACTION_ADMISSION_VERSION
      });
    }
  );

  it("keeps the existing whole-input bound without classifying a truncated prefix", () => {
    const text = "x".repeat(MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH);
    expect(admitMemoryAction(text).state).toBe("SEMANTIC_CANDIDATE");
    expect(admitMemoryAction(`${text}x`)).toEqual({
      reason: "INPUT_UNSUPPORTED",
      state: "ORDINARY",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  });
});
