import { describe, expect, it } from "vitest";
import { HOSTED_SEARCH_RECORD_CLOSING, HOSTED_SEARCH_RECORD_PREFIX, cleanAnswerText } from "./answerTextMarkers";

const RECORD = [
  `${HOSTED_SEARCH_RECORD_PREFIX} in this response you used the built-in web search.`,
  'Queries: "weather in Berlin [today]"; "berlin forecast"',
  "Sources it found:",
  '- "Berlin weather — Example" — https://weather.example.com/berlin',
  "- https://news.example.org/a?b=c",
  HOSTED_SEARCH_RECORD_CLOSING
].join("\n");

/** Every prefix of the text, as a stream that grows one character at a time would show it. */
function streamed(text: string): string[] {
  return Array.from({ length: text.length + 1 }, (_, size) => cleanAnswerText(text.slice(0, size), { partial: true }));
}

function expectCleanStream(text: string, expected: string) {
  const views = streamed(text);
  for (let index = 1; index < views.length; index += 1) {
    // What was shown is never taken back, and no part of a marker ever shows.
    expect(views[index]!.startsWith(views[index - 1]!), JSON.stringify(text.slice(0, index))).toBe(true);
    expect(views[index]).not.toMatch(/\[Rec|Record added|Queries:|cite|turn\d|||/u);
  }
  expect(cleanAnswerText(text)).toBe(expected);
  expect(expected.startsWith(views.at(-1)!)).toBe(true);
}

describe("answer text markers", () => {
  it("keeps ordinary text, including text that mentions the words", () => {
    const texts = [
      "Plain answer.",
      "Please cite the source; the turn of phrase was excited.",
      "Record added by the server, not part of your reply: quoted without the bracket.",
      "[Record] of the server [1]",
      "We cite turn 5 search results and recite turnips.",
      "A [link](https://example.com) and an array a[0].",
      "cite\nturn0search0"
    ];
    for (const text of texts) {
      expect(cleanAnswerText(text)).toBe(text);
      expect(cleanAnswerText(text, { partial: true })).toBe(text.replace(/[ \t]+$/u, ""));
    }
  });

  it("removes the server's record at the start, in the middle and at the end", () => {
    expect(cleanAnswerText(`${RECORD}\n\nThe forecast is sunny.`)).toBe("The forecast is sunny.");
    expect(cleanAnswerText(`Checking first.\n\n${RECORD}\n\nThe forecast is sunny.`)).toBe("Checking first.\n\nThe forecast is sunny.");
    expect(cleanAnswerText(`Checking first. ${RECORD} Sunny.`)).toBe("Checking first. Sunny.");
    expect(cleanAnswerText(`Sunny.\n\n${RECORD}`)).toBe("Sunny.\n\n");
    expect(cleanAnswerText(`${RECORD}\n\nOne.\n\n${RECORD}\nTwo.`)).toBe("One.\n\nTwo.");
  });

  it("removes a record the model cut short, up to the first line that is not its own", () => {
    const cut = RECORD.split("\n").slice(0, 4).join("\n");
    expect(cleanAnswerText(`${cut}\nThe forecast is sunny.`)).toBe("The forecast is sunny.");
    expect(cleanAnswerText(`Intro.\n\n${cut}\n\n- Sunny\n- Warm`)).toBe("Intro.\n\n- Sunny\n- Warm");
    expect(cleanAnswerText(`${HOSTED_SEARCH_RECORD_PREFIX} in this response you used the built-in web search.]\nSunny.`)).toBe("Sunny.");
    expect(cleanAnswerText(`Sunny.\n\n${cut}`)).toBe("Sunny.\n\n");
    expect(cleanAnswerText(`Sunny.\n\n${HOSTED_SEARCH_RECORD_PREFIX} in this resp`)).toBe("Sunny.\n\n");
  });

  it("removes citation markers with and without the private-use characters", () => {
    expect(cleanAnswerText("It rained citeturn925388search0.")).toBe("It rained.");
    expect(cleanAnswerText("It rained. citeturn427001view0turn427001view1turn225968search0\nNext"))
      .toBe("It rained.\nNext");
    expect(cleanAnswerText("It rained citeturn0search0turn1news3 today.")).toBe("It rained today.");
    expect(cleanAnswerText("See the file fileciteturn0file0.")).toBe("See the file.");
    expect(cleanAnswerText("End citeturn0search0")).toBe("End");
  });

  it("never shows a marker that arrives in pieces, and ends as the whole text cleans", () => {
    expectCleanStream(`${RECORD}\n\nThe forecast is sunny.`, "The forecast is sunny.");
    expectCleanStream(`Checking first.\n\n${RECORD}\n\nThe forecast is sunny.`, "Checking first.\n\nThe forecast is sunny.");
    expectCleanStream(`${RECORD.split("\n").slice(0, 3).join("\n")}\nSunny.`, "Sunny.");
    expectCleanStream("It rained citeturn925388search0 in Berlin citeturn1view0.", "It rained in Berlin.");
    expectCleanStream("Basic facts first, then the fine print.", "Basic facts first, then the fine print.");
  });

  it("drops OpenAI's search attribution from Markdown and bare links, keeping the other parameters", () => {
    expect(cleanAnswerText("Prices: [Shop](https://shop.example/item?utm_source=openai) and https://news.example/a?id=2&utm_source=openai."))
      .toBe("Prices: [Shop](https://shop.example/item) and https://news.example/a?id=2.");
    expect(cleanAnswerText("See [docs](https://docs.example/x?utm_source=openai&v=3#intro) citeturn0search0"))
      .toBe("See [docs](https://docs.example/x?v=3#intro)");
    expectCleanStream("Read [it](https://news.example/today?utm_source=openai) now.", "Read [it](https://news.example/today) now.");
    expect(cleanAnswerText("Read https://news.example/today?utm_source=open", { partial: true })).toBe("Read https://news.example/today");
  });

  it("holds back only a tail that may still become a marker", () => {
    expect(cleanAnswerText("Sunny [Rec", { partial: true })).toBe("Sunny");
    expect(cleanAnswerText("Sunny ci", { partial: true })).toBe("Sunny");
    expect(cleanAnswerText("Sunny citeturn1search", { partial: true })).toBe("Sunny");
    expect(cleanAnswerText("Sunny [x", { partial: true })).toBe("Sunny [x");
    expect(cleanAnswerText("Sunny cite it", { partial: true })).toBe("Sunny cite it");
  });
});
