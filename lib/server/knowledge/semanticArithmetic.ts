import { createHash } from "node:crypto";
import { z } from "zod";

export const KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION =
  "knowledge-semantic-arithmetic-receipt-v1" as const;

const SPECIFICATION_DIGEST_DOMAIN =
  `AIQSA\0${KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION}\0specification`;
const RESULT_DIGEST_DOMAIN =
  `AIQSA\0${KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION}\0result`;
const RECEIPT_DIGEST_DOMAIN =
  `AIQSA\0${KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION}\0receipt`;
const MAX_DECIMAL_DIGITS = 64;
const MAX_RATIONAL_DIGITS = 512;
const PARTS_PER_BILLION = 1_000_000_000n;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const coefficientSchema = z.string()
  .max(MAX_DECIMAL_DIGITS + 1)
  .regex(/^-?(?:0|[1-9][0-9]*)$/u)
  .refine((value) => value !== "-0")
  .refine((value) => value.replace("-", "").length <= MAX_DECIMAL_DIGITS);
const canonicalIntegerSchema = z.string()
  .max(MAX_RATIONAL_DIGITS + 1)
  .regex(/^-?(?:0|[1-9][0-9]*)$/u)
  .refine((value) => value !== "-0")
  .refine((value) => value.replace("-", "").length <= MAX_RATIONAL_DIGITS);
const canonicalPositiveIntegerSchema = z.string()
  .max(MAX_RATIONAL_DIGITS)
  .regex(/^[1-9][0-9]*$/u)
  .refine((value) => value.length <= MAX_RATIONAL_DIGITS);

const decimalSchema = z.strictObject({
  coefficient: coefficientSchema,
  scale: z.number().int().min(0).max(18)
}).superRefine((value, context) => {
  const magnitude = value.coefficient.replace("-", "");
  if ((magnitude === "0" && value.scale !== 0) ||
    (value.scale > 0 && magnitude.endsWith("0"))) {
    context.addIssue({ code: "custom", message: "decimal is not canonical" });
  }
});

const rationalSchema = z.strictObject({
  denominator: canonicalPositiveIntegerSchema,
  numerator: canonicalIntegerSchema
}).superRefine((value, context) => {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value.numerator) || value.numerator === "-0" ||
    value.numerator.replace("-", "").length > MAX_RATIONAL_DIGITS ||
    !/^[1-9][0-9]*$/u.test(value.denominator) ||
    value.denominator.length > MAX_RATIONAL_DIGITS) return;
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if ((numerator === 0n && denominator !== 1n) || gcd(abs(numerator), denominator) !== 1n) {
    context.addIssue({ code: "custom", message: "rational is not canonical" });
  }
});

const sourceBindingSchema = z.strictObject({
  sourceArtifactSha256: sha256Schema,
  sourceIdentitySha256: sha256Schema,
  sourceVersionSha256: sha256Schema
});

const structuredRangeLocatorSchema = z.strictObject({
  kind: z.literal("structured_range"),
  range: z.string().min(5).max(32).refine(isCanonicalA1Range),
  sheetIndex: z.number().int().min(0).max(1_023),
  sheetNameSha256: sha256Schema,
  structuredAnalysisSha256: sha256Schema
});

const passageLocatorSchema = z.strictObject({
  kind: z.literal("passage"),
  observationSha256: sha256Schema,
  pageNumber: z.number().int().min(1).max(1_000_000),
  passageSha256: sha256Schema
});

const arithmeticInputSchema = z.strictObject({
  citationHandle: z.string().regex(/^K[1-9][0-9]{0,3}$/u)
    .refine((value) => Number(value.slice(1)) <= 2_048),
  inputId: z.string().regex(/^operand_[0-9]{3}$/u),
  locator: z.discriminatedUnion("kind", [
    passageLocatorSchema,
    structuredRangeLocatorSchema
  ]),
  observationRole: z.enum([
    "metadata_header",
    "observation",
    "reference_maximum",
    "reference_minimum",
    "target",
    "threshold"
  ]),
  source: sourceBindingSchema,
  value: decimalSchema
});

const arithmeticOperatorSchema = z.enum([
  "add",
  "divide",
  "multiply",
  "percent_change",
  "subtract"
]);

const expressionTokenSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    inputId: z.string().regex(/^operand_[0-9]{3}$/u),
    kind: z.literal("input")
  }),
  z.strictObject({
    kind: z.literal("operator"),
    operator: arithmeticOperatorSchema
  })
]);

const expressionSchema = z.strictObject({
  notation: z.literal("reverse_polish_binary_v1"),
  tokens: z.array(expressionTokenSchema).min(3).max(127)
});

const numericPolicySchema = z.strictObject({
  representation: z.literal("decimal_coefficient_scale_v1"),
  rounding: z.strictObject({
    decimalPlaces: z.number().int().min(0).max(18),
    mode: z.enum(["half_away_from_zero", "half_even", "toward_zero"])
  }),
  tolerance: z.strictObject({
    absolute: decimalSchema.superRefine((value, context) => {
      if (value.coefficient.startsWith("-")) {
        context.addIssue({ code: "custom", message: "absolute tolerance is negative" });
      }
    }),
    relativePartsPerBillion: z.number().int().min(0).max(1_000_000_000)
  })
});

const outputUnitSchema = z.union([
  z.null(),
  z.string().min(1).max(128)
    .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value))
]);

export const knowledgeSemanticArithmeticSpecificationSchema = z.strictObject({
  artifactType: z.literal("knowledge_semantic_arithmetic_specification"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION),
  claimSha256: sha256Schema,
  expression: expressionSchema,
  inputs: z.array(arithmeticInputSchema).min(2).max(32),
  operation: arithmeticOperatorSchema,
  outputUnit: outputUnitSchema,
  policy: numericPolicySchema
}).superRefine((value, context) => {
  const inputIds = value.inputs.map((input) => input.inputId);
  if (new Set(inputIds).size !== inputIds.length) {
    context.addIssue({ code: "custom", message: "duplicate arithmetic input" });
  }
  if (inputIds.some((inputId, index) => index > 0 && inputIds[index - 1]! >= inputId)) {
    context.addIssue({ code: "custom", message: "arithmetic inputs are not canonically ordered" });
  }
  const inputIdSet = new Set(inputIds);
  const referenced = new Set<string>();
  let stackDepth = 0;
  for (const token of value.expression.tokens) {
    if (token.kind === "input") {
      if (!inputIdSet.has(token.inputId)) {
        context.addIssue({ code: "custom", message: "expression references an unknown input" });
      }
      referenced.add(token.inputId);
      stackDepth += 1;
    } else if (stackDepth < 2) {
      context.addIssue({ code: "custom", message: "expression stack underflow" });
    } else {
      stackDepth -= 1;
    }
  }
  if (stackDepth !== 1) {
    context.addIssue({ code: "custom", message: "expression does not produce one result" });
  }
  if (inputIds.some((inputId) => !referenced.has(inputId))) {
    context.addIssue({ code: "custom", message: "declared arithmetic input is unused" });
  }
  const finalToken = value.expression.tokens.at(-1);
  if (finalToken?.kind !== "operator" || finalToken.operator !== value.operation) {
    context.addIssue({ code: "custom", message: "root operation does not match expression" });
  }
});

const computationSchema = z.strictObject({
  exact: rationalSchema,
  rounded: decimalSchema
});

const outputSchema = z.strictObject({
  unit: outputUnitSchema,
  value: decimalSchema
});

const arithmeticResultDigestBodySchema = z.strictObject({
  computation: computationSchema,
  output: outputSchema,
  specificationSha256: sha256Schema
});

const arithmeticReceiptBodySchema = z.strictObject({
  artifactType: z.literal("knowledge_semantic_arithmetic_receipt"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION),
  computation: computationSchema,
  output: outputSchema,
  resultSha256: sha256Schema,
  specification: knowledgeSemanticArithmeticSpecificationSchema,
  specificationSha256: sha256Schema
});

export const knowledgeSemanticArithmeticReceiptSchema = arithmeticReceiptBodySchema.extend({
  receiptSha256: sha256Schema
});

export type KnowledgeSemanticArithmeticDecimal = Readonly<z.infer<typeof decimalSchema>>;
export type KnowledgeSemanticArithmeticInput = Readonly<z.infer<typeof arithmeticInputSchema>>;
export type KnowledgeSemanticArithmeticOperator = z.infer<typeof arithmeticOperatorSchema>;
export type KnowledgeSemanticArithmeticSpecification = Readonly<
  z.infer<typeof knowledgeSemanticArithmeticSpecificationSchema>
>;
export type KnowledgeSemanticArithmeticReceipt = Readonly<
  z.infer<typeof knowledgeSemanticArithmeticReceiptSchema>
>;

export const knowledgeSemanticArithmeticVerificationCodes = Object.freeze([
  "authoritative_binding_mismatch",
  "authoritative_specification_invalid",
  "exact_result_mismatch",
  "output_outside_tolerance",
  "output_unit_mismatch",
  "receipt_digest_mismatch",
  "receipt_invalid",
  "recomputation_failed",
  "result_digest_mismatch",
  "rounded_result_mismatch",
  "specification_digest_mismatch",
  "verified"
] as const);

export type KnowledgeSemanticArithmeticVerificationCode =
  typeof knowledgeSemanticArithmeticVerificationCodes[number];

export type KnowledgeSemanticArithmeticVerification = Readonly<{
  code: KnowledgeSemanticArithmeticVerificationCode;
  verified: boolean;
}>;

type Rational = Readonly<{ denominator: bigint; numerator: bigint }>;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let currentLeft = abs(left);
  let currentRight = abs(right);
  while (currentRight !== 0n) {
    const remainder = currentLeft % currentRight;
    currentLeft = currentRight;
    currentRight = remainder;
  }
  return currentLeft;
}

function assertRationalBounds(value: Rational): void {
  if (value.numerator.toString().replace("-", "").length > MAX_RATIONAL_DIGITS ||
    value.denominator.toString().length > MAX_RATIONAL_DIGITS) {
    throw new Error("knowledge_semantic_arithmetic_numeric_limit_exceeded");
  }
}

function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) {
    throw new Error("knowledge_semantic_arithmetic_division_by_zero");
  }
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  const result = Object.freeze({
    denominator: normalizedDenominator / divisor,
    numerator: normalizedNumerator / divisor
  });
  assertRationalBounds(result);
  return result;
}

function decimalToRational(value: KnowledgeSemanticArithmeticDecimal): Rational {
  return rational(BigInt(value.coefficient), 10n ** BigInt(value.scale));
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function subtract(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function multiply(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function compare(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function canonicalDecimal(coefficient: bigint, scale: number): KnowledgeSemanticArithmeticDecimal {
  let canonicalCoefficient = coefficient;
  let canonicalScale = scale;
  while (canonicalScale > 0 && canonicalCoefficient % 10n === 0n) {
    canonicalCoefficient /= 10n;
    canonicalScale -= 1;
  }
  return deepFreeze(decimalSchema.parse({
    coefficient: canonicalCoefficient.toString(),
    scale: canonicalScale
  }));
}

function roundRational(
  value: Rational,
  policy: KnowledgeSemanticArithmeticSpecification["policy"]["rounding"]
): KnowledgeSemanticArithmeticDecimal {
  const scaleMultiplier = 10n ** BigInt(policy.decimalPlaces);
  const scaledMagnitude = abs(value.numerator) * scaleMultiplier;
  let coefficientMagnitude = scaledMagnitude / value.denominator;
  const remainder = scaledMagnitude % value.denominator;
  let increment = false;
  if (policy.mode === "half_away_from_zero") {
    increment = remainder * 2n >= value.denominator;
  } else if (policy.mode === "half_even") {
    const doubled = remainder * 2n;
    increment = doubled > value.denominator ||
      (doubled === value.denominator && coefficientMagnitude % 2n === 1n);
  }
  if (increment) coefficientMagnitude += 1n;
  const coefficient = value.numerator < 0n ? -coefficientMagnitude : coefficientMagnitude;
  return canonicalDecimal(coefficient, policy.decimalPlaces);
}

function applyOperator(
  operator: KnowledgeSemanticArithmeticOperator,
  left: Rational,
  right: Rational
): Rational {
  if (operator === "add") return add(left, right);
  if (operator === "subtract") return subtract(left, right);
  if (operator === "multiply") return multiply(left, right);
  if (operator === "divide") return divide(left, right);
  return multiply(
    divide(subtract(left, right), rational(abs(right.numerator), right.denominator)),
    rational(100n)
  );
}

function evaluateExpression(specification: KnowledgeSemanticArithmeticSpecification): Rational {
  const inputValues = new Map(specification.inputs.map((input) => [
    input.inputId,
    decimalToRational(input.value)
  ]));
  const stack: Rational[] = [];
  for (const token of specification.expression.tokens) {
    if (token.kind === "input") {
      const value = inputValues.get(token.inputId);
      if (!value) throw new Error("knowledge_semantic_arithmetic_unknown_input");
      stack.push(value);
      continue;
    }
    const right = stack.pop();
    const left = stack.pop();
    if (!left || !right) throw new Error("knowledge_semantic_arithmetic_expression_invalid");
    stack.push(applyOperator(token.operator, left, right));
  }
  if (stack.length !== 1) throw new Error("knowledge_semantic_arithmetic_expression_invalid");
  return stack[0]!;
}

function rationalArtifact(value: Rational): Readonly<{ denominator: string; numerator: string }> {
  return Object.freeze({
    denominator: value.denominator.toString(),
    numerator: value.numerator.toString()
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("knowledge_semantic_arithmetic_noncanonical_number");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) {
    throw new Error("knowledge_semantic_arithmetic_noncanonical_value");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${canonicalJson(value)}`, "utf8").digest("hex");
}

function specificationSha256(specification: KnowledgeSemanticArithmeticSpecification): string {
  return digest(SPECIFICATION_DIGEST_DOMAIN, specification);
}

function resultSha256(body: z.infer<typeof arithmeticResultDigestBodySchema>): string {
  return digest(RESULT_DIGEST_DOMAIN, body);
}

function receiptSha256(body: z.infer<typeof arithmeticReceiptBodySchema>): string {
  return digest(RECEIPT_DIGEST_DOMAIN, body);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function decodeKnowledgeSemanticArithmeticSpecification(
  value: unknown
): KnowledgeSemanticArithmeticSpecification | null {
  const parsed = knowledgeSemanticArithmeticSpecificationSchema.safeParse(value);
  return parsed.success ? deepFreeze(parsed.data) : null;
}

/** Accepts one ungrouped decimal using either a comma or a point separator. */
export function knowledgeSemanticArithmeticDecimal(
  value: string
): KnowledgeSemanticArithmeticDecimal {
  if (!/^-?(?:0|[1-9][0-9]*)(?:[.,][0-9]+)?$/u.test(value) || value.length > 96) {
    throw new Error("knowledge_semantic_arithmetic_decimal_invalid");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const separatorIndex = Math.max(unsigned.indexOf("."), unsigned.indexOf(","));
  const integer = separatorIndex < 0 ? unsigned : unsigned.slice(0, separatorIndex);
  const fraction = separatorIndex < 0 ? "" : unsigned.slice(separatorIndex + 1);
  const coefficient = BigInt(`${negative ? "-" : ""}${integer}${fraction}`);
  try {
    return canonicalDecimal(coefficient, fraction.length);
  } catch {
    throw new Error("knowledge_semantic_arithmetic_decimal_invalid");
  }
}

export function decodeKnowledgeSemanticArithmeticReceipt(
  value: unknown
): KnowledgeSemanticArithmeticReceipt | null {
  const parsed = knowledgeSemanticArithmeticReceiptSchema.safeParse(value);
  return parsed.success ? deepFreeze(parsed.data) : null;
}

export function createKnowledgeSemanticArithmeticReceipt(input: Readonly<{
  output: KnowledgeSemanticArithmeticDecimal;
  specification: KnowledgeSemanticArithmeticSpecification;
}>): KnowledgeSemanticArithmeticReceipt {
  const specification = decodeKnowledgeSemanticArithmeticSpecification(input.specification);
  const outputValue = decimalSchema.safeParse(input.output);
  if (!specification || !outputValue.success) {
    throw new Error("knowledge_semantic_arithmetic_receipt_input_invalid");
  }
  const exact = evaluateExpression(specification);
  const specificationDigest = specificationSha256(specification);
  const computation = computationSchema.parse({
    exact: rationalArtifact(exact),
    rounded: roundRational(exact, specification.policy.rounding)
  });
  const output = outputSchema.parse({
    unit: specification.outputUnit,
    value: outputValue.data
  });
  const resultDigestBody = arithmeticResultDigestBodySchema.parse({
    computation,
    output,
    specificationSha256: specificationDigest
  });
  const body = arithmeticReceiptBodySchema.parse({
    artifactType: "knowledge_semantic_arithmetic_receipt",
    artifactVersion: KNOWLEDGE_SEMANTIC_ARITHMETIC_RECEIPT_VERSION,
    computation,
    output,
    resultSha256: resultSha256(resultDigestBody),
    specification,
    specificationSha256: specificationDigest
  });
  return deepFreeze(knowledgeSemanticArithmeticReceiptSchema.parse({
    ...body,
    receiptSha256: receiptSha256(body)
  }));
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isWithinTolerance(
  output: KnowledgeSemanticArithmeticDecimal,
  expected: KnowledgeSemanticArithmeticDecimal,
  policy: KnowledgeSemanticArithmeticSpecification["policy"]
): boolean {
  const difference = subtract(decimalToRational(output), decimalToRational(expected));
  const absoluteDifference = rational(abs(difference.numerator), difference.denominator);
  const absoluteTolerance = decimalToRational(policy.tolerance.absolute);
  const expectedMagnitude = decimalToRational({
    ...expected,
    coefficient: expected.coefficient.replace("-", "")
  });
  const relativeTolerance = multiply(
    expectedMagnitude,
    rational(BigInt(policy.tolerance.relativePartsPerBillion), PARTS_PER_BILLION)
  );
  const allowed = compare(absoluteTolerance, relativeTolerance) >= 0
    ? absoluteTolerance
    : relativeTolerance;
  return compare(absoluteDifference, allowed) <= 0;
}

function verification(
  code: KnowledgeSemanticArithmeticVerificationCode
): KnowledgeSemanticArithmeticVerification {
  return Object.freeze({ code, verified: code === "verified" });
}

export function verifyKnowledgeSemanticArithmeticReceipt(input: Readonly<{
  authoritativeSpecification: unknown;
  receipt: unknown;
}>): KnowledgeSemanticArithmeticVerification {
  const receipt = decodeKnowledgeSemanticArithmeticReceipt(input.receipt);
  if (!receipt) return verification("receipt_invalid");
  const { receiptSha256: actualReceiptSha256, ...body } = receipt;
  if (receiptSha256(body) !== actualReceiptSha256) {
    return verification("receipt_digest_mismatch");
  }
  const embeddedSpecificationSha256 = specificationSha256(receipt.specification);
  if (embeddedSpecificationSha256 !== receipt.specificationSha256) {
    return verification("specification_digest_mismatch");
  }
  const resultDigestBody = {
    computation: receipt.computation,
    output: receipt.output,
    specificationSha256: receipt.specificationSha256
  };
  if (resultSha256(resultDigestBody) !== receipt.resultSha256) {
    return verification("result_digest_mismatch");
  }
  const authoritativeSpecification =
    decodeKnowledgeSemanticArithmeticSpecification(input.authoritativeSpecification);
  if (!authoritativeSpecification) {
    return verification("authoritative_specification_invalid");
  }
  if (specificationSha256(authoritativeSpecification) !== receipt.specificationSha256) {
    return verification("authoritative_binding_mismatch");
  }
  let exact: Rational;
  try {
    exact = evaluateExpression(authoritativeSpecification);
  } catch {
    return verification("recomputation_failed");
  }
  if (!equalCanonical(rationalArtifact(exact), receipt.computation.exact)) {
    return verification("exact_result_mismatch");
  }
  let rounded: KnowledgeSemanticArithmeticDecimal;
  try {
    rounded = roundRational(exact, authoritativeSpecification.policy.rounding);
  } catch {
    return verification("recomputation_failed");
  }
  if (!equalCanonical(rounded, receipt.computation.rounded)) {
    return verification("rounded_result_mismatch");
  }
  if (receipt.output.unit !== authoritativeSpecification.outputUnit) {
    return verification("output_unit_mismatch");
  }
  try {
    if (!isWithinTolerance(receipt.output.value, rounded, authoritativeSpecification.policy)) {
      return verification("output_outside_tolerance");
    }
  } catch {
    return verification("recomputation_failed");
  }
  return verification("verified");
}

function columnNumber(value: string): number {
  let result = 0;
  for (const character of value) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function isCanonicalA1Range(value: string): boolean {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/u.exec(value);
  if (!match) return false;
  const startColumn = columnNumber(match[1]!);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3]!);
  const endRow = Number(match[4]);
  return startColumn <= 16_384 && endColumn <= 16_384 &&
    startRow <= 1_048_576 && endRow <= 1_048_576 &&
    startColumn <= endColumn && startRow <= endRow;
}
