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

  it("isolates the historical ё substitution behind LEGACY_V1", () => {
    const identity = source("./normalization.ts");
    expect(identity.match(/replaceAll\("ё", "е"\)/gu)).toHaveLength(2);
    expect(identity).toContain(
      'if (profile === "LEGACY_V1") return legacyIdentityComponent(namespace, text);'
    );
    expect(identity).toContain(
      'profile === "LEGACY_V1" ? folded.replaceAll("ё", "е") : folded'
    );
  });

  it("retains distinct active and rollback namespaces", () => {
    const identity = source("./normalization.ts");
    const entity = source("../entities/normalization.ts");
    expect(identity).toContain('MEMORY_SLOT_IDENTITY_VERSION = "slot-v4"');
    expect(identity).toContain(
      'MEMORY_PROPOSITION_IDENTITY_VERSION = "proposition-v2"'
    );
    expect(identity).toContain('MEMORY_ENTITY_SLOT_IDENTITY_VERSION = "slot-v3"');
    expect(entity).toContain("`entity:v4:${family}:${unicodeComponent}`");
    expect(entity).toContain("`entity:v3:${family}:${legacyComponent}`");
  });
});
