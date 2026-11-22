import { describe, expect, it } from "vitest";
import { commandResultStdout, printedResultTexts, storedCommandStdout } from "./commandStdout";

describe("Workspace command stdout", () => {
  it("reads the envelope, a failed command's details and the bare form", () => {
    expect(commandResultStdout({ ok: true, data: { stdout: "a", stderr: "b" } })).toBe("a");
    expect(commandResultStdout({ ok: false, error: { code: "exec_failed", details: { stdout: "c" } } })).toBe("c");
    expect(commandResultStdout({ stdout: "d" })).toBe("d");
    expect(commandResultStdout({ ok: true, data: { stderr: "e" } })).toBeNull();
    expect(commandResultStdout("f")).toBeNull();
  });

  it("reads a stored result's stdout once, never its other strings", () => {
    const envelope = { ok: true, data: { stdout: "[browser #1] open @ a.example/", stderr: "[browser #9] open @ b.example/" } };
    expect(storedCommandStdout({ content: [{ type: "text", text: JSON.stringify(envelope) }] })).toEqual(["[browser #1] open @ a.example/"]);
    expect(storedCommandStdout({ content: [{ type: "json", value: envelope }] })).toEqual(["[browser #1] open @ a.example/"]);
    expect(storedCommandStdout({ content: [{ type: "text", text: "plain output" }] })).toEqual(["plain output"]);
    // An escaped quote stays one: the JSON is decoded once.
    expect(storedCommandStdout({ content: [{ type: "text", text: JSON.stringify({ stdout: "\\\"[browser #99]" }) }] })).toEqual(["\\\"[browser #99]"]);
    expect(storedCommandStdout(null)).toEqual([]);
  });

  it("reads every string of a model-facing result, and an excerpt's stdout as far as its head keeps it whole", () => {
    expect(printedResultTexts(JSON.stringify({ ok: true, data: { stdout: "one\ntwo", stderr: "three" } }))).toEqual(["one\ntwo", "three"]);
    expect(printedResultTexts("not JSON\n[browser #1] open @ a.example/")).toEqual(["not JSON\n[browser #1] open @ a.example/"]);
    const excerpt = '{\n  "ok": true,\n  "data": {\n    "stdout": "[browser #4 · forum] open @ forum.example/t/1\\nTitle: \\"A topic\\"\\nxxxx' +
      '\n\n[9000 of 12000 characters omitted here (characters 120-9120). The whole result is saved.]\n\ntail\\n[browser #9] open @ b.example/"}';
    expect(printedResultTexts(excerpt)).toEqual(['[browser #4 · forum] open @ forum.example/t/1\nTitle: "A topic"\nxxxx']);
    // A JSON string a command printed keeps its escaped newline as text; an escape cut in half is left out.
    const js = JSON.stringify(JSON.stringify("hello\n[browser #9] click"));
    expect(printedResultTexts(`{"stdout": ${js.slice(0, -1)}… omitted`)).toEqual([`${JSON.parse(js) as string}… omitted`]);
    expect(printedResultTexts(`{"stdout": "caf\\u00e9 \\ud83d\\ude00 \\u00`)).toEqual(["café 😀 "]);
  });
});
