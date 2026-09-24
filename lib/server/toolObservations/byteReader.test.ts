import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readObservationBytes, type ObservationByteSelector } from "./byteReader";

function fixture(text: string, chunks = 17) {
  const bytes = Buffer.from(text);
  const identity = { byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") };
  let offset = 0;
  let consumed = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const next = bytes.subarray(offset, offset + chunks);
      offset += next.length;
      consumed += next.length;
      controller.enqueue(next);
    }
  });
  return { body, identity, consumed: () => consumed };
}

describe("exact bounded observation byte recall", () => {
  it("returns a valid string envelope for an explicitly incomplete JSON fragment", async () => {
    const original = JSON.stringify({ early: "alpha", multiline: "a\nb", tail: "omega" });
    const f = fixture(original, 5);
    const result = await readObservationBytes({ ...f, selector: { offset: 7, maxBytes: 9 } });
    expect(JSON.parse(JSON.stringify(result)).fragment).toBe(Buffer.from(original).subarray(7, 16).toString());
    expect(result.completeDocument).toBe(false);
    expect(result).toMatchObject({ offset: 7, endOffset: 16, nextOffset: 16 });
    expect(f.consumed()).toBe(f.identity.byteSize);
  });

  it("pages Unicode by exact byte locators without damaged code points", async () => {
    const original = JSON.stringify({ text: "aЯ😀漢\n".repeat(20) });
    let offset = 0;
    const parts: string[] = [];
    for (;;) {
      const page = await readObservationBytes({ ...fixture(original, 1), selector: { offset, maxBytes: 7 } });
      expect(page.fragment).not.toContain("�");
      expect(page.endOffset - page.offset).toBe(Buffer.byteLength(page.fragment));
      parts.push(page.fragment);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(parts.join("")).toBe(original);
    expect(JSON.parse(parts.join(""))).toEqual(JSON.parse(original));
  });

  it.each([1, 17, 32768, 3 * 1024 * 1024])("finds a rare tail record across backend chunks of %i bytes", async chunks => {
    // Keep the one-byte case tiny; the other cases also exercise large originals.
    const size = chunks === 1 ? 137 : 2 * 1024 * 1024;
    const original = JSON.stringify({ rows: ["x".repeat(size), { token: "unique-Я😀", value: 271828 }] });
    const f = fixture(original, chunks);
    const page = await readObservationBytes({ ...f, selector: { offset: 0, maxBytes: 1024, query: "unique-Я😀" } });
    expect(page.fragment).toContain('"value":271828');
    expect(page.matchOffset).toBe(Buffer.from(original).indexOf(Buffer.from("unique-Я😀")));
    expect(page.fragment).toBe(Buffer.from(original).subarray(page.offset, page.endOffset).toString("utf8"));
    expect(f.consumed()).toBe(f.identity.byteSize);
    expect(Buffer.byteLength(page.fragment)).toBeLessThanOrEqual(1024);
  });

  it("keeps the match visible for a small fragment and advances search without returning the same match", async () => {
    const original = JSON.stringify({ text: "x".repeat(500) + "needle first; needle second" });
    const first = await readObservationBytes({ ...fixture(original), selector: { offset: 0, maxBytes: 6, query: "needle" } });
    expect(first.fragment).toBe("needle");
    const second = await readObservationBytes({ ...fixture(original), selector: { offset: first.nextOffset!, maxBytes: 6, query: "needle" } });
    expect(second.fragment).toBe("needle");
    expect(second.matchOffset).toBeGreaterThan(first.matchOffset!);
    const absent = await readObservationBytes({ ...fixture(original), selector: { offset: second.nextOffset!, maxBytes: 6, query: "needle" } });
    expect(absent).toMatchObject({ fragment: "", matchOffset: null, nextOffset: null, completeDocument: false });
  });

  it("rejects wrong size, altered suffix and storage failures even when an early fragment was readable", async () => {
    const original = JSON.stringify({ head: "wanted", tail: "secret" });
    const f = fixture(original);
    await expect(readObservationBytes({ ...fixture(original.replace("secret", "change")), identity: f.identity,
      selector: { offset: 0, maxBytes: 10 } })).rejects.toThrow("tool_observation_unavailable");
    await expect(readObservationBytes({ ...fixture(original.slice(0, -1)), identity: f.identity,
      selector: { offset: 0, maxBytes: 10 } })).rejects.toThrow("tool_observation_unavailable");
    await expect(readObservationBytes({ ...fixture(original + " "), identity: f.identity,
      selector: { offset: 0, maxBytes: 10 } })).rejects.toThrow("tool_observation_unavailable");
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("private-storage-detail")); } });
    await expect(readObservationBytes({ body, identity: f.identity, selector: { offset: 0, maxBytes: 10 } }))
      .rejects.toThrow("tool_observation_unavailable");
  });

  it.each([
    { offset: -1, maxBytes: 4 }, { offset: 1.5, maxBytes: 4 }, { offset: 999, maxBytes: 4 },
    { offset: 0, maxBytes: 2 }, { offset: 0, maxBytes: 65536 }, { offset: 0, maxBytes: 4, query: "" },
    { offset: 0, maxBytes: 4, query: "longer" }, { offset: 0, maxBytes: 1024, query: "x".repeat(257) },
    { offset: 0, maxBytes: 4, query: "\ud800" }
  ])("rejects an invalid selector before consuming storage", async selector => {
    const identity = fixture('"hello"').identity;
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    await expect(readObservationBytes({ body, identity, selector: selector as ObservationByteSelector }))
      .rejects.toThrow("tool_observation_selector_invalid");
    expect(pull).not.toHaveBeenCalled();
  });

  it("refuses a range starting inside a Unicode character", async () => {
    await expect(readObservationBytes({ ...fixture('"😀abc"'), selector: { offset: 2, maxBytes: 4 } }))
      .rejects.toThrow("tool_observation_selector_invalid");
  });

  it("cancels a stalled storage read promptly on Stop without returning a partial fragment", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { markStarted(); }, cancel });
    const read = readObservationBytes({ body, identity: fixture('"original"').identity,
      selector: { offset: 0, maxBytes: 4 }, signal: controller.signal });
    await started;
    controller.abort(new Error("test_stop"));
    await expect(read).rejects.toThrow("test_stop");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
