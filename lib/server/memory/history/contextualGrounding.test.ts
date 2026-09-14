import { describe, expect, it } from "vitest";
import {
  buildMemoryContextualGroundingRequest,
  decodeMemoryContextualGrounding
} from "./contextualGrounding";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  memoryContextualGroundingHash,
  memoryContextualOutputIsVerbatim,
  type MemoryContextualRoundOutput
} from "./rounds";

function fixture() {
  const input = {
    current: { id: "private-current", rawSafeText: "User: She chose a window seat." },
    prior: [
      { id: "private-prior", rawSafeText: "User: Nia booked a table." },
      { id: "private-uncited", rawSafeText: "User: Omar likes cycling." }
    ]
  };
  const batch = [{ input, roundId: input.current.id }];
  const outputs: MemoryContextualRoundOutput[] = [{
    languageCode: "en",
    roundId: input.current.id,
    statements: [{
      sourceRoundIds: [input.prior[0]!.id, input.current.id],
      text: "Nia chose a seat near the window."
    }]
  }];
  return { batch, input, outputs };
}

describe("contextual grounding source and response boundary", () => {
  it("discloses only cited safe sources under opaque handles", () => {
    const { batch, input, outputs } = fixture();
    const built = buildMemoryContextualGroundingRequest(batch, outputs);
    const request = JSON.parse(built.request!.userPrompt);

    expect(request.sources).toEqual([
      { source_ref: "r0p0", text: input.prior[0]!.rawSafeText },
      { source_ref: "r0c", text: input.current.rawSafeText }
    ]);
    expect(request.statements).toEqual([{
      handle: "s0",
      source_refs: ["r0p0", "r0c"],
      text: outputs[0]!.statements[0]!.text
    }]);
    expect(built.request!.userPrompt).not.toContain("private-");
    expect(built.request!.userPrompt).not.toContain(input.prior[1]!.rawSafeText);
  });

  it.each([
    { decisions: [] },
    { decisions: [{ handle: "s1", support: "SUPPORTED" }] },
    { decisions: [{ handle: "s0", support: "YES" }] },
    { decisions: [{ handle: "s0", support: "SUPPORTED", text: "replacement" }] },
    { decisions: [{ handle: "s0", support: "SUPPORTED" }], extra: true },
    { decisions: [null] }
  ])("rejects incomplete or unbound review output %#", (response) => {
    const { batch, outputs } = fixture();
    const built = buildMemoryContextualGroundingRequest(batch, outputs);
    expect(() => decodeMemoryContextualGrounding(response, built.checks, batch, outputs))
      .toThrow("memory_contextual_grounding_invalid");
  });

  it.each(["source", "statement", "citation", "coverage"])(
    "rejects a changed %s after requesting review", (change) => {
      const { batch, input, outputs } = fixture();
      const built = buildMemoryContextualGroundingRequest(batch, outputs);
      if (change === "source") input.current.rawSafeText = "User: She chose an aisle seat.";
      if (change === "statement") outputs[0] = {
        ...outputs[0]!,
        statements: [{ ...outputs[0]!.statements[0]!, text: "Nia chose an aisle seat." }]
      };
      if (change === "citation") outputs[0] = {
        ...outputs[0]!,
        statements: [{ ...outputs[0]!.statements[0]!, sourceRoundIds: [input.current.id] }]
      };
      if (change === "coverage") outputs[0] = {
        ...outputs[0]!,
        statements: [...outputs[0]!.statements, {
          sourceRoundIds: [input.current.id], text: "The seat is near the window."
        }]
      };
      expect(() => decodeMemoryContextualGrounding(
        { decisions: [{ handle: "s0", support: "SUPPORTED" }] },
        built.checks, batch, outputs
      )).toThrow("memory_contextual_grounding_invalid");
    }
  );

  it("rejects reordered or duplicated decisions without partially accepting a round", () => {
    const { batch, outputs } = fixture();
    outputs[0] = {
      ...outputs[0]!,
      statements: [...outputs[0]!.statements, {
        sourceRoundIds: [batch[0]!.input.current.id], text: "A window seat was chosen."
      }]
    };
    const built = buildMemoryContextualGroundingRequest(batch, outputs);
    for (const handles of [["s1", "s0"], ["s0", "s0"]]) {
      expect(() => decodeMemoryContextualGrounding({
        decisions: handles.map((handle) => ({ handle, support: "SUPPORTED" }))
      }, built.checks, batch, outputs)).toThrow("memory_contextual_grounding_invalid");
    }
    const rejected = decodeMemoryContextualGrounding({ decisions: [
      { handle: "s0", support: "SUPPORTED" },
      { handle: "s1", support: "UNCERTAIN" }
    ] }, built.checks, batch, outputs);
    expect(rejected.outputs).toEqual([]);
    expect(rejected.rejectedRoundIds).toEqual([batch[0]!.roundId]);
  });

  it("binds successful review to the exact proposal, sources and policy", () => {
    const { batch, input, outputs } = fixture();
    const built = buildMemoryContextualGroundingRequest(batch, outputs);
    const decoded = decodeMemoryContextualGrounding({
      decisions: [{ handle: "s0", support: "SUPPORTED" }]
    }, built.checks, batch, outputs);
    expect(decoded.outputs).toEqual([{
      ...outputs[0],
      groundingHash: memoryContextualGroundingHash(
        input, outputs[0]!, MEMORY_CONTEXTUAL_KEY_POLICY_VERSION
      )
    }]);
    expect(decoded.rejectedRoundIds).toEqual([]);
    expect(decoded.outputs[0]!.groundingHash).not.toBe(
      memoryContextualGroundingHash(input, outputs[0]!, "another-policy")
    );
  });

  it("retains a supported round when another round in the batch is unsupported", () => {
    const { batch, outputs } = fixture();
    const second = {
      input: { current: { id: "second-round", rawSafeText: "User: I do not prefer tea." }, prior: [] },
      roundId: "second-round"
    };
    const together = [...batch, second];
    const proposals = [...outputs, {
      languageCode: "en", roundId: second.roundId,
      statements: [{ sourceRoundIds: [second.roundId], text: "I prefer tea." }]
    }];
    const review = buildMemoryContextualGroundingRequest(together, proposals);
    const decoded = decodeMemoryContextualGrounding({ decisions: [
      { handle: "s0", support: "SUPPORTED" }, { handle: "s1", support: "UNSUPPORTED" }
    ] }, review.checks, together, proposals);
    expect(decoded.outputs.map((output) => output.roundId)).toEqual([batch[0]!.roundId]);
    expect(decoded.rejectedRoundIds).toEqual([second.roundId]);
  });

  it("allows only complete source copies to bypass semantic review", () => {
    const { batch, input, outputs } = fixture();
    input.current.rawSafeText = "User: I do not prefer tea.";
    const copied = {
      ...outputs[0]!,
      statements: [{ sourceRoundIds: [input.current.id], text: input.current.rawSafeText }]
    };
    expect(buildMemoryContextualGroundingRequest(batch, [copied]).request).toBeNull();
    for (const text of ["I do not prefer tea.", "I prefer tea."]) {
      const shortened = { ...copied, statements: [{ ...copied.statements[0]!, text }] };
      expect(memoryContextualOutputIsVerbatim(input, shortened)).toBe(false);
      expect(buildMemoryContextualGroundingRequest(batch, [shortened]).request).not.toBeNull();
    }
  });

  it.each(["source", "proposal"])("blocks an unsafe %s before reviewer egress", (target) => {
    const { batch, input, outputs } = fixture();
    const unsafe = "sk-" + "a".repeat(40);
    if (target === "source") input.current.rawSafeText = unsafe;
    else outputs[0] = { ...outputs[0]!, statements: [{
      sourceRoundIds: [input.current.id], text: unsafe
    }] };
    expect(() => buildMemoryContextualGroundingRequest(batch, outputs))
      .toThrow("memory_contextual_grounding_invalid");
  });
});
