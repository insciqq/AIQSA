import { createHash } from "node:crypto";
import {
  assertKnowledgeSemanticArithmeticReceiptAudit,
  createKnowledgeSemanticArithmeticReceipt,
  decodeKnowledgeSemanticArithmeticReceipt,
  knowledgeSemanticArithmeticDecimal,
  runKnowledgeSemanticArithmeticReceiptAudit,
  verifyKnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticInput,
  type KnowledgeSemanticArithmeticOperator,
  type KnowledgeSemanticArithmeticReceipt,
  type KnowledgeSemanticArithmeticSpecification
} from "./semanticGroundingArithmetic";

function hash(value: string): string {
  return createHash("sha256").update(`arithmetic-test-only:${value}`, "utf8").digest("hex");
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

function rehashReceipt(value: KnowledgeSemanticArithmeticReceipt): unknown {
  const {
    receiptSha256: _receiptSha256,
    resultSha256: _resultSha256,
    ...receiptWithoutDigests
  } = value;
  const resultBody = {
    computation: value.computation,
    output: value.output,
    specificationSha256: value.specificationSha256
  };
  const resultSha256 = createHash("sha256").update(
    `AIQSA\0knowledge-semantic-arithmetic-receipt-v1\0result\0${canonicalJson(resultBody)}`,
    "utf8"
  ).digest("hex");
  const body = { ...receiptWithoutDigests, resultSha256 };
  const receiptSha256 = createHash("sha256").update(
    `AIQSA\0knowledge-semantic-arithmetic-receipt-v1\0receipt\0${canonicalJson(body)}`,
    "utf8"
  ).digest("hex");
  return { ...body, receiptSha256 };
}

function input(
  inputId: `operand_00${1 | 2}`,
  value: string,
  range: string,
  overrides: Partial<KnowledgeSemanticArithmeticInput> = {}
): KnowledgeSemanticArithmeticInput {
  return {
    citationHandle: inputId === "operand_001" ? "K1" : "K2",
    inputId,
    locator: {
      kind: "structured_range",
      range,
      sheetIndex: 0,
      sheetNameSha256: hash("sheet:Finance"),
      structuredAnalysisSha256: hash("structured-analysis:Finance")
    },
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

function specification(overrides: Partial<KnowledgeSemanticArithmeticSpecification> = {}):
KnowledgeSemanticArithmeticSpecification {
  return {
    artifactType: "knowledge_semantic_arithmetic_specification",
    artifactVersion: "knowledge-semantic-arithmetic-receipt-v1",
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
      input("operand_001", "10.25", "B2:B2"),
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

function receipt(
  spec = specification(),
  output = "7.75"
): KnowledgeSemanticArithmeticReceipt {
  return createKnowledgeSemanticArithmeticReceipt({
    output: knowledgeSemanticArithmeticDecimal(output),
    specification: spec
  });
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

describe("Knowledge semantic derived-arithmetic receipt", () => {
  it("binds exact immutable inputs and recomputes an exact rational result", () => {
    const spec = specification();
    const result = receipt(spec);

    expect(result).toMatchObject({
      artifactType: "knowledge_semantic_arithmetic_receipt",
      artifactVersion: "knowledge-semantic-arithmetic-receipt-v1",
      computation: {
        exact: { denominator: "4", numerator: "31" },
        rounded: { coefficient: "775", scale: 2 }
      },
      output: { unit: "USD", value: { coefficient: "775", scale: 2 } },
      specification: spec
    });
    expect(result.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.specificationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: result
    })).toEqual({ code: "verified", verified: true });

    const decoded = decodeKnowledgeSemanticArithmeticReceipt(
      JSON.parse(JSON.stringify(result)) as unknown
    );
    expect(decoded).toEqual(result);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded?.specification.inputs)).toBe(true);
  });

  it.each([
    ["add", "1.2", "2.3", "3.5"],
    ["subtract", "1.2", "2.3", "-1.1"],
    ["multiply", "1.2", "2.5", "3"],
    ["divide", "1", "8", "0.12"],
    ["percent_change", "125", "100", "25"]
  ] as const)("recomputes %s with explicit deterministic semantics", (
    operator,
    left,
    right,
    expected
  ) => {
    const spec = binarySpecification(operator, left, right);
    const result = receipt(spec, expected);

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: result
    }).verified).toBe(true);
  });

  it("applies explicit half-even, half-away and exact tolerance policies", () => {
    const halfEven = binarySpecification("divide", "1", "8");
    const halfAway = {
      ...halfEven,
      policy: {
        ...halfEven.policy,
        rounding: { decimalPlaces: 2, mode: "half_away_from_zero" as const }
      }
    };
    const tolerant = {
      ...halfEven,
      policy: {
        ...halfEven.policy,
        tolerance: {
          absolute: knowledgeSemanticArithmeticDecimal("0.001"),
          relativePartsPerBillion: 0
        }
      }
    };

    expect(receipt(halfEven, "0.12").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("0.12"));
    expect(receipt(halfAway, "0.13").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("0.13"));
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: tolerant,
      receipt: receipt(tolerant, "0.121")
    }).verified).toBe(true);
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: halfEven,
      receipt: receipt(halfEven, "0.121")
    })).toEqual({ code: "output_outside_tolerance", verified: false });

    const towardZero = {
      ...binarySpecification("divide", "19", "8"),
      policy: {
        ...halfEven.policy,
        rounding: { decimalPlaces: 2, mode: "toward_zero" as const }
      }
    };
    const negativeHalfAwayBase = binarySpecification("divide", "-1", "8");
    const negativeHalfAway = {
      ...negativeHalfAwayBase,
      policy: {
        ...negativeHalfAwayBase.policy,
        rounding: { decimalPlaces: 2, mode: "half_away_from_zero" as const }
      }
    };
    const relativeTolerance = {
      ...binarySpecification("add", "60", "40"),
      policy: {
        ...halfEven.policy,
        tolerance: {
          absolute: knowledgeSemanticArithmeticDecimal("0"),
          relativePartsPerBillion: 1
        }
      }
    };
    expect(receipt(towardZero, "2.37").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("2.37"));
    expect(receipt(negativeHalfAway, "-0.13").computation.rounded)
      .toEqual(knowledgeSemanticArithmeticDecimal("-0.13"));
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: relativeTolerance,
      receipt: receipt(relativeTolerance, "100.0000001")
    }).verified).toBe(true);
  });

  it("supports exact source-local textual observations with mandatory citations", () => {
    const textualInput = input("operand_001", "10.25", "B2:B2", {
      citationHandle: "K9",
      locator: {
        kind: "passage",
        observationSha256: hash("observation:12"),
        pageNumber: 4,
        passageSha256: hash("passage:12")
      }
    });
    const spec = specification({
      inputs: [textualInput, input("operand_002", "2.50", "C2:C2")]
    });

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: receipt(spec)
    }).verified).toBe(true);
  });

  it("rejects receipt, computation, expression, policy and output tampering", () => {
    const spec = specification();
    const result = receipt(spec);
    const candidates: readonly unknown[] = [
      { ...result, receiptSha256: hash("forged") },
      {
        ...result,
        computation: { ...result.computation, exact: { denominator: "1", numerator: "8" } }
      },
      {
        ...result,
        computation: {
          ...result.computation,
          rounded: knowledgeSemanticArithmeticDecimal("7.76")
        }
      },
      {
        ...result,
        output: { ...result.output, value: knowledgeSemanticArithmeticDecimal("8") }
      },
      {
        ...result,
        specification: { ...result.specification, operation: "add" }
      },
      {
        ...result,
        specification: {
          ...result.specification,
          policy: {
            ...result.specification.policy,
            rounding: { decimalPlaces: 1, mode: "half_even" }
          }
        }
      },
      { ...result, privateClaimText: "must not be accepted" }
    ];

    for (const candidate of candidates) {
      expect(verifyKnowledgeSemanticArithmeticReceipt({
        authoritativeSpecification: spec,
        receipt: candidate
      }).verified).toBe(false);
    }
  });

  it("recomputes instead of trusting checksum-correct computation fields", () => {
    const spec = specification();
    const result = receipt(spec);
    const wrongExact = rehashReceipt({
      ...result,
      computation: { ...result.computation, exact: { denominator: "1", numerator: "8" } }
    });
    const wrongRounded = rehashReceipt({
      ...result,
      computation: {
        ...result.computation,
        rounded: knowledgeSemanticArithmeticDecimal("7.76")
      }
    });
    const wrongUnit = rehashReceipt({
      ...result,
      output: { ...result.output, unit: "EUR" }
    });

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongExact
    })).toEqual({ code: "exact_result_mismatch", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongRounded
    })).toEqual({ code: "rounded_result_mismatch", verified: false });
    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: spec,
      receipt: wrongUnit
    })).toEqual({ code: "output_unit_mismatch", verified: false });
  });

  it("rejects re-hashed cross-Source, Version, range, role and value receipts", () => {
    const authority = specification();
    const first = authority.inputs[0]!;
    const alterations: readonly Partial<KnowledgeSemanticArithmeticInput>[] = [
      {
        source: { ...first.source, sourceIdentitySha256: hash("different-source") }
      },
      {
        source: { ...first.source, sourceVersionSha256: hash("different-version") }
      },
      {
        source: { ...first.source, sourceArtifactSha256: hash("different-artifact") }
      },
      {
        locator: {
          kind: "structured_range",
          range: "B3:B3",
          sheetIndex: 0,
          sheetNameSha256: hash("sheet:Finance"),
          structuredAnalysisSha256: hash("structured-analysis:Finance")
        }
      },
      { observationRole: "reference_maximum" },
      { value: knowledgeSemanticArithmeticDecimal("11.25") },
      { citationHandle: "K8" }
    ];

    for (const alteration of alterations) {
      const changedFirst = { ...first, ...alteration } as KnowledgeSemanticArithmeticInput;
      const changed = specification({ inputs: [changedFirst, authority.inputs[1]!] });
      const changedReceipt = receipt(changed, alteration.value ? "8.75" : "7.75");
      expect(verifyKnowledgeSemanticArithmeticReceipt({
        authoritativeSpecification: authority,
        receipt: changedReceipt
      })).toEqual({ code: "authoritative_binding_mismatch", verified: false });
    }
  });

  it("rejects a validly hashed alternative expression against the frozen operation", () => {
    const authority = specification();
    const alternative = binarySpecification("add", "10.25", "2.50", "USD");
    const alternativeReceipt = receipt(alternative, "12.75");

    expect(verifyKnowledgeSemanticArithmeticReceipt({
      authoritativeSpecification: authority,
      receipt: alternativeReceipt
    })).toEqual({ code: "authoritative_binding_mismatch", verified: false });
  });

  it("fails closed for non-canonical ranges, expressions, decimals and zero divisors", () => {
    expect(() => knowledgeSemanticArithmeticDecimal("01.20")).toThrow(
      "knowledge_semantic_arithmetic_decimal_invalid"
    );
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

  it("emits only aggregate content-free audit metrics and gates false accepts", () => {
    const authority = specification();
    const changedFirst = {
      ...authority.inputs[0]!,
      source: {
        ...authority.inputs[0]!.source,
        sourceIdentitySha256: hash("private-source-marker")
      }
    };
    const changed = specification({ inputs: [changedFirst, authority.inputs[1]!] });
    const outsideTolerance = receipt(authority, "7.76");
    const report = runKnowledgeSemanticArithmeticReceiptAudit([
      { authoritativeSpecification: authority, expected: "accept", receipt: receipt(authority) },
      {
        authoritativeSpecification: authority,
        expected: "reject",
        receipt: receipt(changed)
      },
      { authoritativeSpecification: authority, expected: "reject", receipt: outsideTolerance }
    ]);

    expect(report).toMatchObject({
      aggregateOnly: true,
      contentFree: true,
      counts: {
        cases: 3,
        expectedAccepts: 1,
        expectedRejects: 2,
        falseAcceptances: 0,
        falseRejections: 0,
        rejected: 2,
        verified: 1
      },
      independentHumanLabelsUsed: false,
      metrics: {
        acceptanceAccuracy: 1,
        overallAccuracy: 1,
        rejectionAccuracy: 1
      },
      passed: true,
      productionVerifierUsed: true,
      rawEvidenceIncluded: false
    });
    expect(report.failureCodes.authoritative_binding_mismatch).toBe(1);
    expect(report.failureCodes.output_outside_tolerance).toBe(1);
    expect(() => assertKnowledgeSemanticArithmeticReceiptAudit(report)).not.toThrow();
    const serialized = JSON.stringify(report);
    for (const privateValue of [
      "B2:B2",
      "C2:C2",
      "USD",
      "K1",
      "K2",
      hash("private-source-marker"),
      authority.claimSha256
    ]) {
      expect(serialized).not.toContain(privateValue);
    }

    const mislabeled = runKnowledgeSemanticArithmeticReceiptAudit([
      { authoritativeSpecification: authority, expected: "reject", receipt: receipt(authority) },
      { authoritativeSpecification: authority, expected: "reject", receipt: receipt(changed) }
    ]);
    expect(mislabeled.counts.falseAcceptances).toBe(1);
    expect(mislabeled.passed).toBe(false);
    expect(() => assertKnowledgeSemanticArithmeticReceiptAudit(mislabeled))
      .toThrow("knowledge_semantic_arithmetic_receipt_audit_failed");
  });
});
