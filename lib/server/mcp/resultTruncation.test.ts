import { describe, expect, it } from "vitest";
import { jsonStringPrefix, mcpTruncationMarker, truncateMcpCallResult, type McpCallResultValue } from "./resultTruncation";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const MiB = 1024 * 1024;

function truncate(result: McpCallResultValue, maxBytes: number) {
  const truncated = truncateMcpCallResult(result, bytes(result), maxBytes);
  expect(truncated).not.toBeNull();
  const { truncation, value } = truncated!;
  // The delivered result provably fits, measured as the client measures it.
  expect(truncation.deliveredBytes).toBe(bytes(value));
  expect(truncation.deliveredBytes).toBeLessThanOrEqual(maxBytes);
  expect(truncation.originalBytes).toBe(bytes(result));
  const last = value.content.at(-1)!;
  expect(last).toEqual({ type: "text", text: mcpTruncationMarker({ ...truncation, maxBytes }) });
  return { truncation, value };
}

const texts = (value: McpCallResultValue) => value.content.slice(0, -1).map((part) => part.text);

describe("truncateMcpCallResult", () => {
  it("cuts a 9 MiB text result to an 8 MiB limit with the marker and exact byte counts", () => {
    const text = "line of a long mail thread\n".repeat(Math.ceil(9 * MiB / 27));
    const result = { content: [{ type: "text", text }] };
    const { truncation, value } = truncate(result, 8 * MiB);
    expect(truncation.originalBytes).toBeGreaterThan(9 * MiB);
    // Nearly the whole budget is used.
    expect(truncation.deliveredBytes).toBeGreaterThan(8 * MiB - 1);
    expect(texts(value)).toHaveLength(1);
    expect(text.startsWith(texts(value)[0]!)).toBe(true);
    expect(value.content.at(-1)!.text).toContain(`returned ${truncation.originalBytes} bytes`);
    expect(value.content.at(-1)!.text).toContain(`first ${truncation.deliveredBytes} bytes were delivered`);
    expect(value).not.toHaveProperty("isError");
  });

  it.each([
    ["Cyrillic", "Привет, мир! Это длинное письмо. "],
    ["emoji", "mail 📬 thread 👩‍👩‍👧 end 🧵 "],
    ["escapes", "quote \" backslash \\ tab\t nul\u0000 "]
  ])("cuts %s text on a character boundary at every limit", (_name, unit) => {
    const text = unit.repeat(40);
    const result = { content: [{ type: "text", text }] };
    let accepted = false;
    for (let maxBytes = 1; maxBytes < bytes(result); maxBytes += 1) {
      // Below the marker's own size nothing is delivered; above it, always.
      if (!accepted && !truncateMcpCallResult(result, bytes(result), maxBytes)) continue;
      accepted = true;
      const { value } = truncate(result, maxBytes);
      const prefix = texts(value)[0] ?? "";
      expect(text.startsWith(prefix)).toBe(true);
      // No split UTF-8 sequence or surrogate pair: the prefix round-trips.
      expect(Buffer.from(prefix, "utf8").toString("utf8")).toBe(prefix);
      expect(/[\ud800-\udbff]$/u.test(prefix)).toBe(false);
    }
  });

  it("settles the delivered count across a digit boundary", () => {
    const result = { content: [{ type: "text", text: "x".repeat(20_000) }] };
    for (const maxBytes of [...Array.from({ length: 40 }, (_, index) => 9_980 + index),
      ...Array.from({ length: 40 }, (_, index) => 999 + index)]) {
      if (truncateMcpCallResult(result, bytes(result), maxBytes)) truncate(result, maxBytes);
    }
  });

  it("keeps text parts in order and drops the tail after the cut", () => {
    const result = { content: [
      { type: "text", text: "first part" },
      { type: "text", text: "second ".repeat(200) },
      { type: "text", text: "third" }
    ] };
    const { value } = truncate(result, 900);
    const delivered = texts(value);
    expect(delivered[0]).toBe("first part");
    expect(delivered).toHaveLength(2);
    expect(result.content[1]!.text.startsWith(delivered[1]!)).toBe(true);
    expect(delivered[1]!.length).toBeLessThan(result.content[1]!.text.length);
  });

  it("keeps isError on an error result", () => {
    const result = { content: [{ type: "text", text: "failure detail ".repeat(500) }], isError: true };
    const { value } = truncate(result, 2_000);
    expect(value.isError).toBe(true);
  });

  it("drops oversized structured content and keeps the marker", () => {
    const result = { content: [], structuredContent: { rows: Array.from({ length: 500 }, (_, index) => ({ index, subject: "mail" })) } };
    const { value } = truncate(result, 2_000);
    expect(value).not.toHaveProperty("structuredContent");
    expect(value.content).toHaveLength(1);
  });

  it("keeps small structured content and non-text parts that still fit after whole text", () => {
    const result = { content: [
      { type: "text", text: "summary" },
      { type: "image", data: "a".repeat(5_000), mimeType: "image/png" },
      { type: "resource_link", uri: "https://example.test/r", name: "r" }
    ], structuredContent: { ok: true } };
    const { value } = truncate(result, 1_000);
    expect(value.structuredContent).toEqual({ ok: true });
    expect(value.content.map((part) => part.type)).toEqual(["text", "resource_link", "text"]);
  });

  it("refuses a limit that cannot hold the marker", () => {
    const result = { content: [{ type: "text", text: "x".repeat(1_000) }] };
    expect(truncateMcpCallResult(result, bytes(result), 128)).toBeNull();
  });
});

describe("jsonStringPrefix", () => {
  it("never ends inside a surrogate pair or a multi-byte character", () => {
    expect(jsonStringPrefix("a😀b", 4)).toBe("a");
    expect(jsonStringPrefix("a😀b", 5)).toBe("a😀");
    expect(jsonStringPrefix("яя", 3)).toBe("я");
    expect(jsonStringPrefix("\"x", 1)).toBe("");
  });
});
