import { describe, expect, it, vi } from "vitest";
import { sha256 } from "./sha256";

describe("browser upload SHA-256", () => {
  it("supports non-secure operator HTTP origins without WebCrypto", async () => {
    const property = vi.spyOn(globalThis, "crypto", "get").mockReturnValue({} as Crypto);
    try {
      expect(await sha256(new TextEncoder().encode("abc").buffer)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    } finally { property.mockRestore(); }
  });
});
