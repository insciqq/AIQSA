import { describe, expect, it } from "vitest";
import {
  buildMemoryFactSearchIdentity,
  type MemoryFactSearchIdentityInput
} from "./factSearchIdentity";
import { memorySha256, normalizeMemorySearchText } from "./lexical";

const input: MemoryFactSearchIdentityInput = Object.freeze({
  canonicalKey: "preference.editor",
  category: "preferences",
  displayText: "My preferred editor is Neovim.",
  factId: "fact-1",
  languageCode: "en",
  sensitivityClass: "NORMAL",
  sourceMode: "EXPLICIT",
  structuredValue: { statement: "My preferred editor is Neovim." },
  versionId: "version-1"
});

describe("fact search identity", () => {
  it("uses the canonical rebuild provenance shape for incremental entries", () => {
    const sources = [Object.freeze({
      branchGeneration: null,
      evidenceId: "evidence-1",
      kind: "EXPLICIT_ACTION" as const,
      safeSourceHash: "source-hash",
      sourceProjectionVersion: "memory-explicit-source-v1"
    })];
    const normalizedSearchText = normalizeMemorySearchText(input.displayText);

    expect(buildMemoryFactSearchIdentity(input, sources)).toEqual({
      languageCode: "en",
      normalizedSearchText,
      safeContentHash: memorySha256({
        displayText: input.displayText,
        structuredValue: input.structuredValue
      }),
      safetyIdentitySnapshot: memorySha256({
        sensitivityClass: input.sensitivityClass,
        sources
      }),
      sourceIdentitySnapshot: memorySha256({
        factId: input.factId,
        sourceMode: input.sourceMode,
        sources,
        versionId: input.versionId
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: input.canonicalKey,
        category: input.category,
        normalizedValue: normalizedSearchText
      })
    });
  });

  it("fails closed for an automatic fact without exact reusable provenance", () => {
    expect(buildMemoryFactSearchIdentity({
      ...input,
      sourceMode: "AUTOMATIC"
    }, [])).toBeNull();
  });
});
