import { createHash } from "node:crypto";
import {
  createKnowledgeSemanticArithmeticReceipt,
  decodeKnowledgeSemanticArithmeticReceipt,
  decodeKnowledgeSemanticArithmeticSpecification,
  knowledgeSemanticArithmeticDecimal,
  verifyKnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticInput,
  type KnowledgeSemanticArithmeticOperator,
  type KnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticSpecification
} from "./semanticArithmetic";

const VERSION = "knowledge-semantic-arithmetic-receipt-v1";

function hash(value: string): string {
  return createHash("sha256").update(`semantic-arithmetic-test:${value}`, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new Error("test_noncanonical_value");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(kind: "receipt" | "result", value: unknown): string {
  return createHash("sha256").update(
    `AIQSA\0${VERSION}\0${kind}\0${canonicalJson(value)}`,
    "utf8"
  ).digest("hex");
}

function rehashReceipt(value: KnowledgeSemanticArithmeticReceipt): unknown {
  const { receiptSha256: _oldReceiptSha256, resultSha256: _oldResultSha256, ...withoutDigests } =
    value;
  const resultSha256 = digest("result", {
    computation: value.computation,
    output: value.output,
    specificationSha256: value.specificationSha256
  });
  const body = { ...withoutDigests, resultSha256 };
  return { ...body, receiptSha256: digest("receipt", body) };
}

function rehashReceiptOnly(value: KnowledgeSemanticArithmeticReceipt): unknown {
  const { receiptSha256: _oldReceiptSha256, ...body } = value;
  return { ...body, receiptSha256: digest("receipt", body) };
}

function rangeLocator(range: string) {
  return {
    kind: "structured_range" as const,
    range,
    sheetIndex: 0,
    sheetNameSha256: hash("sheet:Finance"),
    structuredAnalysisSha256: hash("structured-analysis:v3")
  };
}

function input(
  inputId: "operand_001" | "operand_002",
  value: string,
  range: string,
  overrides: Partial<KnowledgeSemanticArithmeticInput> = {}
): KnowledgeSemanticArithmeticInput {
  return {
    citationHandle: inputId === "operand_001" ? "K1" : "K2",
    inputId,
    locator: rangeLocator(range),
    observationRole: "observation",
    source: {
      sourceArtifactSha256: hash("source-artifact:v7"),
      sourceIdentitySha256: hash("source:budget"),
      sourceVersionSha256: hash("source-version:7")
    },
    value: knowledgeSemanticArithmeticDecimal(value),
    ...overrides
  };
}

function specification(
  overrides: Partial<KnowledgeSemanticArithmeticSpecification> = {}
): KnowledgeSemanticArithmeticSpecification {
  return {
    artifactType: "knowledge_semantic_arithmetic_specification",
    artifactVersion: VERSION,
    claimSha256: hash("claim:margin"),
    expression: {
      notation: "reverse_polish_binary_v1",
      tokens: [
        { inputId: "operand_001", kind: "input" },
        { inputId: "operand_002", kind: "input" },
        { kind: "operator", operator: "subtract" }
      ]
    },
    inputs: [
      input("operand_001", "10,25", "B2:B2"),
      input("operand_002", "2.50", "C2:C2")
    ],
    operation: "subtract",
    outputUnit: "USD",
    policy: {
      representation: "decimal_coefficient_scale_v1",
      rounding: { decimalPlaces: 2, mode: "half_even" },
      tolerance: {
        absolute: knowledgeSemanticArithmeticDecimal("0"),
        relativePartsPerBillion: 0
      }
    },
    ...overrides
  };
}

function binarySpecification(
  operator: KnowledgeSemanticArithmeticOperator,
  left: string,
  right: string,
  outputUnit: string | null = null
): KnowledgeSemanticArithmeticSpecification {
  return specification({
    expression: {
      notation: "reverse_polish_binary_v1",
      tokens: [
        { inputId: "operand_001", kind: "input" },
        { inputId: "operand_002", kind: "input" },
        { kind: "operator", operator }
      ]
    },
    inputs: [
      input("operand_001", left, "B2:B2"),
      input("operand_002", right, "C2:C2")
    ],
    operation: operator,
    outputUnit
  });
}

function receipt(
  spec: KnowledgeSemanticArithmeticSpecification = specification(),
  output = "7,75"
): KnowledgeSemanticArithmeticReceipt {
  return createKnowledgeSemanticArithmeticReceipt({
    output: knowledgeSemanticArithmeticDecimal(output),
    specification: spec
  });
}

describe("Knowledge semantic arithmetic runtime receipt", () => {
  it("binds exact immutable inputs and recomputes an exact rational result", () => {
    const spec = specification();
    const result = receipt(spec);

    expect(result).toMatchObject({
      artifactType: "knowledge_semantic_arithmetic_receipt",
      artifactVersion: VERSION,
      computation: {
        exact: { denominator: "4", numerator: "31" },
        rounded: { coefficient: "775", scale: 2 }
      },
      output: { unit: "USD", value: { coefficient: "775", scale: 2 } },
      specification: spec
    });
    expect(result.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.specificationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: result
    })).toEqual({ code: "verified", verified: true });

    const serialized = JSON.parse(JSON.stringify(result)) as unknown;
    const decoded = decodeKnowledgeSemanticArithmeticReceipt(serialized);
    expect(decoded).toEqual(result);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded?.specification.inputs)).toBe(true);
    expect(Object.isFrozen(decodeKnowledgeSemanticArithmeticSpecification(spec))).toBe(true);
  });

  it.each([
    ["add", "1.2", "2,3", "3.5"],
    ["subtract", "1,2", "2.3", "-1.1"],
    ["multiply", "1.2", "2,5", "3"],
    ["divide", "1", "8", "0.12"],
    ["percent_change", "125", "100", "25"]
  ] as const)("recomputes %s without floating-point guesses", (operator, left, right, expected) => {
    const spec = binarySpecification(operator, left, right);
    const result = receipt(spec, expected);

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: result
    })).toEqual({ code: "verified", verified: true });
  });

  it("normalizes comma and point decimals to one exact representation", () => {
    expect(knowledgeSemanticArithmeticDecimal("12,3400"))
      .toEqual({ coefficient: "1234", scale: 2 });
    expect(knowledgeSemanticArithmeticDecimal("12.3400"))
      .toEqual({ coefficient: "1234", scale: 2 });
    expect(knowledgeSemanticArithmeticDecimal("-0,000"))
      .toEqual({ coefficient: "0", scale: 0 });
    expect(() => knowledgeSemanticArithmeticDecimal("1,234.50"))
      .toThrow("knowledge_semantic_arithmetic_decimal_invalid");
    expect(() => knowledgeSemanticArithmeticDecimal("01,2"))
      .toThrow("knowledge_semantic_arithmetic_decimal_invalid");

    const exactTenths = binarySpecification("add", "0.1", "0,2");
    expect(receipt(exactTenths, "0.3").computation.exact)
      .toEqual({ denominator: "10", numerator: "3" });
  });

  it("applies the frozen rounding and tolerance policy exactly", () => {
    const halfEven = binarySpecification("divide", "1", "8");
    const halfAway = {
      ...halfEven,
      policy: {
        ...halfEven.policy,
        rounding: { decimalPlaces: 2, mode: "half_away_from_zero" as const }
      }
    };
    const towardZeroBase = binarySpecification("divide", "19", "8");
    const towardZero = {
      ...towardZeroBase,
      policy: {
        ...towardZeroBase.policy,
        rounding: { decimalPlaces: 2, mode: "toward_zero" as const }
      }
    };
    const tolerant = {
      ...halfEven,
      policy: {
        ...halfEven.policy,
        tolerance: {
          absolute: knowledgeSemanticArithmeticDecimal("0,001"),
          relativePartsPerBillion: 0
        }
      }
    };

    expect(receipt(halfEven, "0.12").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("0.12"));
    expect(receipt(halfAway, "0.13").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("0.13"));
    expect(receipt(towardZero, "2.37").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("2.37"));
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: tolerant,
      receipt: receipt(tolerant, "0.121")
    })).toEqual({ code: "verified", verified: true });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: halfEven,
      receipt: receipt(halfEven, "0.121")
    })).toEqual({ code: "output_outside_tolerance", verified: false });
  });

  it("accepts only exact passage or structured-range input locators", () => {
    const passageInput = input("operand_001", "10.25", "B2:B2", {
      citationHandle: "K9",
      locator: {
        kind: "passage",
        observationSha256: hash("observation:12"),
        pageNumber: 4,
        passageSha256: hash("passage:12")
      }
    });
    const spec = specification({
      inputs: [passageInput, input("operand_002", "2.50", "C2:C2")]
    });

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: receipt(spec)
    })).toEqual({ code: "verified", verified: true });

    const malformed = {
      ...spec,
      inputs: [{
        ...passageInput,
        locator: { ...passageInput.locator, passageId: "raw-private-id" }
      }, spec.inputs[1]!]
    };
    expect(decodeKnowledgeSemanticArithmeticSpecification(malformed)).toBeNull();
  });

  it("rejects checksum-correct foreign bindings for every authoritative input dimension", () => {
    const authority = specification();
    const first = authority.inputs[0]!;
    const alterations: readonly Partial<KnowledgeSemanticArithmeticInput>[] = [
      { source: { ...first.source, sourceIdentitySha256: hash("different-source") } },
      { source: { ...first.source, sourceVersionSha256: hash("different-version") } },
      { source: { ...first.source, sourceArtifactSha256: hash("different-artifact") } },
      { locator: { ...rangeLocator("B3:B3"), structuredAnalysisSha256: hash("different-analysis") } },
      { observationRole: "reference_maximum" },
      { value: knowledgeSemanticArithmeticDecimal("11.25") },
      { citationHandle: "K8" }
    ];

    for (const alteration of alterations) {
      const changed = specification({
        inputs: [{ ...first, ...alteration } as KnowledgeSemanticArithmeticInput, authority.inputs[1]!]
      });
      expect(verifyKnowledgeSemanticArithmeticReceipt({
        authoritativeSpecification: authority,
        receipt: receipt(changed)
      })).toEqual({ code: "authoritative_binding_mismatch", verified: false });
    }

    const alternativeExpression = binarySpecification("add", "10.25", "2.50", "USD");
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: authority,
      receipt: receipt(alternativeExpression, "12.75")
    })).toEqual({ code: "authoritative_binding_mismatch", verified: false });

    const alternativePolicy = {
      ...authority,
      policy: {
        ...authority.policy,
        rounding: { decimalPlaces: 1, mode: "half_even" as const }
      }
    };
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: authority,
      receipt: receipt(alternativePolicy, "7.8")
    })).toEqual({ code: "authoritative_binding_mismatch", verified: false });

    const passageAuthority = specification({
      inputs: [{
        ...first,
        locator: {
          kind: "passage",
          observationSha256: hash("observation:12"),
          pageNumber: 4,
          passageSha256: hash("passage:12")
        }
      }, authority.inputs[1]!]
    });
    const changedPassage = specification({
      inputs: [{
        ...passageAuthority.inputs[0]!,
        locator: {
          kind: "passage",
          observationSha256: hash("observation:12"),
          pageNumber: 4,
          passageSha256: hash("passage:foreign")
        }
      }, passageAuthority.inputs[1]!]
    });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: passageAuthority,
      receipt: receipt(changedPassage)
    })).toEqual({ code: "authoritative_binding_mismatch", verified: false });
  });

  it("recomputes instead of trusting checksum-correct result fields", () => {
    const spec = specification();
    const result = receipt(spec);
    const wrongExact = rehashReceipt({
      ...result,
      computation: { ...result.computation, exact: { denominator: "1", numerator: "8" } }
    });
    const wrongOutput = rehashReceipt({
      ...result,
      output: { ...result.output, value: knowledgeSemanticArithmeticDecimal("8") }
    });
    const wrongRounded = rehashReceipt({
      ...result,
      computation: {
        ...result.computation,
        rounded: knowledgeSemanticArithmeticDecimal("7.76")
      }
    });

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongExact
    })).toEqual({ code: "exact_result_mismatch", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongOutput
    })).toEqual({ code: "output_outside_tolerance", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongRounded
    })).toEqual({ code: "rounded_result_mismatch", verified: false });
  });

  it("fails closed for tampered, missing, malformed, and foreign-version receipts", () => {
    const spec = specification();
    const result = receipt(spec);
    const wrongResultDigest = rehashReceiptOnly({
      ...result,
      resultSha256: hash("wrong-result")
    });

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: { ...result, receiptSha256: hash("forged") }
    })).toEqual({ code: "receipt_digest_mismatch", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongResultDigest
    })).toEqual({ code: "result_digest_mismatch", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: undefined
    })).toEqual({ code: "receipt_invalid", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: { ...result, privateId: "must-not-pass" }
    })).toEqual({ code: "receipt_invalid", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: { ...result, artifactVersion: "knowledge-semantic-arithmetic-receipt-v2" }
    })).toEqual({ code: "receipt_invalid", verified: false });
  });

  it("rejects non-canonical ranges, expressions, and zero divisors", () => {
    expect(() => createKnowledgeSemanticArithmeticReceipt({
      output: knowledgeSemanticArithmeticDecimal("0"),
      specification: specification({
        inputs: [
          input("operand_001", "1", "b2:b2"),
          input("operand_002", "0", "C2:C2")
        ],
        operation: "divide",
        expression: {
          notation: "reverse_polish_binary_v1",
          tokens: [
            { inputId: "operand_001", kind: "input" },
            { inputId: "operand_002", kind: "input" },
            { kind: "operator", operator: "divide" }
          ]
        }
      })
    })).toThrow("knowledge_semantic_arithmetic_receipt_input_invalid");
    expect(() => receipt(binarySpecification("divide", "1", "0"), "0"))
      .toThrow("knowledge_semantic_arithmetic_division_by_zero");
    expect(() => receipt(specification({
      expression: {
        notation: "reverse_polish_binary_v1",
        tokens: [
          { inputId: "operand_001", kind: "input" },
          { inputId: "operand_001", kind: "input" },
          { kind: "operator", operator: "subtract" }
        ]
      }
    }))).toThrow("knowledge_semantic_arithmetic_receipt_input_invalid");
  });
});
