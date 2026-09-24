import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiqsaMcpToolCallResult } from "./clientSession";
import { normalizeMcpResultForModel } from "./resultNormalization";
import { DEFAULT_MCP_RESPONSE_WIRE_LIMITS } from "./responseLimits";

const result = (structuredContent: Record<string, unknown> | null, text: string[], isError = false): AiqsaMcpToolCallResult =>
  ({ structuredContent, text, isError, unsupportedContentTypes: ["image"] });

afterEach(() => vi.unstubAllEnvs());
describe("provider-facing MCP exact result normalization", () => {
  it.each([false, true])("removes only whole proven blocks, retaining source, order and error=%s", isError => {
    const structured = { rows: [{ id: 1, name: 'a  b\\"\n雪😀' }, { id: 1 }], empty: null };
    const duplicate = JSON.stringify(structured, null, 2);
    const source = result(structured, ["unique before", duplicate, "unique after", "unique after", JSON.stringify(structured)], isError);
    const original = structuredClone(source);
    for (let call = 0; call < 2; call++) {
      const normalized = normalizeMcpResultForModel(source);
      expect(normalized).toEqual({ ...source, text: ["unique before", "unique after", "unique after"] });
      expect(normalized.structuredContent).toBe(structured);
      expect(normalized.unsupportedContentTypes).toBe(source.unsupportedContentTypes);
      expect(source).toEqual(original);
    }
  });

  it.each([
    ['{"n":9007199254740993}', { n: 9007199254740992 }],
    ['{"n":9007199254740992}', { n: 9007199254740992 }],
    ['{"n":0.1}', { n: 0.1 }],
    ['{"n":1.0}', { n: 1 }],
    ['{"n":1e0}', { n: 1 }],
    ['{"n":-0}', { n: 0 }],
    ['{"n":"1"}', { n: 1 }],
    ['{"n":null}', {}],
    ['{"rows":[2,1]}', { rows: [1, 2] }],
    ['{"rows":[1]}', { rows: [1, 1] }],
    ['{"rows":[1,1]}', { rows: [1] }],
    ['{"n":1,"n":2}', { n: 2 }],
    ['{"n":2,"n":2}', { n: 2 }],
    ['{"nested":{"n":1,"n":2}}', { nested: { n: 2 } }],
    ['{"b":2,"a":1}', { a: 1, b: 2 }],
    ['{"text":"a b"}', { text: "a  b" }],
    ['{"text":"é"}', { text: "e\u0301" }],
    ['{"text":"\\u0061"}', { text: "a" }],
    ['{"text":"雪"}', { text: "雲" }],
    ['prefix {"n":1}', { n: 1 }],
    ['{"n":1} suffix', { n: 1 }],
    ['{"n":t rue}', { n: true }],
    ['{"n":f alse}', { n: false }],
    ['{"n":n ull}', { n: null }],
    ['{"n":1 2}', { n: 12 }],
    ['{"n":- 1}', { n: -1 }],
    ['{"n":1,}', { n: 1 }],
    ['\u00a0{"n":1}', { n: 1 }]
  ] as Array<[string, Record<string, unknown>]>) ("retains unproved or distinct text %s", (text, structured) => {
    const source = result(structured, [text]);
    expect(normalizeMcpResultForModel(source)).toBe(source);
  });

  it("accepts only token-boundary JSON whitespace and safe integer lexemes", () => {
    const source = result({ n: -Number.MAX_SAFE_INTEGER, ok: true, no: false, nothing: null, rows: [] },
      [' \t{ "n" : -9007199254740991 , "ok" : true , "no" : false , "nothing" : null , "rows" : [ ] }\r\n']);
    expect(normalizeMcpResultForModel(source).text).toEqual([]);
    expect(normalizeMcpResultForModel(result({}, ["{}"])).text).toEqual([]);
  });

  it("retains absent structure, over-budget/deep trees and non-JSON values without failing delivery", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 66; index++) deep = { child: deep };
    for (const structured of [null, { n: -0 }, { n: Infinity }, { n: undefined }, cycle, deep,
      { rows: Array.from({ length: 65_536 }, () => 0) }, { custom: { toJSON: () => 1 } }]) {
      const source = result(structured, ["{}"]);
      expect(normalizeMcpResultForModel(source)).toBe(source);
    }
    vi.stubEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES", "8");
    const source = result({ n: 1 }, ['{"n":1}']);
    expect(normalizeMcpResultForModel(source)).toBe(source);
  });

  it("handles a duplicated synthetic payload near the accepted wire cap without copying its source", () => {
    const cap = DEFAULT_MCP_RESPONSE_WIRE_LIMITS.callToolResponseMaxBytes;
    const structured = { opaque: "x".repeat(Math.floor((cap - 512) / 2)) };
    const text = JSON.stringify(structured);
    const source = result(structured, [text, "unique fact"]);
    const wireBytes = Buffer.byteLength(JSON.stringify({ content: source.text.map(text => ({ type: "text", text })), structuredContent: structured }));
    expect(wireBytes).toBeLessThan(cap);
    expect(wireBytes).toBeGreaterThan(cap - 1024);
    const normalized = normalizeMcpResultForModel(source);
    expect(normalized.text).toEqual(["unique fact"]);
    expect(normalized.structuredContent).toBe(structured);
    expect(source.text[0]).toBe(text);
  });
});
