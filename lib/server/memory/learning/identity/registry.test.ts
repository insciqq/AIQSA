import { describe, expect, it } from "vitest";
import type { MemorySemanticFrame } from "../extraction/contract";
import {
  MemoryIdentityError,
  resolveMemoryIdentity,
  type MemoryIdentityProposal,
  type MemoryValueProposal
} from "./registry";

const frame: MemorySemanticFrame = Object.freeze({
  assertionStatus: "ASSERTED",
  changeIntent: "NONE",
  memoryDirective: "NONE",
  polarity: "AFFIRMED",
  speechAct: "ASSERTION",
  subjectScope: "CURRENT_USER",
  temporalPerspective: "CURRENT"
});

const emptyValue: MemoryValueProposal = Object.freeze({
  frequency: null,
  kind: null,
  limit: null,
  place: null,
  role: null,
  schedule: null,
  state: null,
  strength: null,
  value: null
});

function identity(overrides: Partial<MemoryIdentityProposal> = {}): MemoryIdentityProposal {
  return {
    dimensionKey: null,
    mode: "PROPOSITION",
    predicateKey: null,
    subject: {
      canonicalLabel: null,
      entityType: "NONE",
      qualifiers: { brand: null, model: null }
    },
    ...overrides
  };
}

describe("language-neutral Memory identity registry", () => {
  it("builds code-owned product SLOT identity from validated structured values", () => {
    const result = resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "product_status",
        subject: {
          canonicalLabel: "MacBook Air M4",
          entityType: "DEVICE",
          qualifiers: { brand: "Apple", model: "MacBook Air M4" }
        }
      }),
      memoryType: "STATE",
      semanticFrame: frame,
      statement: "opaque statement",
      value: { ...emptyValue, state: "owned" }
    });
    expect(result).toMatchObject({
      identityKind: "SLOT",
      predicateKey: "product_status",
      structuredValue: { schema: "product-status-v1", state: "owned" }
    });
  });

  it("uses structured temporal perspective, never source wording, for former residence", () => {
    const proposal = identity({
      dimensionKey: "primary",
      mode: "SLOT",
      predicateKey: "residence",
      subject: {
        canonicalLabel: null,
        entityType: "PERSON_SELF",
        qualifiers: { brand: null, model: null }
      }
    });
    const current = resolveMemoryIdentity({
      identity: proposal,
      memoryType: "STATE",
      semanticFrame: frame,
      statement: "same opaque statement",
      value: { ...emptyValue, kind: "primary", place: "Turku" }
    });
    const former = resolveMemoryIdentity({
      identity: proposal,
      memoryType: "STATE",
      semanticFrame: { ...frame, temporalPerspective: "FORMER" },
      statement: "same opaque statement",
      value: { ...emptyValue, kind: "primary", place: "Turku" }
    });
    expect(current.identityKind).toBe("SLOT");
    expect(former.identityKind).toBe("PROPOSITION");
  });

  it("falls back conservatively when a SLOT vocabulary is incomplete", () => {
    const result = resolveMemoryIdentity({
      identity: identity({
        dimensionKey: "format:answer",
        mode: "SLOT",
        predicateKey: "preference",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "PREFERENCE",
      semanticFrame: frame,
      statement: "opaque preference",
      value: emptyValue
    });
    expect(result.identityKind).toBe("PROPOSITION");
  });

  it("drops an unsupported optional preference strength without losing the SLOT", () => {
    const result = resolveMemoryIdentity({
      identity: identity({
        dimensionKey: "format:answer",
        mode: "SLOT",
        predicateKey: "preference",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "PREFERENCE",
      semanticFrame: frame,
      statement: "opaque preference",
      value: { ...emptyValue, strength: "consistent", value: "concise" }
    });
    expect(result).toMatchObject({
      identityKind: "SLOT",
      predicateKey: "preference",
      structuredValue: { strength: null, value: "concise" }
    });
  });

  it("rejects invalid code-owned product states independent of language", () => {
    expect(() => resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "product_status",
        subject: {
          canonicalLabel: "device",
          entityType: "DEVICE",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "STATE",
      semanticFrame: frame,
      statement: "opaque",
      value: { ...emptyValue, state: "maybe_owned" }
    })).toThrowError(new MemoryIdentityError("memory_fact_identity_invalid"));
  });

  it("moves colliding legacy SLOT components into distinct Unicode identities", () => {
    const proposal = (dimensionKey: string) => ({
      identity: identity({
        dimensionKey,
        mode: "SLOT",
        predicateKey: "preference",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF" as const,
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "PREFERENCE",
      semanticFrame: frame,
      statement: "opaque preference",
      value: { ...emptyValue, value: "concise" }
    });
    const legacyAscii = resolveMemoryIdentity(
      proposal("topic:caf"),
      "LEGACY_V1"
    );
    const legacyUnicode = resolveMemoryIdentity(
      proposal("topic:cafè"),
      "LEGACY_V1"
    );
    const unicodeAscii = resolveMemoryIdentity(
      proposal("topic:caf"),
      "UNICODE_V2"
    );
    const unicodeLabel = resolveMemoryIdentity(
      proposal("topic:cafè"),
      "UNICODE_V2"
    );
    expect(legacyUnicode.canonicalKey).toBe(legacyAscii.canonicalKey);
    expect(unicodeLabel.canonicalKey).not.toBe(unicodeAscii.canonicalKey);
    expect(unicodeLabel.identityVersion).toBe("slot-v4");
  });
});
