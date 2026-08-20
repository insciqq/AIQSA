import {
  KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
  knowledgeSemanticArithmeticVerificationCodes,
  verifyKnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticVerificationCode
} from "../../lib/server/knowledge/semanticArithmetic";

export {
  KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
  createKnowledgeSemanticArithmeticReceipt,
  decodeKnowledgeSemanticArithmeticReceipt,
  decodeKnowledgeSemanticArithmeticSpecification,
  knowledgeSemanticArithmeticDecimal,
  knowledgeSemanticArithmeticReceiptSchema,
  knowledgeSemanticArithmeticSpecificationSchema,
  knowledgeSemanticArithmeticVerificationCodes,
  verifyKnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticDecimal,
  type KnowledgeSemanticArithmeticInput,
  type KnowledgeSemanticArithmeticOperator,
  type KnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticSpecification,
  type KnowledgeSemanticArithmeticVerification,
  type KnowledgeSemanticArithmeticVerificationCode
} from "../../lib/server/knowledge/semanticArithmetic";

export const KNOWLEDGE_SEMANTIC_ARITHMETIC_AUDIT_VERSION =
  "knowledge-semantic-arithmetic-audit-v2" as const;

export const knowledgeSemanticArithmeticAuditGates = Object.freeze({
  falseAcceptanceMaximum: 0,
  falseRejectionMaximum: 0,
  overallAccuracyMinimum: 1
} as const);

export type KnowledgeSemanticArithmeticAuditCase = Readonly<{
  authoritativeSpecification: unknown;
  expected: "accept" | "reject";
  receipt: unknown;
}>;

export type KnowledgeSemanticArithmeticAuditReport = Readonly<{
  aggregateOnly: true;
  artifactVersion: typeof KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION;
  contentFree: true;
  counts: Readonly<{
    cases: number;
    expectedAccepts: number;
    expectedRejects: number;
    falseAcceptances: number;
    falseRejections: number;
    rejected: number;
    verified: number;
  }>;
  failureCodes: Readonly<Record<Exclude<
    KnowledgeSemanticArithmeticVerificationCode,
    "verified"
  >, number>>;
  gates: typeof knowledgeSemanticArithmeticAuditGates;
  independentHumanLabelsUsed: false;
  metrics: Readonly<{
    acceptanceAccuracy: number;
    overallAccuracy: number;
    rejectionAccuracy: number;
  }>;
  passed: boolean;
  productionVerifierUsed: true;
  rawEvidenceIncluded: false;
  scope: "deterministic_derived_arithmetic_receipt_contract";
  version: typeof KNOWLEDGE_SEMANTIC_ARITHMETIC_AUDIT_VERSION;
}>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function measuredRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function runKnowledgeSemanticArithmeticReceiptAudit(
  cases: readonly KnowledgeSemanticArithmeticAuditCase[]
): KnowledgeSemanticArithmeticAuditReport {
  if (cases.length < 2 || cases.length > 10_000) {
    throw new Error("knowledge_semantic_arithmetic_audit_case_count_invalid");
  }
  const results = cases.map((auditCase) => Object.freeze({
    expected: auditCase.expected,
    verification: verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: auditCase.authoritativeSpecification,
      receipt: auditCase.receipt
    })
  }));
  const expectedAccepts = results.filter((result) => result.expected === "accept").length;
  const expectedRejects = results.length - expectedAccepts;
  const verified = results.filter((result) => result.verification.verified).length;
  const falseAcceptances = results.filter((result) =>
    result.expected === "reject" && result.verification.verified).length;
  const falseRejections = results.filter((result) =>
    result.expected === "accept" && !result.verification.verified).length;
  const failureCodes = Object.fromEntries(knowledgeSemanticArithmeticVerificationCodes
    .filter((code) => code !== "verified")
    .map((code) => [code, results.filter((result) => result.verification.code === code).length])) as
    KnowledgeSemanticArithmeticAuditReport["failureCodes"];
  const metrics = Object.freeze({
    acceptanceAccuracy: measuredRatio(expectedAccepts - falseRejections, expectedAccepts),
    overallAccuracy: measuredRatio(
      results.length - falseAcceptances - falseRejections,
      results.length
    ),
    rejectionAccuracy: measuredRatio(expectedRejects - falseAcceptances, expectedRejects)
  });
  const gates = knowledgeSemanticArithmeticAuditGates;
  return deepFreeze({
    aggregateOnly: true as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
    contentFree: true as const,
    counts: {
      cases: results.length,
      expectedAccepts,
      expectedRejects,
      falseAcceptances,
      falseRejections,
      rejected: results.length - verified,
      verified
    },
    failureCodes,
    gates,
    independentHumanLabelsUsed: false as const,
    metrics,
    passed: expectedAccepts > 0 && expectedRejects > 0 &&
      falseAcceptances <= gates.falseAcceptanceMaximum &&
      falseRejections <= gates.falseRejectionMaximum &&
      metrics.overallAccuracy >= gates.overallAccuracyMinimum,
    productionVerifierUsed: true as const,
    rawEvidenceIncluded: false as const,
    scope: "deterministic_derived_arithmetic_receipt_contract" as const,
    version: KNOWLEDGE_SEMANTIC_ARITHMETIC_AUDIT_VERSION
  });
}

export function assertKnowledgeSemanticArithmeticReceiptAudit(
  report: KnowledgeSemanticArithmeticAuditReport
): void {
  if (!report.passed || !report.productionVerifierUsed) {
    throw new Error("knowledge_semantic_arithmetic_receipt_audit_failed");
  }
}
