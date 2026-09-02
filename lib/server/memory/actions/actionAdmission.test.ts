import { describe, expect, it } from "vitest";
import {
  MEMORY_ACTION_ADMISSION_VERSION,
  admitMemoryAction
} from "./actionAdmission";

describe("Memory action admission", () => {
  it.each([
    "/memory save I prefer concise answers",
    "Remember that I prefer concise answers.",
    "Please forget what I said about my old address.",
    "Change my name to Dmitry.",
    "Change one of my saved reporting-format preferences.",
    "Show my saved memories.",
    "List my memories.",
    "Search my memories for reporting preferences.",
    "Reset my memory.",
    "Use this preference in future conversations.",
    "Запомни, что я предпочитаю короткие ответы.",
    "Пожалуйста, забудь мой старый адрес.",
    "Измени одно из моих сохранённых предпочтений.",
    "Покажи сохранённые воспоминания из памяти.",
    "Recuerda que prefiero respuestas breves.",
    "Por favor, olvida mi dirección anterior.",
    "Cambia uno de mis recuerdos guardados.",
    "Zapamti da volim kratke odgovore.",
    "Molim te, zaboravi moju staru adresu.",
    "Izmeni jednu od mojih sačuvanih postavki.",
    "Запамти да волим кратке одговоре."
  ])("admits an explicit action candidate without choosing its action: %s", (text) => {
    expect(admitMemoryAction(text)).toEqual({
      reason: expect.stringMatching(/^(?:MEMORY_COMMAND|NATURAL_LANGUAGE_DIRECTIVE)$/u),
      state: "EXPLICIT_CANDIDATE",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  });

  it.each([
    "What do you remember about me?",
    "Remember when we discussed the launch plan?",
    "Can you remember my favorite color?",
    "List every trip I took last year.",
    "Search the web for memory allocators.",
    "I forgot where we first met.",
    "Explain how saved Memory works.",
    "Change the page layout.",
    "Update npm dependencies.",
    "Reset the network router.",
    "I prefer concise answers.",
    "Что ты помнишь о моих предпочтениях?",
    "Перечисли все мои поездки за прошлый год.",
    "¿Recuerdas dónde nos conocimos?",
    "Prikaži kako radi memorija računara."
  ])("keeps an ordinary or ambiguous request on the read-only path: %s", (text) => {
    expect(admitMemoryAction(text)).toEqual({
      reason: "NO_DIRECTIVE",
      state: "ORDINARY",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  });
});
