import { describe, expect, it } from "vitest";
import {
  memoryPropositionCanonicalKey,
  normalizeMemoryIdentityComponent
} from "./normalization";
import {
  memoryProductStatusEvidenceIsExplicit,
  memorySourceLooksNonAuthoritative,
  resolveMemoryIdentity,
  type MemoryIdentityProposal,
  type MemoryValueProposal
} from "./registry";

const emptyValue: MemoryValueProposal = {
  frequency: null,
  kind: null,
  limit: null,
  place: null,
  role: null,
  schedule: null,
  state: null,
  strength: null,
  value: null
};

function identity(
  overrides: Partial<MemoryIdentityProposal> = {}
): MemoryIdentityProposal {
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

describe("Memory vNext identity registry", () => {
  it("uses readable ASCII components and collision-resistant non-transliterated hashes", () => {
    expect(normalizeMemoryIdentityComponent("product", "  MacBook   Air M4 "))
      .toBe("macbook-air-m4");
    const cyrillic = normalizeMemoryIdentityComponent("place", "Хельсинки");
    expect(cyrillic).toMatch(/^h-[a-f0-9]{48}$/u);
    expect(cyrillic).toBe(
      normalizeMemoryIdentityComponent("place", "Хельсинки")
    );
    expect(cyrillic).not.toContain("helsinki");
  });

  it("creates dimension-aware residence and employment slots", () => {
    const residence = resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "residence",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "STATE",
      sourceText: "Я живу в Хельсинки",
      statement: "Пользователь живёт в Хельсинки",
      value: { ...emptyValue, kind: "primary", place: "Хельсинки" }
    });
    expect(residence).toMatchObject({
      canonicalKey: "slot:v2:person:self:residence:primary",
      dimensionKey: "primary",
      identityKind: "SLOT",
      predicateKey: "residence",
      subjectKey: "person:self"
    });
    expect(residence.structuredValue).toMatchObject({
      kind: "primary",
      placeKey: expect.stringMatching(/^place:h-[a-f0-9]{48}$/u),
      schema: "residence-v1"
    });

    const employment = resolveMemoryIdentity({
      identity: identity({
        dimensionKey: "OpenAI",
        mode: "SLOT",
        predicateKey: "employment_status",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "WORKFLOW",
      sourceText: "I work at OpenAI as an engineer.",
      statement: "The user works at OpenAI as an engineer.",
      value: { ...emptyValue, role: "engineer", state: "current" }
    });
    expect(employment.canonicalKey)
      .toBe("slot:v2:person:self:employment_status:organization:openai");
    expect(employment.structuredValue).toEqual({
      roleKey: "engineer",
      schema: "employment-status-v1",
      state: "current"
    });
  });

  it("keeps category metadata out of proposition identity", () => {
    const statement = "The user reads release notes.";
    const common = {
      identity: identity(),
      sourceText: "I read release notes.",
      statement,
      value: emptyValue
    };
    const preference = resolveMemoryIdentity({
      ...common,
      memoryType: "PREFERENCE"
    });
    const state = resolveMemoryIdentity({ ...common, memoryType: "STATE" });
    expect(preference.category).not.toBe(state.category);
    expect(preference.canonicalKey).toBe(state.canonicalKey);
  });

  it.each(["constraint", "routine"] as const)(
    "falls back to proposition when %s has no stable dimension",
    (predicateKey) => {
      const resolved = resolveMemoryIdentity({
        identity: identity({
          mode: "SLOT",
          predicateKey,
          subject: {
            canonicalLabel: null,
            entityType: "PERSON_SELF",
            qualifiers: { brand: null, model: null }
          }
        }),
        memoryType: predicateKey === "constraint" ? "CONSTRAINT" : "HABIT",
        sourceText: "I have a durable personal rule.",
        statement: "The user has a durable personal rule.",
        value: { ...emptyValue, value: "durable personal rule" }
      });
      expect(resolved.identityKind).toBe("PROPOSITION");
    }
  );

  it("falls back to a proposition for weak dimensions and retrospective residence", () => {
    const weakPreference = resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "preference",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "PREFERENCE",
      sourceText: "I prefer compact phones.",
      statement: "The user prefers compact phones.",
      value: { ...emptyValue, value: "compact phones" }
    });
    expect(weakPreference).toMatchObject({
      canonicalKey: memoryPropositionCanonicalKey(
        "The user prefers compact phones."
      ),
      identityKind: "PROPOSITION"
    });

    const unknownPredicate = resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "ownership_status"
      }),
      memoryType: "STATE",
      sourceText: "I have a device.",
      statement: "The user has a device.",
      value: { ...emptyValue, state: "owned" }
    });
    expect(unknownPredicate.identityKind).toBe("PROPOSITION");

    const formerResidence = resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "residence",
        subject: {
          canonicalLabel: null,
          entityType: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      }),
      memoryType: "STATE",
      sourceText: "I previously lived in Helsinki.",
      statement: "The user previously lived in Helsinki.",
      value: { ...emptyValue, kind: "primary", place: "Helsinki" }
    });
    expect(formerResidence.identityKind).toBe("PROPOSITION");
  });

  it("keeps product ownership states distinct and requires direct evidence", () => {
    const workDevice = resolveMemoryIdentity({
      identity: identity({
        mode: "SLOT",
        predicateKey: "product_status",
        subject: {
          canonicalLabel: "MacBook Air",
          entityType: "DEVICE",
          qualifiers: { brand: "Apple", model: "MacBook Air" }
        }
      }),
      memoryType: "STATE",
      sourceText: "This is my work MacBook Air.",
      statement: "The user uses a work MacBook Air.",
      value: { ...emptyValue, state: "work_device" }
    });
    expect(workDevice.structuredValue).toEqual({
      schema: "product-status-v1",
      state: "work_device"
    });
    expect(memoryProductStatusEvidenceIsExplicit(
      "work_device",
      "This is my work laptop."
    )).toBe(true);
    expect(memoryProductStatusEvidenceIsExplicit(
      "owned",
      "This is my work laptop."
    )).toBe(false);
    expect(memoryProductStatusEvidenceIsExplicit(
      "borrowed",
      "I borrowed this laptop."
    )).toBe(true);
  });

  it("flags questions, hypotheticals and third-party statements as non-authoritative", () => {
    expect(memorySourceLooksNonAuthoritative("How do I configure a MacBook?"))
      .toBe(true);
    expect(memorySourceLooksNonAuthoritative("If I bought a MacBook, would it work?"))
      .toBe(true);
    expect(memorySourceLooksNonAuthoritative("My brother owns a MacBook."))
      .toBe(true);
    expect(memorySourceLooksNonAuthoritative("I bought a MacBook."))
      .toBe(false);
    expect(memorySourceLooksNonAuthoritative("My new MacBook? It is excellent."))
      .toBe(false);
  });
});
