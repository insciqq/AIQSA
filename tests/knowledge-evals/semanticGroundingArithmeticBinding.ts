import { createHash } from "node:crypto";
import type {
  KnowledgeEvidencePackage,
  KnowledgeEvidencePackageItem
} from "../../lib/server/knowledge/evidencePackage";
import {
  KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
  createKnowledgeSemanticArithmeticReceipt,
  knowledgeSemanticArithmeticDecimal,
  verifyKnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticInput,
  type KnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticSpecification,
  type KnowledgeSemanticArithmeticVerification
} from "../../lib/server/knowledge/semanticArithmetic";
import type {
  KnowledgeSemanticGroundingArithmeticPlan
} from "./semanticGroundingFixtures";

export const KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION =
  "knowledge-semantic-arithmetic-binding-v1" as const;

export type KnowledgeSemanticArithmeticBinding = Readonly<{
  artifactVersion: typeof KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION;
  plan: KnowledgeSemanticGroundingArithmeticPlan;
  receipt: KnowledgeSemanticArithmeticReceipt;
}>;

export type KnowledgeSemanticArithmeticBindingAudit = Readonly<{
  aggregateOnly: true;
  bindingVersion: typeof KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION;
  contradictedByRecomputation: number;
  failed: number;
  passed: boolean;
  productionReceiptVersion: typeof KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION;
  productionVerifierUsed: true;
  receiptCount: number;
  verified: number;
}>;

function sha256(domain: string, value: string): string {
  return createHash("sha256").update(
    `AIQSA\0${KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION}\0${domain}\0${value}`,
    "utf8"
  ).digest("hex");
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceBinding(item: KnowledgeEvidencePackageItem) {
  if (!item.sourceId || !item.sourceVersionId || !item.sourceArtifactId) {
    throw new Error("knowledge_semantic_arithmetic_source_binding_missing");
  }
  return Object.freeze({
    sourceArtifactSha256: sha256("source_artifact", item.sourceArtifactId),
    sourceIdentitySha256: sha256("source_identity", item.sourceId),
    sourceVersionSha256: sha256("source_version", item.sourceVersionId)
  });
}

function inputLocator(
  item: KnowledgeEvidencePackageItem,
  inputIndex: number,
  rawValue: string
): KnowledgeSemanticArithmeticInput["locator"] {
  const locator = item.locator;
  if (record(locator) && Array.isArray(locator.ranges) && locator.ranges.length === 1) {
    const range = locator.ranges[0];
    if (!record(range) || typeof range.range !== "string" ||
      typeof range.sheet !== "string" || !Number.isSafeInteger(range.sheetIndex)) {
      throw new Error("knowledge_semantic_arithmetic_structured_locator_invalid");
    }
    return Object.freeze({
      kind: "structured_range" as const,
      range: range.range,
      sheetIndex: range.sheetIndex as number,
      sheetNameSha256: sha256("sheet_name", range.sheet),
      structuredAnalysisSha256: sha256(
        "structured_analysis",
        JSON.stringify({ artifact: item.sourceArtifactId, locator })
      )
    });
  }
  if (!locator || !Number.isSafeInteger(locator.page) || locator.page < 1 ||
    !item.passageId || !item.contentHash) {
    throw new Error("knowledge_semantic_arithmetic_passage_locator_invalid");
  }
  return Object.freeze({
    kind: "passage" as const,
    observationSha256: sha256(
      "observation",
      `${item.contentHash}\0${inputIndex}\0${rawValue}`
    ),
    pageNumber: locator.page,
    passageSha256: sha256("passage", item.passageId)
  });
}

function planForBinding(plan: KnowledgeSemanticGroundingArithmeticPlan):
KnowledgeSemanticGroundingArithmeticPlan {
  if (!/^K[1-9][0-9]{0,3}$/u.test(plan.citationHandle) ||
    !Number.isSafeInteger(plan.claimOrdinal) || plan.claimOrdinal < 1 ||
    plan.operands.length < 2 || plan.operands.length > 32 ||
    (plan.operation === "subtract" && plan.operands.length !== 2)) {
    throw new Error("knowledge_semantic_arithmetic_plan_invalid");
  }
  plan.operands.forEach(knowledgeSemanticArithmeticDecimal);
  knowledgeSemanticArithmeticDecimal(plan.assertedOutput);
  return Object.freeze({
    ...plan,
    operands: Object.freeze([...plan.operands])
  });
}

function specification(input: Readonly<{
  claimSha256: string;
  evidencePackage: KnowledgeEvidencePackage;
  plan: KnowledgeSemanticGroundingArithmeticPlan;
}>): KnowledgeSemanticArithmeticSpecification {
  const plan = planForBinding(input.plan);
  if (!/^[a-f0-9]{64}$/u.test(input.claimSha256)) {
    throw new Error("knowledge_semantic_arithmetic_claim_binding_invalid");
  }
  const matchingItems = input.evidencePackage.items.filter((item) =>
    item.handle === plan.citationHandle);
  if (matchingItems.length !== 1) {
    throw new Error("knowledge_semantic_arithmetic_evidence_binding_invalid");
  }
  const item = matchingItems[0]!;
  if (item.state !== "available") {
    throw new Error("knowledge_semantic_arithmetic_evidence_unavailable");
  }
  const source = sourceBinding(item);
  const inputs = plan.operands.map((value, index): KnowledgeSemanticArithmeticInput =>
    Object.freeze({
      citationHandle: plan.citationHandle,
      inputId: `operand_${String(index + 1).padStart(3, "0")}`,
      locator: inputLocator(item, index, value),
      observationRole: "observation" as const,
      source,
      value: knowledgeSemanticArithmeticDecimal(value)
    }));
  const tokens: KnowledgeSemanticArithmeticSpecification["expression"]["tokens"][number][] = [
    { inputId: inputs[0]!.inputId, kind: "input" },
    { inputId: inputs[1]!.inputId, kind: "input" },
    { kind: "operator", operator: plan.operation }
  ];
  for (const operand of inputs.slice(2)) {
    tokens.push(
      { inputId: operand.inputId, kind: "input" },
      { kind: "operator", operator: plan.operation }
    );
  }
  const asserted = knowledgeSemanticArithmeticDecimal(plan.assertedOutput);
  return {
    artifactType: "knowledge_semantic_arithmetic_specification" as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
    claimSha256: input.claimSha256,
    expression: {
      notation: "reverse_polish_binary_v1" as const,
      tokens
    },
    inputs,
    operation: plan.operation,
    outputUnit: plan.outputUnit,
    policy: {
      representation: "decimal_coefficient_scale_v1" as const,
      rounding: { decimalPlaces: asserted.scale, mode: "half_even" as const },
      tolerance: {
        absolute: knowledgeSemanticArithmeticDecimal("0"),
        relativePartsPerBillion: 0
      }
    }
  };
}

export function createKnowledgeSemanticArithmeticBinding(input: Readonly<{
  claimSha256: string;
  evidencePackage: KnowledgeEvidencePackage;
  plan: KnowledgeSemanticGroundingArithmeticPlan;
}>): KnowledgeSemanticArithmeticBinding {
  const authoritativeSpecification = specification(input);
  return Object.freeze({
    artifactVersion: KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION,
    plan: planForBinding(input.plan),
    receipt: createKnowledgeSemanticArithmeticReceipt({
      output: knowledgeSemanticArithmeticDecimal(input.plan.assertedOutput),
      specification: authoritativeSpecification
    })
  });
}

export function verifyKnowledgeSemanticArithmeticBinding(input: Readonly<{
  binding: KnowledgeSemanticArithmeticBinding;
  claimSha256: string;
  evidencePackage: KnowledgeEvidencePackage;
}>): KnowledgeSemanticArithmeticVerification {
  if (input.binding.artifactVersion !== KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION) {
    return Object.freeze({ code: "receipt_invalid", verified: false });
  }
  let authoritativeSpecification: KnowledgeSemanticArithmeticSpecification;
  try {
    authoritativeSpecification = specification({
      claimSha256: input.claimSha256,
      evidencePackage: input.evidencePackage,
      plan: input.binding.plan
    });
  } catch {
    return Object.freeze({ code: "authoritative_specification_invalid", verified: false });
  }
  return verifyKnowledgeSemanticArithmeticReceipt({
    authoritativeSpecification,
    receipt: input.binding.receipt
  });
}

export function auditKnowledgeSemanticArithmeticBindings(input: readonly Readonly<{
  binding: KnowledgeSemanticArithmeticBinding;
  claimSha256: string;
  evidencePackage: KnowledgeEvidencePackage;
}>[]): KnowledgeSemanticArithmeticBindingAudit {
  const results = input.map(verifyKnowledgeSemanticArithmeticBinding);
  const verified = results.filter((result) => result.code === "verified").length;
  const contradictedByRecomputation = results.filter((result) =>
    result.code === "output_outside_tolerance").length;
  const failed = results.length - verified - contradictedByRecomputation;
  return Object.freeze({
    aggregateOnly: true as const,
    bindingVersion: KNOWLEDGE_SEMANTIC_ARITHMETIC_BINDING_VERSION,
    contradictedByRecomputation,
    failed,
    passed: input.length > 0 && failed === 0,
    productionReceiptVersion: KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
    productionVerifierUsed: true as const,
    receiptCount: input.length,
    verified
  });
}
