import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readMcpDisplayOriginal } from "./mcpDisplayReader";

function fixture(value: string | Uint8Array, chunkSize = 4096) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  let offset = 0;
  let reads = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (offset >= bytes.length) { controller.close(); return; }
      const chunk = bytes.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      controller.enqueue(chunk);
    }, cancel
  }, { highWaterMark: 0 });
  return { body, cancel, reads: () => reads, identity: { byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") } };
}
const original = (text: string[], structuredContent: Record<string, unknown> | null = null) =>
  JSON.stringify({ text, structuredContent, isError: true, unsupportedContentTypes: ["image", "audio"] });
const read = (value: string, secrets: string[] = [], chunkSize?: number) => readMcpDisplayOriginal({ ...fixture(value, chunkSize), secrets });

describe("bounded MCP display originals", () => {
  it("decodes text and structured JSON without retaining the envelope as display", async () => {
    const result = await read(original(["Hello\nworld", "Next"], { key: [true, null, 1.25, { value: "Я😀漢" }] }), [], 1);
    const expected = "Hello\nworld\n\nNext\n\n" + JSON.stringify({ key: [true, null, 1.25, { value: "Я😀漢" }] }, null, 2);
    expect(result).toEqual({ response: { text: expected, byteSize: Buffer.byteLength(expected), truncated: false },
      isError: true, unsupportedContentTypes: ["image", "audio"] });
  });

  it.each([1, 17, 65536, 200000])("redacts before the 64KiB cutoff across storage chunks of %i bytes", async chunkSize => {
    const prefix = "x".repeat(65530);
    const secret = "synthetic-secret-😀";
    const text = prefix + secret + "y".repeat(70000) + secret;
    const value = original([text]);
    const f = fixture(value, chunkSize);
    const getReader = vi.spyOn(f.body, "getReader");
    const result = await readMcpDisplayOriginal({ ...f, secrets: [secret] });
    const expected = prefix + "[REDACTED]" + "y".repeat(70000) + "[REDACTED]";
    expect(result.response.text).toBe(expected.slice(0, 65536));
    expect(result.response.text).not.toContain("synthetic");
    expect(result.response.byteSize).toBe(Buffer.byteLength(expected));
    expect(result.response.truncated).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.unsupportedContentTypes).toEqual(["image", "audio"]);
    expect(getReader).toHaveBeenCalledOnce();
    expect(f.reads()).toBe(Math.ceil(f.identity.byteSize / chunkSize) + 1);
  });

  it("handles escaped credentials, overlapping secrets, keys and structured scalars", async () => {
    const secret = 'quote"\n😀';
    const value = original([`prefix ${secret} foobar foo end`], { [secret]: secret, number: 123, bool: true });
    const result = await read(value.replaceAll("😀", "\\ud83d\\ude00"), [secret, "foo", "foobar", "123", "true"], 1);
    expect(result.response.text).toBe("prefix [REDACTED] [REDACTED] [REDACTED] end\n\n" +
      JSON.stringify({ "[REDACTED]": "[REDACTED]", number: "[REDACTED]", bool: "[REDACTED]" }, null, 2));
  });

  it("preserves UTF-8 boundaries and counts the entire redacted representation", async () => {
    const text = "x".repeat(65534) + "😀" + "Я漢".repeat(5000);
    const result = await read(original([text]), [], 3);
    expect(result.response.text).toBe("x".repeat(65534));
    expect(result.response.byteSize).toBe(Buffer.byteLength(text));
    expect(result.response.truncated).toBe(true);
    const exact = await read(original(["😀".repeat(16384)]), [], 7);
    expect(exact.response.byteSize).toBe(65536);
    expect(exact.response.truncated).toBe(false);
    expect(exact.response.text).toBe("😀".repeat(16384));
  });

  it("continues through a large structured value to late metadata and preserves JSON escaping", async () => {
    const value = JSON.stringify({ structuredContent: { large: '😀"\\'.repeat(40000) }, text: [], unsupportedContentTypes: ["resource"], isError: true });
    const result = await read(value, ["unused"]);
    expect(result.isError).toBe(true);
    expect(result.unsupportedContentTypes).toEqual(["resource"]);
    expect(result.response.text.startsWith('{\n  "large": "😀\\"\\\\')).toBe(true);
    expect(result.response.byteSize).toBe(Buffer.byteLength(JSON.stringify({ large: '😀"\\'.repeat(40000) }, null, 2)));
  });

  it("keeps escaped surrogate pairs together at internal redaction boundaries", async () => {
    const text = "x".repeat(1023) + "😀" + "y".repeat(1023) + "😀";
    const result = await read(original([], { value: text }).replaceAll("😀", "\\ud83d\\ude00"), [], 1);
    expect(result.response.text).toBe(JSON.stringify({ value: text }, null, 2));
    expect(result.response.byteSize).toBe(Buffer.byteLength(JSON.stringify({ value: text }, null, 2)));
  });

  it("rejects credential-bearing metadata and represents empty results", async () => {
    await expect(read(JSON.stringify({ isError: false, structuredContent: null, text: [], unsupportedContentTypes: ["private"] }), ["private"]))
      .rejects.toThrow("tool_observation_unavailable");
    const result = await read(JSON.stringify({ isError: false, structuredContent: null, text: [], unsupportedContentTypes: [] }));
    expect(result).toEqual({ response: { text: "", byteSize: 0, truncated: false }, isError: false, unsupportedContentTypes: [] });
  });

  it.each([
    '{}', '[]', '{"isError":false,"structuredContent":null,"text":[],"unsupportedContentTypes":[],}',
    original(["ok"]).replace('"isError":true', '"isError":1'),
    original(["ok"]).replace('"structuredContent":null', '"structuredContent":[]'),
    original(["ok"]).replace('"text":["ok"]', '"text":[1]'),
    original(["ok"]).replace('"text":["ok"]', '"text":["ok",]'),
    original(["ok"]).replace('"text":["ok"]', '"text":["bad\\x"]'),
    original(["ok"]).replace('"isError":true', '"isError":true,"isError":false'),
    original(["ok"]).replace('"structuredContent":null', '"structuredContent":{"bad":01}'),
    original(["ok"]).replace('"unsupportedContentTypes":["image","audio"]', '"unsupportedContentTypes":[{}]'),
    original(["ok"]) + 'false', original(["ok"]).slice(0, -1)
  ])("rejects invalid complete envelopes without partial JSON recovery (%#)", async value => {
    await expect(read(value)).rejects.toMatchObject({ code: "tool_observation_unavailable", transient: false });
  });

  it("rejects corrupt suffixes and byte identities after a full display prefix", async () => {
    const value = original(["a".repeat(70000)]);
    const f = fixture(value);
    await expect(readMcpDisplayOriginal({ ...fixture(value.replace('"isError":true', '"isError":fals')), identity: f.identity, secrets: [] })).rejects.toThrow("tool_observation_unavailable");
    await expect(readMcpDisplayOriginal({ ...fixture(value), identity: { ...f.identity, checksum: "0".repeat(64) }, secrets: [] })).rejects.toThrow("tool_observation_unavailable");
    await expect(readMcpDisplayOriginal({ ...fixture(value.slice(0, -1)), identity: f.identity, secrets: [] })).rejects.toThrow("tool_observation_unavailable");
    const invalidUtf8 = Buffer.concat([Buffer.from('{"text":["'), Buffer.from([0xff]), Buffer.from('"]}')]);
    await expect(readMcpDisplayOriginal({ ...fixture(invalidUtf8), secrets: [] })).rejects.toMatchObject({ transient: false });
  });

  it("rejects the document cap before opening or consuming storage", async () => {
    const f = fixture(original([]));
    const getReader = vi.spyOn(f.body, "getReader");
    await expect(readMcpDisplayOriginal({ ...f, identity: { ...f.identity, byteSize: 32 * 1024 * 1024 + 1 }, secrets: [] })).rejects.toThrow("tool_observation_unavailable");
    expect(getReader).not.toHaveBeenCalled();
    expect(f.reads()).toBe(0);
  });

  it("lists many unsupported content types once each, cut to the display limit, instead of failing", async () => {
    const types = [...Array.from({ length: 300 }, () => "image"), ...Array.from({ length: 20 }, (_, index) => `type${index}`), "audio"];
    const result = await read(JSON.stringify({ text: ["Shown"], structuredContent: null, isError: false, unsupportedContentTypes: types }));
    expect(result.response.text).toBe("Shown");
    expect(result.unsupportedContentTypes).toEqual(["image", ...Array.from({ length: 15 }, (_, index) => `type${index}`)]);
  });

  it("bounds nesting and metadata rather than accumulating them", async () => {
    await expect(read(original([], { nested: JSON.parse("[".repeat(130) + "0" + "]".repeat(130)) }))).rejects.toThrow("tool_observation_unavailable");
    await expect(read(original([]).replace('"image"', JSON.stringify("x".repeat(257))))).rejects.toThrow("tool_observation_unavailable");
  });

  it("cancels stalled storage and sanitizes transport failures", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel }, { highWaterMark: 0 });
    const pending = readMcpDisplayOriginal({ body, identity: fixture(original([])).identity, secrets: [], signal: controller.signal });
    await ready;
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    expect(cancel).toHaveBeenCalledOnce();
    const failedBody = new ReadableStream<Uint8Array>({ pull(stream) { stream.error(new Error("private storage location")); } });
    await expect(readMcpDisplayOriginal({ body: failedBody, identity: fixture(original([])).identity, secrets: [] }))
      .rejects.toMatchObject({ message: "tool_observation_unavailable", transient: true });
  });
});
