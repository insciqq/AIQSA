import { describe, expect, it } from "vitest";
import { withoutOpenAiAttribution, withoutOpenAiAttributionInText } from "./searchAttribution";

describe("OpenAI search attribution in a link", () => {
  it("drops only the exact parameter, keeping the rest of the query and the fragment", () => {
    expect(withoutOpenAiAttribution("https://example.com/a?utm_source=openai")).toBe("https://example.com/a");
    expect(withoutOpenAiAttribution("https://example.com/a?utm_source=openai#part")).toBe("https://example.com/a#part");
    expect(withoutOpenAiAttribution("https://example.com/a?utm_source=openai&id=2")).toBe("https://example.com/a?id=2");
    expect(withoutOpenAiAttribution("https://example.com/a?id=2&utm_source=openai")).toBe("https://example.com/a?id=2");
    expect(withoutOpenAiAttribution("https://example.com/a?x=1&utm_source=openai&y=2#f")).toBe("https://example.com/a?x=1&y=2#f");
  });

  it("keeps every other value, parameter and spelling", () => {
    for (const url of ["https://example.com/a", "https://example.com/a?utm_source=openai.com", "https://example.com/a?utm_source=openaix",
      "https://example.com/a?utm_medium=openai", "https://example.com/a?UTM_Source=openai", "https://example.com/a?ref=utm_source=openai",
      "https://example.com/a#utm_source=openai"]) {
      expect(withoutOpenAiAttribution(url)).toBe(url);
    }
  });
});

describe("OpenAI search attribution in answer text", () => {
  it("cleans a Markdown link, alone and among other parameters", () => {
    expect(withoutOpenAiAttributionInText("See [the guide](https://docs.example/guide?utm_source=openai).")).toBe("See [the guide](https://docs.example/guide).");
    expect(withoutOpenAiAttributionInText("See [the guide](https://docs.example/guide?v=2&utm_source=openai&lang=en).")).toBe(
      "See [the guide](https://docs.example/guide?v=2&lang=en).");
    expect(withoutOpenAiAttributionInText("[https://a.example/?utm_source=openai](https://a.example/?utm_source=openai)"))
      .toBe("[https://a.example/](https://a.example/)");
  });

  it("cleans a bare link, alone and among other parameters, keeping sentence punctuation", () => {
    expect(withoutOpenAiAttributionInText("Read https://news.example/today?utm_source=openai. Then go on.")).toBe(
      "Read https://news.example/today. Then go on.");
    expect(withoutOpenAiAttributionInText("Read https://news.example/today?utm_source=openai&page=2, then stop.")).toBe(
      "Read https://news.example/today?page=2, then stop.");
    expect(withoutOpenAiAttributionInText("Read https://news.example/today?page=2&utm_source=openai#top")).toBe(
      "Read https://news.example/today?page=2#top");
  });

  it("leaves text that is no such link as it is", () => {
    for (const text of ["Tag links with utm_source=openai when sharing.", "Use ?utm_source=openai in links.",
      "https://example.com/?utm_source=openai.com stays", "**https://example.com/?utm_source=openaiz**"]) {
      expect(withoutOpenAiAttributionInText(text)).toBe(text);
    }
  });

  it("holds back a streaming link's tail that may still be the parameter, so what shows only grows", () => {
    const text = "Read [it](https://news.example/today?utm_source=openai&page=2) and https://b.example/x?utm_source=openai.com now.";
    const views = Array.from({ length: text.length + 1 }, (_, size) => withoutOpenAiAttributionInText(text.slice(0, size), { partial: true }));
    for (let index = 1; index < views.length; index += 1) {
      expect(views[index]!.startsWith(views[index - 1]!), JSON.stringify(text.slice(0, index))).toBe(true);
      expect(views[index]).not.toContain("utm_source=openai&");
    }
    const final = withoutOpenAiAttributionInText(text);
    expect(final).toBe("Read [it](https://news.example/today?page=2) and https://b.example/x?utm_source=openai.com now.");
    expect(final.startsWith(views.at(-1)!)).toBe(true);
  });
});
