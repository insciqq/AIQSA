import { describe, expect, it } from "vitest";
import {
  MEMORY_ACTION_INTENT_MAX_SOURCE_TEXT_LENGTH,
  MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH
} from "../../../contracts/memoryActionIntent";
import {
  MEMORY_ACTION_ADMISSION_VERSION,
  admitMemoryAction,
  hasExplicitMemoryCommandBoundary,
  memoryActionControlAdmitted
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
      expect(hasExplicitMemoryCommandBoundary(text)).toBe(true);
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

  it.each([
    ["a trailing directive", `${"Background notes. ".repeat(130)}Please remember that I prefer tea.`],
    ["a Unicode trailing directive", `${"Заметки о поездке 🧳. ".repeat(110)}Запомни, что я люблю чай.`],
    ["a quoted instruction", `${"Log line. ".repeat(220)}He wrote: «remember his address».`]
  ])("sends a turn beyond the statement bound with %s to semantic control", (_label, text) => {
    expect(text.length).toBeGreaterThan(MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH);
    expect(admitMemoryAction(text)).toEqual({
      reason: "CURRENT_USER_TEXT",
      state: "SEMANTIC_CANDIDATE",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
    expect(memoryActionControlAdmitted(admitMemoryAction(text), true)).toBe(false);
    expect(memoryActionControlAdmitted(admitMemoryAction(text), false)).toBe(true);
  });

  it("keeps a long explicit command at its protocol boundary", () => {
    const text = `/memory ${"context ".repeat(300)}forget my old address`;
    expect(admitMemoryAction(text)).toMatchObject({
      reason: "MEMORY_COMMAND",
      state: "EXPLICIT_CANDIDATE"
    });
    expect(memoryActionControlAdmitted(admitMemoryAction(text), true)).toBe(true);
  });

  it("reports a turn beyond the source budget as too long without classifying a prefix", () => {
    const text = "x".repeat(MEMORY_ACTION_INTENT_MAX_SOURCE_TEXT_LENGTH);
    expect(admitMemoryAction(text).state).toBe("SEMANTIC_CANDIDATE");
    const tooLong = admitMemoryAction(`/memory ${text}`);
    expect(hasExplicitMemoryCommandBoundary(`/memory ${text}`)).toBe(true);
    expect(tooLong).toEqual({
      reason: "INPUT_TOO_LONG",
      state: "INPUT_TOO_LONG",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
    expect(admitMemoryAction("", { sourceTooLong: true })).toEqual(tooLong);
    expect(memoryActionControlAdmitted(tooLong, true)).toBe(false);
    expect(memoryActionControlAdmitted(tooLong, false)).toBe(false);
  });
});
