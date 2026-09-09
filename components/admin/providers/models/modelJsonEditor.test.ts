import { describe, expect, it } from "vitest";
import { formatJsonParameters, indentJsonSelection, jsonTokens, validateJsonParameters } from "./modelJsonEditor";

describe("model JSON editing", () => {
  it("formats only whitespace without changing duplicate keys, numeric spelling, escapes or arbitrary nested parameters", () => {
    const input = '{"duplicate":1,"duplicate":2,"large":900719925474099312345,"negative":-0,"exponent":1e+23,"escaped":"\\u0061\\/\\\\","provider":{"anything":[null,true,false,{},[]]}}';
    expect(validateJsonParameters(input)).toEqual({ ok: true });
    const formatted = formatJsonParameters(input);
    expect(formatted).toContain('\n  "duplicate": 1,\n  "duplicate": 2,');
    expect(formatted).toContain('"large": 900719925474099312345');
    expect(formatted).toContain('"negative": -0');
    expect(formatted).toContain('"exponent": 1e+23');
    expect(formatted).toContain('"escaped": "\\u0061\\/\\\\"');
    expect(jsonTokens(formatted).filter(({ kind }) => kind !== "space").map(({ text }) => text))
      .toEqual(jsonTokens(input).filter(({ kind }) => kind !== "space").map(({ text }) => text));
    expect(JSON.parse(formatted)).toEqual(JSON.parse(input));
    expect(formatJsonParameters(formatted)).toBe(formatted);
  });

  it.each([
    ["", 1, 1], ["[]", 1, 1], ["null", 1, 1], ['{"x":}', 1, 6],
    ['{\n  "x": true,\n}', 3, 1], ['{"x": [1,]}', 1, 10],
    ['{"x" true}', 1, 6], ['{"x": 01}', 1, 8], ['{"x": +1}', 1, 7],
    ['{"x": "\\q"}', 1, 7], ['{"x": NaN}', 1, 7], ['{"x": undefined}', 1, 7],
    ['{"x":1}{}', 1, 8], ['{\r\n  "x":', 2, 7], ['{\u00a0}', 1, 2]
  ])("locates invalid or non-object JSON without reflecting its contents: %s", (value, line, column) => {
    const result = validateJsonParameters(String(value));
    expect(result).toMatchObject({ column, line, ok: false });
    if (!result.ok) expect(result.message).not.toContain("undefined");
  });

  it.each(['{}', '{"x": [1,-2.3,4E-5,null,true,false,"\\u1234"]}', '{"__proto__":{"x":1},"constructor":null}', '{"empty":{},"list":[]}'])
    ("accepts the existing JSON-object contract: %s", (input) => expect(validateJsonParameters(input)).toEqual({ ok: true }));

  it("handles a selected line range and outdents even when the caret starts the line", () => {
    const text = '{\n  "a": 1,\n  "b": 2\n}';
    const edit = indentJsonSelection(text, 2, text.indexOf("\n}"), false);
    const indented = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    expect(indented).toBe('{\n    "a": 1,\n    "b": 2\n}');
    const undo = indentJsonSelection(indented, edit.selectionStart, edit.selectionEnd, true);
    expect(indented.slice(0, undo.start) + undo.replacement + indented.slice(undo.end)).toBe(text);
    expect(indentJsonSelection('  "a": 1', 0, 0, true)).toMatchObject({ replacement: '"a": 1', selectionStart: 0, start: 0 });
    expect(indentJsonSelection("\n", 0, 0, true)).toMatchObject({ start: 0 });
  });
});
