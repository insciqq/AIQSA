import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeObservationJson, measureObservationJson, observationJsonStream } from "./codec";

const MiB = 1024 * 1024;

describe("accepted observation encoding", () => {
  it("preserves exact JSON values, representation duplicates and Unicode across chunk boundaries", () => {
    const text = `${"x".repeat(4095)}😀\n\"\\\ud800${"Я".repeat(40000)}`;
    const value = { isError: true, text: [text, text], structuredContent: { empty: {}, values: [null, true, -0, 1e50, text] } };
    const bytes = Buffer.concat([...encodeObservationJson(value, MiB)]);
    expect(bytes.toString("utf8")).toBe(JSON.stringify(value));
    expect(measureObservationJson(value, MiB, 1024)).toEqual({ byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"), encoding: "json-utf8-v1", inline: null });
  });

  it("retains only a bounded small inline original", () => {
    const value = { text: ["α\n😀"], structuredContent: null, isError: false };
    const serialized = JSON.stringify(value);
    const size = Buffer.byteLength(serialized);
    expect(measureObservationJson(value, size, size).inline).toBe(serialized);
    expect(measureObservationJson(value, size, size - 1).inline).toBeNull();
    expect(() => measureObservationJson(value, size - 1, 0)).toThrow("tool_observation_too_large");
  });

  it("streams a multi-megabyte accepted result with bounded chunks and the same immutable identity", async () => {
    const value = { text: ["a".repeat(3 * MiB), "tail-marker-α😀"], structuredContent: { count: 271828 } };
    const expected = measureObservationJson(value, 4 * MiB, 4096);
    expect(expected.inline).toBeNull();
    const reader = observationJsonStream(value, 4 * MiB).getReader();
    const hash = createHash("sha256");
    let total = 0;
    let largest = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
      total += next.value.length;
      largest = Math.max(largest, next.value.length);
    }
    expect(total).toBe(expected.byteSize);
    expect(hash.digest("hex")).toBe(expected.checksum);
    expect(largest).toBeLessThanOrEqual(32 * 1024);
  });

  it.each([undefined, NaN, Infinity, new Date(), new Map(), [, 1], { value: undefined }, { value: () => 0 }])(
    "rejects values outside the accepted JSON contract without silently changing them", value => {
      expect(() => [...encodeObservationJson(value, MiB)]).toThrow("tool_observation_invalid");
    });

  it("rejects cycles, accessors and excessive nesting; shared values are not cycles", () => {
    const cycle: { child?: unknown } = {}; cycle.child = cycle;
    expect(() => [...encodeObservationJson(cycle, MiB)]).toThrow("tool_observation_invalid");
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("must not execute"); } });
    expect(() => [...encodeObservationJson(getter, MiB)]).toThrow("tool_observation_invalid");
    let deep: unknown = 0;
    for (let i = 0; i < 150; i++) deep = [deep];
    expect(() => [...encodeObservationJson(deep, MiB)]).toThrow("tool_observation_invalid");
    const shared = { v: "same" };
    expect(Buffer.concat([...encodeObservationJson([shared, shared], MiB)]).toString()).toBe(JSON.stringify([shared, shared]));
  });

  it("stops pulling after cancellation and exposes bounded encoding errors to a stream consumer", async () => {
    const reader = observationJsonStream("a".repeat(MiB), 2 * MiB).getReader();
    expect((await reader.read()).value?.length).toBe(32 * 1024);
    await reader.cancel();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    const invalid = observationJsonStream({ value: "too big" }, 1).getReader();
    await expect(invalid.read()).rejects.toThrow("tool_observation_too_large");
  });
});
