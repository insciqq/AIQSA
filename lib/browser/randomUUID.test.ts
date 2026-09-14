import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./randomUUID";

afterEach(() => vi.unstubAllGlobals());

describe("browser UUIDs", () => {
  it("uses native randomUUID with its Crypto receiver when available", () => {
    const crypto = {
      randomUUID() {
        expect(this).toBe(crypto);
        return "4aa5f5ec-81bf-4e6e-b2e6-23d70a5294e1";
      }
    };
    vi.stubGlobal("crypto", crypto);
    expect(randomUUID()).toBe("4aa5f5ec-81bf-4e6e-b2e6-23d70a5294e1");
  });

  it("uses cryptographic bytes with UUID v4 version and variant bits on HTTP", () => {
    const crypto = {
      getRandomValues(bytes: Uint8Array) {
        expect(this).toBe(crypto);
        bytes.set([0, 1, 2, 3, 4, 5, 0xff, 7, 0xff, 9, 10, 11, 12, 13, 14, 15]);
        return bytes;
      }
    };
    vi.stubGlobal("crypto", crypto);
    expect(randomUUID()).toBe("00010203-0405-4f07-bf09-0a0b0c0d0e0f");
  });

  it("generates fresh UUIDs without native randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const ids = Array.from({ length: 128 }, () => randomUUID());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("does not substitute weak randomness when Crypto is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(() => randomUUID()).toThrow();
  });
});
