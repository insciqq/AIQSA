import {
  MEMORY_PROPOSITION_IDENTITY_VERSION,
  MEMORY_SLOT_IDENTITY_VERSION,
  memoryPropositionCanonicalKey,
  memorySlotCanonicalKey,
  normalizeMemoryIdentityComponent,
  normalizeMemoryProposition,
  normalizeMemorySemanticText
} from "./normalization";
import type { MemorySemanticFrame } from "../extraction/contract";

export const MEMORY_SLOT_PREDICATES = Object.freeze([
  "product_status",
  "residence",
  "employment_status",
  "goal_status",
  "project_status",
  "preference",
  "constraint",
  "routine"
] as const);

export const MEMORY_PREFERENCE_DIMENSION_PREFIXES = Object.freeze([
  "category", "format", "interaction", "topic"
] as const);

export type MemorySlotPredicate = (typeof MEMORY_SLOT_PREDICATES)[number];
export type MemoryIdentityEntityType =
  | "NONE"
  | "PERSON_SELF"
  | "PRODUCT"
  | "DEVICE"
  | "SERVICE"
  | "GOAL"
  | "PROJECT";

export type MemoryIdentityProposal = Readonly<{
  dimensionKey: string | null;
  mode: "PROPOSITION" | "SLOT";
  predicateKey: string | null;
  subject: Readonly<{
    canonicalLabel: string | null;
    entityType: MemoryIdentityEntityType;
    qualifiers: Readonly<{
      brand: string | null;
      model: string | null;
    }>;
  }>;
}>;

export type MemoryValueProposal = Readonly<{
  frequency: string | null;
  kind: string | null;
  limit: string | null;
  place: string | null;
  role: string | null;
  schedule: string | null;
  state: string | null;
  strength: string | null;
  value: string | null;
}>;

export type ResolvedMemoryIdentity = Readonly<{
  canonicalKey: string;
  category: "about_you" | "constraints_routines" | "goals" | "other" |
    "preferences" | "work";
  dimensionKey: string | null;
  identityKind: "PROPOSITION" | "SLOT";
  identityVersion: "proposition-v1" | "slot-v2";
  predicateKey: MemorySlotPredicate | null;
  structuredValue: Readonly<Record<string, string | null>>;
  subjectKey: string | null;
}>;

export class MemoryIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryIdentityError";
  }
}

const productStates = new Set([
  "considering", "planned", "ordered", "owned", "borrowed", "work_device",
  "shared", "returned", "sold", "cancelled", "no_longer_owned"
]);
const residenceKinds = new Set(["primary", "secondary", "temporary"]);
const employmentStates = new Set(["current", "leave_planned", "former"]);
const goalStates = new Set([
  "considering", "planned", "in_progress", "paused", "blocked", "completed",
  "cancelled", "abandoned"
]);
const projectStates = new Set([
  "planned", "active", "paused", "blocked", "completed", "cancelled", "archived"
]);
const preferenceStrengths = new Set(["weak", "normal", "strong"]);

function invalid(code = "memory_fact_identity_invalid"): never {
  throw new MemoryIdentityError(code);
}

function onlyFields(
  proposal: MemoryValueProposal,
  allowed: readonly (keyof MemoryValueProposal)[]
): boolean {
  const allow = new Set(allowed);
  return Object.entries(proposal).every(([key, value]) =>
    value === null || allow.has(key as keyof MemoryValueProposal));
}

function text(value: string | null, maxLength = 512): string | null {
  return value === null ? null : normalizeMemorySemanticText(value, maxLength);
}

function component(namespace: string, value: string | null): string {
  if (value === null) invalid();
  return normalizeMemoryIdentityComponent(namespace, value) ?? invalid();
}

function proposition(statement: string, memoryType: string): ResolvedMemoryIdentity {
  const canonicalKey = memoryPropositionCanonicalKey(statement) ?? invalid();
  const normalizedStatement = normalizeMemoryProposition(statement) ?? invalid();
  const category = memoryType === "PREFERENCE"
    ? "preferences"
    : memoryType === "CONSTRAINT" || memoryType === "HABIT" ||
        memoryType === "WORKFLOW"
      ? "constraints_routines"
      : memoryType === "INTENTION" || memoryType === "PLAN"
        ? "goals"
        : "other";
  return {
    canonicalKey,
    category,
    dimensionKey: null,
    identityKind: "PROPOSITION",
    identityVersion: MEMORY_PROPOSITION_IDENTITY_VERSION,
    predicateKey: null,
    structuredValue: {
      normalizedStatement,
      schema: "generic-fact-v1"
    },
    subjectKey: null
  };
}

function normalizedDimension(
  predicate: "constraint" | "preference" | "routine",
  value: string | null
): string | null {
  const raw = text(value, 256);
  if (!raw) return null;
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) return null;
  const prefix = raw.slice(0, separator).toLocaleLowerCase("und");
  const allowed = predicate === "preference"
    ? new Set<string>(MEMORY_PREFERENCE_DIMENSION_PREFIXES)
    : predicate === "constraint"
      ? new Set(["accessibility", "availability", "dietary", "limit", "resource", "topic"])
      : new Set(["activity", "schedule", "workflow"]);
  if (!allowed.has(prefix)) return null;
  const suffix = normalizeMemoryIdentityComponent(
    `${predicate}-dimension`,
    raw.slice(separator + 1)
  );
  return suffix ? `${prefix}:${suffix}` : null;
}

function slotResult(input: Readonly<{
  category: ResolvedMemoryIdentity["category"];
  dimensionKey: string | null;
  predicateKey: MemorySlotPredicate;
  structuredValue: ResolvedMemoryIdentity["structuredValue"];
  subjectKey: string;
}>): ResolvedMemoryIdentity {
  return {
    canonicalKey: memorySlotCanonicalKey(input),
    category: input.category,
    dimensionKey: input.dimensionKey,
    identityKind: "SLOT",
    identityVersion: MEMORY_SLOT_IDENTITY_VERSION,
    predicateKey: input.predicateKey,
    structuredValue: input.structuredValue,
    subjectKey: input.subjectKey
  };
}

function productSubject(proposal: MemoryIdentityProposal): string | null {
  if (!["PRODUCT", "DEVICE", "SERVICE"].includes(proposal.subject.entityType) ||
    proposal.subject.canonicalLabel === null) return null;
  const label = component("product-label", proposal.subject.canonicalLabel);
  const brand = proposal.subject.qualifiers.brand === null
    ? null
    : component("product-brand", proposal.subject.qualifiers.brand);
  const model = proposal.subject.qualifiers.model === null
    ? label
    : component("product-model", proposal.subject.qualifiers.model);
  const prefix = proposal.subject.entityType.toLocaleLowerCase("und");
  return brand ? `${prefix}:${brand}:${model}` : `${prefix}:${model}`;
}

/** Resolves a provider proposal into code-owned identity/value JSON. Weak or
 * incomplete SLOT guesses conservatively become a proposition. */
export function resolveMemoryIdentity(input: Readonly<{
  identity: MemoryIdentityProposal;
  memoryType: string;
  semanticFrame: MemorySemanticFrame;
  statement: string;
  value: MemoryValueProposal;
}>): ResolvedMemoryIdentity {
  const fallback = () => proposition(input.statement, input.memoryType);
  if (input.identity.mode !== "SLOT" || input.identity.predicateKey === null ||
    !(MEMORY_SLOT_PREDICATES as readonly string[]).includes(
      input.identity.predicateKey
    )) return fallback();
  // Historical status can remain a source-grounded proposition but never
  // acquires the current SLOT identity. All other authority fields are
  // admitted by the semantic boundary (and, when required, adjudication).
  if (input.semanticFrame.temporalPerspective === "FORMER") return fallback();
  const predicate = input.identity.predicateKey as MemorySlotPredicate;
  const value = input.value;

  if (predicate === "product_status") {
    const subjectKey = productSubject(input.identity);
    if (!subjectKey || value.state === null || !productStates.has(value.state) ||
      !onlyFields(value, ["state"])) invalid();
    return slotResult({
      category: "about_you",
      dimensionKey: null,
      predicateKey: predicate,
      structuredValue: { schema: "product-status-v1", state: value.state },
      subjectKey
    });
  }

  if (predicate === "residence") {
    if (input.identity.subject.entityType !== "PERSON_SELF" ||
      value.place === null || value.kind === null ||
      !residenceKinds.has(value.kind) || !onlyFields(value, ["kind", "place"])) {
      return fallback();
    }
    const placeKey = `place:${component("residence-place", value.place)}`;
    const dimensionKey = value.kind === "primary"
      ? "primary"
      : input.identity.dimensionKey === null
        ? null
        : `${value.kind}:${component(
            `residence-${value.kind}-dimension`,
            input.identity.dimensionKey
          )}`;
    if (!dimensionKey) return fallback();
    return slotResult({
      category: "about_you",
      dimensionKey,
      predicateKey: predicate,
      structuredValue: {
        kind: value.kind,
        placeKey,
        schema: "residence-v1"
      },
      subjectKey: "person:self"
    });
  }

  if (predicate === "employment_status") {
    if (input.identity.subject.entityType !== "PERSON_SELF" ||
      value.state === null || !employmentStates.has(value.state) ||
      !onlyFields(value, ["role", "state"])) return fallback();
    const organization = input.identity.dimensionKey === null
      ? null
      : component("employment-organization", input.identity.dimensionKey);
    if (!organization) return fallback();
    return slotResult({
      category: "work",
      dimensionKey: `organization:${organization}`,
      predicateKey: predicate,
      structuredValue: {
        roleKey: value.role === null
          ? null
          : component("employment-role", value.role),
        schema: "employment-status-v1",
        state: value.state
      },
      subjectKey: "person:self"
    });
  }

  if (predicate === "goal_status" || predicate === "project_status") {
    const expectedType = predicate === "goal_status" ? "GOAL" : "PROJECT";
    const states = predicate === "goal_status" ? goalStates : projectStates;
    if (input.identity.subject.entityType !== expectedType ||
      input.identity.subject.canonicalLabel === null || value.state === null ||
      !states.has(value.state) || !onlyFields(value, ["state"])) {
      return fallback();
    }
    const subjectKey = `${expectedType.toLocaleLowerCase("und")}:${component(
      `${predicate}-subject`,
      input.identity.subject.canonicalLabel
    )}`;
    return slotResult({
      category: predicate === "goal_status" ? "goals" : "work",
      dimensionKey: null,
      predicateKey: predicate,
      structuredValue: {
        schema: predicate === "goal_status" ? "goal-status-v1" : "project-status-v1",
        state: value.state
      },
      subjectKey
    });
  }

  if (input.identity.subject.entityType !== "PERSON_SELF") return fallback();
  const dimensionKey = normalizedDimension(predicate, input.identity.dimensionKey);
  if (!dimensionKey) return fallback();
  if (predicate === "preference") {
    const normalizedValue = text(value.value);
    if (!normalizedValue || !onlyFields(value, ["strength", "value"])) {
      return fallback();
    }
    const strength = value.strength !== null &&
      preferenceStrengths.has(value.strength) ? value.strength : null;
    return slotResult({
      category: "preferences",
      dimensionKey,
      predicateKey: predicate,
      structuredValue: {
        schema: "preference-v1",
        strength,
        value: normalizedValue
      },
      subjectKey: "person:self"
    });
  }
  if (predicate === "constraint") {
    const normalizedValue = text(value.value);
    const limit = text(value.limit);
    if ((!normalizedValue && !limit) || !onlyFields(value, ["limit", "value"])) {
      return fallback();
    }
    return slotResult({
      category: "constraints_routines",
      dimensionKey,
      predicateKey: predicate,
      structuredValue: {
        limit,
        schema: "constraint-v1",
        value: normalizedValue
      },
      subjectKey: "person:self"
    });
  }
  const frequency = text(value.frequency);
  const schedule = text(value.schedule);
  const normalizedValue = text(value.value);
  if ((!frequency && !schedule && !normalizedValue) ||
    !onlyFields(value, ["frequency", "schedule", "value"])) return fallback();
  return slotResult({
    category: "constraints_routines",
    dimensionKey,
    predicateKey: predicate,
    structuredValue: {
      frequency,
      schedule,
      schema: "routine-v1",
      value: normalizedValue
    },
    subjectKey: "person:self"
  });
}
