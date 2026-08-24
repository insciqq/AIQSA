import {
  MEMORY_PROPOSITION_IDENTITY_VERSION,
  MEMORY_SLOT_IDENTITY_VERSION,
  memoryPropositionCanonicalKey,
  memorySlotCanonicalKey,
  normalizeMemoryIdentityComponent,
  normalizeMemoryProposition,
  normalizeMemorySemanticText
} from "./normalization";

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

function groundedLabel(sourceText: string, value: string | null): boolean {
  const source = normalizeMemorySemanticText(sourceText, 2_000)
    ?.toLocaleLowerCase("und");
  const label = text(value)?.toLocaleLowerCase("und");
  return Boolean(source && label && source.includes(label));
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
    ? new Set(["category", "format", "interaction", "topic"])
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
  sourceText: string;
  statement: string;
  value: MemoryValueProposal;
}>): ResolvedMemoryIdentity {
  const fallback = () => proposition(input.statement, input.memoryType);
  if (input.identity.mode !== "SLOT" || input.identity.predicateKey === null ||
    !(MEMORY_SLOT_PREDICATES as readonly string[]).includes(
      input.identity.predicateKey
    )) return fallback();
  const predicate = input.identity.predicateKey as MemorySlotPredicate;
  const value = input.value;

  if (predicate === "product_status") {
    if (!groundedLabel(
      input.sourceText,
      input.identity.subject.qualifiers.model ??
        input.identity.subject.canonicalLabel
    )) {
      invalid("memory_fact_product_identity_unsupported");
    }
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
    if (value.place !== null && !groundedLabel(input.sourceText, value.place)) {
      invalid("memory_fact_residence_identity_unsupported");
    }
    if (input.identity.subject.entityType !== "PERSON_SELF" ||
      value.place === null || value.kind === null ||
      !residenceKinds.has(value.kind) || !onlyFields(value, ["kind", "place"]) ||
      /(?:\bpreviously\b|\bused to\b|\bformer(?:ly)?\b|(?:^|[^\p{L}])раньше(?:$|[^\p{L}]))/iu.test(
        input.sourceText
      )) return fallback();
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
    if (input.identity.dimensionKey !== null &&
      !groundedLabel(input.sourceText, input.identity.dimensionKey)) {
      invalid("memory_fact_employment_identity_unsupported");
    }
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
    if (input.identity.subject.canonicalLabel !== null &&
      !groundedLabel(input.sourceText, input.identity.subject.canonicalLabel)) {
      invalid("memory_fact_subject_identity_unsupported");
    }
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
    if (!normalizedValue || !onlyFields(value, ["strength", "value"]) ||
      (value.strength !== null && !preferenceStrengths.has(value.strength))) {
      return fallback();
    }
    return slotResult({
      category: "preferences",
      dimensionKey,
      predicateKey: predicate,
      structuredValue: {
        schema: "preference-v1",
        strength: value.strength,
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

const productStatusEvidence: Readonly<Record<string, RegExp>> = Object.freeze({
  borrowed: /(?:\bborrowed\b|(?:^|[^\p{L}])(?:одолжил[аи]?|взял[аи]?\s+у)(?:$|[^\p{L}]))/iu,
  cancelled: /(?:\bcancel(?:led|ed)\b|(?:^|[^\p{L}])отменил[аи]?(?:$|[^\p{L}]))/iu,
  considering: /(?:\bconsider(?:ing)?\b|\bthinking\s+(?:of|about)\b|(?:^|[^\p{L}])думаю\s+(?:купить|о покупке)(?:$|[^\p{L}]))/iu,
  no_longer_owned: /(?:\bno longer own\b|(?:^|[^\p{L}])больше\s+не\s+владею(?:$|[^\p{L}]))/iu,
  ordered: /(?:\bordered\b|(?:^|[^\p{L}])заказал[аи]?(?:$|[^\p{L}]))/iu,
  owned: /(?:\bi\s+(?:bought|purchased|own|got)\b|\bmy\s+new\b|(?:^|[^\p{L}])я\s+(?:купил[аи]?|приобр[её]л[аи]?|получил[аи]?|владею)(?:$|[^\p{L}])|(?:^|[^\p{L}])мо[йяе]\s+нов)/iu,
  planned: /(?:\bplan(?:ning)?\s+to\s+(?:buy|purchase)\b|(?:^|[^\p{L}])планирую\s+купить(?:$|[^\p{L}]))/iu,
  returned: /(?:\breturned\b|(?:^|[^\p{L}])вернул[аи]?(?:$|[^\p{L}]))/iu,
  shared: /(?:\bshared\b|(?:^|[^\p{L}])общ(?:ий|ая|ее)(?:$|[^\p{L}]))/iu,
  sold: /(?:\bsold\b|(?:^|[^\p{L}])продал[аи]?(?:$|[^\p{L}]))/iu,
  work_device: /(?:\bwork\s+(?:device|laptop|phone|computer)\b|(?:^|[^\p{L}])рабоч(?:ий|ая|ее)(?:$|[^\p{L}]))/iu
});

export function memoryProductStatusEvidenceIsExplicit(
  state: string,
  sourceText: string
): boolean {
  return productStatusEvidence[state]?.test(sourceText) ?? false;
}

export function memorySourceLooksNonAuthoritative(sourceText: string): boolean {
  const text = sourceText.normalize("NFKC");
  const possessiveOwnership = /(?:\bmy\s+new\b|(?:^|[^\p{L}])мо[йяе]\s+нов)/iu.test(text);
  return (
    /^\s*(?:assistant|system|tool|web|model|ассистент|система|инструмент|веб)\s*:/iu.test(text) ||
    /(?:\bif\b|\bwould\b|\bhypothetically\b|(?:^|[^\p{L}])(?:если|допустим)(?:$|[^\p{L}]))/iu.test(text) ||
    /(?:\bmy\s+(?:brother|sister|friend)\b|(?:^|[^\p{L}])у\s+(?:брата|сестры|друга|подруги)(?:$|[^\p{L}]))/iu.test(text) ||
    (/[?？]\s*$/u.test(text.trim()) && !possessiveOwnership)
  );
}

/** A first-person fragment copied inside a quotation remains quoted source
 * data, not direct user authority. This intentionally rejects ambiguous
 * self-quotation; an explicit Saved Memory action remains available. */
export function memoryEvidenceLooksNonAuthoritative(
  sourceText: string,
  evidenceQuote: string
): boolean {
  if (memorySourceLooksNonAuthoritative(sourceText)) return true;
  const start = sourceText.indexOf(evidenceQuote);
  if (start < 0) return true;
  const before = sourceText.slice(0, start);
  const after = sourceText.slice(start + evidenceQuote.length);
  const trimmed = evidenceQuote.trim();
  const selfDelimited =
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("“") && trimmed.endsWith("”")) ||
    (trimmed.startsWith("«") && trimmed.endsWith("»"));
  const enclosed = /["“«]\s*$/u.test(before) && /^\s*["”»]/u.test(after);
  return selfDelimited || enclosed;
}
