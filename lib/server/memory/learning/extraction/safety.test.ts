import { describe, expect, it } from "vitest";
import { inspectMemoryFactSourceSafety } from "./safety";

describe("Memory fact source safety", () => {
  it.each([
    "My medical diagnosis is private.",
    "Мой диагноз указан в карте.",
    "仮にベルリンに住んでいたら、自転車に乗ります。",
    "Please write: I prefer tea.",
    "قال صديقي إنه يفضل الشاي."
  ])("leaves natural-language meaning to the structured extractor: %s", (text) => {
    expect(inspectMemoryFactSourceSafety(text)).toEqual({
      eligible: true,
      reasonCode: null
    });
  });

  it.each([
    "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"
  ])("blocks recognizable secret formats before egress", (text) => {
    expect(inspectMemoryFactSourceSafety(text)).toEqual({
      eligible: false,
      reasonCode: "recognizable_secret_format"
    });
  });
});
