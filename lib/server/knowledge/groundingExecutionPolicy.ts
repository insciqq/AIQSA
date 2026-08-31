import type { ProviderModelCapabilities } from "../providers/types";

export const KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION = 1 as const;

export type KnowledgeGroundingExecutionRole =
  | "auditor"
  | "draft"
  | "selector"
  | "supplement";

export type KnowledgeGroundingExecutionPolicyV1 = Readonly<{
  auditorReasoningEffort: "inherit" | string;
  draftReasoningEffort: "inherit" | string;
  selectorReasoningEffort: "inherit" | string;
  supplementReasoningEffort: "inherit" | string;
  version: typeof KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION;
}>;

/** Exact content-free policy frozen for one accepted V21 operation family. */
export type KnowledgeGroundingEffectiveExecutionPolicyV1 = Readonly<{
  auditorReasoningEffort: string | null;
  draftReasoningEffort: string | null;
  egressDestination: "answer_provider";
  overriddenRoles: readonly KnowledgeGroundingExecutionRole[];
  providerBindingKey: "answer";
  selectorReasoningEffort: string | null;
  supplementReasoningEffort: string | null;
  version: typeof KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION;
}>;

/** Code-owned installation policy. Changing it affects only future V21
 * operation families; accepted snapshots retain their exact effective policy. */
export const KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1 = Object.freeze({
  auditorReasoningEffort: "inherit",
  draftReasoningEffort: "inherit",
  selectorReasoningEffort: "inherit",
  supplementReasoningEffort: "inherit",
  version: KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION
} as const satisfies KnowledgeGroundingExecutionPolicyV1);

const roles = Object.freeze([
  "draft",
  "selector",
  "auditor",
  "supplement"
] as const satisfies readonly KnowledgeGroundingExecutionRole[]);

const policyKeys = Object.freeze([
  "auditorReasoningEffort",
  "draftReasoningEffort",
  "selectorReasoningEffort",
  "supplementReasoningEffort",
  "version"
] as const);

const effectivePolicyKeys = Object.freeze([
  "auditorReasoningEffort",
  "draftReasoningEffort",
  "egressDestination",
  "overriddenRoles",
  "providerBindingKey",
  "selectorReasoningEffort",
  "supplementReasoningEffort",
  "version"
] as const);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function reasoningEffort(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 32 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableReasoningEffort(value: unknown): value is string | null {
  return value === null || reasoningEffort(value);
}

export function decodeKnowledgeGroundingExecutionPolicyV1(
  value: unknown
): KnowledgeGroundingExecutionPolicyV1 | null {
  if (!record(value) || !exactKeys(value, policyKeys) ||
    value.version !== KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION ||
    !reasoningEffort(value.auditorReasoningEffort) ||
    !reasoningEffort(value.draftReasoningEffort) ||
    !reasoningEffort(value.selectorReasoningEffort) ||
    !reasoningEffort(value.supplementReasoningEffort)) return null;
  return Object.freeze({
    auditorReasoningEffort: value.auditorReasoningEffort,
    draftReasoningEffort: value.draftReasoningEffort,
    selectorReasoningEffort: value.selectorReasoningEffort,
    supplementReasoningEffort: value.supplementReasoningEffort,
    version: KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION
  });
}

export function decodeKnowledgeGroundingEffectiveExecutionPolicyV1(
  value: unknown
): KnowledgeGroundingEffectiveExecutionPolicyV1 | null {
  if (!record(value) || !exactKeys(value, effectivePolicyKeys) ||
    value.version !== KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION ||
    value.providerBindingKey !== "answer" ||
    value.egressDestination !== "answer_provider" ||
    !nullableReasoningEffort(value.auditorReasoningEffort) ||
    !nullableReasoningEffort(value.draftReasoningEffort) ||
    !nullableReasoningEffort(value.selectorReasoningEffort) ||
    !nullableReasoningEffort(value.supplementReasoningEffort) ||
    !Array.isArray(value.overriddenRoles) ||
    value.overriddenRoles.some((role) => !roles.includes(
      role as KnowledgeGroundingExecutionRole
    ))) return null;
  const overriddenRoles = value.overriddenRoles as KnowledgeGroundingExecutionRole[];
  const inheritedEfforts = roles
    .filter((role) => !overriddenRoles.includes(role))
    .map((role) => {
      switch (role) {
        case "auditor":
          return value.auditorReasoningEffort;
        case "draft":
          return value.draftReasoningEffort;
        case "selector":
          return value.selectorReasoningEffort;
        case "supplement":
          return value.supplementReasoningEffort;
      }
    });
  if (new Set(overriddenRoles).size !== overriddenRoles.length ||
    roles.filter((role) => overriddenRoles.includes(role)).some(
      (role, index) => role !== overriddenRoles[index]
    ) || new Set(inheritedEfforts).size > 1) return null;
  return Object.freeze({
    auditorReasoningEffort: value.auditorReasoningEffort,
    draftReasoningEffort: value.draftReasoningEffort,
    egressDestination: "answer_provider",
    overriddenRoles: Object.freeze([...overriddenRoles]),
    providerBindingKey: "answer",
    selectorReasoningEffort: value.selectorReasoningEffort,
    supplementReasoningEffort: value.supplementReasoningEffort,
    version: KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION
  });
}

export function resolveKnowledgeGroundingExecutionPolicyV1(input: Readonly<{
  inheritedReasoningEffort?: string | null;
  modelCapabilities: ProviderModelCapabilities;
  policy?: KnowledgeGroundingExecutionPolicyV1;
}>): KnowledgeGroundingEffectiveExecutionPolicyV1 {
  const policy = decodeKnowledgeGroundingExecutionPolicyV1(
    input.policy ?? KNOWLEDGE_GROUNDING_EXECUTION_POLICY_V1
  );
  const inheritedReasoningEffort = input.inheritedReasoningEffort ?? null;
  if (!policy || !nullableReasoningEffort(inheritedReasoningEffort)) {
    throw new Error("knowledge_grounding_execution_policy_invalid");
  }
  const overriddenRoles: KnowledgeGroundingExecutionRole[] = [];
  const resolve = (
    role: KnowledgeGroundingExecutionRole,
    configured: string
  ): string | null => {
    if (configured === "inherit") return inheritedReasoningEffort;
    if (input.modelCapabilities.reasoning !== true ||
      !input.modelCapabilities.reasoningEfforts?.includes(configured)) {
      throw new Error("knowledge_grounding_execution_policy_unsupported");
    }
    overriddenRoles.push(role);
    return configured;
  };
  const draftReasoningEffort = resolve("draft", policy.draftReasoningEffort);
  const selectorReasoningEffort = resolve(
    "selector",
    policy.selectorReasoningEffort
  );
  const auditorReasoningEffort = resolve(
    "auditor",
    policy.auditorReasoningEffort
  );
  const supplementReasoningEffort = resolve(
    "supplement",
    policy.supplementReasoningEffort
  );
  return Object.freeze({
    auditorReasoningEffort,
    draftReasoningEffort,
    egressDestination: "answer_provider",
    overriddenRoles: Object.freeze(roles.filter((role) => overriddenRoles.includes(role))),
    providerBindingKey: "answer",
    selectorReasoningEffort,
    supplementReasoningEffort,
    version: KNOWLEDGE_GROUNDING_EXECUTION_POLICY_VERSION
  });
}

export function knowledgeGroundingReasoningEffortForRoleV1(
  policy: KnowledgeGroundingEffectiveExecutionPolicyV1,
  role: KnowledgeGroundingExecutionRole
): string | null {
  const decoded = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(policy);
  if (!decoded || !roles.includes(role)) {
    throw new Error("knowledge_grounding_execution_policy_invalid");
  }
  switch (role) {
    case "auditor":
      return decoded.auditorReasoningEffort;
    case "draft":
      return decoded.draftReasoningEffort;
    case "selector":
      return decoded.selectorReasoningEffort;
    case "supplement":
      return decoded.supplementReasoningEffort;
  }
}
