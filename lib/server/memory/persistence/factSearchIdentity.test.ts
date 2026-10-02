import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { projectMemoryHistorySourceText } from "../history/safety";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { loadMemoryReusableFactSourceSnapshots } from
  "./reusableFactSourceSnapshots";
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

  it("keeps the exact authority snapshot and identity bytes of non-PATTERN facts", async () => {
    // Any change to these bytes re-indexes every installed fact, so they are
    // pinned while the retired synthesis vocabulary is removed around them.
    const text = "I moved to Lisbon in March.";
    const safeText = projectMemoryHistorySourceText(text).safeText!;
    const sourceHash = memorySha256(safeText);
    const queryRaw = vi.fn(async () => [{
      branchGeneration: 2,
      chatId: "chat-1",
      content: { blocks: [{ text, type: "text" }] },
      evidenceFingerprint: "e".repeat(64),
      factVersionId: "automatic-version",
      id: "message-evidence-1",
      messageId: "message-1",
      observedAt: new Date("2026-03-01T10:00:00.000Z"),
      safeExcerpt: safeText,
      safeSourceHash: sourceHash,
      sourceEndOffset: safeText.length,
      sourceMessageContentHash: sourceHash,
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceStartOffset: 0
    }]);
    const findEvidence = vi.fn(async () => [{
      branchGeneration: null,
      factVersionId: "explicit-version",
      id: "explicit-evidence-1",
      safeSourceHash: "a".repeat(64),
      sourceProjectionVersion: "memory-explicit-source-v1"
    }]);
    const findRelations = vi.fn(async () => []);
    const tx = {
      $queryRaw: queryRaw,
      memoryEvidence: { findMany: findEvidence },
      memoryFactVersionRelation: { findMany: findRelations }
    } as unknown as Prisma.TransactionClient;

    const snapshots = await loadMemoryReusableFactSourceSnapshots(tx, "user-1", [
      { modality: "STATE", sourceMode: "AUTOMATIC", versionId: "automatic-version" },
      { modality: "PREFERENCE", sourceMode: "EXPLICIT", versionId: "explicit-version" }
    ]);

    expect(findRelations).not.toHaveBeenCalled();
    expect(snapshots.get("automatic-version")).toEqual([{
      branchGeneration: 2,
      chatId: "chat-1",
      evidenceFingerprint: "e".repeat(64),
      evidenceId: "message-evidence-1",
      kind: "MESSAGE",
      messageId: "message-1",
      safeSourceHash: sourceHash,
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
    }]);
    expect(snapshots.get("explicit-version")).toEqual([{
      branchGeneration: null,
      evidenceId: "explicit-evidence-1",
      kind: "EXPLICIT_ACTION",
      safeSourceHash: "a".repeat(64),
      sourceProjectionVersion: "memory-explicit-source-v1"
    }]);
    expect(buildMemoryFactSearchIdentity({
      ...input,
      canonicalKey: "residence.city",
      category: "about_you",
      displayText: text,
      sourceMode: "AUTOMATIC",
      structuredValue: { statement: text },
      versionId: "automatic-version"
    }, snapshots.get("automatic-version")!)).toEqual({
      languageCode: "en",
      normalizedSearchText: normalizeMemorySearchText(text),
      safeContentHash: "5ae9f8dbd21ce942b1ae566d3c58bbaa6eff45bec674fc11c186823ec6bab157",
      safetyIdentitySnapshot: "e702009bf558bd854261afe1f87b6f2c1125c10ce647af0e25a9c7816707126c",
      sourceIdentitySnapshot: "45782f738b676e4cad99c1fc623896c41ca464984823c43ff1e845260dc699fd",
      suppressionIdentitySnapshot: "fe8fef3e6927053b36d796d0d845593a9eb5aab4604803009004f8bf4db29ec8"
    });
    expect(buildMemoryFactSearchIdentity({
      ...input,
      versionId: "explicit-version"
    }, snapshots.get("explicit-version")!)).toEqual({
      languageCode: "en",
      normalizedSearchText: normalizeMemorySearchText(input.displayText),
      safeContentHash: "fa57b0540dc79c04b910bb1af69e0c04a7512002d7e3a7accc8ccb3d07985227",
      safetyIdentitySnapshot: "bfdeb1063f2f382b897c072d29a30defffe3371d46ae8a958d2b3a4c5722e1ac",
      sourceIdentitySnapshot: "9ca51f3f51c78350c44a129a35c44cb18c451400569862275674e3039b78a335",
      suppressionIdentitySnapshot: "3ecb57ca13fe5abb8fec1531ec9fab036cbd83e32d2ce38900f8db752e5e2117"
    });
  });
});
