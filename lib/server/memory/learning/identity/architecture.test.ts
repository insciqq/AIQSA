import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8"
);

describe("Memory identity architecture", () => {
  it("keeps lexical analysis and language routing out of canonical identity", () => {
    const identity = source("./normalization.ts");
    const entity = source("../entities/normalization.ts");
    const combined = `${identity}\n${entity}`;
    expect(combined).not.toMatch(
      /normalizeMemorySearchText|transliterateMemory|memoryNgram/iu
    );
    expect(combined).not.toMatch(/Script=(?:Latin|Cyrillic)|languageCode/iu);
    expect(identity).toContain(
      "MEMORY_DEFAULT_IDENTITY_PROFILE: MemoryIdentityProfile =\n  \"UNICODE_V2\""
    );
  });

  it("does not retain language folding in the historical implementation", () => {
    const identity = source("./normalization.ts");
    expect(identity).not.toContain('replaceAll("ё", "е")');
    expect(identity).not.toContain("legacyIdentityComponent");
    expect(source("../extraction/decoder.ts")).not.toContain("decodeMemoryFactExtractionV1");
  });
});
