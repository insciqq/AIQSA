import { describe, expect, it } from "vitest";
import { selectTranscript } from "../transcript";
import { CODEX, charTokens, handleFor, transcriptBuilder } from "./compaction.testFixtures";
import {
  chunkParts,
  excerptText,
  isUsableSummary,
  serializeEntries,
  SUMMARY_SECTIONS,
  summaryPrompt,
  summaryRequestText,
  summaryWordTarget
} from "./summaryPrompt";

const OPTIONS = { argumentChars: 200, assistantChars: 400, resultChars: 200, userChars: 400 };

describe("excerpts", () => {
  it("keeps short text whole and long text as head, error lines from the middle, and tail", () => {
    expect(excerptText("short", 10)).toBe("short");
    const lines = Array.from({ length: 60 }, (_, index) => `row ${String(index).padStart(2, "0")} value ${index * 3}`);
    lines[30] = "2026-04-12T09:02:13Z ERROR stage=validate ERR_SCHEMA_DRIFT_0x3F2: column settled_at type mismatch";
    const text = lines.join("\n");
    const excerpt = excerptText(text, 400);
    expect(excerpt.startsWith(text.slice(0, 200))).toBe(true);
    expect(excerpt.endsWith(text.slice(-200))).toBe(true);
    expect(excerpt).toContain("characters omitted; lines from the omitted part that name errors:]…\n2026-04-12T09:02:13Z ERROR");
    expect(excerpt.length).toBeLessThan(400 + 200);
    const plain = excerptText("x".repeat(1_000), 100);
    expect(plain).toBe(`${"x".repeat(50)}\n…[900 characters omitted]…\n${"x".repeat(50)}`);
  });
});

describe("serialized span", () => {
  it("writes users, answers, calls and results with handles, leaving out reasoning and provider data", () => {
    const chat = transcriptBuilder();
    chat.user("Pull the margins");
    chat.reasoning();
    const handle = handleFor("big");
    const callId = chat.call("run_sql", { query: "SELECT 1" });
    chat.result(callId, "run_sql", `${"r".repeat(500)} handle ${handle}`);
    chat.tool("run_pipeline", { stage: "export" }, "upstream timeout", "error");
    chat.user("also check W-17", true);
    chat.tool("send_mail", { to: "x" }, "stopped", "unknown");
    chat.answer("Margins pulled.");
    const parts = serializeEntries(selectTranscript(chat.items, CODEX).entries, OPTIONS);
    expect(parts).toEqual([
      "[User]\nPull the margins",
      "[Tool call #1 run_sql]\n{\"query\":\"SELECT 1\"}",
      expect.stringMatching(new RegExp(`^\\[Tool result #1 run_sql, 545 characters, full result: read_tool_result handle ${handle}\\]\\nr{100}`, "u")),
      "[Tool call #2 run_pipeline]\n{\"stage\":\"export\"}",
      "[Tool result #2 run_pipeline, error]\nupstream timeout",
      "[User, follow-up during the work]\nalso check W-17",
      "[Tool call #3 send_mail]\n{\"to\":\"x\"}",
      "[Tool result #3 send_mail, outcome unknown]\nstopped",
      "[Assistant]\nMargins pulled."
    ]);
    expect(parts.join("\n")).not.toMatch(/ENC-|rs_i/u);
  });

  it("groups parts into chunks within a budget, a part larger than it alone", () => {
    expect(chunkParts(["aaaa", "bbbb", "cccc", "d".repeat(50), "e"], 12, charTokens))
      .toEqual([["aaaa", "bbbb"], ["cccc"], ["d".repeat(50)], ["e"]]);
    expect(chunkParts([], 10, charTokens)).toEqual([]);
  });
});

describe("summary prompt", () => {
  it("asks for the fixed sections in order, in the user's language, with exact values", () => {
    const prompt = summaryPrompt({ maxWords: 1_800, update: false });
    const positions = SUMMARY_SECTIONS.map((section) => prompt.indexOf(`## ${section}\n`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(prompt).toContain("in the language the user writes in");
    expect(prompt).toContain("name the earlier version as superseded");
    expect(prompt).toContain("character for character");
    expect(prompt).toContain("read_tool_result");
    expect(prompt).toContain("about 1,800 words");
    expect(prompt).not.toContain("previous summary");
    expect(summaryPrompt({ maxWords: 900, update: true })).toContain("Start from the previous summary and keep everything in it that still holds.");
  });

  it("sends the span as data, with the previous summary only in update mode", () => {
    const first = summaryRequestText({ conversation: "[User]\nhi", maxWords: 500 });
    expect(first.startsWith("<conversation>\n[User]\nhi\n</conversation>\n\nWrite a handoff summary")).toBe(true);
    expect(first).not.toContain("<previous-summary>");
    const update = summaryRequestText({ conversation: "[User]\nmore", maxWords: 500, previousSummary: "## Goal\nOld" });
    expect(update).toContain("</conversation>\n\n<previous-summary>\n## Goal\nOld\n</previous-summary>\n\nThe previous summary");
  });

  it("scales the word target with the output budget", () => {
    expect(summaryWordTarget(4_096)).toBe(1_800);
    expect(summaryWordTarget(8_192)).toBe(3_650);
    expect(summaryWordTarget(100)).toBe(300);
  });

  it("accepts a summary with its sections, also when the model translated the headings", () => {
    const english = SUMMARY_SECTIONS.map((section) => `## ${section}\n- item`).join("\n\n");
    expect(isUsableSummary(english)).toBe(true);
    const russian = ["Цель", "Ограничения и поправки", "Сделано и решения", "Текущее состояние", "Открытые задачи", "Критичные данные"]
      .map((heading) => `## ${heading}\n- ${"пункт ".repeat(15)}`).join("\n\n");
    expect(isUsableSummary(russian)).toBe(true);
    expect(isUsableSummary("I will continue with the export stage now.")).toBe(false);
    expect(isUsableSummary("## Goal\nx\n## Current state\ny")).toBe(false);
  });
});
