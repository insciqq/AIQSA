import { describe, expect, it } from "vitest";
import {
  MAX_UTTERANCE_CHARACTERS,
  answerSpeech,
  chunkSpeech,
  detectSpeechLanguage,
  pickVoice,
  resolveFallbackLanguage
} from "./speechText";

describe("answerSpeech", () => {
  it("reads prose as sentences and announces code blocks, tables and formulas as skipped", () => {
    const speech = answerSpeech([
      "# Setup",
      "",
      "Install the **package** first",
      "",
      "```bash",
      "npm install --save something-long",
      "```",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "$$",
      "x^2 + y^2",
      "$$",
      "",
      "- First step",
      "- Second step.",
      "",
      "> Quoted note",
      "",
      "---"
    ].join("\n"), "en");

    expect(speech).toEqual({
      lang: "en",
      sentences: [
        "Setup.",
        "Install the package first.",
        "Code block skipped.",
        "Table skipped.",
        "Formula skipped.",
        "First step.",
        "Second step.",
        "Quoted note."
      ]
    });
    expect(speech.sentences.join(" ")).not.toContain("npm");
  });

  it("reads links as their text and drops citations, numbered markers and URLs", () => {
    const speech = answerSpeech(
      "See [the guide](https://example.com/guide) [1](https://a.example) and [K1] [[K2]] or https://www.example.org/x?y=1 now [K3].",
      "en"
    );
    expect(speech.sentences).toEqual(["See the guide and or example.org now."]);
  });

  it("replaces images with a spoken phrase", () => {
    expect(answerSpeech("Here: ![chart](https://example.com/c.png)", "en").sentences)
      .toEqual(["Here: (image skipped)."]);
  });

  it("detects a Russian answer and speaks its placeholders in Russian", () => {
    const speech = answerSpeech("Вот пример кода для API:\n\n```ts\nconst value = 1;\n```", "en-US");
    expect(speech).toEqual({
      lang: "ru-RU",
      sentences: ["Вот пример кода для API:", "Блок кода пропущен."]
    });
  });

  it("returns nothing to read when only punctuation or citations remain", () => {
    expect(answerSpeech("[K1] — …", "en").sentences).toEqual([]);
    expect(answerSpeech("   ", "en").sentences).toEqual([]);
  });
});

describe("detectSpeechLanguage", () => {
  it("chooses the dominant script", () => {
    expect(detectSpeechLanguage("Привет, это ответ про React", "en")).toBe("ru-RU");
    expect(detectSpeechLanguage("A long English answer with один word", "en-GB")).toBe("en-GB");
    expect(detectSpeechLanguage("12345", "de-DE")).toBe("de-DE");
  });
});

describe("resolveFallbackLanguage", () => {
  it("refines the document language by the browser's regional variant", () => {
    expect(resolveFallbackLanguage("en", ["ru-RU", "en-GB"])).toBe("en-GB");
    expect(resolveFallbackLanguage("en", ["ru-RU"])).toBe("en");
    expect(resolveFallbackLanguage("", ["de-DE"])).toBe("de-DE");
    expect(resolveFallbackLanguage(null, [])).toBe("en-US");
  });
});

describe("chunkSpeech", () => {
  it("packs sentences in order and keeps every utterance bounded", () => {
    const long = `${"word ".repeat(120).trim()}, and the tail of the sentence.`;
    const chunks = chunkSpeech(["One. Two.", "Three!", long, "Last one."]);

    expect(chunks[0]).toBe("One. Two. Three!");
    expect(chunks.every((chunk) => chunk.length <= MAX_UTTERANCE_CHARACTERS)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/gu, " ")).toBe(`One. Two. Three! ${long} Last one.`);
    expect(chunks.at(-1)).toMatch(/Last one\.$/u);
  });

  it("hard-cuts a single unbroken token", () => {
    const chunks = chunkSpeech(["x".repeat(500)], 200);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 100]);
  });
});

describe("pickVoice", () => {
  const voices = [
    { default: true, lang: "en-US", localService: true, name: "English" },
    { default: false, lang: "ru_RU", localService: false, name: "Remote Russian" },
    { default: false, lang: "ru-RU", localService: true, name: "Local Russian" },
    { default: false, lang: "uk-UA", localService: true, name: "Ukrainian" }
  ];

  it("prefers the exact tag, then on-device voices, then the primary language", () => {
    expect(pickVoice(voices, "ru-RU")?.name).toBe("Local Russian");
    expect(pickVoice(voices, "en-GB")?.name).toBe("English");
    expect(pickVoice(voices, "de-DE")).toBeNull();
    expect(pickVoice([], "ru-RU")).toBeNull();
  });
});
